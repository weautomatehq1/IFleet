import { describe, it, expect } from 'vitest';
import { clamp } from '../clamp.js';

describe('clamp', () => {
  describe('constrain', () => {
    it('returns min when value is below range', () => {
      expect(clamp(1, 5, 10)).toBe(5);
    });

    it('returns max when value is above range', () => {
      expect(clamp(15, 5, 10)).toBe(10);
    });

    it('returns value when in range', () => {
      expect(clamp(7, 5, 10)).toBe(7);
    });
  });

  describe('boundaries', () => {
    it('returns min when value equals min', () => {
      expect(clamp(5, 5, 10)).toBe(5);
    });

    it('returns max when value equals max', () => {
      expect(clamp(10, 5, 10)).toBe(10);
    });

    it('returns min when min equals max and value is out of range', () => {
      expect(clamp(7, 5, 5)).toBe(5);
    });

    it('handles negative numbers', () => {
      expect(clamp(-8, -10, -5)).toBe(-8);
      expect(clamp(-12, -10, -5)).toBe(-10);
      expect(clamp(-3, -10, -5)).toBe(-5);
    });
  });

  describe('errors', () => {
    it('throws RangeError when min > max', () => {
      expect(() => clamp(5, 10, 5)).toThrow(RangeError);
      expect(() => clamp(5, 10, 5)).toThrow('min must be less than or equal to max');
    });
  });
});
