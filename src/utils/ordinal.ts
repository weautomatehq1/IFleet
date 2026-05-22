export function ordinal(n: number): string {
  if (!Number.isInteger(n) || n <= 0) {
    throw new RangeError(`ordinal: expected a positive integer, got ${n}`);
  }
  const mod100 = n % 100;
  const mod10 = n % 10;
  let suffix: string;
  if (mod100 === 11 || mod100 === 12 || mod100 === 13) {
    suffix = 'th';
  } else if (mod10 === 1) {
    suffix = 'st';
  } else if (mod10 === 2) {
    suffix = 'nd';
  } else if (mod10 === 3) {
    suffix = 'rd';
  } else {
    suffix = 'th';
  }
  return `${n}${suffix}`;
}
