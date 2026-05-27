import type { RedditClient } from '@devvit/web/server';
import { isT1, isT3, type T1, type T3 } from '@devvit/shared-types/tid.js';
import type { LoadedConfigSource } from '../config/configSource';
import {
  cancelDispatchRecord,
  deadLetterDispatchRecord,
  enqueueDispatchRecord,
  getDispatchRecord,
  listDueDispatchRecords,
  type DispatchQueueRecord,
} from '../storage/dispatchQueue';
import {
  snapshotFromComment,
  snapshotFromPost,
  type ActivitySnapshot,
} from './activityAdapter';
import type {
  ActionRuntimeSettings,
  ActionSchedulerClient,
} from './actionExecutor';
import { processContextModActivity } from './contextModProcessor';

type ProcessInput = Parameters<typeof processContextModActivity>[0];
type DispatchRedditClient = ProcessInput['redditClient'] &
  Pick<RedditClient, 'getCommentById' | 'getPostById'> &
  NonNullable<ProcessInput['configFragmentLoader']> &
  NonNullable<ProcessInput['actionWikiContentLoader']>;
type DispatchRedisClient = ProcessInput['redisClient'];

export type DispatchRecordProcessInput = {
  source: LoadedConfigSource;
  record: DispatchQueueRecord;
  redditClient: DispatchRedditClient;
  redisClient: DispatchRedisClient;
  actionRuntime: ActionRuntimeSettings;
  actionSchedulerClient?: ActionSchedulerClient;
};

export type DispatchRecordProcessResult = {
  dispatchId: string;
  ok: boolean;
  message: string;
};

export type DueDispatchProcessInput = Omit<
  DispatchRecordProcessInput,
  'record'
> & {
  count?: number;
  now?: Date;
};

export type DueDispatchProcessResult = {
  processed: number;
  results: DispatchRecordProcessResult[];
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const getDispatchSource = (record: DispatchQueueRecord): string =>
  record.identifier === undefined ? 'dispatch' : `dispatch:${record.identifier}`;

const snapshotDispatchActivity = async (
  redditClient: DispatchRedditClient,
  record: DispatchQueueRecord
): Promise<{
  activity: ActivitySnapshot;
  target: ProcessInput['target'];
  targetId: T1 | T3;
}> => {
  const source = getDispatchSource(record);

  if (record.activityKind === 'comment') {
    if (!isT1(record.targetId)) {
      throw new Error(`dispatch ${record.id} target is not a comment id`);
    }

    const comment = await redditClient.getCommentById(record.targetId);
    const post = await redditClient.getPostById(comment.postId);
    return {
      activity: snapshotFromComment(comment, { parentPost: post, source }),
      target: comment,
      targetId: record.targetId,
    };
  }

  if (!isT3(record.targetId)) {
    throw new Error(`dispatch ${record.id} target is not a post id`);
  }

  const post = await redditClient.getPostById(record.targetId);
  return {
    activity: snapshotFromPost(post, { source }),
    target: post,
    targetId: record.targetId,
  };
};

const MAX_DISPATCH_RETRIES = 3;
const DISPATCH_RETRY_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

export const processDispatchRecord = async (
  input: DispatchRecordProcessInput
): Promise<DispatchRecordProcessResult> => {
  let ok: boolean;
  let message: string;
  let errorReason = '';

  try {
    const { activity, target, targetId } = await snapshotDispatchActivity(
      input.redditClient,
      input.record
    );
    const processed = await processContextModActivity({
      source: input.source,
      activity,
      target,
      targetId,
      redditClient: input.redditClient,
      redisClient: input.redisClient,
      actionRuntime:
        input.record.dryRun === true
          ? { ...input.actionRuntime, dryRun: true }
          : input.actionRuntime,
      ...(input.actionSchedulerClient === undefined
        ? {}
        : { actionSchedulerClient: input.actionSchedulerClient }),
      configFragmentLoader: input.redditClient,
      actionWikiContentLoader: input.redditClient,
      ...(input.record.goto === undefined
        ? {}
        : { dryRunOptions: { startAt: input.record.goto } }),
    });

    ok = processed.ok;
    message = processed.message;
    if (!ok) {
      errorReason = processed.message;
    }
  } catch (error) {
    ok = false;
    message = getErrorMessage(error);
    errorReason = message;
  }

  try {
    if (ok) {
      await cancelDispatchRecord(input.redisClient, input.record.id);
    } else {
      const retryCount = input.record.retryCount ?? 0;
      if (retryCount < MAX_DISPATCH_RETRIES) {
        const delayMs = DISPATCH_RETRY_BACKOFF_MS * Math.pow(3, retryCount);
        
        await enqueueDispatchRecord(
          input.redisClient,
          {
            delayMs,
            targetId: input.record.targetId,
            activityKind: input.record.activityKind,
            subredditName: input.record.subredditName,
            ...(input.record.dryRun === undefined ? {} : { dryRun: input.record.dryRun }),
            ...(input.record.goto === undefined ? {} : { goto: input.record.goto }),
            ...(input.record.identifier === undefined ? {} : { identifier: input.record.identifier }),
            ...(input.record.schedulerJobId === undefined ? {} : { schedulerJobId: input.record.schedulerJobId }),
            retryCount: retryCount + 1,
          },
          { id: input.record.id }
        );
        message = `${message} (will retry in ${delayMs / 1000}s, attempt ${retryCount + 1})`;
      } else {
        await deadLetterDispatchRecord(input.redisClient, input.record, errorReason);
        message = `${message} (dead-lettered after ${retryCount} retries)`;
      }
    }
  } catch (cleanupError) {
    console.error('Failed to update dispatch record after processing', cleanupError);
  }

  return {
    dispatchId: input.record.id,
    ok,
    message,
  };
};

export const processDueDispatchRecords = async (
  input: DueDispatchProcessInput
): Promise<DueDispatchProcessResult> => {
  const records = await listDueDispatchRecords(
    input.redisClient,
    input.now ?? new Date(),
    input.count
  );
  const results: DispatchRecordProcessResult[] = [];

  for (const record of records) {
    results.push(
      await processDispatchRecord({
        source: input.source,
        record,
        redditClient: input.redditClient,
        redisClient: input.redisClient,
        actionRuntime: input.actionRuntime,
        ...(input.actionSchedulerClient === undefined
          ? {}
          : { actionSchedulerClient: input.actionSchedulerClient }),
      })
    );
  }

  return {
    processed: records.length,
    results,
  };
};

export const processDispatchRecordById = async (
  input: Omit<DispatchRecordProcessInput, 'record'> & { dispatchId: string }
): Promise<DispatchRecordProcessResult> => {
  const record = await getDispatchRecord(input.redisClient, input.dispatchId);
  if (record === undefined) {
    return {
      dispatchId: input.dispatchId,
      ok: false,
      message: 'dispatch record not found',
    };
  }

  return processDispatchRecord({
    source: input.source,
    record,
    redditClient: input.redditClient,
    redisClient: input.redisClient,
    actionRuntime: input.actionRuntime,
    ...(input.actionSchedulerClient === undefined
      ? {}
      : { actionSchedulerClient: input.actionSchedulerClient }),
  });
};
