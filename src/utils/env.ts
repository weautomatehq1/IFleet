/**
 * Throw with a descriptive message if an env var is absent or empty.
 * Used at startup to fail fast rather than crash later with a cryptic error.
 */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`missing required env var: ${name}`);
  return v;
}

/**
 * Parse a port number from an env var string, throwing on invalid values.
 * `Number()` silently produces NaN for non-numeric inputs; Node's
 * `server.listen(NaN)` assigns an ephemeral random port with no error,
 * causing the process to start on the wrong port. (AUDIT-IFleet-e7a23f9c)
 */
export function parsePort(raw: string | number | undefined, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`invalid port value: ${String(raw)} (must be an integer 1–65535)`);
  }
  return n;
}
