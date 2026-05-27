import { describe, expect, it } from 'vitest';
import type { ActivitySnapshot } from '../src/runtime/activityAdapter';
import {
  cancelDispatchRecords,
  cancelDispatchRecord,
  enqueueDispatchRecord,
  findDispatchRecords,
  getDispatchRecord,
  listDueDispatchRecords,
  listDispatchRecords,
  setDispatchSchedulerJobId,
  type DispatchQueueRedisClient,
} from '../src/storage/dispatchQueue';

class MemoryDispatchRedis implements DispatchQueueRedisClient {
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
  id: 't3_post',
  kind: 'submission',
  authorName: 'Poster42',
  subredditName: 'testsub',
  title: 'Needs verification',
  body: '',
  createdAt: new Date('2026-05-25T00:00:00Z'),
  permalink: '/r/testsub/comments/post/needs_verification/',
  score: 1,
  removed: false,
  approved: false,
  locked: false,
  spam: false,
  stickied: false,
  distinguished: false,
};

describe('dispatch queue storage', () => {
  it('enqueues delayed dispatch records and lists due records', async () => {
    const redis = new MemoryDispatchRedis();

    const record = await enqueueDispatchRecord(
      redis,
      {
        activity,
        delayMs: 10 * 60_000,
        dryRun: true,
        goto: 'verification',
        identifier: 'subVerification',
        schedulerJobId: 'job-1',
      },
      {
        id: 'dispatch-1',
        now: new Date('2026-05-25T00:00:00Z'),
      }
    );

    expect(record).toMatchObject({
      id: 'dispatch-1',
      runAt: '2026-05-25T00:10:00.000Z',
      identifier: 'subVerification',
      schedulerJobId: 'job-1',
    });
    await expect(
      listDueDispatchRecords(redis, new Date('2026-05-25T00:09:59Z'))
    ).resolves.toEqual([]);
    expect(
      (await listDueDispatchRecords(redis, new Date('2026-05-25T00:10:00Z')))[0]
        ?.id
    ).toBe('dispatch-1');
  });

  it('patches scheduler job ids into queued records', async () => {
    const redis = new MemoryDispatchRedis();
    await enqueueDispatchRecord(
      redis,
      {
        activity,
        delayMs: 0,
      },
      {
        id: 'dispatch-1',
      }
    );

    await expect(
      setDispatchSchedulerJobId(redis, 'dispatch-1', 'scheduler-1')
    ).resolves.toMatchObject({
      id: 'dispatch-1',
      schedulerJobId: 'scheduler-1',
    });
    await expect(getDispatchRecord(redis, 'dispatch-1')).resolves.toMatchObject({
      schedulerJobId: 'scheduler-1',
    });
  });

  it('cancels dispatch records', async () => {
    const redis = new MemoryDispatchRedis();
    await enqueueDispatchRecord(
      redis,
      {
        activity,
        delayMs: 0,
      },
      {
        id: 'dispatch-1',
      }
    );

    await expect(cancelDispatchRecord(redis, 'dispatch-1')).resolves.toBe(true);
    await expect(
      listDueDispatchRecords(redis, new Date('2026-05-25T00:00:00Z'))
    ).resolves.toEqual([]);
  });

  it('finds and cancels dispatch records by target and identifier', async () => {
    const redis = new MemoryDispatchRedis();
    await enqueueDispatchRecord(
      redis,
      {
        activity,
        delayMs: 0,
        identifier: 'self-check',
      },
      {
        id: 'dispatch-1',
      }
    );
    await enqueueDispatchRecord(
      redis,
      {
        activity,
        delayMs: 0,
        identifier: 'other-check',
      },
      {
        id: 'dispatch-2',
      }
    );

    await expect(
      findDispatchRecords(redis, {
        targetId: 't3_post',
        identifiers: ['self-check'],
      })
    ).resolves.toMatchObject([{ id: 'dispatch-1' }]);
    await expect(
      cancelDispatchRecords(redis, {
        targetId: 't3_post',
        identifiers: ['self-check'],
      })
    ).resolves.toMatchObject([{ id: 'dispatch-1' }]);
    expect((await listDispatchRecords(redis)).map((record) => record.id)).toEqual([
      'dispatch-2',
    ]);
  });

  it('keeps only newest dispatch records when retention is exceeded', async () => {
    const redis = new MemoryDispatchRedis();

    for (const [index, id] of ['dispatch-1', 'dispatch-2', 'dispatch-3'].entries()) {
      await enqueueDispatchRecord(
        redis,
        {
          activity,
          delayMs: index * 60_000,
        },
        {
          id,
          maxRecords: 2,
          now: new Date('2026-05-25T00:00:00Z'),
        }
      );
    }

    const due = await listDueDispatchRecords(
      redis,
      new Date('2026-05-25T00:03:00Z')
    );
    expect(due.map((record) => record.id)).toEqual([
      'dispatch-2',
      'dispatch-3',
    ]);
  });
});
