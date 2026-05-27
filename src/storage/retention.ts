import type { RedisClient } from '@devvit/web/server';

export type IndexedRetentionRedisClient = Pick<
  RedisClient,
  'del' | 'zCard' | 'zRange' | 'zRem'
>;

export type IndexedRecordKeyResolver = (member: string) => string | string[];

export type RemoveIndexedRecordsOptions = {
  indexKey: string;
  members: string[];
  recordKey: IndexedRecordKeyResolver;
};

export type PruneOldestIndexedRecordsOptions = {
  indexKey: string;
  maxRecords: number;
  recordKey: IndexedRecordKeyResolver;
};

export type IndexedRetentionResult = {
  removedRecords: number;
  removedMembers: string[];
};

const recordKeysForMembers = (
  members: string[],
  resolver: IndexedRecordKeyResolver
): string[] =>
  members.flatMap((member) => {
    const resolved = resolver(member);
    return Array.isArray(resolved) ? resolved : [resolved];
  });

export const removeIndexedRecords = async (
  redis: IndexedRetentionRedisClient,
  options: RemoveIndexedRecordsOptions
): Promise<IndexedRetentionResult> => {
  if (options.members.length === 0) {
    return {
      removedRecords: 0,
      removedMembers: [],
    };
  }

  const recordKeys = recordKeysForMembers(options.members, options.recordKey);
  if (recordKeys.length > 0) {
    await redis.del(...recordKeys);
  }
  await redis.zRem(options.indexKey, options.members);

  return {
    removedRecords: recordKeys.length,
    removedMembers: [...options.members],
  };
};

export const pruneOldestIndexedRecords = async (
  redis: IndexedRetentionRedisClient,
  options: PruneOldestIndexedRecordsOptions
): Promise<IndexedRetentionResult> => {
  const maxRecords = Math.max(0, Math.floor(options.maxRecords));
  const totalRecords = await redis.zCard(options.indexKey);
  const overflow = totalRecords - maxRecords;

  if (overflow <= 0) {
    return {
      removedRecords: 0,
      removedMembers: [],
    };
  }

  const oldestMembers = await redis.zRange(options.indexKey, 0, overflow - 1, {
    by: 'rank',
  });
  const members = oldestMembers.map((member) => member.member);

  return removeIndexedRecords(redis, {
    indexKey: options.indexKey,
    members,
    recordKey: options.recordKey,
  });
};
