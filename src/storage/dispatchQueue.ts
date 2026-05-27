import type { RedisClient } from '@devvit/web/server';
import type { ActivitySnapshot } from '../runtime/activityAdapter';
import { pruneOldestIndexedRecords, removeIndexedRecords } from './retention';

export type DispatchQueueRedisClient = Pick<
  RedisClient,
  'del' | 'expire' | 'mGet' | 'set' | 'zAdd' | 'zCard' | 'zRange' | 'zRem'
>;

export type DispatchQueueRecord = {
  version: 1;
  id: string;
  createdAt: string;
  runAt: string;
  targetId: string;
  activityKind: ActivitySnapshot['kind'];
  subredditName: string;
  source: 'dispatch';
  status: 'pending';
  dryRun?: boolean;
  goto?: string;
  identifier?: string;
  schedulerJobId?: string;
  retryCount?: number;
};

export type EnqueueDispatchInput = {
  activity?: ActivitySnapshot;
  delayMs: number;
  activityKind?: ActivitySnapshot['kind'];
  dryRun?: boolean;
  goto?: string;
  identifier?: string;
  schedulerJobId?: string;
  subredditName?: string;
  targetId?: string;
  retryCount?: number;
};

export type EnqueueDispatchOptions = {
  id?: string;
  maxRecords?: number;
  now?: Date;
  ttlMs?: number;
};

export type DispatchRecordMatch = {
  targetId?: string;
  identifiers?: (string | null)[];
};

const DISPATCH_INDEX_KEY = 'contextmod:dispatch:index';
const DISPATCH_DEAD_LETTER_KEY = 'contextmod:dispatch:deadletter';
const DISPATCH_RECORD_KEY_PREFIX = 'contextmod:dispatch:record:';
const DEFAULT_DISPATCH_MAX_RECORDS = 100;
const DEFAULT_DISPATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const dispatchRecordKey = (id: string): string =>
  `${DISPATCH_RECORD_KEY_PREFIX}${id}`;

const createDispatchId = (createdAt: Date, activityId: string): string => {
  const safeActivityId = activityId.replace(/[^a-zA-Z0-9_-]/g, '');
  const random = Math.random().toString(36).slice(2, 10);
  return `${createdAt.getTime().toString(36)}-${safeActivityId}-${random}`;
};

const normalizeMaxRecords = (maxRecords: number | undefined): number =>
  Math.max(1, Math.floor(maxRecords ?? DEFAULT_DISPATCH_MAX_RECORDS));

const normalizeDelayMs = (delayMs: number): number => {
  const normalized = Math.floor(delayMs);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error('dispatch delayMs must be a non-negative integer');
  }

  return normalized;
};

