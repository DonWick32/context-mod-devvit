import type { ModNote } from '@devvit/web/server';
import { isT1, isT3, type T1, type T3 } from '@devvit/shared-types/tid.js';
import {
  parseDurationComparison,
  valueMatchesNumberComparison,
} from './comparison';

export type ModNoteSnapshot = {
  id: string;
  type: string;
  createdAt: Date;
  note?: string;
  label?: string;
  redditId?: string;
  actionType?: string;
  actionDescription?: string;
  actionDetails?: string;
  actionTargetId?: string;
};

export type ModNoteCriteriaEvaluation = {
  supported: boolean;
  passed: boolean;
  reason: string;
};

type UnknownRecord = Record<string, unknown>;

const DEFAULT_NOTE_COUNT = '>= 1';

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [value];

const normalizeString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;

const normalizeStringList = (value: unknown): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const values = asArray(value)
    .map(normalizeString)
    .filter((entry): entry is string => entry !== undefined);
  return values.length === 0 ? undefined : values;
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

  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
};

const valueMatchesSearchList = (
  expected: unknown,
  actual: string | undefined
): boolean | undefined => {
  const values = normalizeStringList(expected);
  if (values === undefined) {
    return undefined;
  }
  if (actual === undefined) {
    return false;
  }

  return values.some((value) => parseSearchRegex(value)?.test(actual) === true);
};

const valueMatchesStringList = (
  expected: unknown,
  actual: string | undefined
): boolean | undefined => {
  const values = normalizeStringList(expected);
  if (values === undefined) {
    return undefined;
  }
  if (actual === undefined) {
    return false;
  }

  return values.some((value) => value.toLowerCase() === actual.toLowerCase());
};

const valueMatchesActivityType = (
  expected: unknown,
  redditId: string | undefined
): boolean | undefined => {
  if (expected === undefined) {
    return undefined;
  }

  const values = asArray(expected);
  const supportedValues = values.filter(
    (value) =>
      value === false ||
      value === 'submission' ||
      value === 'comment' ||
      value === 'post'
  );
  if (supportedValues.length === 0) {
    return undefined;
  }

  return supportedValues.some((value) => {
    if (value === false) {
      return redditId === undefined;
    }
    if (value === 'submission' || value === 'post') {
      return redditId !== undefined && isT3(redditId);
    }
    return redditId !== undefined && isT1(redditId);
  });
};

const noteReferencesTarget = (
  note: ModNoteSnapshot,
  targetId: T1 | T3
): boolean => note.redditId === targetId || note.actionTargetId === targetId;

const valueMatchesReference = (
  expected: unknown,
  note: ModNoteSnapshot,
  targetId: T1 | T3
): boolean | undefined =>
  typeof expected === 'boolean'
    ? noteReferencesTarget(note, targetId) === expected
    : undefined;

const getCountConfig = (
  rawCount: unknown
): {
  comparison: unknown;
  durationMs?: number;
  percent: boolean;
  ascending: boolean;
} => {
  const count = rawCount ?? DEFAULT_NOTE_COUNT;
  if (typeof count !== 'string') {
    return {
      comparison: count,
      percent: false,
      ascending: false,
    };
  }

  const durationMatch = count.match(/^(.*?)\s+in\s+(.+)$/i);
  const withoutDuration = (durationMatch?.[1] ?? count).trim();
  const duration = durationMatch?.[2];
  const orderMatch = withoutDuration.match(/^(.*?)(?:\s+(asc|ascending|desc|descending))?$/i);
  const comparison = (orderMatch?.[1] ?? withoutDuration).trim();
  const order = orderMatch?.[2]?.toLowerCase();
  const durationComparison =
    duration === undefined ? undefined : parseDurationComparison(duration);

  return {
    comparison: comparison.length === 0 ? DEFAULT_NOTE_COUNT : comparison,
    ...(durationComparison === undefined
      ? {}
      : { durationMs: durationComparison.milliseconds }),
    percent: comparison.includes('%'),
    ascending: order === 'asc' || order === 'ascending',
  };
};

const applyDurationFilter = (
  notes: ModNoteSnapshot[],
  durationMs: number | undefined,
  now: Date
): ModNoteSnapshot[] => {
  if (durationMs === undefined) {
    return notes;
  }

  const cutoff = now.getTime() - durationMs;
  return notes.filter((note) => note.createdAt.getTime() >= cutoff);
};

const countConsecutiveMatches = (
  notes: ModNoteSnapshot[],
  validNoteIds: Set<string>,
  ascending: boolean
): number => {
  const ordered = ascending ? [...notes].reverse() : notes;
  let current = 0;
  let maximum = 0;

  for (const note of ordered) {
    if (validNoteIds.has(note.id)) {
      current++;
      maximum = Math.max(maximum, current);
    } else {
      current = 0;
    }
  }

  return maximum;
};

