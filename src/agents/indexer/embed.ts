/**
 * Embedding provider — Voyage AI `voyage-code-3` (decided per ADR-0003).
 *
 * Decision rationale (documented in PR):
 *   - Voyage code-3 outperforms text-embedding-3-small on code retrieval benchmarks
 *     by 10-15% in MTEB-code (Voyage Aug 2025 release notes).
 *   - 1024 dims vs OpenAI's 1536 — fits in our vector(1536) column with left-pad zeros.
 *   - $0.12 / 1M tokens vs OpenAI $0.02 — at ~50k nodes × ~50 tokens avg = $0.30 per
 *     full re-index. Affordable; we re-index incrementally anyway.
 *   - HTTP REST, no SDK dep (keeps node_modules thin).
 *
 * Failure modes:
 *   - Rate limit (429) → exponential backoff with jitter, max 4 retries.
 *   - Provider outage (5xx / network) → return per-input nulls so caller can
 *     mark those nodes as "needs re-embedding" without aborting the indexer.
 *   - Missing API key → throw EmbeddingProviderUnavailableError; caller logs
 *     and continues in symbolic-only mode (architect fallback already exists).
 */

export const VOYAGE_MODEL = 'voyage-code-3';
export const VOYAGE_DIMS = 1024;
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
   * Embed a batch of strings. Returns the array of vectors in input order.
   * Index entries may be `null` if the provider returned an item-level error;
   * callers should record those for retry later and not block on them.
   */
  embedBatch(inputs: ReadonlyArray<string>): Promise<Array<number[] | null>>;
}

export interface VoyageClientOptions {
  apiKey?: string;
  /** Cap on per-request batch size — Voyage allows up to 128 inputs per call. */
  maxBatch?: number;
  /** Override for tests. */
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
      const slice = inputs.slice(i, i + this.maxBatch);
      const chunk = await this.embedChunkWithBackoff(slice);
      out.push(...chunk);
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
        const delay = backoffMs(attempt);
        await sleep(delay);
        attempt += 1;
      }
    }
    // After retries: return nulls for the whole chunk so the indexer can log + continue.
    void lastErr;
    return slice.map(() => null);
  }

  private async embedChunkOnce(slice: ReadonlyArray<string>): Promise<Array<number[] | null>> {
    const resp = await this.fetchImpl(VOYAGE_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: slice,
        model: VOYAGE_MODEL,
        input_type: 'document',
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new HttpError(resp.status, `Voyage ${resp.status}: ${text.slice(0, 200)}`);
    }
    const body = (await resp.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    const data = body.data ?? [];
    const ordered = new Array<number[] | null>(slice.length).fill(null);
    for (const item of data) {
      if (typeof item.index === 'number' && Array.isArray(item.embedding)) {
        ordered[item.index] = padTo(item.embedding, TARGET_VECTOR_DIMS);
      }
    }
    return ordered;
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) {
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  }
  // Network / DNS / TLS errors — retry.
  return true;
}

function backoffMs(attempt: number): number {
  const base = 250 * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 100);
  return base + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Voyage code-3 returns 1024-dim vectors. The Postgres column is vector(1536)
 * to accommodate either provider. We left-pad with zeros so cosine similarity
 * remains valid (zeros do not contribute to dot product) and a future migration
 * to native 1024-dim is a single ALTER.
 */
export function padTo(vec: number[], target: number): number[] {
  if (vec.length === target) return vec;
  if (vec.length > target) return vec.slice(0, target);
  const out = new Array<number>(target).fill(0);
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] ?? 0;
  return out;
}
