const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number): string {
  if (bytes < 0) {
    throw new RangeError('bytes must be non-negative');
  }
  if (bytes === 0) {
    return '0 B';
  }

  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  if (unitIndex === 0) {
    return `${value} B`;
  }
  return `${value.toFixed(1)} ${UNITS[unitIndex]}`;
}
