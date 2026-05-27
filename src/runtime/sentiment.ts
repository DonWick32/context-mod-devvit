import { SentimentIntensityAnalyzer } from 'vader-sentiment';
import type { ActivitySnapshot } from './activityAdapter';
import { valueMatchesNumberComparison } from './comparison';

export type SentimentComparison = {
  displayText: string;
  matches(score: number): boolean | undefined;
};

export type ActivitySentimentResult = {
  score: number;
  sentiment: string;
  passed: boolean;
  comparison: SentimentComparison;
};

type SentimentTestPart = 'title' | 'body';

const sentimentQuantifier: Record<string, number> = {
  'extremely negative': -0.6,
  'very negative': -0.3,
  negative: -0.1,
  positive: 0.1,
  'very positive': 0.3,
  'extremely positive': 0.6,
};

const sentimentRanges = [
  { label: 'extremely negative', max: -0.6 },
  { label: 'very negative', max: -0.3 },
  { label: 'negative', max: -0.1 },
  { label: 'neutral', max: 0.1 },
  { label: 'positive', max: 0.3 },
  { label: 'very positive', max: 0.6 },
  { label: 'extremely positive', max: Number.POSITIVE_INFINITY },
];

const textComparisonPattern =
  /^(?:is\s+)?(?<not>not\s+)?(?<modifier>very\s+|extremely\s+)?(?<sentiment>positive|neutral|negative)$/i;

const getSentimentLabel = (score: number): string =>
  sentimentRanges.find((range) => score < range.max)?.label ??
  'extremely positive';

const normalizeTestParts = (value: unknown): SentimentTestPart[] => {
  if (!Array.isArray(value)) {
    return ['title', 'body'];
  }

  const parts = value.filter(
    (entry): entry is SentimentTestPart =>
      entry === 'title' || entry === 'body'
  );
  return parts.length === 0 ? ['title', 'body'] : [...new Set(parts)];
};

export const getSentimentActivityText = (
  activity: ActivitySnapshot,
  testOn: unknown
): string => {
  if (activity.kind === 'comment') {
    return activity.body;
  }

  return normalizeTestParts(testOn)
    .flatMap((part) => {
      switch (part) {
        case 'title':
          return activity.title ?? [];
        case 'body':
          return activity.body;
      }
    })
    .filter((value) => value.length > 0)
    .join('\n');
};

export const parseSentimentComparison = (
  value: unknown
): SentimentComparison | undefined => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  const trimmed = value.trim();
  const numericProbe = valueMatchesNumberComparison(trimmed, 0);
  if (numericProbe !== undefined) {
    return {
      displayText: trimmed,
      matches: (score: number) => valueMatchesNumberComparison(trimmed, score),
    };
  }

  const textMatch = trimmed.match(textComparisonPattern);
  const groups = textMatch?.groups as
    | {
        not?: string;
        modifier?: string;
        sentiment?: string;
      }
    | undefined;
  if (groups?.sentiment === undefined) {
    return undefined;
  }

  const negated = groups.not !== undefined && groups.not.trim().length > 0;
  const sentiment = groups.sentiment.toLowerCase();
  if (sentiment === 'neutral') {
    return {
      displayText: negated
        ? 'not neutral (outside -0.1 to 0.1)'
        : 'neutral (-0.1 to 0.1)',
      matches: (score: number) =>
        negated ? score < -0.1 || score > 0.1 : score >= -0.1 && score <= 0.1,
    };
  }

  const phrase = `${groups.modifier ?? ''}${sentiment}`
    .trim()
    .toLowerCase();
  const threshold = sentimentQuantifier[phrase];
  if (threshold === undefined) {
    return undefined;
  }

  const operator = negated ? (threshold > 0 ? '<' : '>') : threshold > 0 ? '>=' : '<=';
  return {
    displayText: `${negated ? 'not ' : ''}${phrase} (${operator} ${threshold})`,
    matches: (score: number) =>
      valueMatchesNumberComparison(`${operator} ${threshold}`, score),
  };
};

/**
 * Heuristic language check: VADER only works on English text.
 * Returns true if at least 70% of alphabetic characters are Latin (A-Z/a-z).
 * Very short texts (< 3 alphabetic chars) are assumed English to avoid false
 * negatives on short profanity or emoji-heavy posts.
 */
export const isLikelyEnglish = (text: string): boolean => {
  let latinCount = 0;
  let totalAlpha = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    // Basic Latin letters
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      latinCount++;
      totalAlpha++;
    } else if (
      // Extended Latin, Cyrillic, CJK, Arabic, Devanagari, etc.
      (code >= 0xc0 && code <= 0x24f) || // Latin Extended
      (code >= 0x400 && code <= 0x4ff) || // Cyrillic
      (code >= 0x4e00 && code <= 0x9fff) || // CJK
      (code >= 0x0600 && code <= 0x06ff) || // Arabic
      (code >= 0x0900 && code <= 0x097f) || // Devanagari
      (code >= 0xac00 && code <= 0xd7af) || // Korean
      (code >= 0x3040 && code <= 0x309f) || // Hiragana
      (code >= 0x30a0 && code <= 0x30ff)    // Katakana
    ) {
      totalAlpha++;
    }
  }
  if (totalAlpha < 3) return true;
  return latinCount / totalAlpha >= 0.7;
};

export const analyzeActivitySentiment = (
  activity: ActivitySnapshot,
  comparison: SentimentComparison,
  testOn?: unknown
): ActivitySentimentResult => {
  const text = getSentimentActivityText(activity, testOn);

  if (!isLikelyEnglish(text)) {
    return {
      score: 0,
      sentiment: 'unsupported',
      passed: false,
      comparison,
    };
  }

  const score = SentimentIntensityAnalyzer.polarity_scores(text).compound;
  const passed = comparison.matches(score);

  return {
    score,
    sentiment: getSentimentLabel(score),
    passed: passed === true,
    comparison,
  };
};
