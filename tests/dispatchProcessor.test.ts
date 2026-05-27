import { describe, expect, it, vi } from 'vitest';
import type { RedditClient } from '@devvit/web/server';
import type { ActivitySnapshot } from '../src/runtime/activityAdapter';
import { processDispatchRecord } from '../src/runtime/dispatchProcessor';
import {
  enqueueDispatchRecord,
  listDispatchRecords,
  type DispatchQueueRedisClient,
} from '../src/storage/dispatchQueue';

class MemoryProcessRedis implements DispatchQueueRedisClient {
  readonly strings = new Map<string, string>();
  readonly sortedSets = new Map<string, { member: string; score: number }[]>();

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) {
      this.strings.delete(key);
      this.sortedSets.delete(key);
    }
  }

  async expire(_key: string, _seconds: number): Promise<void> {
    return undefined;
  }

  async get(key: string): Promise<string | undefined> {
    return this.strings.get(key);
  }

  async mGet(keys: string[]): Promise<(string | null)[]> {
    return keys.map((key) => this.strings.get(key) ?? null);
  }

  async set(
    key: string,
    value: string,
    _options?: Parameters<DispatchQueueRedisClient['set']>[2]
  ): Promise<string> {
    this.strings.set(key, value);
    return 'OK';
  }

  async zAdd(
    key: string,
    ...members: { member: string; score: number }[]
  ): Promise<number> {
    const existing = this.sortedSets.get(key) ?? [];
    let added = 0;

    for (const member of members) {
      const index = existing.findIndex((item) => item.member === member.member);
      if (index === -1) {
        existing.push(member);
        added++;
      } else {
        existing[index] = member;
      }
    }

    this.sortedSets.set(key, existing);
    return added;
  }

  async zCard(key: string): Promise<number> {
    return this.sortedSets.get(key)?.length ?? 0;
  }

  async zRange(
    key: string,
    start: number,
    stop: number,
    options?: Parameters<DispatchQueueRedisClient['zRange']>[3]
  ): Promise<{ member: string; score: number }[]> {
    const members = [...(this.sortedSets.get(key) ?? [])].sort((left, right) =>
      left.score === right.score
        ? left.member.localeCompare(right.member)
        : left.score - right.score
    );
    if (options?.by === 'score') {
      return members.filter(
        (member) => member.score >= Number(start) && member.score <= Number(stop)
      );
    }
    if (options?.reverse) {
      members.reverse();
    }

    return members.slice(start, stop + 1);
  }

  async zRem(key: string, members: string[]): Promise<number> {
    const existing = this.sortedSets.get(key) ?? [];
    const remaining = existing.filter((item) => !members.includes(item.member));
    this.sortedSets.set(key, remaining);
    return existing.length - remaining.length;
  }
}

const activity: ActivitySnapshot = {
  id: 't1_comment',
  kind: 'comment',
  authorName: 'Spammer42',
  subredditName: 'testsub',
  body: 'queued dispatch item',
  createdAt: new Date('2026-05-25T00:00:00Z'),
  permalink: '/r/testsub/comments/post/comment',
  score: 1,
  removed: false,
  approved: false,
  locked: false,
  spam: false,
  stickied: false,
  distinguished: false,
};

const post = {
  id: 't3_post',
  authorName: 'Poster42',
  subredditName: 'testsub',
  title: 'Dispatch host',
  body: '',
  url: 'https://www.reddit.com/r/testsub/comments/post/dispatch_host/',
  createdAt: new Date('2026-05-25T00:00:00Z'),
  permalink: '/r/testsub/comments/post/dispatch_host/',
  score: 1,
  numberOfReports: 0,
  removed: false,
  approved: false,
  locked: false,
  spam: false,
  stickied: false,
  distinguishedBy: undefined,
  nsfw: false,
  spoiler: false,
};

const comment = {
  id: 't1_comment',
  authorName: 'Spammer42',
  subredditName: 'testsub',
  body: 'queued dispatch item',
  createdAt: new Date('2026-05-25T00:00:00Z'),
  permalink: '/r/testsub/comments/post/comment',
  score: 1,
  numReports: 0,
  removed: false,
  approved: false,
  locked: false,
  spam: false,
  stickied: false,
  distinguishedBy: undefined,
  parentId: 't3_post',
  postId: 't3_post',
};

const createClient = () => ({
  addModNote: vi.fn<RedditClient['addModNote']>(),
  approve: vi.fn<RedditClient['approve']>(),
  approveUser: vi.fn<RedditClient['approveUser']>(),
  banUser: vi.fn<RedditClient['banUser']>(),
  getApprovedUsers: vi.fn<RedditClient['getApprovedUsers']>(),
  getCommentById: vi.fn<RedditClient['getCommentById']>().mockResolvedValue(comment),
  getModerators: vi.fn<RedditClient['getModerators']>(),
  getPostById: vi.fn<RedditClient['getPostById']>().mockResolvedValue(post),
  getUserByUsername: vi.fn<RedditClient['getUserByUsername']>(),
  getWikiPage: vi.fn<RedditClient['getWikiPage']>(),
  remove: vi.fn<RedditClient['remove']>(),
  removeUser: vi.fn<RedditClient['removeUser']>(),
  removeUserFlair: vi.fn<RedditClient['removeUserFlair']>(),
  report: vi.fn<RedditClient['report']>(),
  sendPrivateMessage: vi.fn<RedditClient['sendPrivateMessage']>(),
  setPostFlair: vi.fn<RedditClient['setPostFlair']>(),
  setUserFlair: vi.fn<RedditClient['setUserFlair']>(),
});

describe('dispatch processor', () => {
  it('processes a queued dispatch record with dispatch source and goto', async () => {
    const redisClient = new MemoryProcessRedis();
    const redditClient = createClient();
    const record = await enqueueDispatchRecord(
      redisClient,
      {
        activity,
        delayMs: 0,
        goto: 'second check',
        identifier: 'followup',
      },
      {
        id: 'dispatch-1',
      }
    );

    const result = await processDispatchRecord({
      source: {
        sourceName: 'test config',
        text: `
runs:
  - name: default
    checks:
      - name: first check
        kind: comment
        itemIs:
          source: user
        actions:
          - kind: report
            content: first
      - name: second check
        kind: comment
        itemIs:
          source: dispatch:followup
        actions:
          - kind: report
            content: second
`,
      },
      record,
      redditClient,
      redisClient,
      actionRuntime: {
        appEnabled: true,
        dryRun: true,
      },
    });

    expect(result).toMatchObject({
      dispatchId: 'dispatch-1',
      ok: true,
    });
    expect(result.message).toContain('1 check(s), 1 triggered');
    expect(redditClient.getCommentById).toHaveBeenCalledWith('t1_comment');
    await expect(listDispatchRecords(redisClient)).resolves.toEqual([]);
  });
});
