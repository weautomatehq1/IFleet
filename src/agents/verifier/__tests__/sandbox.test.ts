/**
 * DockerSandboxRunner unit tests — uses an injected `spawnFn` so no real
 * Docker daemon is required. The fake spawn implements just enough of the
 * Node ChildProcess interface for the runner's stdio/timeout paths.
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerSandboxRunner, StubSandboxRunner } from '../sandbox.js';
import type { VerifierRunInput } from '../types.js';
import type { SprintId, TaskId } from '../../../orchestrator/types.js';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (sig: string) => void;
}

function fakeSpawn(
  plan: Map<string, { exit: number; stdout?: string; stderr?: string }>,
): typeof import('node:child_process').spawn {
  const impl = (cmd: string, args?: readonly string[] | object) => {
    const argList = Array.isArray(args) ? (args as readonly string[]) : [];
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    setImmediate(() => {
      const key = matchKey(plan, cmd, argList);
      const spec = plan.get(key) ?? { exit: 0, stdout: '' };
      if (spec.stdout) child.stdout.emit('data', Buffer.from(spec.stdout));
      if (spec.stderr) child.stderr.emit('data', Buffer.from(spec.stderr));
      child.emit('close', spec.exit, null);
    });
    return child;
  };
  return impl as unknown as typeof import('node:child_process').spawn;
}

function matchKey(plan: Map<string, unknown>, cmd: string, args: readonly string[]): string {
  const argStr = args.join(' ');
  for (const key of plan.keys()) {
    if (argStr.includes(key)) return key;
  }
  return cmd;
}

function makeWorktree(pkg: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

function makeInput(worktreePath: string): VerifierRunInput {
  return {
    taskId: 't1' as TaskId,
    sprintId: 's1' as SprintId,
    repoUrl: 'https://github.com/weautomatehq1/IFleet',
    branch: 'feat/test',
    sha: 'deadbeef',
    attempt: 1,
    worktreePath,
  };
}

describe('StubSandboxRunner', () => {
  it('returns passed unconditionally', async () => {
    const runner = new StubSandboxRunner();
    const result = await runner.run({
      taskId: 't' as TaskId,
      sprintId: 's' as SprintId,
      repoUrl: 'https://x',
      branch: 'b',
      sha: 'sha',
      attempt: 1,
    });
    expect(result.status).toBe('passed');
  });
});

describe('DockerSandboxRunner', () => {
  it('returns error when worktreePath is missing and clone fails', async () => {
    const plan = new Map<string, { exit: number; stdout?: string; stderr?: string }>([
      ['clone', { exit: 128, stderr: 'fatal: repository not found' }],
    ]);
    const runner = new DockerSandboxRunner({ spawnFn: fakeSpawn(plan) });
    const result = await runner.run({
      taskId: 't' as TaskId,
      sprintId: 's' as SprintId,
      repoUrl: 'https://github.com/weautomatehq1/nonexistent',
      branch: 'b',
      sha: 'abc1234',
      attempt: 1,
    });
    expect(result.status).toBe('error');
    expect(result.failures[0]?.message).toMatch(/git clone/);
  });

  it('clones from SHA when worktreePath is not provided', async () => {
    const calls: { cmd: string; args: readonly string[] }[] = [];
    const plan = new Map<string, { exit: number; stdout?: string; stderr?: string }>([
      ['clone', { exit: 0 }],
      ['checkout', { exit: 0 }],
      ['info', { exit: 1 }], // docker info fails → fallback
      ['install', { exit: 0 }],
    ]);
    const baseSpawn = fakeSpawn(plan);
    const trackingSpawn = ((cmd: string, args?: readonly string[] | object) => {
      const argList = Array.isArray(args) ? (args as readonly string[]) : [];
      calls.push({ cmd, args: argList });
      return (baseSpawn as unknown as (c: string, a?: readonly string[] | object) => unknown)(cmd, args);
    }) as unknown as typeof import('node:child_process').spawn;
    const runner = new DockerSandboxRunner({ spawnFn: trackingSpawn });
    const result = await runner.run({
      taskId: 't' as TaskId,
      sprintId: 's' as SprintId,
      repoUrl: 'https://github.com/weautomatehq1/IFleet',
      branch: 'feat/x',
      sha: 'cafebabe',
      attempt: 1,
    });
    // status will be 'partial' (no test script in cloned dir's package.json which doesn't exist)
    // or 'error' if install fails on the empty temp dir — what we really care about is the git calls.
    expect(result.status).not.toBe('passed');
    const gitClone = calls.find((c) => c.cmd === 'git' && c.args.includes('clone'));
    const gitCheckout = calls.find((c) => c.cmd === 'git' && c.args.includes('checkout'));
    expect(gitClone).toBeTruthy();
    expect(gitClone?.args).toContain('https://github.com/weautomatehq1/IFleet');
    expect(gitCheckout).toBeTruthy();
    expect(gitCheckout?.args).toContain('cafebabe');
  });

  it('returns error when worktreePath does not exist', async () => {
    const runner = new DockerSandboxRunner({ spawnFn: fakeSpawn(new Map()) });
    const result = await runner.run(makeInput('/nonexistent/path/here'));
    expect(result.status).toBe('error');
  });

  it('runs all configured phases via the fallback path when docker is down', async () => {
    const dir = makeWorktree({
      scripts: { build: 'echo build', typecheck: 'echo tc', lint: 'echo lint', test: 'echo test' },
    });
    try {
      const plan = new Map([
        ['info', { exit: 1 }], // docker info fails → fallback
        ['install', { exit: 0 }],
        ['run build', { exit: 0 }],
        ['run typecheck', { exit: 0 }],
        ['run lint', { exit: 0 }],
        ['run test', { exit: 0 }],
      ]);
      const runner = new DockerSandboxRunner({ spawnFn: fakeSpawn(plan) });
      const result = await runner.run(makeInput(dir));
      expect(result.status).toBe('passed');
      expect(result.banner).toContain('sandbox: unavailable');
      expect(result.phases?.length ?? 0).toBeGreaterThanOrEqual(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks status partial when no test script is present', async () => {
    const dir = makeWorktree({
      scripts: { build: 'echo build', typecheck: 'echo tc', lint: 'echo lint' },
    });
    try {
      const plan = new Map([
        ['info', { exit: 1 }],
        ['install', { exit: 0 }],
        ['run build', { exit: 0 }],
        ['run typecheck', { exit: 0 }],
        ['run lint', { exit: 0 }],
      ]);
      const runner = new DockerSandboxRunner({ spawnFn: fakeSpawn(plan) });
      const result = await runner.run(makeInput(dir));
      expect(result.status).toBe('partial');
      expect(result.banner).toMatch(/partial/);
      // ensure test phase was recorded as skipped
      const testPhase = result.phases?.find((p) => p.kind === 'test');
      expect(testPhase?.skipped).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports failed on a tsc red phase and stops the chain', async () => {
    const dir = makeWorktree({
      scripts: { build: 'echo', typecheck: 'tsc', lint: 'eslint', test: 'vitest' },
    });
    try {
      const plan = new Map<string, { exit: number; stdout?: string; stderr?: string }>([
        ['info', { exit: 1 }],
        ['install', { exit: 0 }],
        ['run build', { exit: 0 }],
        ['run typecheck', { exit: 1, stdout: `src/foo.ts(12,5): error TS2304: Cannot find name 'X'.` }],
      ]);
      const runner = new DockerSandboxRunner({ spawnFn: fakeSpawn(plan) });
      const result = await runner.run(makeInput(dir));
      expect(result.status).toBe('failed');
      expect(result.failures.some((f) => f.kind === 'typecheck')).toBe(true);
      // lint and test should not be in the phases since we broke on typecheck
      expect(result.phases?.some((p) => p.kind === 'test' && !p.skipped)).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies an install-only failure as status=error (not failed)', async () => {
    const dir = makeWorktree({ scripts: { build: 'echo' } });
    try {
      const plan = new Map<string, { exit: number; stdout?: string; stderr?: string }>([
        ['info', { exit: 1 }],
        ['install', { exit: 1, stdout: 'ERR_PNPM_FETCH_404 GET https://x: Not found' }],
      ]);
      const runner = new DockerSandboxRunner({ spawnFn: fakeSpawn(plan) });
      const result = await runner.run(makeInput(dir));
      expect(result.status).toBe('error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
