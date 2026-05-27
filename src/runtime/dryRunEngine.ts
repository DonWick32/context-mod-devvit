import type {
  NormalizedAction,
  NormalizedCheck,
  NormalizedConfig,
  NormalizedRule,
  NormalizedRun,
  UnknownRecord,
} from '../config/legacyTypes';
import type { T1, T3 } from '@devvit/shared-types/tid.js';
import type { ActivitySnapshot } from './activityAdapter';
import {
  parseDurationComparison,
  parseNumberComparison,
  valueMatchesDurationComparison,
  valueMatchesNumberComparison,
} from './comparison';
import { evaluateModNoteCriteria } from './modNoteCriteria';
import {
  analyzeActivitySentiment,
  parseSentimentComparison,
} from './sentiment';
import { evaluateToolboxUserNoteCriteria } from './toolboxUserNotes';
import { compareImages } from './imageComparison';

export type RuleEvaluation = {
  name: string;
  triggered: boolean;
  supported: boolean;
  reason: string;
  templateData?: RuleTemplateData;
};

export type RuleTemplateData = Record<
  string,
  string | number | boolean | undefined
>;

export type ActionTemplateContext = {
  rules: Record<string, RuleTemplateData>;
};

export type PlannedAction = {
  kind: string;
  name?: string;
  enabled: boolean;
  dryRun: true;
  supported?: boolean;
  reason: string;
  config?: UnknownRecord;
  templateContext?: ActionTemplateContext;
};

export type CheckEvaluation = {
  name: string;
  kind: 'submission' | 'comment';
  triggered: boolean;
  supported: boolean;
  skipped: boolean;
  reason: string;
  postBehavior?: string;
  rules: RuleEvaluation[];
  plannedActions: PlannedAction[];
};

export type DryRunResult = {
  activityId: string;
  checksEvaluated: number;
  checksTriggered: number;
  plannedActions: PlannedAction[];
  checkResults: CheckEvaluation[];
};

export type DryRunOptions = {
  startAt?: string;
  botUsername?: string;
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Module-scoped bot username for self-moderator-name matching.
 * Set by `runDryConfig` from `DryRunOptions.botUsername` before evaluation
 * and cleared after. This avoids threading the parameter through 8+
 * intermediate function signatures.
 */
let currentBotUsername: string | undefined;

const normalizeName = (value: string | undefined, fallback: string) =>
  value && value.trim().length > 0 ? value : fallback;

const parseRegex = (value: unknown): RegExp | undefined => {
  if (value instanceof RegExp) {
    return value;
  }
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }

  const match = value.match(/^\/(.+)\/([a-z]*)$/i);
  try {
    if (match) {
      const pattern = match[1];
      if (pattern === undefined) {
        return undefined;
      }
      return new RegExp(pattern, match[2] ?? '');
    }

    return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  } catch {
    return undefined;
  }
};

const compareNumeric = (
  actual: number,
  operator: '<' | '<=' | '>' | '>=' | '=' | '==',
  expected: number
): boolean => {
  switch (operator) {
    case '<':
      return actual < expected;
    case '<=':
      return actual <= expected;
    case '>':
      return actual > expected;
    case '>=':
      return actual >= expected;
    case '=':
    case '==':
      return actual === expected;
  }
};

const PERCENT_COMPARISON_PATTERN =
  /^(<=|>=|<|>|={1,2})?\s*(-?\d+(?:\.\d+)?)\s*%\s*(.*)$/i;

const valueMatchesCountOrPercentComparison = (
  expected: unknown,
  count: number,
  denominator: number,
  defaultOperator: '<' | '<=' | '>' | '>=' | '=' | '==' = '>='
): boolean | undefined => {
  const values = Array.isArray(expected) ? expected : [expected];
  let supportedValues = 0;

  for (const value of values) {
    if (typeof value === 'string') {
      const percentMatch = value.trim().match(PERCENT_COMPARISON_PATTERN);
      if (percentMatch) {
        const threshold = Number(percentMatch[2]);
        const operator = (percentMatch[1] ?? defaultOperator) as
          | '<'
          | '<='
          | '>'
          | '>='
          | '='
          | '==';
        if (Number.isFinite(threshold)) {
          supportedValues++;
          const percent = denominator <= 0 ? 0 : (count / denominator) * 100;
          if (compareNumeric(percent, operator, threshold)) {
            return true;
          }
        }
        continue;
      }
    }

    const comparison = parseNumberComparison(value, defaultOperator);
    if (comparison === undefined) {
      continue;
    }

    supportedValues++;
    if (compareNumeric(count, comparison.operator, comparison.value)) {
      return true;
    }
  }

  return supportedValues === 0 ? undefined : false;
};

const valueMatchesRatioComparison = (
  expected: unknown,
  numerator: number,
  denominator: number,
  defaultOperator: '<' | '<=' | '>' | '>=' | '=' | '==' = '>='
): boolean | undefined => {
  const values = Array.isArray(expected) ? expected : [expected];
  let supportedValues = 0;
  const ratio = denominator <= 0 ? undefined : numerator / denominator;

  for (const value of values) {
    if (typeof value === 'string') {
      const percentMatch = value.trim().match(PERCENT_COMPARISON_PATTERN);
      if (percentMatch) {
        const threshold = Number(percentMatch[2]);
        const operator = (percentMatch[1] ?? defaultOperator) as
          | '<'
          | '<='
          | '>'
          | '>='
          | '='
          | '==';
        if (Number.isFinite(threshold)) {
          supportedValues++;
          if (
            ratio !== undefined &&
            compareNumeric(ratio, operator, threshold / 100)
          ) {
            return true;
          }
        }
        continue;
      }
    }

    const comparison = parseNumberComparison(value, defaultOperator);
    if (comparison === undefined) {
      continue;
    }

    supportedValues++;
    if (ratio !== undefined && compareNumeric(ratio, comparison.operator, comparison.value)) {
      return true;
    }
  }

  return supportedValues === 0 ? undefined : false;
};

const hasHistoryOnlyRegexOptions = (criterion: UnknownRecord): boolean =>
  criterion.window !== undefined || criterion.lookAt !== undefined;

const getUnsupportedRegexContentReason = (
  value: unknown
): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmedValue = value.trim();
  if (trimmedValue.startsWith('url:')) {
    return 'url-backed regex content requires fetch-domain approval and is not enabled';
  }
  if (trimmedValue.startsWith('wiki:')) {
    return 'wiki-backed regex content requires config include hydration before dry-run evaluation';
  }

  return undefined;
};

type RegexTestPart = 'title' | 'body' | 'url';

const regexTestParts = (value: unknown): RegexTestPart[] => {
  if (!Array.isArray(value)) {
    return ['title', 'body'];
  }

  const parts = value.filter(
    (entry): entry is RegexTestPart =>
      entry === 'title' || entry === 'body' || entry === 'url'
  );
  return parts.length === 0 ? ['title', 'body'] : [...new Set(parts)];
};

const getRegexActivityText = (
  activity: ActivitySnapshot,
  criterion: UnknownRecord
): string => {
  if (activity.kind === 'comment') {
    return activity.body;
  }

  const parts = regexTestParts(criterion.testOn);
  return parts
    .flatMap((part) => {
      switch (part) {
        case 'title':
          return activity.title ?? [];
        case 'body':
          return activity.body;
        case 'url':
          return activity.url ?? [];
      }
    })
    .filter((value) => value.length > 0)
    .join('\n');
};

const countRegexMatches = (regex: RegExp, value: string): number => {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const globalRegex = new RegExp(regex.source, flags);
  return [...value.matchAll(globalRegex)].length;
};

const getRegexMatches = (regex: RegExp, value: string): string[] => {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const globalRegex = new RegExp(regex.source, flags);
  return [...value.matchAll(globalRegex)].map((match) => match[0]);
};

const summarizeRepeatedRegexMatches = (matches: string[]) => {
  const counts = new Map<string, number>();
  for (const match of matches) {
    counts.set(match, (counts.get(match) ?? 0) + 1);
  }

  const repeated = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((left, right) =>
      right[1] === left[1] ? left[0].localeCompare(right[0]) : right[1] - left[1]
    );

  return {
    largestRepeat: repeated[0]?.[1] ?? 0,
    largestRepeatValue: repeated[0]?.[0] ?? '',
    repeatedMatches: repeated.map(([match]) => match),
    repeatedMatchesDelim: repeated.map(([match]) => match).join(', '),
  };
};

const getHistoryActivityKind = (
  lookAt: unknown,
  windowConfig?: unknown
): ActivitySnapshot['kind'] | undefined => {
  const configured =
    lookAt ??
    (isRecord(windowConfig) && windowConfig.fetch !== undefined
      ? windowConfig.fetch
      : undefined);

  switch (configured) {
    case 'comment':
    case 'comments':
      return 'comment';
    case 'submission':
    case 'submissions':
    case 'post':
    case 'posts':
      return 'submission';
    default:
      return undefined;
  }
};

const filterHistoryByKind = (
  history: ActivitySnapshot[],
  lookAt: unknown,
  windowConfig?: unknown
): ActivitySnapshot[] => {
  const kind = getHistoryActivityKind(lookAt, windowConfig);
  return kind === undefined
    ? history
    : history.filter((entry) => entry.kind === kind);
};

const evaluateHistoryRegexCriterion = (
  criterion: UnknownRecord,
  regex: RegExp,
  activity: ActivitySnapshot
): RuleEvaluation => {
  const usesHistory = hasHistoryOnlyRegexOptions(criterion);
  if (usesHistory && activity.authorHistory === undefined) {
    return {
      name: 'regex history',
      triggered: false,
      supported: false,
      reason: 'author history was not hydrated',
    };
  }

  const history = usesHistory
    ? filterHistoryByKind(
        getWindowedHistory(activity, criterion.window).filter(
          (entry) => entry.id !== activity.id
        ),
        criterion.lookAt,
        criterion.window
      )
    : [];

  const activities = [activity, ...history];
  const matchValues = activities.map((entry) =>
    getRegexMatches(regex, getRegexActivityText(entry, criterion))
  );
  const matchCounts = matchValues.map((matches) => matches.length);
  const allMatches = matchValues.flat();
  const repeatSummary = summarizeRepeatedRegexMatches(allMatches);
  const activityMatches = matchCounts.filter((count) =>
    valueMatchesNumberComparison(criterion.matchThreshold ?? '> 0', count)
  ).length;
  const totalMatches = matchCounts.reduce((total, count) => total + count, 0);
  const currentMatches = matchCounts[0] ?? 0;
  const currentMatched = valueMatchesNumberComparison(
    criterion.matchThreshold ?? '> 0',
    currentMatches
  );

  if (currentMatched === undefined) {
    return {
      name: 'regex history',
      triggered: false,
      supported: false,
      reason: 'regex matchThreshold is not supported',
    };
  }

  if (criterion.mustMatchCurrent === true && !currentMatched) {
    return {
      name: 'regex history',
      triggered: false,
      supported: true,
      reason: `current activity matched ${currentMatches} occurrence(s), below matchThreshold`,
    };
  }

  const checks: (boolean | undefined)[] = [];

  if (criterion.activityMatchThreshold !== undefined) {
    if (criterion.activityMatchThreshold !== null) {
      checks.push(
        valueMatchesCountOrPercentComparison(
          criterion.activityMatchThreshold,
          activityMatches,
          activities.length
        )
      );
    }
  }

  if (criterion.totalMatchThreshold !== undefined) {
    checks.push(
      valueMatchesNumberComparison(
        criterion.totalMatchThreshold,
        totalMatches,
        '>='
      )
    );
  }

  if (criterion.repeatThreshold !== undefined) {
    checks.push(
      valueMatchesNumberComparison(
        criterion.repeatThreshold,
        repeatSummary.largestRepeat,
        '>='
      )
    );
  }

  if (checks.length === 0) {
    checks.push(activityMatches > 0);
  }

  const supportedChecks = checks.filter((check) => check !== undefined);
  return {
    name: 'regex history',
    triggered: supportedChecks.some(Boolean),
    supported: supportedChecks.length === checks.length,
    reason: `matched ${activityMatches}/${activities.length} activities, ${totalMatches} total occurrence(s), and largest repeat ${repeatSummary.largestRepeat}`,
    templateData: {
      activityMatches,
      largestRepeat: repeatSummary.largestRepeat,
      largestRepeatValue: repeatSummary.largestRepeatValue,
      matchCount: totalMatches,
      matchSample: activities
        .map((entry) => getRegexActivityText(entry, criterion))
        .filter((value) => countRegexMatches(regex, value) > 0)
        .slice(0, 3)
        .join(', '),
      repeatedMatches: repeatSummary.repeatedMatchesDelim,
      result: `${activityMatches}/${activities.length} activities, ${totalMatches} total occurrence(s)`,
      totalMatches,
      window: activities.length,
    },
  };
};

const evaluateRegexRule = (
  rule: NormalizedRule & { type: 'rule' },
  activity: ActivitySnapshot
): RuleEvaluation => {
  const criteria = rule.config.criteria;
  if (!Array.isArray(criteria)) {
    return {
      name: normalizeName(rule.name, rule.kind),
      triggered: false,
      supported: false,
      reason: 'regex rule has no criteria array',
    };
  }

  const condition = rule.config.condition === 'AND' ? 'AND' : 'OR';
  const evaluations: RuleEvaluation[] = [];

  for (const [index, rawCriterion] of criteria.entries()) {
    if (!isRecord(rawCriterion)) {
      continue;
    }

    const unsupportedContentReason = getUnsupportedRegexContentReason(
      rawCriterion.regex
    );
    if (unsupportedContentReason !== undefined) {
      const criterionResult: RuleEvaluation = {
        name: normalizeName(rule.name, `regex[${index}]`),
        triggered: false,
        supported: false,
        reason: unsupportedContentReason,
      };
      evaluations.push(criterionResult);

      if (condition === 'AND') {
        return {
          ...criterionResult,
          name: normalizeName(rule.name, rule.kind),
          reason: `AND regex criteria failed: ${criterionResult.reason}`,
        };
      }
      continue;
    }

    const regex = parseRegex(rawCriterion.regex);
    if (!regex) {
      const criterionResult: RuleEvaluation = {
        name: normalizeName(rule.name, `regex[${index}]`),
        triggered: false,
        supported: false,
        reason: 'regex criterion pattern is not valid',
      };
      evaluations.push(criterionResult);

      if (condition === 'AND') {
        return {
          ...criterionResult,
          name: normalizeName(rule.name, rule.kind),
          reason: `AND regex criteria failed: ${criterionResult.reason}`,
        };
      }
      continue;
    }

    const criterionResult = {
      ...evaluateHistoryRegexCriterion(rawCriterion, regex, activity),
      name: normalizeName(rule.name, `regex[${index}]`),
    };
    evaluations.push(criterionResult);

    if (condition === 'OR' && criterionResult.triggered) {
      return criterionResult;
    }
    if (condition === 'AND' && !criterionResult.triggered) {
      return {
        ...criterionResult,
        name: normalizeName(rule.name, rule.kind),
        reason: `AND regex criteria failed: ${criterionResult.reason}`,
      };
    }
  }

  const supported =
    evaluations.length > 0 && evaluations.every((entry) => entry.supported);
  const triggered = condition === 'AND' && evaluations.length > 0;
  const reason = triggered
    ? `all regex criteria matched across ${evaluations.length} evaluated criteria`
    : evaluations.length === 1 && evaluations[0] !== undefined
      ? evaluations[0].reason
    : evaluations.length > 0
      ? `no regex criteria matched across ${evaluations.length} evaluated criteria`
      : 'only history-backed regex criteria were present';

  return {
    name: normalizeName(rule.name, rule.kind),
    triggered,
    supported,
    reason,
  };
};

