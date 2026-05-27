import { describe, expect, it } from 'vitest';
import type { ActivitySnapshot } from '../src/runtime/activityAdapter';
import type { ActionExecutionSummary } from '../src/runtime/actionExecutor';
import {
  appendActionAuditRecord,
  getActionAuditStatus,
  listRecentActionAuditRecords,
  summarizeActionAuditStatus,
  type ActionAuditRedisClient,
} from '../src/storage/actionAudit';

class MemoryActionAuditRedis implements ActionAuditRedisClient {
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
    _options?: Parameters<ActionAuditRedisClient['set']>[2]
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
    options?: Parameters<ActionAuditRedisClient['zRange']>[3]
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

const actionExecution: ActionExecutionSummary = {
  appEnabled: true,
  dryRun: false,
  executed: 1,
  failed: 0,
  skipped: 1,
  results: [
    {
      kind: 'remove',
      status: 'executed',
      reason: 'removed',
    },
    {
      kind: 'report',
      status: 'skipped',
      reason: 'action is disabled in config',
    },
  ],
};

describe('action audit storage', () => {
  it('appends and summarizes the latest real action record', async () => {
    const redis = new MemoryActionAuditRedis();

    const record = await appendActionAuditRecord(
      redis,
      {
        activity,
        actionExecution,
        checksEvaluated: 1,
        checksTriggered: 1,
        configSource: 'subreddit setting configText',
        plannedActionCount: 2,
      },
      {
        id: 'action-audit-1',
        now: new Date('2026-05-25T00:00:00Z'),
      }
    );

    expect(record).toMatchObject({
      id: 'action-audit-1',
      targetId: 't1_comment',
      dryRunSummary: {
        plannedActionCount: 2,
      },
      actionExecution: {
        executed: 1,
        skipped: 1,
      },
    });

    const status = await getActionAuditStatus(redis);
    expect(status.totalRecords).toBe(1);
    expect(status.latest?.id).toBe('action-audit-1');
    expect(summarizeActionAuditStatus(status)).toContain('1 executed');
  });

  it('keeps only newest action records when retention is exceeded', async () => {
    const redis = new MemoryActionAuditRedis();

    for (const [index, id] of ['action-1', 'action-2', 'action-3'].entries()) {
      await appendActionAuditRecord(
        redis,
        {
          activity,
          actionExecution,
          checksEvaluated: 1,
          checksTriggered: 1,
          configSource: 'subreddit setting configText',
          plannedActionCount: 2,
        },
        {
          id,
          maxRecords: 2,
          now: new Date(`2026-05-25T00:0${index}:00Z`),
        }
      );
    }

    const records = await listRecentActionAuditRecords(redis, 5);
    expect(records.map((record) => record.id)).toEqual([
      'action-3',
      'action-2',
    ]);
  });

  it('summarizes empty action audit status', () => {
    expect(summarizeActionAuditStatus({ totalRecords: 0 })).toBe(
      'No real action audit records yet.'
    );
  });
});
