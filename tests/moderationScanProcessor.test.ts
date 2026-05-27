import { describe, expect, it, vi } from 'vitest';
import type { Comment, Post } from '@devvit/web/server';
import type { T1, T3 } from '@devvit/shared-types/tid.js';
import type { LoadedConfigSource } from '../src/config/configSource';
import {
  processModerationScan,
  scheduleNextModerationScan,
  type ModerationScanActivityProcessor,
  type ModerationScanRedditClient,
  type ModerationScanRedisClient,
  type ModerationScanSchedulerRedisClient,
} from '../src/runtime/moderationScanProcessor';

const source: LoadedConfigSource = {
  sourceName: 'test config',
  text: 'checks: []',
};

const parentPost = {
  id: 't3_parent' as T3,
  authorName: 'Poster',
} as Post;

const queuePost = {
  id: 't3_post' as T3,
  authorName: 'Poster',
  subredditName: 'context_mod_dev',
  title: 'queued post',
  body: '',
  url: 'https://www.reddit.com/r/context_mod_dev/comments/post/queued_post/',
  createdAt: new Date('2026-05-25T00:00:00Z'),
  permalink: '/r/context_mod_dev/comments/post/queued_post/',
  score: 1,
  numberOfReports: 1,
  removed: false,
  approved: false,
  locked: false,
  spam: false,
  stickied: false,
  distinguishedBy: undefined,
  nsfw: false,
  spoiler: false,
  flair: undefined,
  authorFlair: undefined,
} as Post;

const queueComment = {
  id: 't1_comment' as T1,
  authorName: 'Commenter',
  subredditName: 'context_mod_dev',
  body: 'queued comment',
  createdAt: new Date('2026-05-25T00:01:00Z'),
  permalink: '/r/context_mod_dev/comments/post/comment/',
  score: 2,
  numReports: 1,
  removed: false,
  approved: false,
  locked: false,
  spam: false,
  stickied: false,
  distinguishedBy: undefined,
  parentId: 't3_parent' as T3,
  postId: 't3_parent' as T3,
  authorFlair: undefined,
} as Comment;

const createListing = <T>(items: T[]) => ({
  all: vi.fn<() => Promise<T[]>>().mockResolvedValue(items),
});

const createProcessor = () =>
  vi.fn<ModerationScanActivityProcessor>().mockResolvedValue({
    ok: true,
    message: 'processed',
  } as Awaited<ReturnType<ModerationScanActivityProcessor>>);

const createRedditClient = (items: (Post | Comment)[]) =>
  ({
    getAppUser: vi.fn().mockResolvedValue({ username: 'ContextModApp' }),
    getModQueue: vi.fn().mockReturnValue(createListing(items)),
    getUnmoderated: vi.fn().mockReturnValue(createListing(items)),
    getPostById: vi.fn().mockResolvedValue(parentPost),
  }) as unknown as ModerationScanRedditClient;

const redisClient = {} as ModerationScanRedisClient;

describe('moderation scan processor', () => {
  it('processes modqueue posts and comments with poll source metadata', async () => {
    const redditClient = createRedditClient([queuePost, queueComment]);
    const processActivity = createProcessor();

    const result = await processModerationScan({
      source,
      scanSource: 'modqueue',
      subredditName: 'context_mod_dev',
      redditClient,
      redisClient,
      actionRuntime: {
        appEnabled: true,
        dryRun: true,
      },
      limit: 10,
      processActivity,
    });

    expect(redditClient.getModQueue).toHaveBeenCalledWith({
      subreddit: 'context_mod_dev',
      type: 'all',
      limit: 10,
    });
    expect(redditClient.getPostById).toHaveBeenCalledWith('t3_parent');
    expect(result).toMatchObject({
      source: 'modqueue',
      scanned: 2,
      processed: 2,
      skipped: 0,
      failed: 0,
    });
    expect(processActivity).toHaveBeenCalledTimes(2);
    expect(processActivity.mock.calls[0]?.[0].activity).toMatchObject({
      id: 't3_post',
      kind: 'submission',
      source: 'poll:modqueue',
    });
    expect(processActivity.mock.calls[1]?.[0].activity).toMatchObject({
      id: 't1_comment',
      kind: 'comment',
      source: 'poll:modqueue',
      commentIsOp: false,
    });
  });

  it('skips app-authored unmoderated items before rule processing', async () => {
    const appPost = {
      ...queuePost,
      id: 't3_app' as T3,
      authorName: 'ContextModApp',
    } as Post;
    const redditClient = createRedditClient([appPost, queuePost]);
    const processActivity = createProcessor();

    const result = await processModerationScan({
      source,
      scanSource: 'unmoderated',
      subredditName: 'context_mod_dev',
      redditClient,
      redisClient,
      actionRuntime: {
        appEnabled: true,
        dryRun: true,
      },
      processActivity,
    });

    expect(redditClient.getUnmoderated).toHaveBeenCalledWith({
      subreddit: 'context_mod_dev',
      type: 'all',
      limit: 25,
    });
    expect(result).toMatchObject({
      source: 'unmoderated',
      scanned: 2,
      processed: 1,
      skipped: 1,
      failed: 0,
    });
    expect(processActivity).toHaveBeenCalledOnce();
    expect(processActivity.mock.calls[0]?.[0].activity).toMatchObject({
      id: 't3_post',
      source: 'poll:unmoderated',
    });
  });
});

describe('moderation scan scheduling', () => {
  it('keeps an existing future scheduler job unless forced', async () => {
    const redis = {
      get: vi.fn().mockResolvedValue(
        JSON.stringify({
          version: 1,
          jobId: 'existing-job',
          runAt: '2026-05-25T00:10:00.000Z',
        })
      ),
      set: vi.fn(),
    } as unknown as ModerationScanSchedulerRedisClient;
    const scheduler = {
      runJob: vi.fn(),
      cancelJob: vi.fn(),
    };

    const record = await scheduleNextModerationScan(scheduler, redis, {
      now: new Date('2026-05-25T00:00:00.000Z'),
    });

    expect(record.jobId).toBe('existing-job');
    expect(scheduler.runJob).not.toHaveBeenCalled();
    expect(scheduler.cancelJob).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('replaces stale scheduler jobs and stores the next run', async () => {
    const redis = {
      get: vi.fn().mockResolvedValue(
        JSON.stringify({
          version: 1,
          jobId: 'stale-job',
          runAt: '2026-05-25T00:00:00.000Z',
        })
      ),
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as ModerationScanSchedulerRedisClient;
    const scheduler = {
      runJob: vi.fn().mockResolvedValue('next-job'),
      cancelJob: vi.fn().mockResolvedValue(undefined),
    };

    const record = await scheduleNextModerationScan(scheduler, redis, {
      intervalMinutes: 5,
      now: new Date('2026-05-25T00:00:00.000Z'),
    });

    expect(scheduler.cancelJob).toHaveBeenCalledWith('stale-job');
    expect(scheduler.runJob).toHaveBeenCalledWith({
      name: 'contextModModerationScan',
      runAt: new Date('2026-05-25T00:05:00.000Z'),
    });
    expect(record).toEqual({
      version: 1,
      jobId: 'next-job',
      runAt: '2026-05-25T00:05:00.000Z',
    });
    expect(redis.set).toHaveBeenCalledWith(
      'context-mod:moderation-scan:scheduler',
      JSON.stringify(record)
    );
  });
});
