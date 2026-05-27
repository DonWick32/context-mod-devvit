import { describe, expect, it } from 'vitest';
import type { ActivitySnapshot } from '../src/runtime/activityAdapter';
import type { DryRunResult } from '../src/runtime/dryRunEngine';
import {
  appendDryRunAuditRecord,
  getDryRunAuditStatus,
  listRecentDryRunAuditRecords,
  summarizeDryRunAuditStatus,
  type AuditRedisClient,
} from '../src/storage/dryRunAudit';

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

const activity: ActivitySnapshot = {
  id: 't1_comment',
  kind: 'comment',
  authorName: 'Spammer42',
  subredditName: 'testsub',
  body: 'join my discord.gg/abc123',
  createdAt: new Date('2026-05-24T00:00:00Z'),
  permalink: '/r/testsub/comments/post/comment',
  score: 1,
  removed: false,
  approved: false,
  locked: false,
  spam: false,
  stickied: false,
  distinguished: false,
};

const dryRunResult: DryRunResult = {
  activityId: 't1_comment',
  checksEvaluated: 1,
  checksTriggered: 1,
  plannedActions: [
    {
      kind: 'remove',
      enabled: true,
      dryRun: true,
      reason: 'planned only',
    },
  ],
  checkResults: [
    {
      name: 'remove discord spam',
      kind: 'comment',
      triggered: true,
      supported: true,
      skipped: false,
      reason: 'check triggered in dry run',
      rules: [
        {
          name: 'linkOnlySpam',
          triggered: true,
          supported: true,
          reason: 'matched regex',
        },
      ],
      plannedActions: [
        {
          kind: 'remove',
          enabled: true,
          dryRun: true,
          reason: 'planned only',
        },
      ],
    },
  ],
};

describe('dry-run audit storage', () => {
  it('appends and reads the latest dry-run record', async () => {
    const redis = new MemoryAuditRedis();

    const record = await appendDryRunAuditRecord(
      redis,
      {
        activity,
        configSource: 'subreddit setting configText',
        result: dryRunResult,
      },
      {
        id: 'audit-1',
        now: new Date('2026-05-25T00:00:00Z'),
      }
    );

    expect(record).toMatchObject({
      id: 'audit-1',
      configSource: 'subreddit setting configText',
      targetId: 't1_comment',
      result: {
        checksTriggered: 1,
      },
    });

    const status = await getDryRunAuditStatus(redis);
    expect(status.totalRecords).toBe(1);
    expect(status.latest?.id).toBe('audit-1');
    expect(summarizeDryRunAuditStatus(status)).toContain(
      '1/1 check(s) triggered'
    );
  });

  it('keeps only the newest records when the retention limit is exceeded', async () => {
    const redis = new MemoryAuditRedis();

    for (const [index, id] of ['audit-1', 'audit-2', 'audit-3'].entries()) {
      await appendDryRunAuditRecord(
        redis,
        {
          activity,
          configSource: 'subreddit setting configText',
          result: dryRunResult,
        },
        {
          id,
          maxRecords: 2,
          now: new Date(`2026-05-25T00:0${index}:00Z`),
        }
      );
    }

    const records = await listRecentDryRunAuditRecords(redis, 5);
    expect(records.map((record) => record.id)).toEqual(['audit-3', 'audit-2']);
  });

  it('summarizes empty audit status', () => {
    expect(summarizeDryRunAuditStatus({ totalRecords: 0 })).toBe(
      'ContextMod Devvit scaffold is installed. No dry-run audit records yet.'
    );
  });
});
