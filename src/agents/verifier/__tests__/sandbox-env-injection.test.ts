/**
 * Tests for .ifleet/verify-env/<repoId>.env injection into docker run.
 * No real Docker daemon required — spawnFn is injected.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerSandboxRunner } from '../sandbox.js';
import type { VerifierRunInput } from '../types.js';
import type { SprintId, TaskId } from '../../../orchestrator/types.js';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (sig: string) => void;
}

/** Captures every spawn call made, then succeeds. */
function capturingSpawn(calls: { cmd: string; args: string[] }[]) {
  return ((cmd: string, args?: readonly string[] | object) => {
    const argList = Array.isArray(args) ? (args as string[]) : [];
    calls.push({ cmd, args: argList });
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    setImmediate(() => {
      // docker info succeeds → Docker path taken
      if (cmd === 'docker' && argList.includes('info')) {
        child.emit('close', 0, null);
      } else {
        child.emit('close', 0, null);
      }
    });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
}

const dirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'env-inject-test-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function makeWorktree(): string {
  const dir = tmpDir();
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { build: 'echo', typecheck: 'echo', lint: 'echo', test: 'echo' } }),
  );
  return dir;
}

function makeInput(worktreePath: string, repoUrl = 'https://github.com/weautomatehq1/IFleet'): VerifierRunInput {
  return {
    taskId: 't1' as TaskId,
    sprintId: 's1' as SprintId,
    repoUrl,
    branch: 'feat/test',
    sha: 'deadbeef',
    attempt: 1,
    worktreePath,
  };
}

describe('env-file injection', () => {
  it('includes --env-file when .ifleet/verify-env/<repoId>.env exists', async () => {
    const worktree = makeWorktree();
    const envDir = tmpDir();
    const envFile = join(envDir, 'weautomatehq1_IFleet.env');
    writeFileSync(envFile, 'GITHUB_TOKEN=ghp_test\n');

    const calls: { cmd: string; args: string[] }[] = [];
    const runner = new DockerSandboxRunner({
      envDir,
      spawnFn: capturingSpawn(calls),
    });

    await runner.run(makeInput(worktree));

    const dockerRunCalls = calls.filter(
      (c) => c.cmd === 'docker' && c.args.includes('run'),
    );
    expect(dockerRunCalls.length).toBeGreaterThan(0);
    for (const call of dockerRunCalls) {
      expect(call.args).toContain('--env-file');
      const idx = call.args.indexOf('--env-file');
      expect(call.args[idx + 1]).toBe(envFile);
    }
  });

  it('omits --env-file and sets banner when env file is missing', async () => {
    const worktree = makeWorktree();
    const envDir = tmpDir(); // empty — no env file

    const calls: { cmd: string; args: string[] }[] = [];
    const runner = new DockerSandboxRunner({
      envDir,
      spawnFn: capturingSpawn(calls),
    });

    const result = await runner.run(makeInput(worktree));

    const dockerRunCalls = calls.filter(
      (c) => c.cmd === 'docker' && c.args.includes('run'),
    );
    expect(dockerRunCalls.length).toBeGreaterThan(0);
    for (const call of dockerRunCalls) {
      expect(call.args).not.toContain('--env-file');
    }
    expect(result.banner).toMatch(/verify-env: not configured/);
  });

  it('passes env file path as a discrete arg (no shell injection risk)', async () => {
    const worktree = makeWorktree();
    const envDir = tmpDir();
    // Path contains spaces and special chars — must be passed as a separate arg, not interpolated
    const specialDir = join(envDir, 'org with spaces');
    mkdirSync(specialDir, { recursive: true });
    const envFile = join(specialDir, 'weautomatehq1_IFleet.env');
    writeFileSync(envFile, 'FOO=bar\n');

    // Override envDir to point to the special sub-path — the runner resolves the repoId file inside it
    // Since special chars are in the envDir path (not repoId), we need envDir = specialDir
    const calls: { cmd: string; args: string[] }[] = [];
    const runner = new DockerSandboxRunner({
      envDir: specialDir,
      spawnFn: capturingSpawn(calls),
    });

    await runner.run(makeInput(worktree));

    const dockerRunCalls = calls.filter(
      (c) => c.cmd === 'docker' && c.args.includes('run'),
    );
    expect(dockerRunCalls.length).toBeGreaterThan(0);
    const firstRun = dockerRunCalls[0]!;
    expect(firstRun.args).toContain('--env-file');
    // Path passed as a discrete element — no shell quoting, no interpolation
    const idx = firstRun.args.indexOf('--env-file');
    expect(firstRun.args[idx + 1]).toBe(envFile);
  });

  it('derives repoId correctly from GitHub URLs', async () => {
    const worktree = makeWorktree();
    const envDir = tmpDir();
    // repoId for https://github.com/my-org/my-repo → my-org_my-repo
    const envFile = join(envDir, 'my-org_my-repo.env');
    writeFileSync(envFile, 'SECRET=x\n');

    const calls: { cmd: string; args: string[] }[] = [];
    const runner = new DockerSandboxRunner({
      envDir,
      spawnFn: capturingSpawn(calls),
    });

    await runner.run(makeInput(worktree, 'https://github.com/my-org/my-repo'));

    const dockerRunCalls = calls.filter(
      (c) => c.cmd === 'docker' && c.args.includes('run'),
    );
    const firstRun = dockerRunCalls[0]!;
    expect(firstRun.args).toContain('--env-file');
    const idx = firstRun.args.indexOf('--env-file');
    expect(firstRun.args[idx + 1]).toContain('my-org_my-repo.env');
  });
});
