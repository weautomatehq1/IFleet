/**
 * Formats a byte count into a human-readable string using binary units (1024).
 * @param bytes - The number of bytes to format
 * @returns A formatted string with appropriate unit (B, KB, MB, GB, TB)
 * @throws {RangeError} If bytes is negative
 */
export function formatBytes(bytes: number): string {
  if (bytes < 0) {
    throw new RangeError('bytes must be non-negative');
  }

  if (bytes === 0) {
    return '0 B';
  }

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );

  if (unitIndex === 0) {
    return `${bytes} B`;
  }

  const size = bytes / Math.pow(1024, unitIndex);
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}
