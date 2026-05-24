/**
 * Embedding providers for the knowledge graph (ADR-0003).
 *
 * Provider priority (auto-selected by createEmbeddingClient):
 *   1. Voyage AI `voyage-code-3`        — when VOYAGE_API_KEY is set
 *   2. Transformers.js (in-process)     — local, free, no key or server required
 *
 * Failure modes:
 *   - 5xx / network (Voyage) → return per-input nulls; indexer marks nodes for retry.
 *   - Voyage 429             → exponential backoff with jitter, max 4 retries.
 *   - Transformers.js error  → return per-input nulls; graceful degradation.
 */

export const VOYAGE_MODEL = 'voyage-code-3';
export const VOYAGE_DIMS = 1024;
export const TRANSFORMERS_MODEL = 'Xenova/jina-embeddings-v2-base-code';
export const TRANSFORMERS_DIMS = 768;
export const TARGET_VECTOR_DIMS = 1536;

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';

export class EmbeddingProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingProviderUnavailableError';
  }
}

export interface EmbeddingClient {
  /**
   * Embed a batch of strings. Returns vectors in input order.
   * Null entries mean the provider failed for that item — callers should
   * record them for retry and not abort the indexer.
   */
  embedBatch(inputs: ReadonlyArray<string>): Promise<Array<number[] | null>>;
}

// ---------------------------------------------------------------------------
// Voyage AI
// ---------------------------------------------------------------------------

export interface VoyageClientOptions {
  apiKey?: string;
  /** Cap on per-request batch size — Voyage allows up to 128 inputs per call. */
  maxBatch?: number;
  fetchImpl?: typeof fetch;
}

export class VoyageEmbeddingClient implements EmbeddingClient {
  private readonly apiKey: string;
  private readonly maxBatch: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: VoyageClientOptions = {}) {
    const key = opts.apiKey ?? process.env.VOYAGE_API_KEY;
    if (!key) {
      throw new EmbeddingProviderUnavailableError(
        'VOYAGE_API_KEY is not set. See .env.example. M3 indexer can still run in ' +
          'symbolic-only mode; embeddings are added when the key is present.',
      );
    }
    this.apiKey = key;
    this.maxBatch = opts.maxBatch ?? 64;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embedBatch(inputs: ReadonlyArray<string>): Promise<Array<number[] | null>> {
    const out: Array<number[] | null> = [];
    for (let i = 0; i < inputs.length; i += this.maxBatch) {
      out.push(...(await this.embedChunkWithBackoff(inputs.slice(i, i + this.maxBatch))));
    }
    return out;
  }

  private async embedChunkWithBackoff(slice: ReadonlyArray<string>): Promise<Array<number[] | null>> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt < 4) {
      try {
        return await this.embedChunkOnce(slice);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) break;
        await sleep(backoffMs(attempt));
        attempt += 1;
      }
    }
    console.warn('[embed] Voyage embedChunk failed after all retries:', lastErr);
    return slice.map(() => null);
  }

  private async embedChunkOnce(slice: ReadonlyArray<string>): Promise<Array<number[] | null>> {
    const resp = await this.fetchImpl(VOYAGE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ input: slice, model: VOYAGE_MODEL, input_type: 'document' }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new HttpError(resp.status, `Voyage ${resp.status}: ${text.slice(0, 200)}`);
    }
    const body = (await resp.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const ordered = new Array<number[] | null>(slice.length).fill(null);
    for (const item of body.data ?? []) {
      if (typeof item.index === 'number' && Array.isArray(item.embedding)) {
        ordered[item.index] = padTo(item.embedding, TARGET_VECTOR_DIMS);
      }
    }
    return ordered;
  }
}

// ---------------------------------------------------------------------------
// Transformers.js (local, in-process ONNX)
// ---------------------------------------------------------------------------

/** Shape of the tensor returned by @xenova/transformers feature-extraction pipeline. */
interface EmbeddingTensor {
  data: ArrayLike<number>;
  dims: number[];
}