const valueMatchesStringList = (expected: unknown, actual: string): boolean => {
  const values = Array.isArray(expected) ? expected : [expected];
  return values.some((value) => {
    const regex = parseRegex(value);
    return regex ? regex.test(actual) : false;
  });
};

const valueMatchesOptionalBoolean = (
  expected: unknown,
  actual: boolean | undefined
): boolean | undefined =>
  typeof expected === 'boolean' && actual !== undefined
    ? actual === expected
    : undefined;

const normalizedLowerName = (value: string): string => value.trim().toLowerCase();

const isUserProfileSubreddit = (subredditName: string): boolean =>
  normalizedLowerName(subredditName).startsWith('u_');

const isOwnProfileSubreddit = (
  subredditName: string,
  authorName: string
): boolean =>
  normalizedLowerName(subredditName) === `u_${normalizedLowerName(authorName)}`;

const valueMatchesSubredditCriteria = (
  expected: unknown,
  entry: ActivitySnapshot,
  referenceActivity: ActivitySnapshot
): boolean | undefined => {
  const values = Array.isArray(expected) ? expected : [expected];
  let supportedValues = 0;

  for (const value of values) {
    if (typeof value === 'string') {
      supportedValues++;
      if (valueMatchesStringList(value, entry.subredditName)) {
        return true;
      }
      continue;
    }

    if (!isRecord(value)) {
      continue;
    }

    const checks: (boolean | undefined)[] = [];
    const name = value.name ?? value.subredditName ?? value.subreddit_name;
    if (name !== undefined) {
      checks.push(valueMatchesStringList(name, entry.subredditName));
    }
    if (value.isUserProfile !== undefined) {
      checks.push(
        valueMatchesOptionalBoolean(
          value.isUserProfile,
          isUserProfileSubreddit(entry.subredditName)
        )
      );
    }
    if (value.is_user_profile !== undefined) {
      checks.push(
        valueMatchesOptionalBoolean(
          value.is_user_profile,
          isUserProfileSubreddit(entry.subredditName)
        )
      );
    }
    if (value.isOwnProfile !== undefined) {
      checks.push(
        valueMatchesOptionalBoolean(
          value.isOwnProfile,
          isOwnProfileSubreddit(
            entry.subredditName,
            referenceActivity.authorName
          )
        )
      );
    }
    if (value.is_own_profile !== undefined) {
      checks.push(
        valueMatchesOptionalBoolean(
          value.is_own_profile,
          isOwnProfileSubreddit(
            entry.subredditName,
            referenceActivity.authorName
          )
        )
      );
    }

    const nsfw =
      value.over18 ?? value.over_18 ?? value.nsfw ?? value.subredditNsfw;
    if (nsfw !== undefined) {
      checks.push(valueMatchesOptionalBoolean(nsfw, entry.subredditNsfw));
    }
    if (value.subreddit_nsfw !== undefined) {
      checks.push(
        valueMatchesOptionalBoolean(value.subreddit_nsfw, entry.subredditNsfw)
      );
    }

    const quarantined =
      value.quarantine ?? value.quarantined ?? value.subredditQuarantined;
    if (quarantined !== undefined) {
      checks.push(
        valueMatchesOptionalBoolean(quarantined, entry.subredditQuarantined)
      );
    }
    if (value.subreddit_quarantined !== undefined) {
      checks.push(
        valueMatchesOptionalBoolean(
          value.subreddit_quarantined,
          entry.subredditQuarantined
        )
      );
    }

    const type = value.type ?? value.subredditType ?? value.subreddit_type;
    if (type !== undefined) {
      checks.push(valueMatchesOptionalString(type, entry.subredditType));
    }

    if (checks.length === 0) {
      continue;
    }

    supportedValues++;
    if (checks.every((check) => check === true)) {
      return true;
    }
  }

  return supportedValues === 0 ? undefined : false;
};

type ReportTypeFilter = 'user' | 'mod';
type ReportComparisonFilter =
  | {
      operator: '<' | '<=' | '>' | '>=' | '=' | '==';
      value: number;
      reportType?: ReportTypeFilter;
      reasonRegex?: RegExp;
      durationMs?: number;
    }
  | {
      unsupported: true;
    };

const REPORT_COMPARISON_PATTERN =
  /^\s*(<=|>=|<|>|={1,2})?\s*(\d+(?:\.\d+)?)\s*(%)?\s*(.*)$/i;
const REPORT_TYPE_PATTERN = /^(mods?|users?)\b/i;
const REPORT_TIME_PATTERN =
  /\bin\s+\d+(?:\.\d+)?\s*(days?|weeks?|months?|years?|hours?|minutes?|seconds?|milliseconds?)\b/i;

