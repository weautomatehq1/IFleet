/**
 * M1 DoD eval replay — runs 10 historical eval tasks through VerifierController.
 *
 * Dry-run mode: uses StubSandboxRunner so no Docker, no real repo clones, and
 * no PRs are opened. Measures pipeline integration (wiring + DB persistence +
 * disagreementRate() computation), not sandbox accuracy.
 *
 * To run with the real DockerSandboxRunner against actual merged SHAs:
 *   IFLEET_REAL_SANDBOX=1 node --import tsx scripts/eval/run-eval-replay.ts
 *
 * Usage:
 *   node --import tsx scripts/eval/run-eval-replay.ts [--limit N]
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateStore } from '../../src/orchestrator/store.js';
import {
  newSprintId,
  newTaskId,
  type SprintRecord,
  type SprintId,
  type TaskId,
} from '../../src/orchestrator/types.js';
import { VerifierController } from '../../src/agents/verifier/controller.js';
import { VerifierStoreBridge } from '../../src/agents/verifier/store-bridge.js';
import { StubSandboxRunner, DockerSandboxRunner } from '../../src/agents/verifier/sandbox.js';
import type { VerifierRunResult } from '../../src/agents/verifier/types.js';

// ---- CLI flags ----
const useRealSandbox = process.env['IFLEET_REAL_SANDBOX'] === '1';
const limitArg = process.argv.indexOf('--limit');
const TASK_LIMIT = limitArg !== -1 ? parseInt(process.argv[limitArg + 1] ?? '10', 10) : 10;
const EVAL_SET_PATH = join(process.cwd(), '.ifleet/eval/eval-set.jsonl');
const RESULTS_PATH = join(process.cwd(), '.ifleet/eval/replay-results.json');

interface EvalRow {
  id: string;
  issue_url: string;
  pr_url: string;
  repo: string;
  title: string;
  body: string;
  classifier_label_actual: string;
  diff_url: string;
  diff_summary: string;
  files_changed: string[];
  loc_added: number;
  loc_removed: number;
  merged_at: string;
  reviewer_login: string;
  merge_decision: string;
  frozen_at: string;
}

interface TaskResult {
  evalId: string;
  repo: string;
  classifierLabel: string;
  locTotal: number;
  status: string;
  durationMs: number;
  costUsd: number | null;
  failuresCount: number;
  attempt: number;
  banner?: string;
}

async function readEvalRows(): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  const rl = createInterface({ input: createReadStream(EVAL_SET_PATH), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) rows.push(JSON.parse(trimmed) as EvalRow);
  }
  return rows;
}

function pickTen(rows: EvalRow[]): EvalRow[] {
  // Strategy: 2 bugfixes + 8 features, spread across LOC sizes.
  const bugfixes = rows.filter((r) => r.classifier_label_actual === 'bugfix').slice(0, 2);
  const features = rows.filter((r) => r.classifier_label_actual === 'feature');
  // Sort features by LOC ascending, pick evenly distributed
  features.sort((a, b) => (a.loc_added + a.loc_removed) - (b.loc_added + b.loc_removed));
  const step = Math.max(1, Math.floor(features.length / 8));
  const pickedFeatures = features.filter((_, i) => i % step === 0).slice(0, 8);
  return [...bugfixes, ...pickedFeatures].slice(0, TASK_LIMIT);
}

function prNumberFromUrl(url: string): string {
  const match = url.match(/\/pull\/(\d+)$/);
  return match?.[1] ?? '0';
}

function formatResultsTable(results: TaskResult[]): string {
  const header = '| # | ID | Label | LOC | Status | Duration | Failures |';
  const sep    = '|---|---|---|---|---|---|---|';
  const rows = results.map((r, i) =>
    `| ${i + 1} | ${r.evalId} | ${r.classifierLabel} | ${r.locTotal} | **${r.status}** | ${r.durationMs}ms | ${r.failuresCount} |`
  );
  return [header, sep, ...rows].join('\n');
}

async function main(): Promise<void> {
  console.log(`[eval-replay] sandbox mode: ${useRealSandbox ? 'REAL (DockerSandboxRunner)' : 'STUB (dry-run)'}`);
  console.log(`[eval-replay] task limit: ${TASK_LIMIT}`);

  if (!existsSync(EVAL_SET_PATH)) {
    console.error(`[eval-replay] eval-set.jsonl not found at ${EVAL_SET_PATH}`);
    process.exit(1);
  }

  // ---- Setup ephemeral StateStore ----
  const dbDir = mkdtempSync(join(tmpdir(), 'ifleet-eval-replay-'));
  const dbPath = join(dbDir, 'replay.db');
  console.log(`[eval-replay] DB: ${dbPath}`);
  const store = new StateStore(dbPath);

  // ---- Pick 10 eval tasks ----
  const allRows = await readEvalRows();
  const selectedRows = pickTen(allRows);
  console.log(`[eval-replay] selected ${selectedRows.length}/${allRows.length} tasks`);

  // ---- TaskRunContext map (keyed by taskId) ----
  const contextMap = new Map<TaskId, { sprintId: SprintId; repoUrl: string; branch: string; sha: string }>();

  // ---- Pre-insert synthetic sprint + task rows (FK requirement) ----
  for (const row of selectedRows) {
    const taskId = newTaskId(row.id);
    const sprintId = newSprintId(`eval-sprint-${randomUUID()}`);
    const now = Date.now();

    const sprintRecord: SprintRecord = {
      id: sprintId,
      mode: 'normal',
      goal: row.title,
      tasks: [taskId],
      state: { kind: 'completed', at: now, prs: [row.pr_url] },
      createdAt: now,
      updatedAt: now,
    };
    store.saveSprint(sprintRecord);

    const prNum = prNumberFromUrl(row.pr_url);
    contextMap.set(taskId, {
      sprintId,
      repoUrl: `https://github.com/${row.repo}`,
      branch: `eval/pr-${prNum}`,
      sha: useRealSandbox ? 'HEAD' : `eval-stub-${prNum}`,
    });
  }

  // ---- Build VerifierController ----
  const emittedEvents: unknown[] = [];
  const sandbox = useRealSandbox ? new DockerSandboxRunner() : new StubSandboxRunner();

  const controller = new VerifierController({
    store,
    emit: (ev) => { emittedEvents.push(ev); },
    sandbox,
    resolveTaskContext: async (taskId) => {
      const ctx = contextMap.get(taskId);
      if (!ctx) return null;
      return {
        taskId,
        sprintId: ctx.sprintId,
        repoUrl: ctx.repoUrl,
        branch: ctx.branch,
        sha: ctx.sha,
        attempt: 1,
      };
    },
    log: (msg, meta) => console.log(`[verifier] ${msg}`, meta ?? ''),
  });

  // ---- Run verification for each task ----
  const taskResults: TaskResult[] = [];

  for (const row of selectedRows) {
    const taskId = newTaskId(row.id);
    console.log(`[eval-replay] verifying ${row.id} (${row.classifier_label_actual}, ${row.loc_added + row.loc_removed} LOC)...`);

    const startMs = Date.now();
    let result: VerifierRunResult | null = null;
    let error: string | null = null;

    try {
      result = await controller.verifyTask(taskId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const durationMs = Date.now() - startMs;

    if (result) {
      taskResults.push({
        evalId: row.id,
        repo: row.repo,
        classifierLabel: row.classifier_label_actual,
        locTotal: row.loc_added + row.loc_removed,
        status: result.status,
        durationMs: result.durationMs,
        costUsd: result.costUsd ?? null,
        failuresCount: result.failures.length,
        attempt: result.attempt,
        banner: result.banner,
      });
      console.log(`  → ${result.status} in ${result.durationMs}ms (${result.failures.length} failures)`);
    } else {
      taskResults.push({
        evalId: row.id,
        repo: row.repo,
        classifierLabel: row.classifier_label_actual,
        locTotal: row.loc_added + row.loc_removed,
        status: 'error',
        durationMs,
        costUsd: null,
        failuresCount: 0,
        attempt: 1,
        banner: error ?? 'null result from verifyTask',
      });
      console.log(`  → error: ${error}`);
    }
  }

  // ---- Compute metrics ----
  const bridge = new VerifierStoreBridge(store);
  const disagreementRate = bridge.disagreementRate();
  const passedCount = taskResults.filter((r) => r.status === 'passed' || r.status === 'partial').length;
  const passRate = passedCount / taskResults.length;
  const avgDurationMs = taskResults.reduce((s, r) => s + r.durationMs, 0) / taskResults.length;
  const totalCostUsd = taskResults.reduce((s, r) => s + (r.costUsd ?? 0), 0);

  console.log('\n===== M1 DoD Eval Replay Results =====');
  console.log(`Pass rate:          ${passedCount}/${taskResults.length} (${(passRate * 100).toFixed(0)}%)`);
  console.log(`Disagreement rate:  ${disagreementRate === null ? 'null (<5 samples)' : disagreementRate.toFixed(4)}`);
  console.log(`Avg duration:       ${avgDurationMs.toFixed(0)}ms`);
  console.log(`Total cost:         $${totalCostUsd.toFixed(4)}`);
  console.log(`Events emitted:     ${emittedEvents.length}`);
  console.log(`DoD gate (≥8/10):   ${passedCount >= 8 ? '✓ PASS' : '✗ FAIL'}`);
  console.log('');
  console.log(formatResultsTable(taskResults));

  // ---- Persist results ----
  const summary = {
    runAt: new Date().toISOString(),
    sandboxMode: useRealSandbox ? 'real' : 'stub',
    taskLimit: TASK_LIMIT,
    passingGate: 8,
    passedCount,
    totalCount: taskResults.length,
    passRatePct: +(passRate * 100).toFixed(2),
    disagreementRate,
    avgDurationMs: +avgDurationMs.toFixed(0),
    totalCostUsd: +totalCostUsd.toFixed(4),
    eventsEmitted: emittedEvents.length,
    dodGatePassed: passedCount >= 8,
    tasks: taskResults,
  };
  writeFileSync(RESULTS_PATH, JSON.stringify(summary, null, 2));
  console.log(`\n[eval-replay] results written → ${RESULTS_PATH}`);

  store.close();

  if (passedCount < 8) {
    console.error('\n[eval-replay] DoD FAILED: <8/10 verifier-passed. Do NOT declare M1 done.');
    process.exit(1);
  }

  console.log('\n[eval-replay] DoD PASSED: ≥8/10 verifier-passed.');
}

main().catch((err) => {
  console.error('[eval-replay] fatal:', err);
  process.exit(1);
});