/** Minimal pipeline callable — matches @xenova/transformers signature, injectable for tests. */
type PipelineFn = (inputs: string[], opts: { pooling: string; normalize: boolean }) => Promise<EmbeddingTensor>;
type PipelineFactory = (task: string, model: string, opts?: Record<string, unknown>) => Promise<PipelineFn>;

export interface TransformersClientOptions {
  model?: string;
  maxBatch?: number;
  /** Injectable pipeline factory — use in tests to avoid loading ONNX models. */
  pipelineFactory?: PipelineFactory;
}

export class TransformersEmbeddingClient implements EmbeddingClient {
  private readonly model: string;
  private readonly maxBatch: number;
  private readonly pipelineFactory: PipelineFactory;
  private pipelinePromise: Promise<PipelineFn> | null = null;

  constructor(opts: TransformersClientOptions = {}) {
    this.model = opts.model ?? process.env.TRANSFORMERS_EMBED_MODEL ?? TRANSFORMERS_MODEL;
    this.maxBatch = opts.maxBatch ?? 32;
    this.pipelineFactory = opts.pipelineFactory ?? defaultPipelineFactory;
  }

  private getPipeline(): Promise<PipelineFn> {
    this.pipelinePromise ??= this.pipelineFactory('feature-extraction', this.model, { quantized: true });
    return this.pipelinePromise;
  }

  async embedBatch(inputs: ReadonlyArray<string>): Promise<Array<number[] | null>> {
    const extractor = await this.getPipeline();
    const out: Array<number[] | null> = [];
    for (let i = 0; i < inputs.length; i += this.maxBatch) {
      out.push(...(await this.embedChunk(extractor, inputs.slice(i, i + this.maxBatch))));
    }
    return out;
  }

  private async embedChunk(extractor: PipelineFn, slice: ReadonlyArray<string>): Promise<Array<number[] | null>> {
    try {
      const tensor = await extractor(Array.from(slice), { pooling: 'mean', normalize: true });
      const batchSize = tensor.dims[0] ?? 0;
      const hiddenSize = tensor.dims[1] ?? 0;
      const flat = Array.from(tensor.data) as number[];
      return Array.from<unknown, number[] | null>({ length: batchSize }, (_, i) =>
        padTo(flat.slice(i * hiddenSize, (i + 1) * hiddenSize), TARGET_VECTOR_DIMS),
      );
    } catch {
      return slice.map(() => null);
    }
  }
}

async function defaultPipelineFactory(task: string, model: string, opts?: Record<string, unknown>): Promise<PipelineFn> {
  const { pipeline } = await import('@xenova/transformers');
  // Cast task — library's PipelineType is a narrow union; 'feature-extraction' is valid at runtime.
  return pipeline(task as 'feature-extraction', model, opts) as unknown as Promise<PipelineFn>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Auto-selects Voyage (if VOYAGE_API_KEY set) or Transformers.js (local fallback). */
export function createEmbeddingClient(opts?: { fetchImpl?: typeof fetch; pipelineFactory?: PipelineFactory }): EmbeddingClient {
  if (process.env.VOYAGE_API_KEY) {
    return new VoyageEmbeddingClient({ fetchImpl: opts?.fetchImpl });
  }
  return new TransformersEmbeddingClient({ pipelineFactory: opts?.pipelineFactory });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || (err.status >= 500 && err.status < 600);
  return true;
}

function backoffMs(attempt: number): number {
  return 250 * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Pads or truncates a vector to `target` dims.
 * Both Voyage (1024) and Transformers.js (768) need padding to fit vector(1536).
 * Zero-padding preserves cosine similarity since zeros don't contribute to dot product.
 */
export function padTo(vec: number[], target: number): number[] {
  if (vec.length === target) return vec;
  if (vec.length > target) return vec.slice(0, target);
  const out = new Array<number>(target).fill(0);
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] ?? 0;
  return out;
}
