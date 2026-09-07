import { describe, expect, it } from 'vitest';
import { calculateAmountVnd } from './pricing';

describe('calculateAmountVnd', () => {
  it.each([
    [60, 5000],
    [120, 10000],
    [180, 15000]
  ])('charges %i minutes as %i VND', (minutes, expected) => {
    expect(calculateAmountVnd(minutes)).toBe(expected);
  });

  it('rejects a duration that is not a whole number of hours', () => {
    expect(() => calculateAmountVnd(90)).toThrow(
      'Duration must be a whole number of hours'
    );
  });
});
