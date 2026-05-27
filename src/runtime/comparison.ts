export type ComparisonOperator = '<' | '<=' | '>' | '>=' | '=' | '==';

export type NumberComparison = {
  operator: ComparisonOperator;
  value: number;
};

export type DurationComparison = {
  operator: ComparisonOperator;
  milliseconds: number;
};

type NumericComparison = {
  operator: ComparisonOperator;
  value: number;
};

const NUMBER_COMPARISON_PATTERN =
  /^(<=|>=|<|>|={1,2})?\s*(-?\d+(?:\.\d+)?)$/;

const DURATION_COMPARISON_PATTERN =
  /^(<=|>=|<|>|={1,2})?\s*(\d+(?:\.\d+)?)\s*([a-z]+)$/i;

const durationUnitMilliseconds: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  second: 1000,
  seconds: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  months: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
  years: 365 * 24 * 60 * 60 * 1000,
};

const compareNumber = (
  actual: number,
  comparison: NumericComparison
): boolean => {
  switch (comparison.operator) {
    case '<':
      return actual < comparison.value;
    case '<=':
      return actual <= comparison.value;
    case '>':
      return actual > comparison.value;
    case '>=':
      return actual >= comparison.value;
    case '=':
    case '==':
      return actual === comparison.value;
  }
};

export const parseNumberComparison = (
  value: unknown,
  defaultOperator: ComparisonOperator = '=='
): NumberComparison | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { operator: defaultOperator, value };
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const match = value.trim().match(NUMBER_COMPARISON_PATTERN);
  if (!match) {
    return undefined;
  }

  const expectedValue = Number(match[2]);
  if (!Number.isFinite(expectedValue)) {
    return undefined;
  }

  return {
    operator: (match[1] ?? defaultOperator) as ComparisonOperator,
    value: expectedValue,
  };
};

export const valueMatchesNumberComparison = (
  expected: unknown,
  actual: number,
  defaultOperator: ComparisonOperator = '=='
): boolean | undefined => {
  const values = Array.isArray(expected) ? expected : [expected];
  let supportedValues = 0;

  for (const value of values) {
    const comparison = parseNumberComparison(value, defaultOperator);
    if (comparison === undefined) {
      continue;
    }

    supportedValues++;
    if (compareNumber(actual, comparison)) {
      return true;
    }
  }

  return supportedValues === 0 ? undefined : false;
};

export const parseDurationComparison = (
  value: unknown,
  defaultOperator: ComparisonOperator = '=='
): DurationComparison | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const match = value.trim().match(DURATION_COMPARISON_PATTERN);
  if (!match) {
    return undefined;
  }

  const amount = Number(match[2]);
  const unit = match[3]?.toLowerCase();
  const multiplier = unit === undefined ? undefined : durationUnitMilliseconds[unit];
  if (!Number.isFinite(amount) || multiplier === undefined) {
    return undefined;
  }

  return {
    operator: (match[1] ?? defaultOperator) as ComparisonOperator,
    milliseconds: amount * multiplier,
  };
};

export const valueMatchesDurationComparison = (
  expected: unknown,
  actualMilliseconds: number,
  defaultOperator: ComparisonOperator = '=='
): boolean | undefined => {
  const values = Array.isArray(expected) ? expected : [expected];
  let supportedValues = 0;

  for (const value of values) {
    const comparison = parseDurationComparison(value, defaultOperator);
    if (comparison === undefined) {
      continue;
    }

    supportedValues++;
    if (
      compareNumber(actualMilliseconds, {
        operator: comparison.operator,
        value: comparison.milliseconds,
      })
    ) {
      return true;
    }
  }

  return supportedValues === 0 ? undefined : false;
};
