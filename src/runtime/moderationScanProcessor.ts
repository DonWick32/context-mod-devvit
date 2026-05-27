import type { Comment, Post, RedditClient } from '@devvit/web/server';
import { isT1, isT3, type T1, type T3 } from '@devvit/shared-types/tid.js';
import type { LoadedConfigSource } from '../config/configSource';
import {
  snapshotFromComment,
  snapshotFromPost,
  type ActivitySnapshot,
} from './activityAdapter';
import type {
  ActionRuntimeSettings,
  ActionSchedulerClient,
} from './actionExecutor';
import {
  processContextModActivity,
  type ContextModProcessInput,
  type ContextModProcessResult,
} from './contextModProcessor';

type ProcessInput = ContextModProcessInput;
type ReportableThing = ProcessInput['target'];
type ListingLike<T> = {
  all(): Promise<T[]>;
};

export type ModerationScanSource = 'modqueue' | 'unmoderated';

export type ModerationScanRedditClient = ProcessInput['redditClient'] &
  Pick<
    RedditClient,
    'getAppUser' | 'getModQueue' | 'getPostById' | 'getUnmoderated'
  > &
  NonNullable<ProcessInput['configFragmentLoader']> &
  NonNullable<ProcessInput['actionWikiContentLoader']>;

export type ModerationScanRedisClient = ProcessInput['redisClient'];

export type ModerationScanActivityProcessor = (
  input: ContextModProcessInput
) => Promise<ContextModProcessResult>;

export type ModerationScanRuntimeSettings = {
  limit: number;
  intervalMinutes: number;
};

export type ModerationScanInput = {
  source: LoadedConfigSource;
  scanSource: ModerationScanSource;
  subredditName: string;
  redditClient: ModerationScanRedditClient;
  redisClient: ModerationScanRedisClient;
  actionRuntime: ActionRuntimeSettings;
  actionSchedulerClient?: ActionSchedulerClient;
  limit?: number;
  processActivity?: ModerationScanActivityProcessor;
};

export type ModerationScanItemResult = {
  targetId?: T1 | T3;
  skipped?: boolean;
  ok: boolean;
  message: string;
};

export type ModerationScanResult = {
  source: ModerationScanSource;
  scanned: number;
  processed: number;
  skipped: number;
  failed: number;
  results: ModerationScanItemResult[];
};

export type ModerationScanSchedulerClient = Pick<
  ActionSchedulerClient,
  'cancelJob' | 'runJob'
>;

export type ModerationScanSchedulerRedisClient = Pick<
  ModerationScanRedisClient,
  'get' | 'set'
>;

type ScheduledScanRecord = {
  version: 1;
  jobId: string;
  runAt: string;
};

type ScanTarget = {
  activity: ActivitySnapshot;
  target: ReportableThing;
  targetId: T1 | T3;
};

export const MODERATION_SCAN_SCHEDULER_JOB_NAME =
  'contextModModerationScan';

const MODERATION_SCAN_SCHEDULER_KEY = 'context-mod:moderation-scan:scheduler';
const DEFAULT_SCAN_LIMIT = 25;
const MAX_SCAN_LIMIT = 100;
const DEFAULT_SCAN_INTERVAL_MINUTES = 10;
const MIN_SCAN_INTERVAL_MINUTES = 1;

export const normalizeModerationScanLimit = (
  value: unknown,
  fallback = DEFAULT_SCAN_LIMIT
): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(MAX_SCAN_LIMIT, Math.max(1, Math.floor(parsed)));
};

export const normalizeModerationScanIntervalMinutes = (
  value: unknown,
  fallback = DEFAULT_SCAN_INTERVAL_MINUTES
): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(MIN_SCAN_INTERVAL_MINUTES, Math.floor(parsed));
};

const pollSourceName = (source: ModerationScanSource): string => `poll:${source}`;

const getListing = (
  redditClient: ModerationScanRedditClient,
  source: ModerationScanSource,
  subredditName: string,
  limit: number
): ListingLike<Post | Comment> =>
  source === 'modqueue'
    ? redditClient.getModQueue({
        subreddit: subredditName,
        type: 'all',
        limit,
      })
    : redditClient.getUnmoderated({
        subreddit: subredditName,
        type: 'all',
        limit,
      });

const getAppUsername = async (
  redditClient: ModerationScanRedditClient
): Promise<string | undefined> => {
  try {
    return (await redditClient.getAppUser())?.username;
  } catch (error) {
    console.warn('ContextMod moderation scan app-user lookup failed:', error);
    return undefined;
  }
};

const isAuthoredByApp = (
  activity: Post | Comment,
  appUsername: string | undefined
): boolean =>
  appUsername !== undefined &&
  activity.authorName.toLowerCase() === appUsername.toLowerCase();

