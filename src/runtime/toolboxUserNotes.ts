import { deflateSync, inflateSync } from 'node:zlib';
import { valueMatchesNumberComparison } from './comparison';

type ToolboxRawNote = {
  n: string;
  t: number;
  m: number;
  l: string | null;
  w: number;
};

type ToolboxRawPayload = {
  ver: number;
  constants: {
    users: string[];
    warnings: (string | null)[];
  };
  blob: string | Record<string, { ns?: ToolboxRawNote[] }>;
};

type ParsedToolboxUserNotesPayload = Omit<ToolboxRawPayload, 'blob'> & {
  blob: Record<string, { ns?: ToolboxRawNote[] }>;
};

export type ToolboxUserNote = {
  text: string;
  type: string | number;
  moderator?: string;
  createdAt: Date;
  link?: string;
};

export type AddToolboxUserNoteInput = {
  username: string;
  moderatorName: string;
  noteType: string;
  noteText: string;
  activityId: string;
  activityKind: 'submission' | 'comment';
  permalink?: string;
  postId?: string;
  now?: Date;
};

export type AddToolboxUserNoteResult = {
  content: string;
  note: ToolboxUserNote;
  wikiReason: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeUsername = (username: string): string => username.trim().toLowerCase();

export const inflateToolboxUserNotesBlob = (
  blob: string
): Record<string, { ns?: ToolboxRawNote[] }> =>
  JSON.parse(inflateSync(Buffer.from(blob, 'base64')).toString('utf-8')) as Record<
    string,
    { ns?: ToolboxRawNote[] }
  >;

export const deflateToolboxUserNotesBlob = (blob: object): string =>
  Buffer.from(deflateSync(JSON.stringify(blob))).toString('base64');

const expandToolboxUserNoteLink = (link: string | null): string | undefined => {
  if (link === null || link.trim().length === 0) {
    return undefined;
  }

  if (link.startsWith('l,')) {
    const pieces = link.split(',');
    if (pieces.length === 3 && pieces[1] !== undefined && pieces[2] !== undefined) {
      return `https://www.reddit.com/comments/${pieces[1]}/_/${pieces[2]}`;
    }
    if (pieces[1] !== undefined) {
      return `https://redd.it/${pieces[1]}`;
    }
  }

  if (link.startsWith('m,')) {
    return `https://www.reddit.com/message/messages/${link.split(',')[1] ?? ''}`;
  }

  return link;
};

const parseToolboxUserNotesPayload = (
  content: string
): ParsedToolboxUserNotesPayload => {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.constants)) {
    throw new Error('Toolbox usernotes wiki page is not a valid payload');
  }

  const users = parsed.constants.users;
  const warnings = parsed.constants.warnings;
  if (!Array.isArray(users) || !Array.isArray(warnings)) {
    throw new Error('Toolbox usernotes constants are missing users or warnings');
  }

  const rawBlob = parsed.blob;
  const blob =
    typeof rawBlob === 'string'
      ? inflateToolboxUserNotesBlob(rawBlob)
      : isRecord(rawBlob)
        ? (rawBlob as Record<string, { ns?: ToolboxRawNote[] }>)
        : undefined;
  if (blob === undefined) {
    throw new Error('Toolbox usernotes blob is missing or invalid');
  }

  return {
    ver: typeof parsed.ver === 'number' ? parsed.ver : 0,
    constants: {
      users: users.filter((user): user is string => typeof user === 'string'),
      warnings: warnings.filter(
        (warning): warning is string | null =>
          typeof warning === 'string' || warning === null
      ),
    },
    blob,
  };
};

const stripThingPrefix = (thingId: string): string =>
  thingId.replace(/^t[13]_/, '');

const getToolboxUserNoteLinkShorthand = (
  input: AddToolboxUserNoteInput
): string => {
  if (input.activityKind === 'submission') {
    return `l,${stripThingPrefix(input.activityId)}`;
  }

  const postId =
    input.postId === undefined ? undefined : stripThingPrefix(input.postId);
  if (postId !== undefined && postId.length > 0) {
    return `l,${postId},${stripThingPrefix(input.activityId)}`;
  }

  return input.permalink === undefined || input.permalink.length === 0
    ? ''
    : `https://reddit.com${input.permalink.startsWith('/') ? '' : '/'}${
        input.permalink
      }`;
};