const parseDispatchRecord = (
  value: string | null | undefined
): DispatchQueueRecord | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<DispatchQueueRecord>;
    if (
      parsed.version === 1 &&
      typeof parsed.id === 'string' &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.runAt === 'string' &&
      typeof parsed.targetId === 'string' &&
      (parsed.activityKind === 'comment' || parsed.activityKind === 'submission') &&
      typeof parsed.subredditName === 'string' &&
      parsed.source === 'dispatch' &&
      parsed.status === 'pending'
    ) {
      if (typeof parsed.retryCount === 'number') {
        return parsed as DispatchQueueRecord;
      }
      return { ...parsed, retryCount: parsed.retryCount ?? 0 } as DispatchQueueRecord;
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const pruneDispatchRecords = async (
  redis: DispatchQueueRedisClient,
  maxRecords: number
): Promise<void> => {
  await pruneOldestIndexedRecords(redis, {
    indexKey: DISPATCH_INDEX_KEY,
    maxRecords,
    recordKey: dispatchRecordKey,
  });
};

export const enqueueDispatchRecord = async (
  redis: DispatchQueueRedisClient,
  input: EnqueueDispatchInput,
  options: EnqueueDispatchOptions = {}
): Promise<DispatchQueueRecord> => {
  const delayMs = normalizeDelayMs(input.delayMs);
  const createdAt = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_DISPATCH_TTL_MS;
  const activityId = input.activity?.id ?? input.targetId;
  if (activityId === undefined) {
    throw new Error('enqueueDispatchRecord requires either activity or targetId');
  }
  const id = options.id ?? createDispatchId(createdAt, activityId);
  const runAt = new Date(createdAt.getTime() + delayMs);
  
  const targetId = input.targetId ?? input.activity?.id;
  const activityKind = input.activityKind ?? input.activity?.kind;
  const subredditName = input.subredditName ?? input.activity?.subredditName;
  
  if (targetId === undefined || activityKind === undefined || subredditName === undefined) {
    throw new Error('enqueueDispatchRecord requires targetId, activityKind, and subredditName');
  }

  const record: DispatchQueueRecord = {
    version: 1,
    id,
    createdAt: createdAt.toISOString(),
    runAt: runAt.toISOString(),
    targetId,
    activityKind,
    subredditName,
    source: 'dispatch',
    status: 'pending',
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    ...(input.goto === undefined ? {} : { goto: input.goto }),
    ...(input.identifier === undefined ? {} : { identifier: input.identifier }),
    ...(input.schedulerJobId === undefined
      ? {}
      : { schedulerJobId: input.schedulerJobId }),
    retryCount: input.retryCount ?? 0,
  };

  await redis.set(dispatchRecordKey(id), JSON.stringify(record), {
    expiration: new Date(createdAt.getTime() + ttlMs),
  });
  await redis.zAdd(DISPATCH_INDEX_KEY, {
    member: id,
    score: runAt.getTime(),
  });
  await redis.expire(DISPATCH_INDEX_KEY, Math.ceil(ttlMs / 1000));
  await pruneDispatchRecords(redis, normalizeMaxRecords(options.maxRecords));

  return record;
};

export const listDueDispatchRecords = async (
  redis: DispatchQueueRedisClient,
  now = new Date(),
  count = 25
): Promise<DispatchQueueRecord[]> => {
  if (count <= 0) {
    return [];
  }

  const members = await redis.zRange(DISPATCH_INDEX_KEY, 0, now.getTime(), {
    by: 'score',
  });
  const ids = members.slice(0, count).map((member) => member.member);
  if (ids.length === 0) {
    return [];
  }

  const values = await redis.mGet(ids.map(dispatchRecordKey));
  const staleIds: string[] = [];
  const records = values.flatMap((value, index) => {
    const record = parseDispatchRecord(value);
    const id = ids[index];
    if (record === undefined && id !== undefined) {
      staleIds.push(id);
      return [];
    }
    return record === undefined ? [] : [record];
  });

  if (staleIds.length > 0) {
    await removeIndexedRecords(redis, {
      indexKey: DISPATCH_INDEX_KEY,
      members: staleIds,
      recordKey: dispatchRecordKey,
    });
  }

  return records;
};

export const getDispatchRecord = async (
  redis: DispatchQueueRedisClient,
  dispatchId: string
): Promise<DispatchQueueRecord | undefined> => {
  const [value] = await redis.mGet([dispatchRecordKey(dispatchId)]);
  return parseDispatchRecord(value);
};

export const setDispatchSchedulerJobId = async (
  redis: DispatchQueueRedisClient,
  dispatchId: string,
  schedulerJobId: string
): Promise<DispatchQueueRecord | undefined> => {
  const record = await getDispatchRecord(redis, dispatchId);
  if (record === undefined) {
    return undefined;
  }

  const updatedRecord: DispatchQueueRecord = {
    ...record,
    schedulerJobId,
  };
  await redis.set(dispatchRecordKey(dispatchId), JSON.stringify(updatedRecord));
  return updatedRecord;
};

export const listDispatchRecords = async (
  redis: DispatchQueueRedisClient,
  count = DEFAULT_DISPATCH_MAX_RECORDS
): Promise<DispatchQueueRecord[]> => {
  if (count <= 0) {
    return [];
  }

  const total = await redis.zCard(DISPATCH_INDEX_KEY);
  if (total === 0) {
    return [];
  }

  const members = await redis.zRange(
    DISPATCH_INDEX_KEY,
    0,
    Math.min(total, count) - 1
  );
  const ids = members.map((member) => member.member);
  const values = await redis.mGet(ids.map(dispatchRecordKey));
  const staleIds: string[] = [];
  const records = values.flatMap((value, index) => {
    const record = parseDispatchRecord(value);
    const id = ids[index];
    if (record === undefined && id !== undefined) {
      staleIds.push(id);
      return [];
    }
    return record === undefined ? [] : [record];
  });

  if (staleIds.length > 0) {
    await removeIndexedRecords(redis, {
      indexKey: DISPATCH_INDEX_KEY,
      members: staleIds,
      recordKey: dispatchRecordKey,
    });
  }

  return records;
};

const dispatchRecordMatches = (
  record: DispatchQueueRecord,
  match: DispatchRecordMatch
): boolean => {
  if (match.targetId !== undefined && record.targetId !== match.targetId) {
    return false;
  }

  if (match.identifiers === undefined) {
    return true;
  }

  if (record.identifier === undefined) {
    return match.identifiers.includes(null);
  }

  return match.identifiers.includes(record.identifier);
};

export const findDispatchRecords = async (
  redis: DispatchQueueRedisClient,
  match: DispatchRecordMatch
): Promise<DispatchQueueRecord[]> => {
  const records = await listDispatchRecords(redis);
  return records.filter((record) => dispatchRecordMatches(record, match));
};

export const cancelDispatchRecords = async (
  redis: DispatchQueueRedisClient,
  match: DispatchRecordMatch
): Promise<DispatchQueueRecord[]> => {
  const records = await findDispatchRecords(redis, match);
  if (records.length === 0) {
    return [];
  }

  await removeIndexedRecords(redis, {
    indexKey: DISPATCH_INDEX_KEY,
    members: records.map((record) => record.id),
    recordKey: dispatchRecordKey,
  });

  return records;
};

export const cancelDispatchRecord = async (
  redis: DispatchQueueRedisClient,
  dispatchId: string
): Promise<boolean> => {
  const removed = await removeIndexedRecords(redis, {
    indexKey: DISPATCH_INDEX_KEY,
    members: [dispatchId],
    recordKey: dispatchRecordKey,
  });

  return removed.removedMembers.length > 0;
};

export const deadLetterDispatchRecord = async (
  redis: DispatchQueueRedisClient,
  record: DispatchQueueRecord,
  errorReason: string
): Promise<void> => {
  const deadLetterRecord = {
    ...record,
    status: 'failed',
    errorReason,
    deadLetteredAt: new Date().toISOString(),
  };
  await redis.set(dispatchRecordKey(record.id), JSON.stringify(deadLetterRecord), {
    expiration: new Date(Date.now() + DEFAULT_DISPATCH_TTL_MS),
  });
  await redis.zAdd(DISPATCH_DEAD_LETTER_KEY, {
    member: record.id,
    score: Date.now(),
  });
  await redis.expire(DISPATCH_DEAD_LETTER_KEY, Math.ceil(DEFAULT_DISPATCH_TTL_MS / 1000));
  await removeIndexedRecords(redis, {
    indexKey: DISPATCH_INDEX_KEY,
    members: [record.id],
    recordKey: dispatchRecordKey,
  });
};
