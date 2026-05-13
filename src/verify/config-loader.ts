import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_VERIFY_CONFIG, type VerifyConfig } from './types.js';

export function loadVerifyConfig(worktreePath: string): VerifyConfig {
  const configPath = resolve(worktreePath, 'config/verify.json');
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<VerifyConfig>;
    return {
      screenshot: { ...DEFAULT_VERIFY_CONFIG.screenshot, ...(parsed.screenshot ?? {}) },
      timeouts: { ...DEFAULT_VERIFY_CONFIG.timeouts, ...(parsed.timeouts ?? {}) },
    };
  } catch {
    return DEFAULT_VERIFY_CONFIG;
  }
}
