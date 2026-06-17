import { describe, it, expect } from 'vitest';
import { runProcess, verifyChildEnv } from '../spawn-util.js';
import { OUTPUT_BUFFER_CAP_BYTES } from '../types.js';

const NODE = process.execPath;

// Print one env var's value to stdout from inside the child, so the test can
// assert what the subprocess actually saw (not just what we passed).
const PRINT_ENV = (key: string): string =>
  `process.stdout.write(String(process.env[${JSON.stringify(key)}] ?? ''));`;

const SENSITIVE_KEYS = [
  'GITHUB_TOKEN',
  'IFLEET_HMAC_SECRET',
  'ANTHROPIC_API_KEY',
  'DISCORD_BOT_TOKEN',
] as const;

/**
 * These tests exercise the real spawn path (not mocked) because the contract
 * we care about is OS-level: a child that floods stderr past the buffer cap
 * must not deadlock the parent reader, and exit codes must propagate intact.
 */

describe('runProcess — real child', () => {
  it('propagates non-zero exit codes verbatim', async () => {
    const result = await runProcess(
      NODE,
      ['-e', 'process.stderr.write("bye"); process.exit(7);'],
      { cwd: process.cwd(), timeoutMs: 10_000 },
    );
    expect(result.exitCode).toBe(7);
    expect(result.ok).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain('bye');
  }, 15_000);

  it('returns ok=true and exitCode=0 on clean exit', async () => {
    const result = await runProcess(
      NODE,
      ['-e', 'process.stdout.write("hello"); process.exit(0);'],
      { cwd: process.cwd(), timeoutMs: 10_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('hello');
  }, 15_000);

  it('does NOT deadlock when stderr exceeds the buffer cap', async () => {
    // Write 2 × the cap to stderr in a tight loop. If the parent didn't
    // drain (or didn't cap) the pipe, the OS pipe buffer would fill and
    // the child would block forever in write(). The truncation logic in
    // spawn-util keeps consuming chunks after the cap, so the child still
    // drains and exits cleanly.
    const cap = OUTPUT_BUFFER_CAP_BYTES;
    const overflowBytes = cap * 2;
    const chunkSize = 64 * 1024;
    const script = `
      const chunk = Buffer.alloc(${chunkSize}, 0x41);
      let written = 0;
      const target = ${overflowBytes};
      function loop() {
        while (written < target) {
          if (!process.stderr.write(chunk)) return process.stderr.once('drain', loop);
          written += chunk.length;
        }
        process.exit(0);
      }
      loop();
    `;
    const result = await runProcess(NODE, ['-e', script], {
      cwd: process.cwd(),
      timeoutMs: 20_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
    // The captured output should be capped and tagged.
    expect(result.output.length).toBeLessThanOrEqual(cap + 200);
    expect(result.output).toContain(`[output truncated at ${cap} bytes]`);
  }, 30_000);

  it('marks timedOut=true and ok=false when the child exceeds the timeout', async () => {
    const result = await runProcess(
      NODE,
      ['-e', 'setTimeout(() => {}, 60_000);'],
      { cwd: process.cwd(), timeoutMs: 100 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/killed after 100ms/);
  }, 10_000);

  it('captures stderr from a binary that does not exist via the error event', async () => {
    const result = await runProcess('definitely-not-a-real-binary', ['--nope'], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('[spawn error]');
  }, 10_000);
});

describe('runProcess — child env is allowlisted (AUDIT-IFleet-193fb84e)', () => {
  it('does NOT forward sensitive parent env into the child by default', async () => {
    // Seed every sensitive key in THIS process so we prove the child env is
    // filtered, not merely that the var happened to be unset on the runner.
    for (const key of SENSITIVE_KEYS) process.env[key] = `secret-${key}`;
    try {
      for (const key of SENSITIVE_KEYS) {
        const result = await runProcess(NODE, ['-e', PRINT_ENV(key)], {
          cwd: process.cwd(),
          timeoutMs: 10_000,
          // no `env` → default minimal allowlist
        });
        expect(result.ok).toBe(true);
        expect(result.output).toBe('');
        expect(result.output).not.toContain('secret-');
      }
    } finally {
      for (const key of SENSITIVE_KEYS) delete process.env[key];
    }
  }, 30_000);

  it('still forwards PATH so the toolchain (pnpm/npx/node) resolves', async () => {
    const result = await runProcess(NODE, ['-e', PRINT_ENV('PATH')], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(true);
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.output).toBe(process.env.PATH ?? '');
  }, 15_000);
});

describe('verifyChildEnv', () => {
  it('drops every key outside the allowlist', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/x',
      GITHUB_TOKEN: 'ghp_xxx',
      IFLEET_HMAC_SECRET: 'hmac',
      ANTHROPIC_API_KEY: 'sk-ant',
      DISCORD_BOT_TOKEN: 'disc',
      OPENAI_API_KEY: 'sk-oai',
    };
    const env = verifyChildEnv(source);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/x');
    for (const key of [...SENSITIVE_KEYS, 'OPENAI_API_KEY']) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('layers non-secret extra vars on top of the allowlist', () => {
    const env = verifyChildEnv(
      { PATH: '/usr/bin', GITHUB_TOKEN: 'leak' },
      { PLAYWRIGHT_JSON_OUTPUT_NAME: '/tmp/report.json' },
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.PLAYWRIGHT_JSON_OUTPUT_NAME).toBe('/tmp/report.json');
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('extra vars win on collision with allowlisted keys', () => {
    const env = verifyChildEnv({ NODE_ENV: 'production' }, { NODE_ENV: 'test' });
    expect(env.NODE_ENV).toBe('test');
  });
});
