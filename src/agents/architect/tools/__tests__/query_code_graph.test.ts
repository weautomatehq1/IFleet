/**
 * query_code_graph stub tests — pin the signature and the gating behavior
 * so M3.W3 can swap in the real implementation without breaking callers.
 */
import { describe, expect, it, vi } from 'vitest';
import { queryCodeGraph } from '../query_code_graph.js';

describe('queryCodeGraph (M3.W1 stub)', () => {
  it('returns an empty result and does not log when IFLEET_KG_ENABLED is unset', async () => {
    const logger = vi.fn();
    const result = await queryCodeGraph(
      { query: 'how does the verifier retry?' },
      { logger, envLookup: () => undefined },
    );
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.hitDatabase).toBe(false);
    expect(result.banner).toMatch(/disabled/);
    expect(logger).not.toHaveBeenCalled();
  });

  it('logs and returns empty result when IFLEET_KG_ENABLED=1 (stub path)', async () => {
    const logger = vi.fn();
    const result = await queryCodeGraph(
      { query: 'verifier', repoId: 'r', depth: 2 },
      { logger, envLookup: k => (k === 'IFLEET_KG_ENABLED' ? '1' : undefined) },
    );
    expect(result.nodes).toEqual([]);
    expect(result.hitDatabase).toBe(false);
    expect(logger).toHaveBeenCalledTimes(1);
  });

  it('clamps depth to [1,4]', async () => {
    const logger = vi.fn();
    await queryCodeGraph(
      { query: 'x', depth: 99 },
      { logger, envLookup: k => (k === 'IFLEET_KG_ENABLED' ? '1' : undefined) },
    );
    const meta = logger.mock.calls[0]?.[1] as { depth?: number };
    expect(meta?.depth).toBe(4);
  });
});