const truncateWikiReason = (value: string): string =>
  value.length > 256 ? `${value.slice(0, 252)}...` : value;

const serializeToolboxUserNotesPayload = (
  payload: ParsedToolboxUserNotesPayload
): string =>
  JSON.stringify({
    ...payload,
    blob: deflateToolboxUserNotesBlob(payload.blob),
  });

export const getToolboxUserNotesForAuthor = (
  content: string,
  username: string
): ToolboxUserNote[] => {
  const payload = parseToolboxUserNotesPayload(content);
  const notesRoot = Object.entries(payload.blob).find(
    ([noteUsername]) => normalizeUsername(noteUsername) === normalizeUsername(username)
  )?.[1];
  const rawNotes: ToolboxRawNote[] = Array.isArray(notesRoot?.ns)
    ? notesRoot.ns
    : [];

  return rawNotes
    .map((rawNote) => {
      const type = payload.constants.warnings[rawNote.w] ?? rawNote.w;
      const expandedLink = expandToolboxUserNoteLink(rawNote.l);
      return {
        text: rawNote.n,
        type: type === null ? rawNote.w : type,
        ...(payload.constants.users[rawNote.m] === undefined
          ? {}
          : { moderator: payload.constants.users[rawNote.m] }),
        createdAt: new Date(rawNote.t * 1000),
        ...(expandedLink === undefined ? {} : { link: expandedLink }),
      };
    })
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
};

const parseRegexOrLiteral = (value: string): RegExp => {
  const regexMatch = value.match(/^\/(.+)\/([a-z]*)$/i);
  if (regexMatch?.[1] !== undefined) {
    return new RegExp(regexMatch[1], regexMatch[2] ?? '');
  }

  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
};

const noteReferencesActivity = (
  note: ToolboxUserNote,
  activityId: string
): boolean => {
  const link = note.link;
  if (link === undefined) {
    return false;
  }

  const bareId = activityId.replace(/^t[13]_/, '');
  return link.includes(activityId) || link.includes(bareId);
};

const toolboxUserNoteMatches = (
  note: ToolboxUserNote,
  criterion: Record<string, unknown>,
  activityId: string
): boolean => {
  if (
    typeof criterion.type === 'string' &&
    String(note.type).trim().toLowerCase() !==
      criterion.type.trim().toLowerCase()
  ) {
    return false;
  }

  const noteCriteria = criterion.note;
  if (noteCriteria !== undefined) {
    const notePatterns = (Array.isArray(noteCriteria) ? noteCriteria : [noteCriteria])
      .filter((entry): entry is string => typeof entry === 'string')
      .map(parseRegexOrLiteral);
    if (
      notePatterns.length === 0 ||
      !notePatterns.some((pattern) => pattern.test(note.text))
    ) {
      return false;
    }
  }

  if (typeof criterion.referencesCurrentActivity === 'boolean') {
    const references = noteReferencesActivity(note, activityId);
    if (references !== criterion.referencesCurrentActivity) {
      return false;
    }
  }

  return true;
};

const valueMatchesPercentComparison = (
  expected: unknown,
  numerator: number,
  denominator: number
): boolean | undefined => {
  if (typeof expected !== 'string') {
    return undefined;
  }

  const match = expected
    .trim()
    .match(/^(<=|>=|<|>|={1,2})?\s*(-?\d+(?:\.\d+)?)\s*%/);
  if (match?.[2] === undefined) {
    return undefined;
  }

  const operator = match[1] ?? '>=';
  const percent = denominator === 0 ? 0 : (numerator / denominator) * 100;
  return valueMatchesNumberComparison(`${operator} ${match[2]}`, percent);
};