const getSearchMode = (criteria: UnknownRecord): 'current' | 'total' | 'consecutive' =>
  criteria.search === 'total' || criteria.search === 'consecutive'
    ? criteria.search
    : 'current';

const getCriteriaMatch = (
  criteria: UnknownRecord,
  note: ModNoteSnapshot,
  targetId: T1 | T3
): boolean | undefined => {
  const results: (boolean | undefined)[] = [];

  if (criteria.type !== undefined) {
    results.push(valueMatchesStringList(criteria.type, note.type));
  }
  if (criteria.noteType !== undefined) {
    results.push(valueMatchesStringList(criteria.noteType, note.label));
  }
  if (criteria.note !== undefined) {
    results.push(valueMatchesSearchList(criteria.note, note.note));
  }
  if (criteria.activityType !== undefined) {
    results.push(valueMatchesActivityType(criteria.activityType, note.redditId));
  }
  if (criteria.referencesCurrentActivity !== undefined) {
    results.push(
      valueMatchesReference(criteria.referencesCurrentActivity, note, targetId)
    );
  }
  if (criteria.action !== undefined) {
    results.push(valueMatchesSearchList(criteria.action, note.actionType));
  }
  if (criteria.description !== undefined) {
    results.push(valueMatchesSearchList(criteria.description, note.actionDescription));
  }
  if (criteria.details !== undefined) {
    results.push(valueMatchesSearchList(criteria.details, note.actionDetails));
  }

  if (results.length === 0) {
    return true;
  }
  if (results.some((result) => result === undefined)) {
    return undefined;
  }

  return results.every(Boolean);
};

export const snapshotFromModNote = (note: ModNote): ModNoteSnapshot => ({
  id: note.id,
  type: note.type,
  createdAt: note.createdAt,
  ...(note.userNote?.note === undefined ? {} : { note: note.userNote.note }),
  ...(note.userNote?.label === undefined ? {} : { label: note.userNote.label }),
  ...(note.userNote?.redditId === undefined
    ? {}
    : { redditId: note.userNote.redditId }),
  ...(note.modAction?.type === undefined
    ? {}
    : { actionType: note.modAction.type }),
  ...(note.modAction?.description === undefined
    ? {}
    : { actionDescription: note.modAction.description }),
  ...(note.modAction?.details === undefined
    ? {}
    : { actionDetails: note.modAction.details }),
  ...(note.modAction?.target?.id === undefined
    ? {}
    : { actionTargetId: note.modAction.target.id }),
});

export const evaluateModNoteCriteria = (
  notes: ModNoteSnapshot[],
  rawCriteria: unknown,
  targetId: T1 | T3,
  now = new Date()
): ModNoteCriteriaEvaluation => {
  if (!isRecord(rawCriteria)) {
    return {
      supported: false,
      passed: false,
      reason: 'modnote criteria must be an object',
    };
  }

  const countConfig = getCountConfig(rawCriteria.count);
  const isModLog = 'action' in rawCriteria || 'details' in rawCriteria || 'description' in rawCriteria;
  const typedNotes = notes.filter((note) => {
    if (rawCriteria.type !== undefined) {
      return valueMatchesStringList(rawCriteria.type, note.type) === true;
    }
    // If type is not specified, default to 'NOTE' for ModNoteCriteria,
    // and match anything except 'NOTE' for ModLogCriteria
    return isModLog ? note.type !== 'NOTE' : note.type === 'NOTE';
  });
  const notesToUse = applyDurationFilter(
    typedNotes,
    countConfig.durationMs,
    now
  );
  const search = getSearchMode(rawCriteria);
  const searchedNotes =
    search === 'current' && notesToUse.length > 0
      ? [notesToUse[0] as ModNoteSnapshot]
      : notesToUse;
  const matchedNotes: ModNoteSnapshot[] = [];

  for (const note of searchedNotes) {
    const matches = getCriteriaMatch(rawCriteria, note, targetId);
    if (matches === undefined) {
      return {
        supported: false,
        passed: false,
        reason: 'modnote criteria contains unsupported values',
      };
    }
    if (matches) {
      matchedNotes.push(note);
    }
  }

  const actual =
    search === 'consecutive'
      ? countConsecutiveMatches(
          searchedNotes,
          new Set(matchedNotes.map((note) => note.id)),
          countConfig.ascending
        )
      : countConfig.percent
        ? searchedNotes.length === 0
          ? 0
          : (matchedNotes.length / searchedNotes.length) * 100
        : matchedNotes.length;
  const comparison =
    typeof countConfig.comparison === 'string'
      ? countConfig.comparison.replace('%', '').trim()
      : countConfig.comparison;
  const passed = valueMatchesNumberComparison(comparison, actual);

  if (passed === undefined) {
    return {
      supported: false,
      passed: false,
      reason: 'modnote count comparison is unsupported',
    };
  }

  return {
    supported: true,
    passed,
    reason: `${matchedNotes.length}/${searchedNotes.length} mod note(s) matched criteria`,
  };
};