const escapeRegexSource = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseQuotedReportReason = (
  value: string
): { reason: string; rest: string } | undefined => {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") {
    return undefined;
  }

  let escaped = false;
  for (let index = 1; index < value.length; index++) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote) {
      return {
        reason: value.slice(1, index).replace(/\\(["'\\])/g, '$1'),
        rest: value.slice(index + 1).trim(),
      };
    }
  }

  return undefined;
};

const parseReportComparisonFilter = (
  value: unknown
): ReportComparisonFilter | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { operator: '==', value };
  }
  if (typeof value !== 'string') {
    return undefined;
  }

  const match = value.match(REPORT_COMPARISON_PATTERN);
  if (!match) {
    return undefined;
  }

  const comparisonValue = Number(match[2]);
  if (!Number.isFinite(comparisonValue)) {
    return undefined;
  }
  if (match[3] !== undefined && match[3].trim().length > 0) {
    return { unsupported: true };
  }

  let rest = (match[4] ?? '').trim();
  let reportType: ReportTypeFilter | undefined;
  const typeMatch = rest.match(REPORT_TYPE_PATTERN);
  if (typeMatch?.[0] !== undefined) {
    reportType = typeMatch[0].toLowerCase().startsWith('mod')
      ? 'mod'
      : 'user';
    rest = rest.slice(typeMatch[0].length).trim();
  }

  let reasonRegex: RegExp | undefined;
  const quotedReason = parseQuotedReportReason(rest);
  if (quotedReason !== undefined) {
    reasonRegex = new RegExp(escapeRegexSource(quotedReason.reason), 'i');
    rest = quotedReason.rest;
  } else if (rest.startsWith('/')) {
    const regexMatch = rest.match(/^(\/.+\/[a-z]*)\s*(.*)$/i);
    if (regexMatch?.[1] === undefined) {
      return undefined;
    }
    reasonRegex = parseRegex(regexMatch[1]);
    if (reasonRegex === undefined) {
      return undefined;
    }
    rest = (regexMatch[2] ?? '').trim();
  }

  let durationMs: number | undefined;
  if (REPORT_TIME_PATTERN.test(rest)) {
    const timeMatch = rest.match(REPORT_TIME_PATTERN);
    if (timeMatch && timeMatch[0]) {
      const parsed = parseDurationComparison(timeMatch[0].replace(/^in\s+/i, ''));
      if (parsed !== undefined) {
        durationMs = parsed.milliseconds;
      }
      rest = rest.slice(0, timeMatch.index) + rest.slice(timeMatch.index! + timeMatch[0].length);
      rest = rest.trim();
    }
  }

  if (rest.length > 0) {
    return undefined;
  }

  return {
    operator: (match[1] ?? '==') as '<' | '<=' | '>' | '>=' | '=' | '==',
    value: comparisonValue,
    ...(reportType === undefined ? {} : { reportType }),
    ...(reasonRegex === undefined ? {} : { reasonRegex }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
};

const getReportReasonPool = (
  activity: ActivitySnapshot,
  reportType: ReportTypeFilter | undefined
): string[] | undefined => {
  if (reportType === 'user') {
    return activity.userReportReasons;
  }
  if (reportType === 'mod') {
    return activity.modReportReasons;
  }
  if (
    activity.userReportReasons === undefined ||
    activity.modReportReasons === undefined
  ) {
    return undefined;
  }

  return [...activity.userReportReasons, ...activity.modReportReasons];
};

const getReportCount = (
  filter: Exclude<ReportComparisonFilter, { unsupported: true }>,
  activity: ActivitySnapshot
): number | undefined => {
  if (filter.durationMs !== undefined) {
    const history = activity.reportHistory;
    if (history === undefined) {
      return undefined; // We don't have history to evaluate this
    }
    
    const cutoff = Date.now() - filter.durationMs;
    const validReports = history.filter((report) => {
      if (report.timestamp < cutoff) {
        return false;
      }
      if (filter.reportType !== undefined && report.type !== filter.reportType) {
        return false;
      }
      if (filter.reasonRegex !== undefined) {
        filter.reasonRegex.lastIndex = 0;
        if (!filter.reasonRegex.test(report.reason)) {
          return false;
        }
      }
      return true;
    });
    
    return validReports.length;
  }

  if (filter.reasonRegex !== undefined || filter.reportType !== undefined) {
    const reasons = getReportReasonPool(activity, filter.reportType);
    return reasons === undefined
      ? undefined
      : reasons.filter((reason) => {
          if (filter.reasonRegex === undefined) {
            return true;
          }
          filter.reasonRegex.lastIndex = 0;
          return filter.reasonRegex.test(reason);
        }).length;
  }

  return (
    activity.numReports ??
    getReportReasonPool(activity, undefined)?.length
  );
};

const valueMatchesReportComparison = (
  expected: unknown,
  activity: ActivitySnapshot
): boolean | undefined => {
  const values = Array.isArray(expected) ? expected : [expected];
  let supportedValues = 0;

  for (const value of values) {
    const comparison = parseReportComparisonFilter(value);
    if (comparison === undefined || 'unsupported' in comparison) {
      continue;
    }

    const count = getReportCount(comparison, activity);
    if (count === undefined) {
      continue;
    }

    supportedValues++;
    if (compareNumeric(count, comparison.operator, comparison.value)) {
      return true;
    }
  }

  return supportedValues === 0 ? undefined : false;
};

const valueMatchesOptionalString = (
  expected: unknown,
  actual: string | undefined
): boolean | undefined => {
  if (typeof expected === 'boolean') {
    return expected ? actual !== undefined && actual.length > 0 : !actual;
  }

  if (actual === undefined) {
    return false;
  }

  return valueMatchesStringList(expected, actual);
};

const valueMatchesOptionalColor = (
  expected: unknown,
  actual: string | undefined
): boolean | undefined => {
  if (typeof expected === 'boolean') {
    return expected ? actual !== undefined && actual.length > 0 : !actual;
  }

  if (actual === undefined) {
    return false;
  }

  return (
    valueMatchesStringList(expected, actual) ||
    valueMatchesStringList(expected, actual.replace(/^#/, ''))
  );
};

type ModeratorNameComparison =
  | {
      behavior: 'include' | 'exclude';
      names: string[];
    }
  | {
      unsupported: true;
    };

const normalizeModeratorName = (value: string): string => {
  const normalized = value.trim().replace(/^\/?u\//i, '').toLowerCase();
  return normalized === 'automod' ? 'automoderator' : normalized;
};

const parseModeratorNameComparison = (
  expected: unknown,
  botUsername?: string
): ModeratorNameComparison | undefined => {
  const rawNames: unknown[] =
    typeof expected === 'string'
      ? [expected]
      : Array.isArray(expected)
        ? expected
        : isRecord(expected)
          ? Array.isArray(expected.name)
            ? expected.name
            : [expected.name]
          : [];
  if (
    rawNames.length === 0 ||
    rawNames.some((name) => typeof name !== 'string')
  ) {
    return undefined;
  }

  const normalizedNames = rawNames
    .map((name) => normalizeModeratorName(name as string))
    .filter((name) => name.length > 0);
  if (normalizedNames.length === 0) {
    return undefined;
  }

  const rawBehavior = isRecord(expected) ? expected.behavior : undefined;
  const behavior = rawBehavior === 'exclude' ? 'exclude' : 'include';

  if (normalizedNames.includes('self')) {
    if (botUsername === undefined) {
      return { unsupported: true };
    }
    return {
      behavior,
      names: [
        ...new Set(
          normalizedNames.map((name) =>
            name === 'self' ? normalizeModeratorName(botUsername) : name
          )
        ),
      ],
    };
  }

  return {
    behavior,
    names: [...new Set(normalizedNames)],
  };
};

const valueMatchesModeratorName = (
  expected: unknown,
  actual: string | undefined,
  state: boolean,
  botUsername?: string
): boolean | undefined => {
  const comparison = parseModeratorNameComparison(expected, botUsername);
  if (comparison === undefined || 'unsupported' in comparison) {
    return undefined;
  }
  if (!state) {
    return false;
  }
  if (actual === undefined) {
    return undefined;
  }

  const normalizedActual = normalizeModeratorName(actual);
  const matched = comparison.names.includes(normalizedActual);
  return comparison.behavior === 'include' ? matched : !matched;
};

const valueMatchesActivitySource = (
  expected: unknown,
  actual: string | undefined
): boolean | undefined => {
  if (typeof expected === 'boolean') {
    return expected ? actual !== undefined : actual === undefined;
  }

  if (actual === undefined) {
    return false;
  }

  const values = Array.isArray(expected) ? expected : [expected];
  let supportedValues = 0;
  for (const value of values) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      continue;
    }

    supportedValues++;
    const normalizedExpected = value.trim().toLowerCase();
    const normalizedActual = actual.trim().toLowerCase();
    if (
      normalizedActual === normalizedExpected ||
      (!normalizedExpected.includes(':') &&
        normalizedActual.startsWith(`${normalizedExpected}:`)) ||
      valueMatchesStringList(value, actual)
    ) {
      return true;
    }
  }

  return supportedValues === 0 ? undefined : false;
};

const dayNameToUtcDay: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const valueMatchesCreatedOn = (
  expected: unknown,
  actual: Date
): boolean | undefined => {
  const values = Array.isArray(expected) ? expected : [expected];
  let supportedValues = 0;

  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const expectedDay = dayNameToUtcDay[value.trim().toLowerCase()];
    if (expectedDay === undefined) {
      continue;
    }

    supportedValues++;
    if (actual.getUTCDay() === expectedDay) {
      return true;
    }
  }

  return supportedValues === 0 ? undefined : false;
};

type CriteriaEvaluator = (
  criterion: unknown,
  activity: ActivitySnapshot
) => boolean | undefined;

type FilterEvaluation = {
  result: boolean | undefined;
  supported: boolean;
  reason?: string;
};

type ConfigRegistry = {
  actions: Map<string, NormalizedAction>;
  authorFilters: Map<string, unknown>;
  itemFilters: Map<string, unknown>;
  rules: Map<string, NormalizedRule>;
};

const normalizeReferenceName = (name: string): string =>
  name.trim().toLowerCase();

const normalizeTemplateName = (name: string): string =>
  normalizeReferenceName(name).replace(/[\s_-]+/g, '');

const registerRule = (
  registry: ConfigRegistry,
  rule: NormalizedRule
): void => {
  if (
    (rule.type === 'rule' || rule.type === 'ruleSet') &&
    rule.name !== undefined
  ) {
    const name = normalizeReferenceName(rule.name);
    if (!registry.rules.has(name)) {
      registry.rules.set(name, rule);
    }
  }

  if (rule.type === 'ruleSet') {
    for (const childRule of rule.rules) {
      registerRule(registry, childRule);
    }
  }
};

const registerAction = (
  registry: ConfigRegistry,
  action: NormalizedAction
): void => {
  if (action.type === 'action' && action.name !== undefined) {
    const name = normalizeReferenceName(action.name);
    if (!registry.actions.has(name)) {
      registry.actions.set(name, action);
    }
  }
};

const registerNamedFilterCriteria = (
  filters: Map<string, unknown>,
  filter: unknown
): void => {
  if (Array.isArray(filter)) {
    for (const entry of filter) {
      registerNamedFilterCriteria(filters, entry);
    }
    return;
  }

  if (!isRecord(filter)) {
    return;
  }

  if (typeof filter.name === 'string' && filter.criteria !== undefined) {
    const name = normalizeReferenceName(filter.name);
    if (!filters.has(name)) {
      filters.set(name, filter);
    }
  }

  registerNamedFilterCriteria(filters, filter.criteria);
  registerNamedFilterCriteria(filters, filter.include);
  registerNamedFilterCriteria(filters, filter.exclude);
};

const registerRunnableFilters = (
  registry: ConfigRegistry,
  config: UnknownRecord
): void => {
  registerNamedFilterCriteria(registry.authorFilters, config.authorIs);
  registerNamedFilterCriteria(registry.itemFilters, config.itemIs);
  if (isRecord(config.filterCriteriaDefaults)) {
    registerNamedFilterCriteria(
      registry.authorFilters,
      config.filterCriteriaDefaults.authorIs
    );
    registerNamedFilterCriteria(
      registry.itemFilters,
      config.filterCriteriaDefaults.itemIs
    );
  }
};

const registerRuleFilters = (
  registry: ConfigRegistry,
  rule: NormalizedRule
): void => {
  if (rule.type === 'ruleSet') {
    registerRunnableFilters(registry, rule.config);
    for (const childRule of rule.rules) {
      registerRuleFilters(registry, childRule);
    }
    return;
  }

  if (rule.type !== 'rule') {
    return;
  }

  registerRunnableFilters(registry, rule.config);
  if (rule.kind === 'author') {
    registerNamedFilterCriteria(registry.authorFilters, rule.config);
  }
};

const buildConfigRegistry = (config: NormalizedConfig): ConfigRegistry => {
  const registry: ConfigRegistry = {
    actions: new Map(),
    authorFilters: new Map(),
    itemFilters: new Map(),
    rules: new Map(),
  };

  registerRunnableFilters(registry, config.config);
  for (const run of config.runs) {
    registerRunnableFilters(registry, run.config);
    for (const check of run.checks) {
      registerRunnableFilters(registry, check.config);
      for (const rule of check.rules) {
        registerRule(registry, rule);
        registerRuleFilters(registry, rule);
      }
      for (const action of check.actions) {
        registerAction(registry, action);
        if (action.type === 'action') {
          registerRunnableFilters(registry, action.config);
        }
      }
    }
  }

  return registry;
};

const normalizeCriteriaList = (value: unknown): unknown[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  return Array.isArray(value) ? value : [value];
};

type NormalizedFilter = {
  include: unknown[];
  exclude: unknown[];
  excludeCondition?: 'AND' | 'OR';
};

type FilterDefaults = {
  authorIs?: unknown;
  itemIs?: unknown;
  authorIsBehavior: 'merge' | 'replace';
  itemIsBehavior: 'merge' | 'replace';
};

const normalizeFilter = (filter: unknown): NormalizedFilter => {
  if (
    isRecord(filter) &&
    (filter.include !== undefined ||
      filter.exclude !== undefined ||
      filter.excludeCondition !== undefined)
  ) {
    return {
      include: normalizeCriteriaList(filter.include) ?? [],
      exclude: normalizeCriteriaList(filter.exclude) ?? [],
      ...(filter.excludeCondition === 'AND' ? { excludeCondition: 'AND' } : {}),
    };
  }

  return {
    include: normalizeCriteriaList(filter) ?? [],
    exclude: [],
  };
};

const filterIsEmpty = (filter: NormalizedFilter): boolean =>
  filter.include.length === 0 && filter.exclude.length === 0;

const criterionKeys = (criterion: unknown): string[] => {
  if (!isRecord(criterion)) {
    return [];
  }

  if (isRecord(criterion.criteria)) {
    return Object.keys(criterion.criteria);
  }

  return Object.keys(criterion);
};

const addNonConflictingCriteria = (
  defaultCriteria: unknown[],
  explicitCriteria: unknown[]
): unknown[] => {
  if (explicitCriteria.length === 0) {
    return defaultCriteria;
  }

  const explicitKeys = new Set(explicitCriteria.flatMap(criterionKeys));
  const nonConflictingDefaults = defaultCriteria.filter((criterion) =>
    criterionKeys(criterion).every((key) => !explicitKeys.has(key))
  );

  return explicitCriteria.concat(nonConflictingDefaults);
};

const toFilterForEvaluation = (filter: NormalizedFilter): UnknownRecord => ({
  include: filter.include,
  exclude: filter.exclude,
  ...(filter.excludeCondition === undefined
    ? {}
    : { excludeCondition: filter.excludeCondition }),
});

const mergeFilterWithDefaults = (
  explicitFilter: unknown,
  defaultFilter: unknown,
  behavior: 'merge' | 'replace'
): unknown => {
  if (defaultFilter === undefined) {
    return explicitFilter;
  }

  const defaults = normalizeFilter(defaultFilter);
  const explicit = normalizeFilter(explicitFilter);
  if (behavior === 'replace' && !filterIsEmpty(explicit)) {
    return toFilterForEvaluation(explicit);
  }

  if (behavior === 'replace') {
    return toFilterForEvaluation(defaults);
  }

  const excludeCondition = explicit.excludeCondition ?? defaults.excludeCondition;
  return toFilterForEvaluation({
    include: addNonConflictingCriteria(defaults.include, explicit.include),
    exclude: addNonConflictingCriteria(defaults.exclude, explicit.exclude),
    ...(excludeCondition === undefined ? {} : { excludeCondition }),
  });
};

const getFilterDefaults = (config: UnknownRecord): FilterDefaults | undefined => {
  if (!isRecord(config.filterCriteriaDefaults)) {
    return undefined;
  }

  const defaults = config.filterCriteriaDefaults;
  return {
    authorIs: defaults.authorIs,
    itemIs: defaults.itemIs,
    authorIsBehavior:
      defaults.authorIsBehavior === 'replace' ? 'replace' : 'merge',
    itemIsBehavior: defaults.itemIsBehavior === 'replace' ? 'replace' : 'merge',
  };
};

const evaluateCriteriaCollection = (
  criteria: unknown,
  activity: ActivitySnapshot,
  evaluator: CriteriaEvaluator
): boolean | undefined => {
  const values = normalizeCriteriaList(criteria);
  if (values === undefined) {
    return undefined;
  }

  const results = values
    .map((criterion) => evaluator(criterion, activity))
    .filter((result) => result !== undefined);

  return results.length === 0 ? undefined : results.some(Boolean);
};

const evaluateSubmissionStateCriteria = (
  criteria: unknown,
  parentSubmission: ActivitySnapshot | undefined
): boolean | undefined => {
  if (parentSubmission === undefined) {
    return undefined;
  }

  const filter = normalizeFilter(criteria);
  if (filter.include.length > 0) {
    const includeResult = evaluateCriteriaCollection(
      filter.include,
      parentSubmission,
      evaluateItemCriteria
    );
    if (includeResult !== true) {
      return includeResult;
    }
  }

  if (filter.exclude.length > 0) {
    const excludeResults = filter.exclude
      .map((criterion) => evaluateItemCriteria(criterion, parentSubmission))
      .filter((result) => result !== undefined);
    if (excludeResults.length !== filter.exclude.length) {
      return undefined;
    }

    const shouldExclude =
      filter.excludeCondition === 'AND'
        ? excludeResults.every(Boolean)
        : excludeResults.some(Boolean);
    return !shouldExclude;
  }

  return filter.include.length > 0
    ? true
    : evaluateCriteriaCollection(criteria, parentSubmission, evaluateItemCriteria);
};

const hydrateNamedFilterReferences = (
  value: unknown,
  namedFilters: Map<string, unknown>,
  visitedReferences: Set<string> = new Set()
): unknown => {
  if (typeof value === 'string') {
    const referenceName = normalizeReferenceName(value);
    const resolved = namedFilters.get(referenceName);
    if (resolved === undefined || visitedReferences.has(referenceName)) {
      return value;
    }

    return hydrateNamedFilterReferences(
      resolved,
      namedFilters,
      new Set([...visitedReferences, referenceName])
    );
  }

  if (Array.isArray(value)) {
    return value.map((entry) =>
      hydrateNamedFilterReferences(entry, namedFilters, visitedReferences)
    );
  }

  if (!isRecord(value)) {
    return value;
  }

  return {
    ...value,
    ...(value.criteria === undefined
      ? {}
      : {
          criteria: hydrateNamedFilterReferences(
            value.criteria,
            namedFilters,
            visitedReferences
          ),
        }),
    ...(value.include === undefined
      ? {}
      : {
          include: hydrateNamedFilterReferences(
            value.include,
            namedFilters,
            visitedReferences
          ),
        }),
    ...(value.exclude === undefined
      ? {}
      : {
          exclude: hydrateNamedFilterReferences(
            value.exclude,
            namedFilters,
            visitedReferences
          ),
        }),
  };
};

const evaluateFilter = (
  filter: unknown,
  activity: ActivitySnapshot,
  evaluator: CriteriaEvaluator,
  filterName: string,
  namedFilters: Map<string, unknown>
): FilterEvaluation => {
  if (filter === undefined) {
    return { result: undefined, supported: true };
  }

  const hydratedFilter = hydrateNamedFilterReferences(filter, namedFilters);
  const isFullFilter =
    isRecord(hydratedFilter) &&
    (hydratedFilter.include !== undefined ||
      hydratedFilter.exclude !== undefined ||
      hydratedFilter.excludeCondition !== undefined);
  const include = isFullFilter
    ? normalizeCriteriaList(hydratedFilter.include)
    : normalizeCriteriaList(hydratedFilter);
  const exclude = isFullFilter
    ? normalizeCriteriaList(hydratedFilter.exclude)
    : undefined;
  const excludeCondition =
    isFullFilter && hydratedFilter.excludeCondition === 'AND' ? 'AND' : 'OR';

  if (include !== undefined && include.length > 0) {
    const results = include
      .map((criterion) => evaluator(criterion, activity))
      .filter((result) => result !== undefined);

    return {
      result: results.length === 0 ? undefined : results.some(Boolean),
      supported: results.length === include.length,
      reason:
        results.length === include.length
          ? `${filterName} include criteria evaluated`
          : `${filterName} include criteria need unsupported fields or named filters`,
    };
  }

  if (exclude !== undefined && exclude.length > 0) {
    const results = exclude
      .map((criterion) => evaluator(criterion, activity))
      .filter((result) => result !== undefined);

    if (results.length === 0) {
      return {
        result: undefined,
        supported: false,
        reason: `${filterName} exclude criteria need unsupported fields or named filters`,
      };
    }

    const shouldExclude =
      excludeCondition === 'AND'
        ? results.every(Boolean)
        : results.some(Boolean);

    return {
      result: !shouldExclude,
      supported: results.length === exclude.length,
      reason:
        results.length === exclude.length
          ? `${filterName} exclude criteria evaluated`
          : `${filterName} exclude criteria partially evaluated`,
    };
  }

  return { result: undefined, supported: true };
};

const evaluateAuthorCriteria = (
  criterion: unknown,
  activity: ActivitySnapshot
): boolean | undefined => {
  if (!isRecord(criterion)) {
    return undefined;
  }
  if (criterion.criteria !== undefined) {
    return evaluateCriteriaCollection(
      criterion.criteria,
      activity,
      evaluateAuthorCriteria
    );
  }

  const keys = Object.keys(criterion);
  const supportedKeys = [
    'name',
    'flairText',
    'authorFlairText',
    'flairCssClass',
    'authorFlairCssClass',
    'flairTemplate',
    'flairTemplateId',
    'authorFlairTemplateId',
    'flairBackgroundColor',
    'authorFlairBackgroundColor',
    'age',
    'linkKarma',
    'commentKarma',
    'totalKarma',
    'verified',
    'hasVerifiedEmail',
    'shadowBanned',
    'shadowbanned',
    'description',
    'profileDescription',
    'about',
    'nsfw',
    'isMod',
    'isModerator',
    'isContributor',
    'userNotes',
    'modActions',
  ];
  const criterionSupportedKeys = keys.filter((key) =>
    supportedKeys.includes(key)
  );
  const unsupportedKeys = keys.filter((key) => !supportedKeys.includes(key));
  if (criterionSupportedKeys.length === 0 || unsupportedKeys.length > 0) {
    return undefined;
  }

  const results = criterionSupportedKeys.map((key) => {
    switch (key) {
      case 'name':
        return valueMatchesStringList(criterion.name, activity.authorName);
      case 'flairText':
      case 'authorFlairText':
        return valueMatchesOptionalString(
          criterion[key],
          activity.authorFlairText
        );
      case 'flairCssClass':
      case 'authorFlairCssClass':
        return valueMatchesOptionalString(
          criterion[key],
          activity.authorFlairCssClass
        );
      case 'flairTemplate':
      case 'flairTemplateId':
      case 'authorFlairTemplateId':
        return valueMatchesOptionalString(
          criterion[key],
          activity.authorFlairTemplateId
        );
      case 'flairBackgroundColor':
      case 'authorFlairBackgroundColor':
        return valueMatchesOptionalColor(
          criterion[key],
          activity.authorFlairBackgroundColor
        );
      case 'age':
        return activity.authorAccountCreatedAt === undefined
          ? undefined
          : valueMatchesDurationComparison(
              criterion[key],
              Math.max(0, Date.now() - activity.authorAccountCreatedAt.getTime())
            );
      case 'linkKarma':
        return activity.authorLinkKarma === undefined
          ? undefined
          : valueMatchesNumberComparison(criterion[key], activity.authorLinkKarma);
      case 'commentKarma':
        return activity.authorCommentKarma === undefined
          ? undefined
          : valueMatchesNumberComparison(
              criterion[key],
              activity.authorCommentKarma
            );
      case 'totalKarma':
        return activity.authorTotalKarma === undefined
          ? undefined
          : valueMatchesNumberComparison(criterion[key], activity.authorTotalKarma);
      case 'verified':
      case 'hasVerifiedEmail':
        return typeof criterion[key] === 'boolean' &&
          activity.authorHasVerifiedEmail !== undefined
          ? activity.authorHasVerifiedEmail === criterion[key]
          : undefined;
      case 'shadowBanned':
      case 'shadowbanned':
        return typeof criterion[key] === 'boolean' &&
          activity.authorShadowbanned !== undefined
          ? activity.authorShadowbanned === criterion[key]
          : undefined;
      case 'description':
      case 'profileDescription':
      case 'about':
        return valueMatchesOptionalString(
          criterion[key],
          activity.authorProfileDescription
        );
      case 'nsfw':
        return typeof criterion[key] === 'boolean' &&
          activity.authorNsfw !== undefined
          ? activity.authorNsfw === criterion[key]
          : undefined;
      case 'isMod':
      case 'isModerator':
        return typeof criterion[key] === 'boolean' &&
          activity.authorIsModerator !== undefined
          ? activity.authorIsModerator === criterion[key]
          : undefined;
      case 'isContributor':
        return typeof criterion[key] === 'boolean' &&
          activity.authorIsContributor !== undefined
          ? activity.authorIsContributor === criterion[key]
          : undefined;
      case 'userNotes':
        return activity.authorUserNotes === undefined
          ? undefined
          : evaluateToolboxUserNoteCriteria(
              activity.authorUserNotes,
              criterion[key],
              activity.id
            );
      case 'modActions': {
        if (activity.authorModNotes === undefined) {
          return undefined;
        }

        const criteria = Array.isArray(criterion[key])
          ? criterion[key]
          : [criterion[key]];
        const evaluations = criteria.map((entry) =>
          evaluateModNoteCriteria(activity.authorModNotes ?? [], entry, activity.id as T1 | T3)
        );
        return evaluations.some((evaluation) => !evaluation.supported)
          ? undefined
          : evaluations.some((evaluation) => evaluation.passed);
      }
      default:
        return false;
    }
  });

  return results.some((result) => result === undefined)
    ? undefined
    : results.every(Boolean);
};

const evaluateItemCriteria = (
  criterion: unknown,
  activity: ActivitySnapshot
): boolean | undefined => {
  if (!isRecord(criterion)) {
    return undefined;
  }
  if (criterion.criteria !== undefined) {
    return evaluateCriteriaCollection(
      criterion.criteria,
      activity,
      evaluateItemCriteria
    );
  }

  const supportedItemKeys = [
    'removed',
    'deleted',
    'filtered',
    'approved',
    'locked',
    'spam',
    'stickied',
    'distinguished',
    'archived',
    'quarantined',
    'hidden',
    'ignoringReports',
    'ignoring_reports',
    'collapsedBecauseCrowdControl',
    'collapsed_because_crowd_control',
    'score',
    'reports',
    'age',
    'createdOn',
    'nsfw',
    'over_18',
    'pinned',
    'spoiler',
    'is_self',
    'isRedditMediaDomain',
    'is_reddit_media_domain',
    'title',
    'link_flair_text',
    'flairText',
    'link_flair_css_class',
    'linkFlairCssClass',
    'link_flair_background_color',
    'linkFlairBackgroundColor',
    'flairTemplate',
    'link_flair_template_id',
    'linkFlairTemplateId',
    'op',
    'depth',
    'upvoteRatio',
    'upvote_ratio',
    'submissionState',
    'source',
    'subredditName',
    'subreddit_name',
    'subredditNsfw',
    'subreddit_nsfw',
    'subredditQuarantined',
    'subreddit_quarantined',
    'subredditType',
    'subreddit_type',
    'is_user_profile',
    'isUserProfile',
    'is_own_profile',
    'isOwnProfile',
    'youtubeChannelRegex',
    'youtubeMinPublishAgeMs',
  ];
  if (Object.keys(criterion).some((key) => !supportedItemKeys.includes(key))) {
    return undefined;
  }

  const supportedResults = Object.entries(criterion)
    .map(([key, expected]) => {
      switch (key) {
        case 'removed':
          return typeof expected === 'boolean'
            ? activity.removed === expected
            : valueMatchesModeratorName(
                expected,
                activity.removedBy,
                activity.removed,
                currentBotUsername
              );
        case 'approved':
          return typeof expected === 'boolean'
            ? activity.approved === expected
            : valueMatchesModeratorName(
                expected,
                activity.approvedBy,
                activity.approved,
                currentBotUsername
              );
        case 'deleted':
        case 'filtered':
        case 'locked':
        case 'spam':
        case 'stickied':
        case 'distinguished':
          return typeof expected === 'boolean'
            ? activity[key as keyof ActivitySnapshot] === expected
            : undefined;
        case 'archived':
          return typeof expected === 'boolean' && activity.archived !== undefined
            ? activity.archived === expected
            : undefined;
        case 'quarantined':
          return typeof expected === 'boolean' &&
            activity.quarantined !== undefined
            ? activity.quarantined === expected
            : undefined;
        case 'hidden':
          return typeof expected === 'boolean' && activity.hidden !== undefined
            ? activity.hidden === expected
            : undefined;
        case 'ignoringReports':
        case 'ignoring_reports':
          return typeof expected === 'boolean' &&
            activity.ignoringReports !== undefined
            ? activity.ignoringReports === expected
            : undefined;
        case 'collapsedBecauseCrowdControl':
        case 'collapsed_because_crowd_control':
          return typeof expected === 'boolean' &&
            activity.collapsedBecauseCrowdControl !== undefined
            ? activity.collapsedBecauseCrowdControl === expected
            : undefined;
        case 'age':
          return valueMatchesDurationComparison(
            expected,
            Math.max(0, Date.now() - activity.createdAt.getTime())
          );
        case 'youtubeChannelRegex':
          return typeof expected === 'string' &&
            activity.youtubeChannel !== undefined
            ? new RegExp(expected, 'i').test(activity.youtubeChannel)
            : undefined;
        case 'youtubeMinPublishAgeMs':
          return typeof expected === 'number' &&
            activity.youtubePublishAgeMs !== undefined
            ? activity.youtubePublishAgeMs >= expected
            : undefined;
        case 'createdOn':
          return valueMatchesCreatedOn(expected, activity.createdAt);
        case 'reports':
          return valueMatchesReportComparison(expected, activity);
        case 'nsfw':
        case 'over_18':
          return typeof expected === 'boolean' && activity.nsfw !== undefined
            ? activity.nsfw === expected
            : undefined;
        case 'pinned':
          return typeof expected === 'boolean'
            ? activity.stickied === expected
            : undefined;
        case 'spoiler':
          return typeof expected === 'boolean' && activity.spoiler !== undefined
            ? activity.spoiler === expected
            : undefined;
        case 'is_self':
          return typeof expected === 'boolean' && activity.selfPost !== undefined
            ? activity.selfPost === expected
            : undefined;
        case 'isRedditMediaDomain':
        case 'is_reddit_media_domain':
          return typeof expected === 'boolean' &&
            activity.isRedditMediaDomain !== undefined
            ? activity.isRedditMediaDomain === expected
            : undefined;
        case 'title':
          return activity.title === undefined
            ? undefined
            : valueMatchesStringList(expected, activity.title);
        case 'link_flair_text':
        case 'flairText':
          return valueMatchesOptionalString(expected, activity.linkFlairText);
        case 'link_flair_css_class':
        case 'linkFlairCssClass':
          return valueMatchesOptionalString(
            expected,
            activity.linkFlairCssClass
          );
        case 'link_flair_background_color':
        case 'linkFlairBackgroundColor':
          return valueMatchesOptionalColor(
            expected,
            activity.linkFlairBackgroundColor
          );
        case 'flairTemplate':
        case 'link_flair_template_id':
        case 'linkFlairTemplateId':
          return valueMatchesOptionalString(
            expected,
            activity.linkFlairTemplateId
          );
        case 'score':
          return valueMatchesNumberComparison(expected, activity.score);
        case 'upvoteRatio':
        case 'upvote_ratio':
          return activity.upvoteRatio !== undefined
            ? valueMatchesNumberComparison(expected, activity.upvoteRatio)
            : undefined;
        case 'subredditName':
        case 'subreddit_name':
          return valueMatchesOptionalString(expected, activity.subredditName);
        case 'subredditNsfw':
        case 'subreddit_nsfw':
          return activity.subredditNsfw !== undefined
            ? activity.subredditNsfw === expected
            : undefined;
        case 'subredditQuarantined':
        case 'subreddit_quarantined':
          return activity.subredditQuarantined !== undefined
            ? activity.subredditQuarantined === expected
            : undefined;
        case 'subredditType':
        case 'subreddit_type':
          return valueMatchesOptionalString(expected, activity.subredditType);
        case 'is_user_profile':
        case 'isUserProfile':
          return isUserProfileSubreddit(activity.subredditName) === expected;
        case 'is_own_profile':
        case 'isOwnProfile':
          return (
            isOwnProfileSubreddit(activity.subredditName, activity.authorName) ===
            expected
          );
        case 'op':
          return typeof expected === 'boolean' &&
            activity.commentIsOp !== undefined
            ? activity.commentIsOp === expected
            : undefined;
        case 'depth':
          return activity.commentDepth === undefined
            ? undefined
            : valueMatchesNumberComparison(expected, activity.commentDepth);
        case 'submissionState':
          return evaluateSubmissionStateCriteria(
            expected,
            activity.parentSubmission
          );
        case 'source':
          return valueMatchesActivitySource(expected, activity.source);
        default:
          return undefined;
      }
    })
    .filter((result) => result !== undefined);

  return supportedResults.length === 0
    ? undefined
    : supportedResults.every(Boolean);
};

const evaluateAuthorFilter = (
  filter: unknown,
  activity: ActivitySnapshot,
  registry: ConfigRegistry
): FilterEvaluation =>
  evaluateFilter(
    filter,
    activity,
    evaluateAuthorCriteria,
    'authorIs',
    registry.authorFilters
  );

const evaluateItemFilter = (
  filter: unknown,
  activity: ActivitySnapshot,
  registry: ConfigRegistry
): FilterEvaluation =>
  evaluateFilter(
    filter,
    activity,
    evaluateItemCriteria,
    'itemIs',
    registry.itemFilters
  );

const combineFilterReasons = (
  base: string,
  ...filters: FilterEvaluation[]
): string => {
  const unsupportedReasons = filters
    .filter((filter) => !filter.supported && filter.reason !== undefined)
    .map((filter) => filter.reason);

  return unsupportedReasons.length === 0
    ? base
    : `${base}; ${unsupportedReasons.join('; ')}`;
};

const evaluateRunnableFilters = (
  config: UnknownRecord,
  activity: ActivitySnapshot,
  registry: ConfigRegistry,
  filterDefaults?: FilterDefaults
): FilterEvaluation => {
  const authorFilter = evaluateAuthorFilter(
    filterDefaults === undefined
      ? config.authorIs
      : mergeFilterWithDefaults(
          config.authorIs,
          filterDefaults.authorIs,
          filterDefaults.authorIsBehavior
        ),
    activity,
    registry
  );
  if (authorFilter.result === false) {
    return {
      result: false,
      supported: authorFilter.supported,
      reason: 'authorIs criteria did not pass',
    };
  }

  const itemFilter = evaluateItemFilter(
    filterDefaults === undefined
      ? config.itemIs
      : mergeFilterWithDefaults(
          config.itemIs,
          filterDefaults.itemIs,
          filterDefaults.itemIsBehavior
        ),
    activity,
    registry
  );
  if (itemFilter.result === false) {
    return {
      result: false,
      supported: authorFilter.supported && itemFilter.supported,
      reason: 'itemIs criteria did not pass',
    };
  }

  return {
    result:
      authorFilter.result === undefined && itemFilter.result === undefined
        ? undefined
        : true,
    supported: authorFilter.supported && itemFilter.supported,
    reason: combineFilterReasons('filters evaluated', authorFilter, itemFilter),
  };
};

const getWindowLimit = (windowConfig: unknown): number | undefined => {
  if (typeof windowConfig === 'number' && Number.isFinite(windowConfig)) {
    return Math.max(1, Math.floor(windowConfig));
  }

  if (isRecord(windowConfig) && typeof windowConfig.count === 'number') {
    return Math.max(1, Math.floor(windowConfig.count));
  }

  return undefined;
};

const getWindowDurationMs = (windowConfig: unknown): number | undefined => {
  const durationObjectToMs = (value: unknown): number | undefined => {
    if (!isRecord(value)) {
      return undefined;
    }

    const unitMs: Record<string, number> = {
      millisecond: 1,
      milliseconds: 1,
      second: 1000,
      seconds: 1000,
      minute: 60 * 1000,
      minutes: 60 * 1000,
      hour: 60 * 60 * 1000,
      hours: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      weeks: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
      months: 30 * 24 * 60 * 60 * 1000,
      year: 365 * 24 * 60 * 60 * 1000,
      years: 365 * 24 * 60 * 60 * 1000,
    };
    let total = 0;

    for (const [unit, amount] of Object.entries(value)) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        continue;
      }
      const multiplier = unitMs[unit];
      if (multiplier === undefined) {
        continue;
      }
      total += amount * multiplier;
    }

    return total > 0 ? total : undefined;
  };

  if (typeof windowConfig === 'string') {
    return parseDurationComparison(windowConfig)?.milliseconds;
  }

  if (isRecord(windowConfig)) {
    return (
      parseDurationComparison(windowConfig.duration)?.milliseconds ??
      durationObjectToMs(windowConfig.duration)
    );
  }

  return undefined;
};