const isCommentLike = (item: Post | Comment): item is Comment => isT1(item.id);

const isPostLike = (item: Post | Comment): item is Post => isT3(item.id);

const snapshotScanTarget = async (
  redditClient: ModerationScanRedditClient,
  item: Post | Comment,
  source: ModerationScanSource
): Promise<ScanTarget> => {
  const itemId = item.id;
  const snapshotSource = pollSourceName(source);

  if (isCommentLike(item)) {
    const post = await redditClient.getPostById(item.postId);
    return {
      activity: snapshotFromComment(item, {
        parentPost: post,
        source: snapshotSource,
      }),
      target: item,
      targetId: item.id,
    };
  }

  if (!isPostLike(item)) {
    throw new Error(`unsupported moderation queue item id: ${itemId}`);
  }

  return {
    activity: snapshotFromPost(item, { source: snapshotSource }),
    target: item,
    targetId: item.id,
  };
};

export const processModerationScan = async (
  input: ModerationScanInput
): Promise<ModerationScanResult> => {
  const limit = normalizeModerationScanLimit(input.limit);
  const listing = getListing(
    input.redditClient,
    input.scanSource,
    input.subredditName,
    limit
  );
  const items = await listing.all();
  const appUsername = await getAppUsername(input.redditClient);
  const processActivity = input.processActivity ?? processContextModActivity;
  const results: ModerationScanItemResult[] = [];

  for (const item of items) {
    if (isAuthoredByApp(item, appUsername)) {
      results.push({
        ok: true,
        skipped: true,
        message: 'skipped app-authored item',
      });
      continue;
    }

    try {
      const target = await snapshotScanTarget(
        input.redditClient,
        item,
        input.scanSource
      );
      const processed = await processActivity({
        source: input.source,
        activity: target.activity,
        target: target.target,
        targetId: target.targetId,
        redditClient: input.redditClient,
        redisClient: input.redisClient,
        actionRuntime: input.actionRuntime,
        ...(input.actionSchedulerClient === undefined
          ? {}
          : { actionSchedulerClient: input.actionSchedulerClient }),
        configFragmentLoader: input.redditClient,
        actionWikiContentLoader: input.redditClient,
      });

      results.push({
        targetId: target.targetId,
        ok: processed.ok,
        message: processed.message,
      });
    } catch (error) {
      results.push({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    source: input.scanSource,
    scanned: items.length,
    processed: results.filter((result) => result.skipped !== true).length,
    skipped: results.filter((result) => result.skipped === true).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
};

export const summarizeModerationScanResult = (
  result: ModerationScanResult
): string =>
  `${result.source}: scanned ${result.scanned}, processed ${result.processed}, skipped ${result.skipped}, failed ${result.failed}`;

const parseScheduledScanRecord = (
  value: string | undefined
): ScheduledScanRecord | undefined => {
  if (value === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<ScheduledScanRecord>;
    return parsed.version === 1 &&
      typeof parsed.jobId === 'string' &&
      typeof parsed.runAt === 'string'
      ? {
          version: 1,
          jobId: parsed.jobId,
          runAt: parsed.runAt,
        }
      : undefined;
  } catch {
    return undefined;
  }
};

export const scheduleNextModerationScan = async (
  schedulerClient: ModerationScanSchedulerClient,
  redisClient: ModerationScanSchedulerRedisClient,
  options: {
    intervalMinutes?: number;
    force?: boolean;
    now?: Date;
  } = {}
): Promise<ScheduledScanRecord> => {
  const now = options.now ?? new Date();
  const intervalMinutes = normalizeModerationScanIntervalMinutes(
    options.intervalMinutes
  );
  const existing = parseScheduledScanRecord(
    await redisClient.get(MODERATION_SCAN_SCHEDULER_KEY)
  );
  const existingRunAt =
    existing === undefined ? undefined : new Date(existing.runAt);

  if (
    options.force !== true &&
    existing !== undefined &&
    existingRunAt !== undefined &&
    Number.isFinite(existingRunAt.getTime()) &&
    existingRunAt.getTime() > now.getTime()
  ) {
    return existing;
  }

  if (existing !== undefined) {
    try {
      await schedulerClient.cancelJob(existing.jobId);
    } catch {
      // The previously stored job may already have fired or expired.
    }
  }

  const runAt = new Date(now.getTime() + intervalMinutes * 60 * 1000);
  const jobId = await schedulerClient.runJob({
    name: MODERATION_SCAN_SCHEDULER_JOB_NAME,
    runAt,
  });
  const record = {
    version: 1 as const,
    jobId,
    runAt: runAt.toISOString(),
  };
  await redisClient.set(MODERATION_SCAN_SCHEDULER_KEY, JSON.stringify(record));

  return record;
};
