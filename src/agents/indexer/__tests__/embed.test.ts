/**
 * Voyage embedding client tests with a stubbed fetch. Covers:
 *   - batches inputs into chunks of `maxBatch`
 *   - left-pads 1024-dim Voyage output to 1536 for the vector column
 *   - retries on 429 / 5xx and ultimately returns nulls (non-blocking)
 *   - throws EmbeddingProviderUnavailableError when key is missing
 */
import { describe, expect, it, vi } from 'vitest';
import {
  EmbeddingProviderUnavailableError,
  TARGET_VECTOR_DIMS,
  VoyageEmbeddingClient,
  padTo,
} from '../embed.js';

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('padTo', () => {
  it('left-pads short vectors with zeros and preserves the leading values', () => {
    const padded = padTo([1, 2, 3], 5);
    expect(padded).toEqual([1, 2, 3, 0, 0]);
  });
  it('truncates oversized vectors', () => {
    expect(padTo([1, 2, 3, 4, 5], 3)).toEqual([1, 2, 3]);
  });
});

describe('VoyageEmbeddingClient', () => {
  it('throws when api key is missing', () => {
    expect(() => new VoyageEmbeddingClient({ apiKey: '' })).toThrow(
      EmbeddingProviderUnavailableError,
    );
  });

  it('chunks inputs by maxBatch and pads to TARGET_VECTOR_DIMS', async () => {
    const voyageDim1024 = Array.from({ length: 1024 }, (_, i) => i / 1024);
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const items = body.input as string[];
      return jsonResp({
        data: items.map((_v, idx) => ({ index: idx, embedding: voyageDim1024 })),
      });
    });
    const client = new VoyageEmbeddingClient({ apiKey: 'k', maxBatch: 2, fetchImpl });
    const vectors = await client.embedBatch(['a', 'b', 'c']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vectors).toHaveLength(3);
    for (const v of vectors) {
      expect(v).not.toBeNull();
      expect(v?.length).toBe(TARGET_VECTOR_DIMS);
      expect(v?.slice(0, 1024)).toEqual(voyageDim1024);
      expect(v?.slice(1024).every(x => x === 0)).toBe(true);
    }
  });

  it('returns nulls (non-blocking) after exhausting retries on 5xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResp({ error: 'down' }, 503));
    const client = new VoyageEmbeddingClient({ apiKey: 'k', maxBatch: 4, fetchImpl });
    const vectors = await client.embedBatch(['a', 'b']);
    expect(vectors).toEqual([null, null]);
    // 4 retries per chunk (0,1,2,3) — we only made one chunk because both inputs fit.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  }, 10_000);
});