const getWindowedHistory = (
  activity: ActivitySnapshot,
  windowConfig: unknown
): ActivitySnapshot[] => {
  const history = activity.authorHistory ?? [];
  return getWindowedActivities(history, windowConfig, activity);
};

const getWindowedActivities = (
  activities: ActivitySnapshot[],
  windowConfig: unknown,
  referenceActivity?: ActivitySnapshot
): ActivitySnapshot[] => {
  const durationMs = getWindowDurationMs(windowConfig);
  let cutoff: number | undefined = undefined;

  if (durationMs !== undefined) {
    const referenceTime = referenceActivity?.createdAt.getTime() ?? Date.now();
    cutoff = referenceTime - Math.max(0, durationMs);
  }

  let filtered = activities;

  if (cutoff !== undefined) {
    filtered = filtered.filter((entry) => entry.createdAt.getTime() >= cutoff!);
  }

  if (referenceActivity !== undefined) {
    filtered = filtered.filter(
      (entry) => entry.createdAt.getTime() <= referenceActivity.createdAt.getTime()
    );
  }

  const limit = getWindowLimit(windowConfig);
  return limit === undefined ? filtered : filtered.slice(0, limit);
};

const getCriteriaSubreddits = (
  ruleConfig: UnknownRecord,
  criterion: UnknownRecord
): { include?: unknown; exclude?: unknown } => {
  const windowSubreddits =
    isRecord(criterion.window) &&
    isRecord(criterion.window.filterOn) &&
    isRecord(criterion.window.filterOn.post) &&
    isRecord(criterion.window.filterOn.post.subreddits)
      ? criterion.window.filterOn.post.subreddits
      : {};

  return {
    include: criterion.include ?? windowSubreddits.include ?? ruleConfig.include,
    exclude: criterion.exclude ?? windowSubreddits.exclude ?? ruleConfig.exclude,
  };
};

