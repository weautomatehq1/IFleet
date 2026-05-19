import { randomBytes } from 'node:crypto';

// Crockford's Base32 alphabet (no I, L, O, U).
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastTime = -1;
let lastRand: number[] = new Array<number>(RAND_LEN).fill(0);

function encodeTime(now: number): string {
  let out = '';
  let n = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = n % 32;
    out = ENC[mod] + out;
    n = (n - mod) / 32;
  }
  return out;
}

function encodeRand(buf: Buffer): string {
  let out = '';
  for (let i = 0; i < RAND_LEN; i++) out += ENC[buf[i]! & 0x1f];
  return out;
}

/**
 * Monotonic ULID. 26 chars, lexicographically sortable by time.
 * Within the same millisecond the random suffix is incremented so successive
 * ULIDs are still ordered.
 */
export function ulid(now: number = Date.now()): string {
  const time = encodeTime(now);
  if (now === lastTime) {
    // increment the last random suffix in place (big-endian)
    for (let i = RAND_LEN - 1; i >= 0; i--) {
      if (lastRand[i]! < 31) {
        lastRand[i]!++;
        break;
      }
      lastRand[i] = 0;
    }
    return time + lastRand.map((b) => ENC[b]).join('');
  }
  const buf = randomBytes(RAND_LEN);
  lastTime = now;
  lastRand = Array.from(buf, (b) => b & 0x1f);
  return time + encodeRand(buf);
}
