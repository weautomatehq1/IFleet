/**
 * Throw with a descriptive message if an env var is absent or empty.
 * Used at startup to fail fast rather than crash later with a cryptic error.
 */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`missing required env var: ${name}`);
  return v;
}
