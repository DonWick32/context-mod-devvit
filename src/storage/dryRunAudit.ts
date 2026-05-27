import type { RedisClient } from '@devvit/web/server';
import type { ActivitySnapshot } from '../runtime/activityAdapter';
import type { DryRunResult } from '../runtime/dryRunEngine';
import { pruneOldestIndexedRecords } from './retention';

export type AuditRedisClient = Pick<
  RedisClient,
  'del' | 'expire' | 'mGet' | 'set' | 'zAdd' | 'zCard' | 'zRange' | 'zRem'
>;

export type DryRunAuditRecord = {
  version: 1;
  id: string;
  createdAt: string;
  configSource: string;
  targetId: string;
  activity: {
    id: string;
    kind: ActivitySnapshot['kind'];
    authorName: string;
    subredditName: string;
    permalink: string;
    createdAt: string;
    title?: string;
    url?: string;
  };
  result: DryRunResult;
};

export type DryRunAuditStatus = {
  totalRecords: number;
  latest?: DryRunAuditRecord;
};

type AppendDryRunAuditInput = {
  activity: ActivitySnapshot;
  configSource: string;
  result: DryRunResult;
  targetId?: string;
};

type AppendDryRunAuditOptions = {
  id?: string;
  maxRecords?: number;
  now?: Date;
  ttlMs?: number;
};

const AUDIT_INDEX_KEY = 'contextmod:audit:dryrun:index';
const AUDIT_RECORD_KEY_PREFIX = 'contextmod:audit:dryrun:record:';
const DEFAULT_AUDIT_MAX_RECORDS = 25;
const DEFAULT_AUDIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const auditRecordKey = (id: string): string =>
  `${AUDIT_RECORD_KEY_PREFIX}${id}`;

const createAuditId = (createdAt: Date, activityId: string): string => {
  const safeActivityId = activityId.replace(/[^a-zA-Z0-9_-]/g, '');
  const random = Math.random().toString(36).slice(2, 10);
  return `${createdAt.getTime().toString(36)}-${safeActivityId}-${random}`;
};

const normalizeMaxRecords = (maxRecords: number | undefined): number =>
  Math.max(1, Math.floor(maxRecords ?? DEFAULT_AUDIT_MAX_RECORDS));

const parseDryRunAuditRecord = (
  value: string | null | undefined
): DryRunAuditRecord | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<DryRunAuditRecord>;
    if (
      parsed.version === 1 &&
      typeof parsed.id === 'string' &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.configSource === 'string' &&
      typeof parsed.targetId === 'string' &&
      parsed.activity !== undefined &&
      parsed.result !== undefined
    ) {
      return parsed as DryRunAuditRecord;
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const pruneDryRunAuditRecords = async (
  redis: AuditRedisClient,
  maxRecords: number
): Promise<void> => {
  await pruneOldestIndexedRecords(redis, {
    indexKey: AUDIT_INDEX_KEY,
    maxRecords,
    recordKey: auditRecordKey,
  });
};

export const appendDryRunAuditRecord = async (
  redis: AuditRedisClient,
  input: AppendDryRunAuditInput,
  options: AppendDryRunAuditOptions = {}
): Promise<DryRunAuditRecord> => {
  const createdAt = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_AUDIT_TTL_MS;
  const id = options.id ?? createAuditId(createdAt, input.activity.id);
  const record: DryRunAuditRecord = {
    version: 1,
    id,
    createdAt: createdAt.toISOString(),
    configSource: input.configSource,
    targetId: input.targetId ?? input.activity.id,
    activity: {
      id: input.activity.id,
      kind: input.activity.kind,
      authorName: input.activity.authorName,
      subredditName: input.activity.subredditName,
      permalink: input.activity.permalink,
      createdAt: input.activity.createdAt.toISOString(),
      ...(input.activity.title === undefined
        ? {}
        : { title: input.activity.title }),
      ...(input.activity.url === undefined ? {} : { url: input.activity.url }),
    },
    result: input.result,
  };

  await redis.set(auditRecordKey(id), JSON.stringify(record), {
    expiration: new Date(createdAt.getTime() + ttlMs),
  });
  await redis.zAdd(AUDIT_INDEX_KEY, {
    member: id,
    score: createdAt.getTime(),
  });
  await redis.expire(AUDIT_INDEX_KEY, Math.ceil(ttlMs / 1000));
  await pruneDryRunAuditRecords(redis, normalizeMaxRecords(options.maxRecords));

  return record;
};

export const listRecentDryRunAuditRecords = async (
  redis: AuditRedisClient,
  count = 5
): Promise<DryRunAuditRecord[]> => {
  if (count <= 0) {
    return [];
  }

  const members = await redis.zRange(AUDIT_INDEX_KEY, 0, count - 1, {
    by: 'rank',
    reverse: true,
  });
  const ids = members.map((member) => member.member);

  if (ids.length === 0) {
    return [];
  }

  const values = await redis.mGet(ids.map(auditRecordKey));
  const staleIds: string[] = [];
  const records = values.flatMap((value, index) => {
    const record = parseDryRunAuditRecord(value);
    const id = ids[index];
    if (record === undefined && id !== undefined) {
      staleIds.push(id);
      return [];
    }
    return record === undefined ? [] : [record];
  });

  if (staleIds.length > 0) {
    await redis.del(...staleIds.map(auditRecordKey));
    await redis.zRem(AUDIT_INDEX_KEY, staleIds);
  }

  return records;
};

export const getDryRunAuditStatus = async (
  redis: AuditRedisClient
): Promise<DryRunAuditStatus> => {
  const latestRecords = await listRecentDryRunAuditRecords(redis, 1);
  const totalRecords = await redis.zCard(AUDIT_INDEX_KEY);

  return {
    totalRecords,
    ...(latestRecords[0] === undefined ? {} : { latest: latestRecords[0] }),
  };
};

export const summarizeDryRunAuditStatus = (
  status: DryRunAuditStatus
): string => {
  if (status.latest === undefined) {
    return 'ContextMod Devvit scaffold is installed. No dry-run audit records yet.';
  }

  const { latest } = status;
  return `Latest dry run: ${latest.activity.kind} ${latest.activity.id}, ${latest.result.checksTriggered}/${latest.result.checksEvaluated} check(s) triggered, ${latest.result.plannedActions.length} planned action(s). Retained audit records: ${status.totalRecords}.`;
};
