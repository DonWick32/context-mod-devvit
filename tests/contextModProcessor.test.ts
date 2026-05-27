import { describe, expect, it, vi } from 'vitest';
import type { RedditClient } from '@devvit/web/server';
import type { T1 } from '@devvit/shared-types/tid.js';
import type { LoadedConfigSource } from '../src/config/configSource';
import type { ActivitySnapshot } from '../src/runtime/activityAdapter';
import { processContextModActivity } from '../src/runtime/contextModProcessor';
import type { AuditRedisClient } from '../src/storage/dryRunAudit';

class MemoryAuditRedis implements AuditRedisClient {
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
    _options?: Parameters<AuditRedisClient['set']>[2]
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
    options?: Parameters<AuditRedisClient['zRange']>[3]
  ): Promise<{ member: string; score: number }[]> {
    const members = [...(this.sortedSets.get(key) ?? [])].sort((left, right) =>
      left.score === right.score
        ? left.member.localeCompare(right.member)
        : left.score - right.score
    );
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

type ReportableThing = Parameters<RedditClient['report']>[0];

const activity: ActivitySnapshot = {
  id: 't1_comment',
  kind: 'comment',
  authorName: 'Spammer42',
  subredditName: 'testsub',
  body: 'join my discord.gg/abc123',
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

const source: LoadedConfigSource = {
  sourceName: 'subreddit setting configText',
  text: `
checks:
  - name: remove discord spam
    kind: comment
    rules:
      - name: linkOnlySpam
        kind: regex
        criteria:
          - regex: '/discord\\.gg\\/[\\w\\d]+/i'
    actions:
      - kind: remove
      - kind: report
        enable: false
        content: discord spam
`,
};

const contributorSource: LoadedConfigSource = {
  sourceName: 'subreddit setting configText',
  text: `
checks:
  - name: contributor only
    kind: comment
    authorIs:
      isContributor: true
    actions:
      - kind: report
        content: contributor matched
`,
};

const target = {
  id: 't1_comment',
} as unknown as ReportableThing;
const targetId = 't1_comment' as T1;

const createClient = () => ({
  approve: vi.fn<RedditClient['approve']>().mockResolvedValue(undefined),
  getCurrentUsername: vi
    .fn<RedditClient['getCurrentUsername']>()
    .mockResolvedValue('ContextModBot'),
  getApprovedUsers: vi.fn<RedditClient['getApprovedUsers']>(),
  getPostById: vi.fn<RedditClient['getPostById']>(),
  getModerators: vi.fn<RedditClient['getModerators']>(),
  getUserByUsername: vi.fn<RedditClient['getUserByUsername']>(),
  remove: vi.fn<RedditClient['remove']>().mockResolvedValue(undefined),
  report: vi.fn<RedditClient['report']>().mockResolvedValue({ success: true }),
  setPostFlair: vi
    .fn<RedditClient['setPostFlair']>()
    .mockResolvedValue(undefined),
});

describe('processContextModActivity', () => {
  it('runs the shared dry-run pipeline and respects action runtime gates', async () => {
    const redditClient = createClient();
    const redisClient = new MemoryAuditRedis();

    const result = await processContextModActivity({
      source,
      activity,
      target,
      targetId,
      redditClient,
      redisClient,
      actionRuntime: {
        appEnabled: true,
        dryRun: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('Dry run: 1 check(s), 1 triggered');
    expect(result.message).toContain('Actions not executed: dry run is enabled.');
    expect(redditClient.remove).not.toHaveBeenCalled();

    if (result.ok) {
      expect(result.dryRunResult.plannedActions).toHaveLength(2);
      expect(result.actionExecution).toMatchObject({
        executed: 0,
        skipped: 2,
        failed: 0,
      });
      expect(result.auditRecord?.targetId).toBe('t1_comment');
      expect(result.actionAuditRecord).toBeUndefined();
    }
  });

  it('executes enabled planned actions when runtime gates allow it', async () => {
    const redditClient = createClient();
    const redisClient = new MemoryAuditRedis();

    const result = await processContextModActivity({
      source,
      activity,
      target,
      targetId,
      redditClient,
      redisClient,
      actionRuntime: {
        appEnabled: true,
        dryRun: false,
      },
    });

    expect(result.ok).toBe(true);
    expect(redditClient.remove).toHaveBeenCalledWith(targetId, false);
    expect(redditClient.report).not.toHaveBeenCalled();
    expect(result.message).toContain(
      'Action execution: 1 executed, 1 skipped, 0 failed.'
    );
    if (result.ok) {
      expect(result.message).toContain('Action audit saved:');
      expect(result.actionAuditRecord).toMatchObject({
        targetId: 't1_comment',
        dryRunSummary: {
          checksTriggered: 1,
          plannedActionCount: 2,
        },
        actionExecution: {
          executed: 1,
          skipped: 1,
          failed: 0,
        },
      });
    }
  });

  it('hydrates author resources before evaluating filters', async () => {
    const redditClient = createClient();
    redditClient.getApprovedUsers.mockReturnValue({
      all: vi.fn().mockResolvedValue([{ username: 'Spammer42' }]),
    } as ReturnType<RedditClient['getApprovedUsers']>);
    const redisClient = new MemoryAuditRedis();

    const result = await processContextModActivity({
      source: contributorSource,
      activity,
      target,
      targetId,
      redditClient,
      redisClient,
      actionRuntime: {
        appEnabled: true,
        dryRun: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(redditClient.getApprovedUsers).toHaveBeenCalledWith({
      subredditName: 'testsub',
      username: 'Spammer42',
      limit: 1,
      pageSize: 1,
    });
    if (result.ok) {
      expect(result.dryRunResult.checksTriggered).toBe(1);
      expect(result.dryRunResult.plannedActions[0]).toMatchObject({
        kind: 'report',
      });
      expect(result.auditRecord?.result.checkResults[0]).toMatchObject({
        supported: true,
      });
    }
  });

  it('resolves self moderator-name item filters with the app username', async () => {
    const redditClient = createClient();
    const redisClient = new MemoryAuditRedis();

    const result = await processContextModActivity({
      source: {
        sourceName: 'self moderator config',
        text: `
checks:
  - name: self approval
    kind: comment
    itemIs:
      approved: self
    actions:
      - kind: report
        content: self approval matched
`,
      },
      activity: {
        ...activity,
        approved: true,
        approvedBy: 'ContextModBot',
      },
      target,
      targetId,
      redditClient,
      redisClient,
      actionRuntime: {
        appEnabled: true,
        dryRun: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(redditClient.getCurrentUsername).toHaveBeenCalledOnce();
    if (result.ok) {
      expect(result.dryRunResult.checksTriggered).toBe(1);
      expect(result.dryRunResult.checkResults[0]).toMatchObject({
        supported: true,
      });
    }
  });

  it('hydrates same-subreddit wiki config fragments before processing', async () => {
    const redditClient = createClient();
    const redisClient = new MemoryAuditRedis();
    const configFragmentLoader = {
      getWikiPage: vi.fn(async (_subredditName: string, pageName: string) => {
        if (pageName === 'botconfig/rules/discord') {
          return {
            content: `
kind: regex
criteria:
  - regex: '/discord\\.gg\\/[\\w\\d]+/i'
`,
          };
        }

        if (pageName === 'botconfig/actions/report') {
          return {
            content: `
kind: report
content: discord fragment matched
`,
          };
        }

        throw new Error('404 Not Found');
      }),
    };

    const result = await processContextModActivity({
      source: {
        sourceName: 'wiki include config',
        text: `
checks:
  - name: wiki fragment check
    kind: comment
    rules:
      - wiki:botconfig/rules/discord
    actions:
      - wiki:botconfig/actions/report
`,
      },
      activity,
      target,
      targetId,
      redditClient,
      redisClient,
      actionRuntime: {
        appEnabled: true,
        dryRun: true,
      },
      configFragmentLoader,
    });

    expect(result.ok).toBe(true);
    expect(configFragmentLoader.getWikiPage).toHaveBeenCalledWith(
      'testsub',
      'botconfig/rules/discord'
    );
    if (result.ok) {
      expect(result.dryRunResult.checksTriggered).toBe(1);
      expect(result.dryRunResult.plannedActions[0]).toMatchObject({
        kind: 'report',
        config: {
          content: 'discord fragment matched',
        },
      });
    }
  });

  it('returns config validation errors without running actions', async () => {
    const redditClient = createClient();
    const redisClient = new MemoryAuditRedis();

    const result = await processContextModActivity({
      source: {
        sourceName: 'bad config',
        text: 'checks: nope',
      },
      activity,
      target,
      targetId,
      redditClient,
      redisClient,
      actionRuntime: {
        appEnabled: true,
        dryRun: false,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Invalid ContextMod config');
    expect(redditClient.remove).not.toHaveBeenCalled();
  });
});
