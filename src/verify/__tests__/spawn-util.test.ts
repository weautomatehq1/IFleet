import { describe, it, expect } from 'vitest';
import { runProcess } from '../spawn-util.js';
import { OUTPUT_BUFFER_CAP_BYTES } from '../types.js';

const NODE = process.execPath;

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
