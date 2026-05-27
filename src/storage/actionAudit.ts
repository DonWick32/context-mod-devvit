import type { RedisClient } from '@devvit/web/server';
import type { ActivitySnapshot } from '../runtime/activityAdapter';
import type { ActionExecutionSummary } from '../runtime/actionExecutor';
import { pruneOldestIndexedRecords, removeIndexedRecords } from './retention';

export type ActionAuditRedisClient = Pick<
  RedisClient,
  'del' | 'expire' | 'mGet' | 'set' | 'zAdd' | 'zCard' | 'zRange' | 'zRem'
>;

export type ActionAuditRecord = {
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
  dryRunSummary: {
    checksEvaluated: number;
    checksTriggered: number;
    plannedActionCount: number;
  };
  actionExecution: ActionExecutionSummary;
};

export type ActionAuditStatus = {
  totalRecords: number;
  latest?: ActionAuditRecord;
};

type AppendActionAuditInput = {
  activity: ActivitySnapshot;
  actionExecution: ActionExecutionSummary;
  checksEvaluated: number;
  checksTriggered: number;
  configSource: string;
  plannedActionCount: number;
  targetId?: string;
};

type AppendActionAuditOptions = {
  id?: string;
  maxRecords?: number;
  now?: Date;
  ttlMs?: number;
};

const ACTION_AUDIT_INDEX_KEY = 'contextmod:audit:action:index';
const ACTION_AUDIT_RECORD_KEY_PREFIX = 'contextmod:audit:action:record:';
const DEFAULT_ACTION_AUDIT_MAX_RECORDS = 25;
const DEFAULT_ACTION_AUDIT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const actionAuditRecordKey = (id: string): string =>
  `${ACTION_AUDIT_RECORD_KEY_PREFIX}${id}`;

const createActionAuditId = (createdAt: Date, activityId: string): string => {
  const safeActivityId = activityId.replace(/[^a-zA-Z0-9_-]/g, '');
  const random = Math.random().toString(36).slice(2, 10);
  return `${createdAt.getTime().toString(36)}-${safeActivityId}-${random}`;
};

const normalizeMaxRecords = (maxRecords: number | undefined): number =>
  Math.max(1, Math.floor(maxRecords ?? DEFAULT_ACTION_AUDIT_MAX_RECORDS));

const parseActionAuditRecord = (
  value: string | null | undefined
): ActionAuditRecord | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<ActionAuditRecord>;
    if (
      parsed.version === 1 &&
      typeof parsed.id === 'string' &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.configSource === 'string' &&
      typeof parsed.targetId === 'string' &&
      parsed.activity !== undefined &&
      parsed.dryRunSummary !== undefined &&
      parsed.actionExecution !== undefined
    ) {
      return parsed as ActionAuditRecord;
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const pruneActionAuditRecords = async (
  redis: ActionAuditRedisClient,
  maxRecords: number
): Promise<void> => {
  await pruneOldestIndexedRecords(redis, {
    indexKey: ACTION_AUDIT_INDEX_KEY,
    maxRecords,
    recordKey: actionAuditRecordKey,
  });
};

export const appendActionAuditRecord = async (
  redis: ActionAuditRedisClient,
  input: AppendActionAuditInput,
  options: AppendActionAuditOptions = {}
): Promise<ActionAuditRecord> => {
  const createdAt = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_ACTION_AUDIT_TTL_MS;
  const id = options.id ?? createActionAuditId(createdAt, input.activity.id);
  const record: ActionAuditRecord = {
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
    dryRunSummary: {
      checksEvaluated: input.checksEvaluated,
      checksTriggered: input.checksTriggered,
      plannedActionCount: input.plannedActionCount,
    },
    actionExecution: input.actionExecution,
  };

  await redis.set(actionAuditRecordKey(id), JSON.stringify(record), {
    expiration: new Date(createdAt.getTime() + ttlMs),
  });
  await redis.zAdd(ACTION_AUDIT_INDEX_KEY, {
    member: id,
    score: createdAt.getTime(),
  });
  await redis.expire(ACTION_AUDIT_INDEX_KEY, Math.ceil(ttlMs / 1000));
  await pruneActionAuditRecords(redis, normalizeMaxRecords(options.maxRecords));

  return record;
};

export const listRecentActionAuditRecords = async (
  redis: ActionAuditRedisClient,
  count = 5
): Promise<ActionAuditRecord[]> => {
  if (count <= 0) {
    return [];
  }

  const members = await redis.zRange(ACTION_AUDIT_INDEX_KEY, 0, count - 1, {
    by: 'rank',
    reverse: true,
  });
  const ids = members.map((member) => member.member);

  if (ids.length === 0) {
    return [];
  }

  const values = await redis.mGet(ids.map(actionAuditRecordKey));
  const staleIds: string[] = [];
  const records = values.flatMap((value, index) => {
    const record = parseActionAuditRecord(value);
    const id = ids[index];
    if (record === undefined && id !== undefined) {
      staleIds.push(id);
      return [];
    }
    return record === undefined ? [] : [record];
  });

  if (staleIds.length > 0) {
    await removeIndexedRecords(redis, {
      indexKey: ACTION_AUDIT_INDEX_KEY,
      members: staleIds,
      recordKey: actionAuditRecordKey,
    });
  }

  return records;
};

export const getActionAuditStatus = async (
  redis: ActionAuditRedisClient
): Promise<ActionAuditStatus> => {
  const latestRecords = await listRecentActionAuditRecords(redis, 1);
  const totalRecords = await redis.zCard(ACTION_AUDIT_INDEX_KEY);

  return {
    totalRecords,
    ...(latestRecords[0] === undefined ? {} : { latest: latestRecords[0] }),
  };
};

export const summarizeActionAuditStatus = (
  status: ActionAuditStatus
): string => {
  if (status.latest === undefined) {
    return 'No real action audit records yet.';
  }

  const { latest } = status;
  return `Latest action run: ${latest.activity.kind} ${latest.activity.id}, ${latest.actionExecution.executed} executed, ${latest.actionExecution.skipped} skipped, ${latest.actionExecution.failed} failed. Retained action records: ${status.totalRecords}.`;
};