export const evaluateToolboxUserNoteCriteria = (
  notes: ToolboxUserNote[],
  criteria: unknown,
  activityId: string
): boolean | undefined => {
  const criteriaList = Array.isArray(criteria) ? criteria : [criteria];
  let evaluated = 0;

  for (const criterion of criteriaList) {
    if (!isRecord(criterion) || typeof criterion.type !== 'string') {
      continue;
    }

    const search =
      criterion.search === 'total' || criterion.search === 'consecutive'
        ? criterion.search
        : 'current';
    const rawCount = criterion.count ?? '>= 1';
    const count =
      typeof rawCount === 'string'
        ? rawCount.replace(/\b(asc|desc|ascending|descending)\b/gi, '').trim()
        : rawCount;
    const orderedNotes =
      typeof rawCount === 'string' && /\basc(?:ending)?\b/i.test(rawCount)
        ? notes
        : [...notes].reverse();

    let matchedCount: number;
    let denominator: number;
    if (search === 'consecutive') {
      matchedCount = 0;
      for (const note of orderedNotes) {
        if (!toolboxUserNoteMatches(note, criterion, activityId)) {
          break;
        }
        matchedCount++;
      }
      denominator = orderedNotes.length;
    } else {
      const latestNote = notes.at(-1);
      const notesToSearch =
        search === 'current'
          ? latestNote === undefined
            ? []
            : [latestNote]
          : notes;
      denominator = notesToSearch.length;
      matchedCount = notesToSearch.filter((note) =>
        toolboxUserNoteMatches(note, criterion, activityId)
      ).length;
    }

    const percentMatch = valueMatchesPercentComparison(
      count,
      matchedCount,
      denominator
    );
    const countMatch =
      percentMatch ??
      valueMatchesNumberComparison(count, matchedCount);
    if (countMatch === undefined) {
      continue;
    }

    evaluated++;
    if (countMatch) {
      return true;
    }
  }

  return evaluated === 0 ? undefined : false;
};

export const addToolboxUserNote = (
  content: string,
  input: AddToolboxUserNoteInput
): AddToolboxUserNoteResult => {
  const payload = parseToolboxUserNotesPayload(content);
  const moderatorIndex = payload.constants.users.findIndex(
    (user) => normalizeUsername(user) === normalizeUsername(input.moderatorName)
  );
  const resolvedModeratorIndex =
    moderatorIndex === -1
      ? payload.constants.users.push(input.moderatorName) - 1
      : moderatorIndex;
  const warningIndex = payload.constants.warnings.findIndex(
    (warning) =>
      typeof warning === 'string' &&
      warning.trim().toLowerCase() === input.noteType.trim().toLowerCase()
  );
  const resolvedWarningIndex =
    warningIndex === -1
      ? payload.constants.warnings.push(input.noteType) - 1
      : warningIndex;
  const rawNote = {
    n: input.noteText,
    t: Math.floor((input.now ?? new Date()).getTime() / 1000),
    m: resolvedModeratorIndex,
    l: getToolboxUserNoteLinkShorthand(input),
    w: resolvedWarningIndex,
  };

  const existingUsernameKey =
    Object.keys(payload.blob).find(
      (username) => normalizeUsername(username) === normalizeUsername(input.username)
    ) ?? input.username;
  const root = payload.blob[existingUsernameKey] ?? { ns: [] };
  const notes = Array.isArray(root.ns) ? root.ns : [];
  payload.blob[existingUsernameKey] = {
    ...root,
    ns: [...notes, rawNote],
  };

  const expandedLink = expandToolboxUserNoteLink(rawNote.l);
  const note: ToolboxUserNote = {
    text: rawNote.n,
    type: input.noteType,
    moderator: input.moderatorName,
    createdAt: new Date(rawNote.t * 1000),
    ...(expandedLink === undefined ? {} : { link: expandedLink }),
  };
  const wikiReason = truncateWikiReason(
    `ContextMod added ${input.noteType} for ${input.username} on ${
      input.activityKind === 'submission' ? 'SUB' : 'COMM'
    } ${input.activityId}${input.noteText.length === 0 ? '' : ` => ${input.noteText}`}`
  );

  return {
    content: serializeToolboxUserNotesPayload(payload),
    note,
    wikiReason,
  };
};
