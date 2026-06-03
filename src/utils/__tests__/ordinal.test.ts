import { describe, it, expect } from 'vitest';
import { ordinal } from '../ordinal';

describe('ordinal', () => {
  describe('basic cases 1–4', () => {
    it.each([
      [1, '1st'],
      [2, '2nd'],
      [3, '3rd'],
      [4, '4th'],
    ])('ordinal(%i) === %s', (n, expected) => {
      expect(ordinal(n)).toBe(expected);
    });
  });

  describe('teen special cases', () => {
    it.each([
      [11, '11th'],
      [12, '12th'],
      [13, '13th'],
    ])('ordinal(%i) === %s', (n, expected) => {
      expect(ordinal(n)).toBe(expected);
    });
  });

  describe('twenties', () => {
    it.each([
      [21, '21st'],
      [22, '22nd'],
      [23, '23rd'],
    ])('ordinal(%i) === %s', (n, expected) => {
      expect(ordinal(n)).toBe(expected);
    });
  });

  describe('hundreds', () => {
    it.each([
      [101, '101st'],
      [102, '102nd'],
      [103, '103rd'],
    ])('ordinal(%i) === %s', (n, expected) => {
      expect(ordinal(n)).toBe(expected);
    });
  });

  describe('invalid inputs', () => {
    it.each([
      [-1],
      [-100],
      [0],
      [1.5],
      [2.9],
      [NaN],
      [Infinity],
      [-Infinity],
    ])('throws RangeError for %s', (n) => {
      expect(() => ordinal(n)).toThrow(RangeError);
    });

    it('throws RangeError for non-number types coerced', () => {
      // @ts-expect-error testing runtime guard
      expect(() => ordinal('1')).toThrow(RangeError);
    });
  });
});
