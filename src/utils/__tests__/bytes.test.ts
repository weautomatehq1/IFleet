import { describe, it, expect } from 'vitest';
import { formatBytes } from '../bytes.js';

describe('formatBytes', () => {
  it('formats 0 as "0 B"', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats 512 as "512 B"', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('formats 1023 as "1023 B"', () => {
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats 1024 as "1.0 KB"', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
  });

  it('formats 1536 as "1.5 KB"', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('formats 1048575 as "1024.0 KB"', () => {
    expect(formatBytes(1048575)).toBe('1024.0 KB');
  });

  it('formats 1048576 as "1.0 MB"', () => {
    expect(formatBytes(1048576)).toBe('1.0 MB');
  });

  it('formats 1073741823 as "1024.0 MB"', () => {
    expect(formatBytes(1073741823)).toBe('1024.0 MB');
  });

  it('formats 1073741824 as "1.0 GB"', () => {
    expect(formatBytes(1073741824)).toBe('1.0 GB');
  });

  it('formats TB-scale values correctly', () => {
    expect(formatBytes(1099511627776)).toBe('1.0 TB');
  });

  it('throws RangeError for negative input', () => {
    expect(() => formatBytes(-1)).toThrow(RangeError);
  });
});
