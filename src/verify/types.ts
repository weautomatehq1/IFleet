export type VerifyKind = 'typecheck' | 'lint' | 'test' | 'playwright' | 'screenshot';

export interface VerifyKindResult {
  ok: boolean;
  durationMs: number;
  output: string;
}

export interface VerifyResult {
  ok: boolean;
  perKind: Record<VerifyKind, VerifyKindResult>;
  totalDurationMs: number;
}

export interface VerifyRunner {
  run(worktreePath: string, kinds: VerifyKind[]): Promise<VerifyResult>;
}

export interface VerifyConfig {
  screenshot: {
    maxDiffPixels: number;
    threshold: number;
  };
  timeouts: {
    typecheck: number;
    lint: number;
    test: number;
    playwright: number;
    playwrightBootstrap: number;
    screenshot: number;
  };
}

export const DEFAULT_VERIFY_CONFIG: VerifyConfig = {
  screenshot: { maxDiffPixels: 50, threshold: 0.2 },
  timeouts: {
    typecheck: 5 * 60 * 1000,
    lint: 5 * 60 * 1000,
    test: 10 * 60 * 1000,
    playwright: 10 * 60 * 1000,
    playwrightBootstrap: 2 * 60 * 1000,
    screenshot: 10 * 60 * 1000,
  },
};

export const OUTPUT_BUFFER_CAP_BYTES = 2 * 1024 * 1024;
