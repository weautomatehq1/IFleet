import { describe, it, expect } from 'vitest';
import { formatBytes } from '../bytes';

describe('formatBytes', () => {
  it('formats 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats 512 bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('formats 1024 bytes', () => {
    expect(formatBytes(1024)).toBe('1.0 KiB');
  });

  it('formats 1536 bytes', () => {
    expect(formatBytes(1536)).toBe('1.5 KiB');
  });

  it('formats 1048576 bytes', () => {
    expect(formatBytes(1048576)).toBe('1.0 MiB');
  });

  it('formats 1073741824 bytes', () => {
    expect(formatBytes(1073741824)).toBe('1.0 GiB');
  });

  it('throws RangeError for negative input', () => {
    expect(() => formatBytes(-1)).toThrow(RangeError);
  });
});