const filterHistoryBySubreddit = (
  history: ActivitySnapshot[],
  ruleConfig: UnknownRecord,
  criterion: UnknownRecord,
  referenceActivity: ActivitySnapshot
): ActivitySnapshot[] => {
  const { include, exclude } = getCriteriaSubreddits(ruleConfig, criterion);
  return history.filter((entry) => {
    const includeResult =
      include === undefined
        ? true
        : valueMatchesSubredditCriteria(include, entry, referenceActivity) === true;
    const excludeResult =
      exclude === undefined
        ? false
        : valueMatchesSubredditCriteria(exclude, entry, referenceActivity) === true;
    return includeResult && !excludeResult;
  });
};

const historyCounts = (history: ActivitySnapshot[]) =>
  history.reduce(
    (counts, entry) => {
      if (entry.kind === 'submission') {
        counts.submissions++;
      } else {
        counts.comments++;
        if (entry.commentIsOp === true) {
          counts.opComments++;
        }
      }

      return counts;
    },
    {
      submissions: 0,
      comments: 0,
      opComments: 0,
    }
  );

const historyCriterionMatches = (
  criterion: UnknownRecord,
  activity: ActivitySnapshot,
  allHistory: ActivitySnapshot[],
  filteredHistory: ActivitySnapshot[]
): boolean | undefined => {
  const allCounts = historyCounts(allHistory);
  const filteredCounts = historyCounts(filteredHistory);
  const checks: (boolean | undefined)[] = [];

  if (criterion.submission !== undefined) {
    checks.push(
      valueMatchesCountOrPercentComparison(
        criterion.submission,
        filteredCounts.submissions,
        allHistory.length
      )
    );
  }

  if (criterion.comment !== undefined) {
    const opOnly =
      typeof criterion.comment === 'string' && /\bop\b/i.test(criterion.comment);
    checks.push(
      valueMatchesCountOrPercentComparison(
        criterion.comment,
        opOnly ? filteredCounts.opComments : filteredCounts.comments,
        opOnly ? allCounts.comments : allHistory.length
      )
    );
  }

  if (criterion.total !== undefined) {
    checks.push(
      valueMatchesCountOrPercentComparison(
        criterion.total,
        filteredHistory.length,
        allHistory.length
      )
    );
  }

  if (isRecord(criterion.ratio)) {
    const ratioWindowHistory = filterHistoryBySubreddit(
      getWindowedHistory(activity, criterion.ratio.window),
      {},
      { window: criterion.ratio.window },
      activity
    );
    checks.push(
      valueMatchesRatioComparison(
        criterion.ratio.threshold,
        filteredHistory.length,
        ratioWindowHistory.length
      )
    );
  }

  const supportedChecks = checks.filter((check) => check !== undefined);
  return supportedChecks.length === 0
    ? undefined
    : supportedChecks.every(Boolean);
};

const evaluateHistoryRule = (
  rule: NormalizedRule & { type: 'rule' },
  activity: ActivitySnapshot
): RuleEvaluation => {
  if (activity.authorHistory === undefined) {
    return {
      name: normalizeName(rule.name, rule.kind),
      triggered: false,
      supported: false,
      reason: 'author history was not hydrated',
    };
  }

  const criteria = Array.isArray(rule.config.criteria) ? rule.config.criteria : [];
  if (criteria.length === 0) {
    return {
      name: normalizeName(rule.name, rule.kind),
      triggered: false,
      supported: false,
      reason: 'history rule has no criteria array',
    };
  }

  const results = criteria.flatMap((rawCriterion) => {
    if (!isRecord(rawCriterion)) {
      return [];
    }

    const allHistory = getWindowedHistory(activity, rawCriterion.window);
    const filteredHistory = filterHistoryBySubreddit(
      allHistory,
      rule.config,
      rawCriterion,
      activity
    );
    const minActivityCount =
      typeof rawCriterion.minActivityCount === 'number'
        ? rawCriterion.minActivityCount
        : 5;
    if (filteredHistory.length < minActivityCount) {
      return [false];
    }

    return [
      historyCriterionMatches(
        rawCriterion,
        activity,
        allHistory,
        filteredHistory
      ),
    ];
  });
  const supportedResults = results.filter((result) => result !== undefined);
  const triggered =
    rule.config.condition === 'AND'
      ? supportedResults.length > 0 && supportedResults.every(Boolean)
      : supportedResults.some(Boolean);

  return {
    name: normalizeName(rule.name, rule.kind),
    triggered,
    supported: supportedResults.length === results.length && results.length > 0,
    reason: `evaluated ${supportedResults.length}/${criteria.length} history criteria`,
  };
};

const getRecentThresholdSubreddits = (threshold: UnknownRecord): unknown =>
  threshold.subreddits ?? threshold.subreddit;

const recentThresholdMatches = (
  threshold: UnknownRecord,
  history: ActivitySnapshot[],
  referenceActivity: ActivitySnapshot
): boolean | undefined => {
  const subreddits = getRecentThresholdSubreddits(threshold);
  const matchingHistory =
    subreddits === undefined
      ? history
      : history.filter((entry) =>
          valueMatchesSubredditCriteria(subreddits, entry, referenceActivity) === true
        );
  const thresholdMatch = valueMatchesCountOrPercentComparison(
    threshold.threshold ?? '>= 1',
    matchingHistory.length,
    history.length
  );
  if (thresholdMatch !== true) {
    return thresholdMatch;
  }

  if (threshold.karmaThreshold !== undefined) {
    return valueMatchesNumberComparison(
      threshold.karmaThreshold,
      matchingHistory.reduce((total, entry) => total + entry.score, 0)
    );
  }

  return true;
};

const evaluateRecentActivityRule = (
  rule: NormalizedRule & { type: 'rule' },
  activity: ActivitySnapshot
): RuleEvaluation => {
  if (activity.authorHistory === undefined) {
    return {
      name: normalizeName(rule.name, rule.kind),
      triggered: false,
      supported: false,
      reason: 'author history was not hydrated',
    };
  }

  let history = filterHistoryByKind(
    getWindowedHistory(activity, rule.config.window).filter(
      (entry) => entry.id !== activity.id
    ),
    rule.config.lookAt,
    rule.config.window
  );

  if (rule.config.useSubmissionAsReference === true) {
    if (activity.kind !== 'submission' || activity.url === undefined) {
      history = [];
    } else {
      history = history.filter(
        (entry) => {
          if (entry.kind !== 'submission') {
            return false;
          }
          if (entry.url === activity.url) {
            return true;
          }
          if (
            activity.imageHash &&
            entry.imageHash &&
            activity.flippedImageHash &&
            entry.flippedImageHash
          ) {
            // Check if there is an imageDetection configuration or just use default threshold
            const matchScore =
              isRecord(rule.config.imageDetection) &&
              isRecord(rule.config.imageDetection.pixel) &&
              typeof rule.config.imageDetection.pixel.threshold === 'number'
                ? rule.config.imageDetection.pixel.threshold
                : (isRecord(rule.config.imageDetection) &&
                   isRecord(rule.config.imageDetection.hash) &&
                   typeof rule.config.imageDetection.hash.hardThreshold === 'number'
                     ? 100 - rule.config.imageDetection.hash.hardThreshold
                     : 95);
                     
            return compareImages(
              activity.imageHash,
              activity.flippedImageHash,
              entry.imageHash,
              matchScore
            );
          }
          return false;
        }
      );
    }
  }

  const thresholds = Array.isArray(rule.config.thresholds)
    ? rule.config.thresholds
    : [];
  if (thresholds.length === 0) {
    return {
      name: normalizeName(rule.name, rule.kind),
      triggered: false,
      supported: false,
      reason: 'recentActivity rule has no thresholds array',
    };
  }

  const results = thresholds.flatMap((threshold) =>
    isRecord(threshold) ? [recentThresholdMatches(threshold, history, activity)] : []
  );
  const supportedResults = results.filter((result) => result !== undefined);

  return {
    name: normalizeName(rule.name, rule.kind),
    triggered: supportedResults.some(Boolean),
    supported: supportedResults.length === results.length && results.length > 0,
    reason: `evaluated ${supportedResults.length}/${thresholds.length} recent activity thresholds`,
  };
};

const evaluateSentimentRule = (
  rule: NormalizedRule & { type: 'rule' },
  activity: ActivitySnapshot
): RuleEvaluation => {
  const currentComparison = parseSentimentComparison(rule.config.sentiment);
  if (currentComparison === undefined) {
    return {
      name: normalizeName(rule.name, rule.kind),
      triggered: false,
      supported: false,
      reason: 'sentiment rule has no supported sentiment comparison',
    };
  }

  const current = analyzeActivitySentiment(
    activity,
    currentComparison,
    rule.config.testOn
  );
  const historical = isRecord(rule.config.historical)
    ? rule.config.historical
    : undefined;

  if (historical === undefined) {
    return {
      name: normalizeName(rule.name, rule.kind),
      triggered: current.passed,
      supported: true,
      reason: `current activity sentiment ${current.score} (${current.sentiment}) ${
        current.passed ? 'matched' : 'did not match'
      } ${current.comparison.displayText}`,
      templateData: {
        averageScore: current.score,
        result: `Current activity sentiment ${current.score} (${current.sentiment})`,
        sentiment: current.sentiment,
        sentimentTest: current.comparison.displayText,
      },
    };
  }

  if (historical.mustMatchCurrent === true && !current.passed) {
    return {
      name: normalizeName(rule.name, rule.kind),
      triggered: false,
      supported: true,
      reason: `current activity sentiment ${current.score} (${current.sentiment}) did not match ${current.comparison.displayText}; historical sentiment skipped`,
      templateData: {
        averageScore: current.score,
        result: `Current activity sentiment ${current.score} (${current.sentiment}) did not match`,
        sentiment: current.sentiment,
        sentimentTest: current.comparison.displayText,
      },
    };
  }

  if (activity.authorHistory === undefined) {
    return {
      name: normalizeName(rule.name, rule.kind),
      triggered: false,
      supported: false,
      reason: 'author history was not hydrated',
    };
  }

  const historicalComparison = parseSentimentComparison(
    historical.sentiment ?? rule.config.sentiment
  );
  if (historicalComparison === undefined) {
    return {
      name: normalizeName(rule.name, rule.kind),
      triggered: false,
      supported: false,
      reason: 'historical sentiment comparison is unsupported',
    };
  }

  const history = getWindowedHistory(activity, historical.window).filter(
    (entry) => entry.id !== activity.id
  );
  const historicalResults = history.map((entry) =>
    analyzeActivitySentiment(entry, historicalComparison, rule.config.testOn)
  );
  const matchingHistory = historicalResults.filter((result) => result.passed);
  const totalMatching = historical.totalMatching ?? '> 0';
  const thresholdPassed = valueMatchesCountOrPercentComparison(
    totalMatching,
    matchingHistory.length,
    historicalResults.length,
    '>'
  );

  if (thresholdPassed === undefined) {
    return {
      name: normalizeName(rule.name, rule.kind),
      triggered: false,
      supported: false,
      reason: 'historical sentiment totalMatching comparison is unsupported',
    };
  }

  const averageWindowScore =
    historicalResults.length === 0
      ? 0
      : historicalResults.reduce((total, result) => total + result.score, 0) /
        historicalResults.length;

  return {
    name: normalizeName(rule.name, rule.kind),
    triggered: thresholdPassed,
    supported: true,
    reason: `${matchingHistory.length}/${historicalResults.length} historical activities matched ${historicalComparison.displayText}; current score ${current.score}`,
    templateData: {
      averageScore: current.score,
      averageWindowScore,
      historicalSentimentTest: historicalComparison.displayText,
      result: `${matchingHistory.length}/${historicalResults.length} historical activities matched sentiment threshold`,
      sentiment: current.sentiment,
      sentimentTest: current.comparison.displayText,
      totalMatching: String(totalMatching),
      window: historicalResults.length,
    },
  };
};

const parseSearchRegex = (value: string): RegExp | undefined => {
  const regexMatch = value.match(/^\/(.+)\/([a-z]*)$/i);
  if (regexMatch) {
    const pattern = regexMatch[1];
    if (pattern === undefined) {
      return undefined;
    }
    try {
      return new RegExp(pattern, regexMatch[2] ?? '');
    } catch {
      return undefined;
    }
  }

  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
};

const normalizeSimilarityText = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s{2,}|\n/g, ' ');

const getBigrams = (value: string): string[] => {
  if (value.length < 2) {
    return value.length === 0 ? [] : [value];
  }

  const bigrams: string[] = [];
  for (let index = 0; index < value.length - 1; index++) {
    bigrams.push(value.slice(index, index + 2));
  }
  return bigrams;
};

const diceSimilarity = (left: string, right: string): number => {
  if (left === right) {
    return 100;
  }

  const leftBigrams = getBigrams(left);
  const rightBigrams = getBigrams(right);
  if (leftBigrams.length === 0 || rightBigrams.length === 0) {
    return 0;
  }

  const rightCounts = new Map<string, number>();
  for (const bigram of rightBigrams) {
    rightCounts.set(bigram, (rightCounts.get(bigram) ?? 0) + 1);
  }

  let intersection = 0;
  for (const bigram of leftBigrams) {
    const count = rightCounts.get(bigram) ?? 0;
    if (count > 0) {
      intersection++;
      rightCounts.set(bigram, count - 1);
    }
  }

  return (2 * intersection * 100) / (leftBigrams.length + rightBigrams.length);
};

const cosineSimilarity = (left: string, right: string): number => {
  const termFrequency = (value: string): Map<string, number> => {
    const frequencies = new Map<string, number>();
    for (const term of value.split(' ').filter((entry) => entry.length > 0)) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
    return frequencies;
  };

  const leftFrequencies = termFrequency(left);
  const rightFrequencies = termFrequency(right);
  const terms = new Set([...leftFrequencies.keys(), ...rightFrequencies.keys()]);
  if (terms.size === 0) {
    return left === right ? 100 : 0;
  }

  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (const term of terms) {
    const leftCount = leftFrequencies.get(term) ?? 0;
    const rightCount = rightFrequencies.get(term) ?? 0;
    dotProduct += leftCount * rightCount;
    leftMagnitude += leftCount * leftCount;
    rightMagnitude += rightCount * rightCount;
  }

  const magnitude = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return magnitude === 0 ? 0 : (dotProduct / magnitude) * 100;
};

