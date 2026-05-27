import { describe, expect, it } from 'vitest';
import {
  parseDurationComparison,
  parseNumberComparison,
  valueMatchesDurationComparison,
  valueMatchesNumberComparison,
} from '../src/runtime/comparison';

describe('comparison parsing', () => {
  it('parses numeric comparisons with explicit and default operators', () => {
    expect(parseNumberComparison('>= 3')).toEqual({
      operator: '>=',
      value: 3,
    });
    expect(parseNumberComparison(4)).toEqual({
      operator: '==',
      value: 4,
    });
    expect(parseNumberComparison('not a comparison')).toBeUndefined();
  });

  it('matches numeric comparisons and arrays of candidate comparisons', () => {
    expect(valueMatchesNumberComparison('> 10', 12)).toBe(true);
    expect(valueMatchesNumberComparison('<= 1', 3)).toBe(false);
    expect(valueMatchesNumberComparison(['< 2', '>= 10'], 12)).toBe(true);
    expect(valueMatchesNumberComparison('> 2 user', 3)).toBeUndefined();
  });

  it('parses duration comparisons into milliseconds', () => {
    expect(parseDurationComparison('> 2 days')).toEqual({
      operator: '>',
      milliseconds: 2 * 24 * 60 * 60 * 1000,
    });
    expect(parseDurationComparison('<= 90 minutes')).toEqual({
      operator: '<=',
      milliseconds: 90 * 60 * 1000,
    });
    expect(parseDurationComparison('within 2 days')).toBeUndefined();
  });

  it('matches duration comparisons', () => {
    const threeDays = 3 * 24 * 60 * 60 * 1000;

    expect(valueMatchesDurationComparison('> 2 days', threeDays)).toBe(true);
    expect(valueMatchesDurationComparison('< 2 days', threeDays)).toBe(false);
    expect(
      valueMatchesDurationComparison(['< 1 hours', '>= 3 days'], threeDays)
    ).toBe(true);
  });
});
