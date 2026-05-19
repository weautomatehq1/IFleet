/**
 * Docker sandbox invocation — M0.W1 scaffold.
 *
 * Contract: given a VerifierRunInput, returns a VerifierRunResult. The current
 * implementation is a stub that returns `passed` unconditionally so the event
 * contract is exercised end-to-end without any Docker work. M1.W2 swaps the
 * stub for a real `docker run` + log-parse loop without changing the signature.
 */

import { randomUUID } from 'node:crypto';
import type {
  VerifierRunInput,
  VerifierRunResult,
} from './types.js';
import { newVerifierRunId } from './types.js';

export interface SandboxRunner {
  run(input: VerifierRunInput): Promise<VerifierRunResult>;
}

export interface SandboxConfig {
  /** Image tag — defaults to ifleet-verifier:base, overridden per-repo in M1.W4. */
  image?: string;
  /** Hard timeout (ms) before SIGKILL. Default 600_000 (10 min) per ADR-0002. */
  timeoutMs?: number;
  /** Memory cap in MB. Default 4096 per ADR-0002. */
  memoryMb?: number;
  /** Override the clock for tests. */
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MEMORY_MB = 4096;

/**
 * Stub sandbox runner. Returns `passed` unconditionally so the editor.completed
 * → verifier.passed → PR-open contract can be tested end-to-end without Docker
 * on the loop. Real implementation lands in M1.W2.
 */
export class StubSandboxRunner implements SandboxRunner {
  private readonly now: () => number;

  constructor(cfg: SandboxConfig = {}) {
    this.now = cfg.now ?? Date.now;
  }

  async run(input: VerifierRunInput): Promise<VerifierRunResult> {
    const startedAt = this.now();
    // Yield a tick so callers observing async semantics see the same shape they
    // will in M1.W2 (where the real `docker run` is async).
    await Promise.resolve();
    const finishedAt = this.now();
    return {
      runId: newVerifierRunId(randomUUID()),
      status: 'passed',
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      attempt: input.attempt,
      failures: [],
    };
  }
}

/**
 * Real Docker sandbox — NOT IMPLEMENTED in M0.W1.
 *
 * Implementation plan (M1.W2):
 *   1. Build/cache image tagged `ifleet-verifier:<repoId>-<lockfileHash>`
 *   2. `docker run --rm --memory=${memoryMb}m -v <worktree>:/work <image>` with
 *      entrypoint script doing: pnpm install, pnpm build, pnpm typecheck,
 *      pnpm lint, pnpm test, then run invariants (M1.W4).
 *   3. Stream stdout+stderr to a temp file; capture exit code.
 *   4. Parse output → VerifierFailure[] via failure-parser.ts (M1.W2).
 *   5. Upload raw log to S3 → rawLogUrl.
 *   6. SIGKILL + status:'timeout' if duration > timeoutMs.
 */
export class DockerSandboxRunner implements SandboxRunner {
  constructor(_cfg: SandboxConfig = {}) {
    void _cfg; // suppress unused warning in scaffold
  }

  async run(_input: VerifierRunInput): Promise<VerifierRunResult> {
    void _input;
    throw new Error('DockerSandboxRunner not implemented — M1.W2');
  }
}

export const sandboxDefaults = Object.freeze({
  timeoutMs: DEFAULT_TIMEOUT_MS,
  memoryMb: DEFAULT_MEMORY_MB,
});