const levenshteinSimilarity = (left: string, right: string): number => {
  if (left === right) {
    return 100;
  }

  const longer = left.length >= right.length ? left : right;
  const shorter = left.length >= right.length ? right : left;
  if (longer.length === 0) {
    return 100;
  }

  let previous = Array.from(
    { length: shorter.length + 1 },
    (_value, index) => index
  );
  for (let longerIndex = 1; longerIndex <= longer.length; longerIndex++) {
    const current = [longerIndex];
    for (let shorterIndex = 1; shorterIndex <= shorter.length; shorterIndex++) {
      const insertion = (current[shorterIndex - 1] ?? 0) + 1;
      const deletion = (previous[shorterIndex] ?? 0) + 1;
      const substitution =
        (previous[shorterIndex - 1] ?? 0) +
        (longer[longerIndex - 1] === shorter[shorterIndex - 1] ? 0 : 1);
      current[shorterIndex] = Math.min(insertion, deletion, substitution);
    }
    previous = current;
  }

  const distance = previous[shorter.length] ?? longer.length;
  return 100 - (distance / longer.length) * 100;
};

const sentenceLengthWeight = (length: number): number =>
  length <= 0 ? 0 : Math.log(length) / 0.2 - 5;

const getStringSimilarityScore = (left: string, right: string): number => {
  const normalizedLeft = normalizeSimilarityText(left);
  const normalizedRight = normalizeSimilarityText(right);
  const shortestLength = Math.min(normalizedLeft.length, normalizedRight.length);
  const averageScore =
    (diceSimilarity(normalizedLeft, normalizedRight) +
      cosineSimilarity(normalizedLeft, normalizedRight) +
      levenshteinSimilarity(normalizedLeft, normalizedRight)) /
    3;

  return averageScore + Math.min(sentenceLengthWeight(shortestLength), 15);
};

const applyTextTransformations = (
  value: string,
  transformations: unknown
): string => {
  if (!Array.isArray(transformations)) {
    return value;
  }

  return transformations.reduce((current, transformation) => {
    if (
      !isRecord(transformation) ||
      typeof transformation.search !== 'string' ||
      typeof transformation.replace !== 'string'
    ) {
      return current;
    }

    const searchRegex = parseSearchRegex(transformation.search);
    return searchRegex === undefined
      ? current
      : current.replace(searchRegex, transformation.replace);
  }, value);
};

