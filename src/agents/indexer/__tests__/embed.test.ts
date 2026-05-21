import { describe, expect, it, vi } from 'vitest';
import {
  EmbeddingProviderUnavailableError,
  TARGET_VECTOR_DIMS,
  TRANSFORMERS_DIMS,
  TransformersEmbeddingClient,
  VoyageEmbeddingClient,
  createEmbeddingClient,
  padTo,
} from '../embed.js';

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeMockPipelineFactory(dim: number, batchSize?: number) {
  return vi.fn().mockResolvedValue(
    vi.fn().mockImplementation(async (inputs: string[]) => {
      const n = batchSize ?? inputs.length;
      const vec = Array.from({ length: dim }, (_, i) => i / dim);
      return {
        data: Array.from({ length: n }, () => vec).flat(),
        dims: [n, dim],
      };
    }),
  );
}

describe('padTo', () => {
  it('right-pads short vectors with zeros', () => {
    expect(padTo([1, 2, 3], 5)).toEqual([1, 2, 3, 0, 0]);
  });
  it('truncates oversized vectors', () => {
    expect(padTo([1, 2, 3, 4, 5], 3)).toEqual([1, 2, 3]);
  });
});

describe('VoyageEmbeddingClient', () => {
  it('throws when api key is missing', () => {
    expect(() => new VoyageEmbeddingClient({ apiKey: '' })).toThrow(EmbeddingProviderUnavailableError);
  });

  it('chunks inputs by maxBatch and pads to TARGET_VECTOR_DIMS', async () => {
    const voyageDim1024 = Array.from({ length: 1024 }, (_, i) => i / 1024);
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return jsonResp({ data: (body.input as string[]).map((_: string, idx: number) => ({ index: idx, embedding: voyageDim1024 })) });
    });
    const client = new VoyageEmbeddingClient({ apiKey: 'k', maxBatch: 2, fetchImpl });
    const vectors = await client.embedBatch(['a', 'b', 'c']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vectors).toHaveLength(3);
    for (const v of vectors) {
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
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  }, 10_000);
});

describe('TransformersEmbeddingClient', () => {
  it('pads 768-dim vectors to TARGET_VECTOR_DIMS', async () => {
    const factory = makeMockPipelineFactory(TRANSFORMERS_DIMS);
    const client = new TransformersEmbeddingClient({ pipelineFactory: factory });
    const vectors = await client.embedBatch(['hello', 'world']);
    expect(vectors).toHaveLength(2);
    for (const v of vectors) {
      expect(v?.length).toBe(TARGET_VECTOR_DIMS);
      expect(v?.slice(TRANSFORMERS_DIMS).every(x => x === 0)).toBe(true);
    }
  });

  it('reuses the same pipeline across calls (loaded once)', async () => {
    const factory = makeMockPipelineFactory(TRANSFORMERS_DIMS);
    const client = new TransformersEmbeddingClient({ pipelineFactory: factory });
    await client.embedBatch(['a']);
    await client.embedBatch(['b']);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('returns nulls when pipeline throws', async () => {
    const factory = vi.fn().mockResolvedValue(vi.fn().mockRejectedValue(new Error('ONNX error')));
    const client = new TransformersEmbeddingClient({ pipelineFactory: factory });
    expect(await client.embedBatch(['x', 'y'])).toEqual([null, null]);
  });

  it('chunks inputs by maxBatch', async () => {
    const pipelineFn = vi.fn().mockImplementation(async (inputs: string[]) => ({
      data: Array.from({ length: inputs.length * TRANSFORMERS_DIMS }, (_, i) => i),
      dims: [inputs.length, TRANSFORMERS_DIMS],
    }));
    const factory = vi.fn().mockResolvedValue(pipelineFn);
    const client = new TransformersEmbeddingClient({ pipelineFactory: factory, maxBatch: 2 });
    await client.embedBatch(['a', 'b', 'c']);
    expect(pipelineFn).toHaveBeenCalledTimes(2);
  });
});

describe('createEmbeddingClient', () => {
  it('returns VoyageEmbeddingClient when VOYAGE_API_KEY is set', () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    const client = createEmbeddingClient();
    delete process.env.VOYAGE_API_KEY;
    expect(client).toBeInstanceOf(VoyageEmbeddingClient);
  });

  it('returns TransformersEmbeddingClient when VOYAGE_API_KEY is absent', () => {
    delete process.env.VOYAGE_API_KEY;
    const client = createEmbeddingClient();
    expect(client).toBeInstanceOf(TransformersEmbeddingClient);
  });
});
