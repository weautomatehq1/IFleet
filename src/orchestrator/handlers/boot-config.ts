// Boot-time configuration helpers.
// Extracted from daemon.ts — pure structural refactor, no logic changes.

import { readFileSync } from 'node:fs';
import { loadReposConfig } from '../../config/repos.js';
import { FileChannelRouter } from '../../repos/router.js';
import type { RepoResolver, ResolvedRepo } from '../../pipeline/factory.js';
import type { WorkerConfig } from '../types.js';
import { validateMaxPlanConcurrency } from '../workers.js';

// AUDIT-IFleet-1b8126b6 / dc8a89c5 / c29996f1 — minimal sanity-check on
// worker model IDs from BOTH bootstrap paths: the WORKER_MODELS env var
// (dot-separated aliases like `opus-4.7`) and config/workers.json (full
// model IDs like `claude-opus-4-7`). Unknown values are still allowed
// (forward-compatibility with new models) but emit a one-line warn so a
// typo like "sonet-4.6" surfaces immediately at boot instead of failing
// opaquely at account-pool resolution.
export const KNOWN_MODEL_SHORTHAND = new Set([
  // Short aliases (WORKER_MODELS env var)
  'opus-4.7', 'sonnet-4.6', 'haiku-4.5',
  // Full model IDs (config/workers.json)
  'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
]);

export function warnUnknownModels(source: string, models: ReadonlyArray<string>): void {
  for (const m of models) {
    if (!KNOWN_MODEL_SHORTHAND.has(m)) {
      console.warn(
        `[daemon] ${source} contains unknown model id: \`${m}\` ` +
          `(known: ${Array.from(KNOWN_MODEL_SHORTHAND).join(', ')}). ` +
          `Forwarding to pool anyway; verify pipeline factory mapModel() supports it.`,
      );
    }
  }
}

export function loadInitialWorkers(configPath?: string): ReadonlyArray<WorkerConfig> {
  // Preferred bootstrap path: read config/workers.json so the initial value
  // matches the live config without hardcoding model versions in source code.
  // AUDIT-IFleet-df1f3730 / 3ea3e721.
  if (configPath) {
    let enabled: ReadonlyArray<WorkerConfig> | undefined;
    try {
      const raw = readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw) as { workers?: ReadonlyArray<WorkerConfig> };
      enabled = (parsed.workers ?? []).filter((w) => w.enabled);
    } catch (err) {
      console.warn(
        `[daemon] loadInitialWorkers: could not read ${configPath} (${
          err instanceof Error ? err.message : String(err)
        }); falling back to env / hardcoded bootstrap`,
      );
    }
    if (enabled !== undefined && enabled.length > 0) {
      // Throws on tier=max-* with maxConcurrent>1 (single-seat policy,
      // AUDIT-IFleet-a394a4f1). The bootstrap path MUST fail loud — a
      // silent fallback to defaults would mask a config that the operator
      // explicitly meant to honor. Kept OUTSIDE the read-file try/catch so
      // a validation throw is not swallowed by the "config unreadable"
      // handler (codex review caught this).
      validateMaxPlanConcurrency(enabled);
      for (const w of enabled) {
        warnUnknownModels(`workers.json[${w.id}].models`, w.models ?? []);
      }
      return enabled;
    }
    if (enabled !== undefined) {
      // AUDIT-IFleet-1543b30a — surface the silent fall-through when the
      // config file exists but every worker is disabled. Without this warn
      // the operator only learns from boot-time worker counts that the
      // config wasn't honored.
      console.warn(
        `[daemon] loadInitialWorkers: ${configPath} has no enabled workers ` +
          `— falling back to env / hardcoded bootstrap`,
      );
    }
  }
  // Fallback: WORKER_MODELS env var, then a single-account hardcoded bootstrap.
  // The orchestrator's WorkerRegistry watches config/workers.json and reloads
  // on change, so this fallback only survives until the file appears.
  const modelsEnv = process.env['WORKER_MODELS'];
  const models = modelsEnv
    ? modelsEnv
        .split(',')
        .map((m) => m.trim())
        .filter((m) => m.length > 0)
    : ['opus-4.7', 'sonnet-4.6', 'haiku-4.5'];
  warnUnknownModels('WORKER_MODELS', models);
  const cfg: WorkerConfig = {
    id: 'claude-max-1',
    provider: 'claude',
    authProfile: process.env['CLAUDE_AUTH_PROFILE'] ?? 'default',
    models,
    maxConcurrent: 1,
    enabled: true,
  };
  return [cfg];
}

/**
 * Compose a {@link RepoResolver} from the existing channels router (which
 * carries `workDir` + `defaultBranch` + `codeowners`) and the reposMap
 * allowlist. The factory uses this to refuse any task whose `task.repo` is
 * not whitelisted, before a worktree is created or any git/PR command runs.
 *
 * The resolver is the load-bearing fix for AUDIT-IFleet-6126a1f9: previously
 * the factory hardcoded `repoRoot` to the daemon's working directory and
 * defaulted `repoId` to `weautomatehq1/IFleet`, so a task from the factory
 * channel would build a worktree under IFleet and open a PR against IFleet.
 *
 * Composition rules (intentionally strict):
 *   - A repo must appear in BOTH `reposMap` (security allowlist) AND in some
 *     `channels.json` route (so we know where the clone lives). Either-only
 *     yields a `null` resolve.
 *   - `repoRoot` comes from the channel route's `workDir`.
 *   - `defaultBranch` and `codeowners` come from the channel route.
 *   - `owner`/`name` are split from the canonical slug.
 *
 * No "legacy IFleet fallback" — codex review caught that a backstop entry
 * built from the daemon's cwd would reintroduce exactly the foot-gun this
 * audit closes (silently dispatching to the host checkout on a misconfigured
 * channels.json). If channels.json doesn't mention IFleet, the resolver
 * returns null and the factory refuses to dispatch.
 */
export function buildRepoResolver(
  router: FileChannelRouter,
  reposMap: ReturnType<typeof loadReposConfig>,
): RepoResolver {
  // Build a per-repo view by walking channels.json once. Channels can map
  // multiple channelIds to the same repo (e.g. a public and a triage channel
  // for IFleet); first-wins is fine for our purposes since workDir is a
  // function of the repo slug, not the channel.
  const byRepo = new Map<string, ResolvedRepo>();
  for (const route of router.list()) {
    if (byRepo.has(route.repo)) continue;
    if (!reposMap[route.repo]) continue;
    if (!route.repo.includes('/')) {
      console.error(
        `[boot-config] channels.json repo must be owner/name format, got: ${route.repo} — skipping`,
      );
      continue;
    }
    const [owner, name] = route.repo.split('/', 2) as [string, string];
    byRepo.set(route.repo, {
      repoId: route.repo,
      owner,
      name,
      repoRoot: route.workDir,
      defaultBranch: route.defaultBranch,
      codeowners: route.codeowners,
    });
  }
  return {
    resolve(repoSlug: string): ResolvedRepo | null {
      return byRepo.get(repoSlug) ?? null;
    },
    list(): ReadonlyArray<ResolvedRepo> {
      return Array.from(byRepo.values());
    },
  };
}