const normalizeRepeatUrl = (value: string): string => {
  try {
    const url = new URL(value);
    url.hash = '';
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${
      url.search
    }`;
  } catch {
    return value;
  }
};

const getRepeatActivityIdentifier = (
  activity: ActivitySnapshot,
  config: UnknownRecord
): string | undefined => {
  const rawIdentifier =
    activity.kind === 'submission'
      ? activity.selfPost === true
        ? `${activity.title ?? ''}\n${activity.body}`
        : activity.url === undefined
          ? (activity.title ?? activity.body)
          : normalizeRepeatUrl(activity.url)
      : activity.body;

  const transformed = applyTextTransformations(
    rawIdentifier,
    config.transformations
  );
  const identifier =
    config.caseSensitive === false
      ? transformed.toLowerCase()
      : transformed;
  const normalized = identifier.replace(/\s+/g, ' ').trim();
  const minLength =
    typeof config.minWordCount === 'number' && Number.isFinite(config.minWordCount)
      ? Math.max(0, config.minWordCount)
      : 1;

  return normalized.length >= minLength ? normalized : undefined;
};

type RepeatIdentifierEntry = {
  activity: ActivitySnapshot;
  identifier: string;
};

const getRepeatIdentifierEntries = (
  activities: ActivitySnapshot[],
  config: UnknownRecord
): RepeatIdentifierEntry[] =>
  activities.flatMap((entry) => {
    const identifier = getRepeatActivityIdentifier(entry, config);
    return identifier === undefined ? [] : [{ activity: entry, identifier }];
  });

const getRepeatMatchScore = (config: UnknownRecord): number => {
  const rawMatchScore = config.matchScore;
  const matchScore =
    typeof rawMatchScore === 'number'
      ? rawMatchScore
      : typeof rawMatchScore === 'string'
        ? Number(rawMatchScore)
        : 85;

  return Number.isFinite(matchScore) ? Math.max(0, matchScore) : 85;
};

const repeatIdentifiersMatch = (
  left: string,
  right: string,
  config: UnknownRecord
): boolean =>
  left === right || getStringSimilarityScore(left, right) >= getRepeatMatchScore(config);

const getRepeatIdentifierGroups = (
  entries: RepeatIdentifierEntry[],
  config: UnknownRecord
): string[] => {
  const identifiers: string[] = [];
  for (const entry of entries) {
    if (
      identifiers.some((identifier) =>
        repeatIdentifiersMatch(identifier, entry.identifier, config)
      )
    ) {
      continue;
    }

    identifiers.push(entry.identifier);
  }

  return identifiers;
};

const countRepeatRun = (
  entries: RepeatIdentifierEntry[],
  startIndex: number,
  gapAllowance: number,
  config: UnknownRecord
): number => {
  const target = entries[startIndex]?.identifier;
  if (target === undefined) {
    return 0;
  }

  let count = 0;
  let gapCount = 0;
  for (let index = startIndex; index < entries.length; index++) {
    const entry = entries[index];
    if (entry === undefined) {
      continue;
    }

    if (repeatIdentifiersMatch(entry.identifier, target, config)) {
      count++;
      gapCount = 0;
      continue;
    }

    gapCount++;
    if (gapCount > gapAllowance) {
      break;
    }
  }

  return count;
};

const evaluateRepeatActivityRule = (
  rule: NormalizedRule & { type: 'rule' },
  activity: ActivitySnapshot
): RuleEvaluation => {
  if (activity.authorHistory === undefined) {
    return {
      name: normalizeName(rule.name, rule.kind),
      triggered: false,
      supported: false,
      reason: 'author history was not hydrated',
    };
  }

  const gapAllowance =
    typeof rule.config.gapAllowance === 'number' &&
    Number.isFinite(rule.config.gapAllowance)
      ? Math.max(0, Math.floor(rule.config.gapAllowance))
      : 0;
  const threshold = rule.config.threshold ?? '> 5';
  const referenceIdentifier = getRepeatActivityIdentifier(activity, rule.config);
  let activities = [
    activity,
    ...getWindowedHistory(activity, rule.config.window).filter(
      (entry) => entry.id !== activity.id
    ),
  ];

  if (rule.config.keepRemoved !== true) {
    activities = activities.filter((entry) => !entry.removed);
  }

  activities = filterHistoryByKind(
    activities,
    rule.config.lookAt,
    rule.config.window
  );
  activities = filterHistoryBySubreddit(
    activities,
    rule.config,
    rule.config,
    activity
  );

  const entries = getRepeatIdentifierEntries(activities, rule.config);
  const identifiers =
    rule.config.useSubmissionAsReference === false
      ? getRepeatIdentifierGroups(entries, rule.config)
      : referenceIdentifier === undefined
        ? []
        : [referenceIdentifier];
  const summaries = identifiers.map((identifier) => {
    const largestRepeat = entries.reduce((largest, entry, index) => {
      if (!repeatIdentifiersMatch(entry.identifier, identifier, rule.config)) {
        return largest;
      }
      return Math.max(
        largest,
        countRepeatRun(entries, index, gapAllowance, rule.config)
      );
    }, 0);
    return { identifier, largestRepeat };
  });
  const thresholdResults = summaries.map((summary) =>
    valueMatchesNumberComparison(threshold, summary.largestRepeat, '>=')
  );
  const supportedResults = thresholdResults.filter(
    (result) => result !== undefined
  );
  const largestRepeat = summaries.reduce(
    (largest, summary) => Math.max(largest, summary.largestRepeat),
    0
  );
  const triggeringSets = thresholdResults.filter(Boolean).length;

  return {
    name: normalizeName(rule.name, rule.kind),
    triggered: thresholdResults.some(Boolean),
    supported: supportedResults.length === thresholdResults.length,
    reason: `repeat scan found ${triggeringSets}/${summaries.length} identifier(s) at ${String(
      threshold
    )}; largest repeat ${largestRepeat}; matchScore ${getRepeatMatchScore(
      rule.config
    )}`,
    templateData: {
      gapAllowance,
      largestRepeat,
      result: `${triggeringSets} of ${summaries.length} unique items repeated ${String(
        threshold
      )}; largest repeat: ${largestRepeat}`,
      threshold: String(threshold),
      totalTriggeringSets: triggeringSets,
      window: activities.length,
    },
  };
};

type AttributionDomain = {
  key: string;
  type: 'link' | 'media' | 'redditMedia' | 'self';
};

const stripWww = (value: string): string => value.replace(/^www\./i, '');

const getAttributionDomain = (
  activity: ActivitySnapshot,
  consolidateMediaDomains: boolean
): AttributionDomain | undefined => {
  if (activity.kind !== 'submission') {
    return undefined;
  }

  if (activity.selfPost === true || activity.url === undefined) {
    return {
      key: `self.${activity.subredditName}`,
      type: 'self',
    };
  }

  try {
    const url = new URL(activity.url);
    const host = stripWww(url.hostname.toLowerCase());
    const mediaHosts = [
      'youtube.com',
      'youtu.be',
      'vimeo.com',
      'twitch.tv',
      'tiktok.com',
      'soundcloud.com',
    ];
    const redditMediaHosts = ['i.redd.it', 'v.redd.it', 'redd.it'];

    if (redditMediaHosts.includes(host)) {
      return {
        key: host,
        type: 'redditMedia',
      };
    }

    if (host === 'reddit.com' || host.endsWith('.reddit.com')) {
      return {
        key: `self.${activity.subredditName}`,
        type: 'self',
      };
    }

    if (mediaHosts.some((mediaHost) => host === mediaHost || host.endsWith(`.${mediaHost}`))) {
      return {
        key: consolidateMediaDomains
          ? host
          : normalizeRepeatUrl(activity.url),
        type: 'media',
      };
    }

    return {
      key: host,
      type: 'link',
    };
  } catch {
    return {
      key: activity.url,
      type: 'link',
    };
  }
};

const domainMatchesExpected = (expected: string, actual: string): boolean =>
  actual.toLowerCase().includes(expected.toLowerCase());

type AttributionCriterionResult = {
  triggered: boolean;
  templateData: RuleTemplateData;
};

const evaluateAttributionCriterion = (
  criterion: UnknownRecord,
  activity: ActivitySnapshot
): AttributionCriterionResult | undefined => {
  const threshold = criterion.threshold ?? '> 10%';
  const consolidateMediaDomains = criterion.consolidateMediaDomains === true;
  const allActivities = [
    activity,
    ...getWindowedHistory(activity, criterion.window).filter(
      (entry) => entry.id !== activity.id
    ),
  ];
  const filteredActivities = filterHistoryBySubreddit(
    allActivities,
    criterion,
    criterion,
    activity
  );
  const minActivityCount =
    typeof criterion.minActivityCount === 'number' &&
    Number.isFinite(criterion.minActivityCount)
      ? criterion.minActivityCount
      : 10;
  if (filteredActivities.length < minActivityCount) {
    return {
      triggered: false,
      templateData: {
        activityTotal: filteredActivities.length,
        result: 'No criteria had their min activity count met',
        threshold: String(threshold),
        window: filteredActivities.length,
      },
    };
  }

  const thresholdOnSubmissions =
    criterion.thresholdOn === 'submissions' ||
    getHistoryActivityKind(undefined, criterion.window) === 'submission';
  const denominator = thresholdOnSubmissions
    ? filteredActivities.filter((entry) => entry.kind === 'submission').length
    : filteredActivities.length;
  if (denominator === 0) {
    return {
      triggered: false,
      templateData: {
        activityTotal: 0,
        result: 'No activities available for attribution threshold',
        threshold: String(threshold),
        window: filteredActivities.length,
      },
    };
  }

  const aggregateOn = Array.isArray(criterion.aggregateOn)
    ? criterion.aggregateOn
    : ['link', 'media'];
  const currentDomain = getAttributionDomain(activity, consolidateMediaDomains);
  const configuredDomains = Array.isArray(criterion.domains)
    ? criterion.domains
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) =>
          entry === 'AGG:SELF' && currentDomain !== undefined
            ? currentDomain.key
            : entry
        )
    : [];
  const aggregates = new Map<string, number>();

  for (const entry of filteredActivities) {
    const domain = getAttributionDomain(entry, consolidateMediaDomains);
    if (domain === undefined) {
      continue;
    }

    if (
      aggregateOn.length > 0 &&
      !aggregateOn.includes(domain.type)
    ) {
      continue;
    }

    if (
      configuredDomains.length > 0 &&
      !configuredDomains.some((expected) =>
        domainMatchesExpected(expected, domain.key)
      )
    ) {
      continue;
    }

    aggregates.set(domain.key, (aggregates.get(domain.key) ?? 0) + 1);
  }

  if (aggregates.size === 0) {
    return {
      triggered: false,
      templateData: {
        activityTotal: denominator,
        result: 'No attribution domains found',
        threshold: String(threshold),
        window: filteredActivities.length,
      },
    };
  }

  const rows =
    criterion.domainsCombined === true
      ? [
          {
            count: [...aggregates.values()].reduce(
              (total, count) => total + count,
              0
            ),
            domain: [...aggregates.keys()].join(' and '),
          },
        ]
      : [...aggregates.entries()].map(([domain, count]) => ({ count, domain }));
  const testedRows = rows.map((row) => ({
    ...row,
    percent: Math.round((row.count / denominator) * 100),
    triggered:
      valueMatchesCountOrPercentComparison(threshold, row.count, denominator) ??
      false,
  }));
  const largestCount = testedRows.reduce(
    (largest, row) => Math.max(largest, row.count),
    0
  );
  const smallestCount = testedRows.reduce(
    (smallest, row) => Math.min(smallest, row.count),
    testedRows[0]?.count ?? 0
  );
  const largestPercent = testedRows.reduce(
    (largest, row) => Math.max(largest, row.percent),
    0
  );
  const smallestPercent = testedRows.reduce(
    (smallest, row) => Math.min(smallest, row.percent),
    testedRows[0]?.percent ?? 0
  );
  const triggeredRows = testedRows.filter((row) => row.triggered);

  return {
    triggered: triggeredRows.length > 0,
    templateData: {
      activityTotal: denominator,
      countRange:
        smallestCount === largestCount
          ? largestCount
          : `${smallestCount} - ${largestCount}`,
      domainsDelim: triggeredRows.map((row) => row.domain).join(', '),
      largestCount,
      largestPercent,
      largestPercentage: `${largestPercent}%`,
      percentRange:
        smallestPercent === largestPercent
          ? `${largestPercent}%`
          : `${smallestPercent}% - ${largestPercent}%`,
      result: `${triggeredRows.length} attribution(s) met ${String(threshold)}`,
      smallestCount,
      smallestPercent,
      threshold: String(threshold),
      titlesDelim: triggeredRows.map((row) => row.domain).join(', '),
      triggeredDomainCount: triggeredRows.length,
      window: filteredActivities.length,
    },
  };
};

const evaluateAttributionRule = (
  rule: NormalizedRule & { type: 'rule' },
  activity: ActivitySnapshot
): RuleEvaluation => {
  if (activity.authorHistory === undefined) {
    return {
      name: normalizeName(rule.name, rule.kind),
      triggered: false,
      supported: false,
      reason: 'author history was not hydrated',
    };
  }

  const criteria = Array.isArray(rule.config.criteria)
    ? rule.config.criteria
    : [{ threshold: '> 10%', window: 100 }];
  const results = criteria.flatMap((criterion) =>
    isRecord(criterion) ? [evaluateAttributionCriterion(criterion, activity)] : []
  );
  const supportedResults = results.filter((result) => result !== undefined);
  const triggeredResults = supportedResults.filter((result) => result.triggered);
  const triggered =
    rule.config.criteriaJoin === 'AND'
      ? supportedResults.length > 0 &&
        supportedResults.every((result) => result.triggered)
      : triggeredResults.length > 0;
  const templateData =
    triggeredResults[0]?.templateData ?? supportedResults[0]?.templateData;

  return {
    name: normalizeName(rule.name, rule.kind),
    triggered,
    supported: supportedResults.length === results.length && results.length > 0,
    reason: `evaluated ${supportedResults.length}/${criteria.length} attribution criteria with local domain aggregation`,
    ...(templateData === undefined ? {} : { templateData }),
  };
};

type RepostFacetKind = 'title' | 'url' | 'duplicates' | 'crossposts' | 'external';
type RepostFacet = {
  kind: RepostFacetKind;
  config: UnknownRecord;
};

const isRepostFacetKind = (value: unknown): value is RepostFacetKind =>
  value === 'title' ||
  value === 'url' ||
  value === 'duplicates' ||
  value === 'crossposts' ||
  value === 'external';

const getRepostFacets = (
  criteria: UnknownRecord,
  activityKind: ActivitySnapshot['kind']
): RepostFacet[] => {
  const rawSearchOn = Array.isArray(criteria.searchOn)
    ? criteria.searchOn
    : activityKind === 'comment'
      ? ['external', 'duplicates', 'crossposts']
      : ['title', 'url', 'duplicates', 'crossposts'];

  return rawSearchOn.flatMap((entry) => {
    if (isRepostFacetKind(entry)) {
      return [{ kind: entry, config: {} }];
    }
    if (!isRecord(entry)) {
      return [];
    }
    const kinds = Array.isArray(entry.kind) ? entry.kind : [entry.kind];
    return kinds.flatMap((kind) =>
      isRepostFacetKind(kind) ? [{ kind, config: entry }] : []
    );
  });
};

const wordCount = (value: string): number =>
  value
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0).length;

const normalizeComparableText = (value: string, caseSensitive: boolean): string => {
  const normalized = value.replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return caseSensitive ? normalized : normalized.toLowerCase();
};

const textSimilarityScore = (
  left: string,
  right: string,
  caseSensitive: boolean
): number => {
  const normalizedLeft = normalizeComparableText(left, caseSensitive);
  const normalizedRight = normalizeComparableText(right, caseSensitive);
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) {
    return 0;
  }
  if (normalizedLeft === normalizedRight) {
    return 100;
  }

  const leftTokens = new Set(normalizedLeft.split(' '));
  const rightTokens = new Set(normalizedRight.split(' '));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token))
    .length;
  return Math.round(
    (intersection / Math.max(leftTokens.size, rightTokens.size)) * 100
  );
};

const repostCandidateMatchesFacet = (
  activity: ActivitySnapshot,
  candidate: ActivitySnapshot,
  facet: RepostFacet
): boolean => {
  if (activity.kind === 'comment' && candidate.kind === 'comment') {
    if (
      facet.kind !== 'duplicates' &&
      facet.kind !== 'crossposts' &&
      facet.kind !== 'external'
    ) {
      return false;
    }

    if (candidate.repostCandidateSource !== facet.kind) {
      return false;
    }

    const minWordCount =
      typeof facet.config.minWordCount === 'number'
        ? facet.config.minWordCount
        : 3;
    if (wordCount(candidate.body) < minWordCount) {
      return false;
    }
    const matchScore =
      typeof facet.config.matchScore === 'number' ? facet.config.matchScore : 85;
    return (
      textSimilarityScore(
        activity.body,
        candidate.body,
        facet.config.caseSensitive === true
      ) >= matchScore
    );
  }

  switch (facet.kind) {
    case 'url': {
      if (activity.url !== undefined && candidate.url !== undefined) {
        if (normalizeRepeatUrl(activity.url) === normalizeRepeatUrl(candidate.url)) {
          return true;
        }
        if (
          activity.imageHash &&
          candidate.imageHash &&
          activity.flippedImageHash &&
          candidate.flippedImageHash
        ) {
          const matchScore =
            typeof facet.config.matchScore === 'number' ? facet.config.matchScore : 95;
          return compareImages(
            activity.imageHash,
            activity.flippedImageHash,
            candidate.imageHash,
            matchScore
          );
        }
      }
      return false;
    }
    case 'duplicates':
      return candidate.repostCandidateSource === 'duplicates';
    case 'crossposts':
      return candidate.repostCandidateSource === 'crossposts';
    case 'title': {
      if (activity.title === undefined || candidate.title === undefined) {
        return false;
      }
      const minWordCount =
        typeof facet.config.minWordCount === 'number'
          ? facet.config.minWordCount
          : 2;
      if (wordCount(candidate.title) < minWordCount) {
        return false;
      }
      const matchScore =
        typeof facet.config.matchScore === 'number' ? facet.config.matchScore : 85;
      return (
        textSimilarityScore(
          activity.title,
          candidate.title,
          facet.config.caseSensitive === true
        ) >= matchScore
      );
    }
    case 'external':
      return candidate.repostCandidateSource === 'external';
  }
};

const getRepostOccurrenceTests = (criteria: UnknownRecord): unknown[] => {
  if (
    isRecord(criteria.occurrences) &&
    Array.isArray(criteria.occurrences.criteria)
  ) {
    return criteria.occurrences.criteria;
  }

  return [
    {
      count: {
        test: ['> 0'],
      },
    },
  ];
};

const repostOccurrencesMatch = (
  criteria: UnknownRecord,
  matches: ActivitySnapshot[]
): boolean | undefined => {
  const baseOccurrenceTests = getRepostOccurrenceTests(criteria);
  const occurrenceTests = isRecord(criteria.occurredAt)
    ? [
        ...baseOccurrenceTests,
        {
          time: criteria.occurredAt,
        },
      ]
    : baseOccurrenceTests;
  const occurrenceCondition =
    isRecord(criteria.occurrences) && criteria.occurrences.condition === 'OR'
      ? 'OR'
      : 'AND';
  const results = occurrenceTests.flatMap((test) => {
    if (!isRecord(test)) {
      return [];
    }
    const occurrenceResults: (boolean | undefined)[] = [];

    if (test.count !== undefined || test.time === undefined) {
      const countConfig = isRecord(test.count) ? test.count : {};
      const comparisons = Array.isArray(countConfig.test)
        ? countConfig.test
        : ['> 0'];
      const countCondition = countConfig.condition === 'OR' ? 'OR' : 'AND';
      const comparisonResults = comparisons
        .map((comparison) =>
          valueMatchesNumberComparison(comparison, matches.length, '>=')
        )
        .filter((result) => result !== undefined);

      occurrenceResults.push(
        comparisonResults.length === 0
          ? undefined
          : countCondition === 'OR'
            ? comparisonResults.some(Boolean)
            : comparisonResults.every(Boolean)
      );
    }

    if (test.time !== undefined) {
      occurrenceResults.push(repostTimeCriteriaMatch(test.time, matches));
    }

    return [
      occurrenceResults.some((result) => result === undefined)
        ? undefined
        : occurrenceResults.every(Boolean),
    ];
  });
  const supportedResults = results.filter((result) => result !== undefined);

  if (supportedResults.length !== results.length || supportedResults.length === 0) {
    return undefined;
  }

  return occurrenceCondition === 'OR'
    ? supportedResults.some(Boolean)
    : supportedResults.every(Boolean);
};

const getRepostTimeTests = (timeConfig: unknown): UnknownRecord[] => {
  if (!isRecord(timeConfig)) {
    return [];
  }

  const tests = Array.isArray(timeConfig.test)
    ? timeConfig.test
    : Array.isArray(timeConfig.criteria)
      ? timeConfig.criteria
      : [];
  return tests.filter(isRecord);
};

const getSelectedRepostTimes = (
  testOn: unknown,
  matches: ActivitySnapshot[]
): ActivitySnapshot[] => {
  const sorted = [...matches].sort(
    (left, right) => right.createdAt.getTime() - left.createdAt.getTime()
  );

  switch (testOn) {
    case 'all':
      return sorted;
    case 'newest':
      return sorted.slice(0, 1);
    case 'oldest':
      return sorted.slice(-1);
    case 'any':
    default:
      return sorted;
  }
};

const repostTimeTestMatches = (
  test: UnknownRecord,
  matches: ActivitySnapshot[]
): boolean | undefined => {
  const selected = getSelectedRepostTimes(test.testOn, matches);
  if (selected.length === 0) {
    return false;
  }
  const condition = test.condition;
  const results = selected.map((match) =>
    valueMatchesDurationComparison(
      condition,
      Math.max(0, Date.now() - match.createdAt.getTime())
    )
  );
  if (results.some((result) => result === undefined)) {
    return undefined;
  }

  return test.testOn === 'all' ? results.every(Boolean) : results.some(Boolean);
};

const repostTimeCriteriaMatch = (
  timeConfig: unknown,
  matches: ActivitySnapshot[]
): boolean | undefined => {
  const tests = getRepostTimeTests(timeConfig);
  if (tests.length === 0) {
    return undefined;
  }

  const condition =
    isRecord(timeConfig) && timeConfig.condition === 'OR' ? 'OR' : 'AND';
  const results = tests.map((test) => repostTimeTestMatches(test, matches));
  if (results.some((result) => result === undefined)) {
    return undefined;
  }

  return condition === 'OR' ? results.some(Boolean) : results.every(Boolean);
};

type RepostCriterionResult = {
  triggered: boolean;
  templateData: RuleTemplateData;
};

const evaluateRepostCriterion = (
  criteria: UnknownRecord,
  activity: ActivitySnapshot
): RepostCriterionResult | undefined => {
  const facets = getRepostFacets(criteria, activity.kind);
  if (facets.length === 0) {
    return undefined;
  }

  const candidates = getWindowedActivities(
    activity.repostCandidates ?? [],
    criteria.window ?? 20,
    activity
  ).filter((candidate) => candidate.id !== activity.id);
  const matches = new Map<string, ActivitySnapshot>();

  for (const candidate of candidates) {
    if (
      facets.some((facet) => repostCandidateMatchesFacet(activity, candidate, facet))
    ) {
      matches.set(candidate.id, candidate);
    }
  }

  const matchedCandidates = [...matches.values()];
  const triggered = repostOccurrencesMatch(criteria, matchedCandidates);
  if (triggered === undefined) {
    return undefined;
  }

  return {
    triggered,
    templateData: {
      closestSameness: matches.size > 0 ? 100 : 0,
      closestSummary:
        matches.size > 0
          ? `matched a ${activity.kind === 'comment' ? 'comment' : 'submission'} repost candidate`
          : undefined,
      count: matches.size,
      result: `found ${matches.size} repost candidate(s)`,
      totalCount: matches.size,
    },
  };
};

const evaluateRepostRule = (
  rule: NormalizedRule & { type: 'rule' },
  activity: ActivitySnapshot
): RuleEvaluation => {
  if (activity.repostCandidates === undefined) {
    return {
      name: normalizeName(rule.name, rule.kind),
      triggered: false,
      supported: false,
      reason: 'repost candidates were not hydrated',
    };
  }

  const criteria = Array.isArray(rule.config.criteria) ? rule.config.criteria : [{}];
  const results = criteria.flatMap((criterion) =>
    isRecord(criterion) ? [evaluateRepostCriterion(criterion, activity)] : []
  );
  const supportedResults = results.filter((result) => result !== undefined);
  const triggeredResults = supportedResults.filter((result) => result.triggered);
  const triggered =
    rule.config.condition === 'AND'
      ? supportedResults.length > 0 &&
        supportedResults.every((result) => result.triggered)
      : triggeredResults.length > 0;
  const templateData =
    triggeredResults[0]?.templateData ?? supportedResults[0]?.templateData;

  return {
    name: normalizeName(rule.name, rule.kind),
    triggered,
    supported: supportedResults.length === results.length && results.length > 0,
    reason: `evaluated ${supportedResults.length}/${criteria.length} repost criteria against ${
      activity.repostCandidates.length
    } hydrated duplicate/crosspost/external candidate(s)`,
    ...(templateData === undefined ? {} : { templateData }),
  };
};

const evaluateAuthorRule = (
  rule: NormalizedRule & { type: 'rule' },
  activity: ActivitySnapshot,
  registry: ConfigRegistry
): RuleEvaluation => {
  const filter = evaluateAuthorFilter(rule.config, activity, registry);
  if (filter.result !== undefined) {
    return {
      name: normalizeName(rule.name, rule.kind),
      triggered: filter.result,
      supported: filter.supported,
      reason: filter.reason ?? 'evaluated supported author criteria',
    };
  }

  return {
    name: normalizeName(rule.name, rule.kind),
    triggered: false,
    supported: false,
    reason: 'author rule has no include or exclude criteria',
  };
};

const evaluateMhsRule = (
  rule: NormalizedRule & { type: 'rule' },
  activity: ActivitySnapshot
): RuleEvaluation => {
  if (activity.toxicity === undefined) {
    return {
      name: normalizeName(rule.name, rule.kind),
      triggered: false,
      supported: false,
      reason: 'toxicity classification was not hydrated (geminiApiKey missing?)',
    };
  }

  const { flagged, confidence } = activity.toxicity;

  let triggered = false;
  if (flagged) {
    const configConfidence = typeof rule.config.confidence === 'number' ? rule.config.confidence : 0.8;
    // Note: old MHS confidence was a probability or percentage. The new Gemini prompt outputs 0-100.
    const normalizedConfidence = confidence > 1 ? confidence / 100 : confidence;
    if (normalizedConfidence >= configConfidence) {
      triggered = true;
    }
  }

  return {
    name: normalizeName(rule.name, rule.kind),
    triggered,
    supported: true,
    reason: `toxicity classification ${triggered ? 'matched' : 'did not match'} criteria`,
  };
};

const evaluateRule = (
  rule: NormalizedRule,
  activity: ActivitySnapshot,
  registry: ConfigRegistry,
  visitedReferences: Set<string> = new Set()
): RuleEvaluation => {
  if (rule.type === 'reference') {
    const referenceName = normalizeReferenceName(rule.ref);
    const resolvedRule = registry.rules.get(referenceName);
    if (resolvedRule !== undefined) {
      if (visitedReferences.has(referenceName)) {
        return {
          name: rule.ref,
          triggered: false,
          supported: false,
          reason: 'circular named rule reference detected',
        };
      }

      const resolved = evaluateRule(
        resolvedRule,
        activity,
        registry,
        new Set([...visitedReferences, referenceName])
      );
      return {
        ...resolved,
        name: rule.ref,
        reason: `resolved named rule: ${resolved.reason}`,
      };
    }

    return {
      name: rule.ref,
      triggered: false,
      supported: false,
      reason: 'named rule reference was not found',
    };
  }

  if (rule.type === 'include') {
    return {
      name: rule.include.path,
      triggered: false,
      supported: false,
      reason: 'config include was not hydrated before dry-run planning',
    };
  }

  if (rule.type === 'ruleSet') {
    const filter = evaluateRunnableFilters(rule.config, activity, registry);
    if (filter.result === false) {
      return {
        name: normalizeName(rule.name, 'ruleSet'),
        triggered: false,
        supported: filter.supported,
        reason: filter.reason ?? 'ruleSet filters did not pass',
      };
    }

    const results = rule.rules.map((childRule) =>
      evaluateRule(childRule, activity, registry, visitedReferences)
    );
    const supported =
      results.every((result) => result.supported) && filter.supported;
    const triggered =
      rule.condition === 'AND'
        ? results.every((result) => result.triggered)
        : results.some((result) => result.triggered);

    return {
      name: normalizeName(rule.name, 'ruleSet'),
      triggered,
      supported,
      reason: combineFilterReasons(
        `${rule.condition} rule set evaluated ${results.length} child rule(s)`,
        filter
      ),
    };
  }

  const filter = evaluateRunnableFilters(rule.config, activity, registry);
  if (filter.result === false) {
    return {
      name: normalizeName(rule.name, rule.kind),
      triggered: false,
      supported: filter.supported,
      reason: filter.reason ?? 'rule filters did not pass',
    };
  }

  let result: RuleEvaluation;
  switch (rule.kind) {
    case 'regex':
      result = evaluateRegexRule(rule, activity);
      break;
    case 'author':
      result = evaluateAuthorRule(rule, activity, registry);
      break;
    case 'history':
      result = evaluateHistoryRule(rule, activity);
      break;
    case 'recentActivity':
      result = evaluateRecentActivityRule(rule, activity);
      break;
    case 'sentiment':
      result = evaluateSentimentRule(rule, activity);
      break;
    case 'repeatActivity':
      result = evaluateRepeatActivityRule(rule, activity);
      break;
    case 'attribution':
      result = evaluateAttributionRule(rule, activity);
      break;
    case 'repost':
      result = evaluateRepostRule(rule, activity);
      break;
    case 'mhs':
    case 'toxicity':
      result = evaluateMhsRule(rule, activity);
      break;
    default:
      result = {
        name: normalizeName(rule.name, rule.kind),
        triggered: false,
        supported: false,
        reason: `${rule.kind} rule evaluation is not ported in the Devvit migration`,
      };
  }

  return {
    ...result,
    supported: result.supported && filter.supported,
    reason: combineFilterReasons(result.reason, filter),
  };
};

const templateNamesForRule = (rule: RuleEvaluation): string[] => {
  const normalized = normalizeReferenceName(rule.name);
  const compact = normalizeTemplateName(rule.name);
  return [...new Set([normalized, compact].filter((name) => name.length > 0))];
};

const buildActionTemplateContext = (
  rules: RuleEvaluation[]
): ActionTemplateContext | undefined => {
  if (rules.length === 0) {
    return undefined;
  }

  const ruleTemplates: Record<string, RuleTemplateData> = {};
  for (const rule of rules) {
    const data: RuleTemplateData = {
      result: rule.templateData?.result ?? rule.reason,
      supported: rule.supported,
      triggered: rule.triggered,
      ...rule.templateData,
    };
    for (const name of templateNamesForRule(rule)) {
      ruleTemplates[name] = data;
    }
  }

  return Object.keys(ruleTemplates).length === 0
    ? undefined
    : { rules: ruleTemplates };
};

const planActions = (
  actions: NormalizedAction[],
  activity: ActivitySnapshot,
  registry: ConfigRegistry,
  templateContext?: ActionTemplateContext,
  planningSupported = true
): PlannedAction[] => {
  const plannedActions: PlannedAction[] = [];

  for (const action of actions) {
    if (action.type === 'reference') {
      const resolvedAction = registry.actions.get(normalizeReferenceName(action.ref));
      if (resolvedAction !== undefined) {
        plannedActions.push(
          ...planActions([resolvedAction], activity, registry, templateContext).map(
            (planned) => ({
              ...planned,
              supported: planningSupported && planned.supported !== false,
              name: planned.name ?? action.ref,
              reason: `resolved named action: ${planned.reason}`,
            })
          )
        );
        continue;
      }

      plannedActions.push({
        kind: 'reference',
        name: action.ref,
        enabled: false,
        dryRun: true,
        supported: false,
        reason: 'named action reference was not found',
      });
      continue;
    }

    if (action.type === 'include') {
      plannedActions.push({
        kind: 'include',
        name: action.include.path,
        enabled: false,
        dryRun: true,
        supported: false,
        reason: 'config include was not hydrated before dry-run planning',
      });
      continue;
    }

    const filter = evaluateRunnableFilters(action.config, activity, registry);
    if (filter.result === false) {
      continue;
    }

    const reason = action.enabled
      ? 'planned only; moderator actions are still disabled'
      : 'action is disabled in config';
    const actionSupported = planningSupported && filter.supported;

    plannedActions.push({
      kind: action.kind,
      ...(action.name === undefined ? {} : { name: action.name }),
      enabled: action.enabled,
      dryRun: true,
      supported: actionSupported,
      reason: combineFilterReasons(reason, filter),
      config: action.config,
      ...(templateContext === undefined ? {} : { templateContext }),
    });
  }

  return plannedActions;
};

const evaluateCheck = (
  check: NormalizedCheck,
  activity: ActivitySnapshot,
  registry: ConfigRegistry,
  inheritedFilter: FilterEvaluation = { result: undefined, supported: true },
  filterDefaults?: FilterDefaults
): CheckEvaluation => {
  if (!check.enabled) {
    return {
      name: check.name,
      kind: check.kind,
      triggered: false,
      supported: true,
      skipped: true,
      reason: 'check disabled',
      rules: [],
      plannedActions: [],
    };
  }

  if (check.kind !== activity.kind) {
    return {
      name: check.name,
      kind: check.kind,
      triggered: false,
      supported: true,
      skipped: true,
      reason: `check is for ${check.kind}, activity is ${activity.kind}`,
      rules: [],
      plannedActions: [],
    };
  }

  const filter = evaluateRunnableFilters(
    check.config,
    activity,
    registry,
    filterDefaults
  );
  if (filter.result === false) {
    return {
      name: check.name,
      kind: check.kind,
      triggered: false,
      supported: filter.supported,
      skipped: true,
      reason: filter.reason ?? 'check filters did not pass',
      rules: [],
      plannedActions: [],
    };
  }

  const rules = check.rules.map((rule) => evaluateRule(rule, activity, registry));
  const supported =
    rules.every((rule) => rule.supported) &&
    filter.supported &&
    inheritedFilter.supported;
  const triggered =
    rules.length === 0
      ? true
      : check.condition === 'AND'
        ? rules.every((rule) => rule.triggered)
        : rules.some((rule) => rule.triggered);
  const plannedActions = triggered
    ? planActions(
        check.actions,
        activity,
        registry,
        buildActionTemplateContext(rules),
        supported
      )
    : [];

  return {
    name: check.name,
    kind: check.kind,
    triggered,
    supported,
    skipped: false,
    reason: combineFilterReasons(
      triggered
        ? 'check triggered in dry run'
        : 'check did not trigger in dry run',
      inheritedFilter,
      filter
    ),
    rules,
    plannedActions,
  };
};

type FlowBehavior = {
  behavior: string;
  goto?: string;
};

const normalizeNameForFlow = (name: string): string =>
  name.trim().toLowerCase().replace(/\s+/g, ' ');

const getPostBehavior = (value: unknown, fallback: string): FlowBehavior => {
  const rawBehavior =
    typeof value === 'string'
      ? value
      : isRecord(value) && typeof value.behavior === 'string'
        ? value.behavior
        : fallback;
  const behavior = rawBehavior.trim();
  const goto = behavior.toLowerCase().startsWith('goto:')
    ? behavior.slice('goto:'.length).trim()
    : undefined;

  return {
    behavior: behavior.length === 0 ? fallback : behavior,
    ...(goto === undefined || goto.length === 0 ? {} : { goto }),
  };
};

const getGlobalPostBehaviorDefaults = (
  config: NormalizedConfig
): { postTrigger: string; postFail: string } => {
  const defaults = isRecord(config.config.postCheckBehaviorDefaults)
    ? config.config.postCheckBehaviorDefaults
    : {};

  return {
    postTrigger: getPostBehavior(defaults.postTrigger, 'nextRun').behavior,
    postFail: getPostBehavior(defaults.postFail, 'next').behavior,
  };
};

const getRunPostBehaviorDefaults = (
  run: NormalizedRun,
  globalDefaults: { postTrigger: string; postFail: string }
): { postTrigger: string; postFail: string } => ({
  postTrigger: getPostBehavior(
    run.config.postTrigger,
    globalDefaults.postTrigger
  ).behavior,
  postFail: getPostBehavior(run.config.postFail, globalDefaults.postFail)
    .behavior,
});

type GotoTarget = {
  runIndex: number;
  checkIndex: number;
};

const findRunIndex = (config: NormalizedConfig, runName: string): number =>
  config.runs.findIndex(
    (run) => normalizeNameForFlow(run.name) === normalizeNameForFlow(runName)
  );

const findCheckIndex = (
  run: NormalizedRun,
  activity: ActivitySnapshot,
  checkName: string
): number =>
  run.checks.findIndex(
    (check) =>
      check.kind === activity.kind &&
      normalizeNameForFlow(check.name) === normalizeNameForFlow(checkName)
  );

const resolveGotoTarget = (
  config: NormalizedConfig,
  activity: ActivitySnapshot,
  currentRunIndex: number,
  goto: string
): GotoTarget | undefined => {
  const [rawRunName, rawCheckName] = goto.split('.', 2);
  const runIndex =
    rawRunName === undefined || rawRunName.length === 0
      ? currentRunIndex
      : findRunIndex(config, rawRunName);

  if (runIndex === -1) {
    return undefined;
  }

  if (rawCheckName === undefined) {
    return {
      runIndex,
      checkIndex: 0,
    };
  }

  const targetRun = config.runs[runIndex];
  if (targetRun === undefined) {
    return undefined;
  }

  const checkIndex = findCheckIndex(targetRun, activity, rawCheckName);
  return checkIndex === -1
    ? undefined
    : {
        runIndex,
        checkIndex,
      };
};

const resolveStartTarget = (
  config: NormalizedConfig,
  activity: ActivitySnapshot,
  startAt: string
): GotoTarget | undefined => {
  const explicitTarget = resolveGotoTarget(config, activity, 0, startAt);
  if (explicitTarget !== undefined) {
    return explicitTarget;
  }

  for (const [runIndex, run] of config.runs.entries()) {
    const checkIndex = findCheckIndex(run, activity, startAt);
    if (checkIndex !== -1) {
      return {
        runIndex,
        checkIndex,
      };
    }
  }

  return undefined;
};

export const runDryConfig = (
  config: NormalizedConfig,
  activity: ActivitySnapshot,
  options: DryRunOptions = {}
): DryRunResult => {
  currentBotUsername = options.botUsername;
  try {
  const checkResults: CheckEvaluation[] = [];
  const registry = buildConfigRegistry(config);
  const configFilterDefaults = getFilterDefaults(config.config);
  const globalPostBehaviorDefaults = getGlobalPostBehaviorDefaults(config);
  const gotoHits = new Map<string, number>();
  let runIndex = 0;
  let forcedCheckIndex = 0;
  let stopped = false;

  if (options.startAt !== undefined && options.startAt.trim().length > 0) {
    const target = resolveStartTarget(config, activity, options.startAt.trim());
    if (target !== undefined) {
      runIndex = target.runIndex;
      forcedCheckIndex = target.checkIndex;
    } else {
      throw new Error(`Could not resolve goto target '${options.startAt.trim()}'`);
    }
  }

  while (runIndex < config.runs.length && !stopped) {
    const run = config.runs[runIndex];
    if (run === undefined) {
      break;
    }

    if (!run.enabled) {
      runIndex++;
      forcedCheckIndex = 0;
      continue;
    }

    const runFilter = evaluateRunnableFilters(run.config, activity, registry);
    if (runFilter.result === false) {
      runIndex++;
      forcedCheckIndex = 0;
      continue;
    }

    const checkFilterDefaults =
      getFilterDefaults(run.config) ?? configFilterDefaults;
    const runPostBehaviorDefaults = getRunPostBehaviorDefaults(
      run,
      globalPostBehaviorDefaults
    );
    let checkIndex = forcedCheckIndex;
    forcedCheckIndex = 0;
    let advanceRun = true;

    while (checkIndex < run.checks.length && !stopped) {
      const check = run.checks[checkIndex];
      if (check === undefined) {
        break;
      }

      const evaluated = evaluateCheck(
        check,
        activity,
        registry,
        runFilter,
        checkFilterDefaults
      );
      if (evaluated.skipped) {
        checkResults.push(evaluated);
        checkIndex++;
        continue;
      }

      const postBehavior = getPostBehavior(
        evaluated.triggered ? check.config.postTrigger : check.config.postFail,
        evaluated.triggered
          ? runPostBehaviorDefaults.postTrigger
          : runPostBehaviorDefaults.postFail
      );
      const resultWithBehavior: CheckEvaluation = {
        ...evaluated,
        postBehavior: postBehavior.behavior,
      };
      checkResults.push(resultWithBehavior);

      switch (postBehavior.behavior.toLowerCase()) {
        case 'next':
          checkIndex++;
          break;
        case 'nextrun':
          checkIndex = run.checks.length;
          break;
        case 'stop':
          stopped = true;
          break;
        default: {
          if (postBehavior.goto === undefined) {
            checkIndex++;
            break;
          }

          const hitCount = (gotoHits.get(postBehavior.goto) ?? 0) + 1;
          gotoHits.set(postBehavior.goto, hitCount);
          if (hitCount > 1) {
            stopped = true;
            break;
          }

          const target = resolveGotoTarget(
            config,
            activity,
            runIndex,
            postBehavior.goto
          );
          if (target === undefined) {
            stopped = true;
            break;
          }

          if (target.runIndex === runIndex) {
            checkIndex = target.checkIndex;
          } else {
            runIndex = target.runIndex;
            forcedCheckIndex = target.checkIndex;
            advanceRun = false;
            checkIndex = run.checks.length;
          }
        }
      }
    }

    if (advanceRun && !stopped) {
      runIndex++;
      forcedCheckIndex = 0;
    }
  }
  const plannedActions = checkResults.flatMap((check) => check.plannedActions);

  return {
    activityId: activity.id,
    checksEvaluated: checkResults.filter((check) => !check.skipped).length,
    checksTriggered: checkResults.filter((check) => check.triggered).length,
    plannedActions,
    checkResults,
  };
  } finally {
    currentBotUsername = undefined;
  }
};

export const summarizeDryRunResult = (result: DryRunResult): string =>
  `Dry run: ${result.checksEvaluated} check(s), ${result.checksTriggered} triggered, ${result.plannedActions.length} planned action(s).`;
