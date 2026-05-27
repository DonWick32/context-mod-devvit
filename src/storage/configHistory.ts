import type { RedisClient } from '@devvit/web/server';
import { pruneOldestIndexedRecords, removeIndexedRecords } from './retention';

export type ConfigHistoryRedisClient = Pick<
  RedisClient,
  'del' | 'expire' | 'mGet' | 'set' | 'zAdd' | 'zCard' | 'zRange' | 'zRem'
>;

export type ConfigRevisionRecord = {
  version: 1;
  id: string;
  createdAt: string;
  source: string;
  subredditName: string;
  pageName: string;
  reason: string;
  sizeBytes: number;
  preview: string;
  content: string;
};

type AppendConfigRevisionInput = {
  source: string;
  subredditName: string;
  pageName: string;
  reason: string;
  content: string;
};

type AppendConfigRevisionOptions = {
  id?: string;
  maxRecords?: number;
  now?: Date;
  ttlMs?: number;
};

const CONFIG_REVISION_INDEX_KEY = 'contextmod:config:revisions:index';
const CONFIG_REVISION_RECORD_KEY_PREFIX = 'contextmod:config:revisions:record:';
const DEFAULT_CONFIG_REVISION_MAX_RECORDS = 25;
const DEFAULT_CONFIG_REVISION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const configRevisionRecordKey = (id: string): string =>
  `${CONFIG_REVISION_RECORD_KEY_PREFIX}${id}`;

const normalizeMaxRecords = (maxRecords: number | undefined): number =>
  Math.max(1, Math.floor(maxRecords ?? DEFAULT_CONFIG_REVISION_MAX_RECORDS));

const createConfigRevisionId = (createdAt: Date, pageName: string): string => {
  const safePageName = pageName.replace(/[^a-zA-Z0-9_-]/g, '');
  const random = Math.random().toString(36).slice(2, 10);
  return `${createdAt.getTime().toString(36)}-${safePageName}-${random}`;
};

const parseConfigRevisionRecord = (
  value: string | null | undefined
): ConfigRevisionRecord | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<ConfigRevisionRecord>;
    if (
      parsed.version === 1 &&
      typeof parsed.id === 'string' &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.source === 'string' &&
      typeof parsed.subredditName === 'string' &&
      typeof parsed.pageName === 'string' &&
      typeof parsed.reason === 'string' &&
      typeof parsed.sizeBytes === 'number' &&
      typeof parsed.preview === 'string'
    ) {
      return {
        ...(parsed as Omit<ConfigRevisionRecord, 'content'>),
        content: typeof parsed.content === 'string' ? parsed.content : '',
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const pruneConfigRevisionRecords = async (
  redis: ConfigHistoryRedisClient,
  maxRecords: number
): Promise<void> => {
  await pruneOldestIndexedRecords(redis, {
    indexKey: CONFIG_REVISION_INDEX_KEY,
    maxRecords,
    recordKey: configRevisionRecordKey,
  });
};

export const appendConfigRevisionRecord = async (
  redis: ConfigHistoryRedisClient,
  input: AppendConfigRevisionInput,
  options: AppendConfigRevisionOptions = {}
): Promise<ConfigRevisionRecord> => {
  const createdAt = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_CONFIG_REVISION_TTL_MS;
  const id = options.id ?? createConfigRevisionId(createdAt, input.pageName);
  const record: ConfigRevisionRecord = {
    version: 1,
    id,
    createdAt: createdAt.toISOString(),
    source: input.source,
    subredditName: input.subredditName,
    pageName: input.pageName,
    reason: input.reason,
    sizeBytes: Buffer.byteLength(input.content, 'utf8'),
    preview: input.content.trim().slice(0, 220),
    content: input.content,
  };

  await redis.set(configRevisionRecordKey(id), JSON.stringify(record), {
    expiration: new Date(createdAt.getTime() + ttlMs),
  });
  await redis.zAdd(CONFIG_REVISION_INDEX_KEY, {
    member: id,
    score: createdAt.getTime(),
  });
  await redis.expire(CONFIG_REVISION_INDEX_KEY, Math.ceil(ttlMs / 1000));
  await pruneConfigRevisionRecords(redis, normalizeMaxRecords(options.maxRecords));

  return record;
};

export const listRecentConfigRevisionRecords = async (
  redis: ConfigHistoryRedisClient,
  count = 10
): Promise<ConfigRevisionRecord[]> => {
  if (count <= 0) {
    return [];
  }

  const members = await redis.zRange(CONFIG_REVISION_INDEX_KEY, 0, count - 1, {
    by: 'rank',
    reverse: true,
  });
  const ids = members.map((member) => member.member);
  if (ids.length === 0) {
    return [];
  }

  const values = await redis.mGet(ids.map(configRevisionRecordKey));
  const staleIds: string[] = [];
  const records = values.flatMap((value, index) => {
    const record = parseConfigRevisionRecord(value);
    const id = ids[index];
    if (record === undefined && id !== undefined) {
      staleIds.push(id);
      return [];
    }
    return record === undefined ? [] : [record];
  });

  if (staleIds.length > 0) {
    await removeIndexedRecords(redis, {
      indexKey: CONFIG_REVISION_INDEX_KEY,
      members: staleIds,
      recordKey: configRevisionRecordKey,
    });
  }

  return records;
};

export const getConfigRevisionRecord = async (
  redis: ConfigHistoryRedisClient,
  revisionId: string
): Promise<ConfigRevisionRecord | undefined> => {
  const [value] = await redis.mGet([configRevisionRecordKey(revisionId)]);
  return parseConfigRevisionRecord(value);
};

export const deleteConfigRevisionRecord = async (
  redis: ConfigHistoryRedisClient,
  revisionId: string
): Promise<void> => {
  await redis.del(configRevisionRecordKey(revisionId));
  await redis.zRem(CONFIG_REVISION_INDEX_KEY, [revisionId]);
};
