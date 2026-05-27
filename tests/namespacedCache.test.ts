import { describe, expect, it } from 'vitest';
import {
  createNamespacedRedisCache,
  type NamespacedCacheRedisClient,
} from '../src/storage/namespacedCache';

class MemoryCacheRedis implements NamespacedCacheRedisClient {
  readonly strings = new Map<string, string>();
  readonly sortedSets = new Map<string, { member: string; score: number }[]>();
  readonly expirations = new Map<string, number>();

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) {
      this.strings.delete(key);
      this.sortedSets.delete(key);
      this.expirations.delete(key);
    }
  }

  async expire(key: string, seconds: number): Promise<void> {
    this.expirations.set(key, seconds);
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
    _options?: Parameters<NamespacedCacheRedisClient['set']>[2]
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
    options?: Parameters<NamespacedCacheRedisClient['zRange']>[3]
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

describe('namespaced redis cache', () => {
  it('stores and reads JSON values under a sanitized namespace', async () => {
    const redis = new MemoryCacheRedis();
    const cache = createNamespacedRedisCache(redis, {
      namespace: 'Wiki Pages',
      defaultTtlMs: 60_000,
      now: () => new Date('2026-05-25T00:00:00Z'),
    });

    await cache.set('botconfig/contextbot', { revision: 3 });

    expect(cache.namespace).toBe('wiki-pages');
    expect(cache.keyFor('botconfig/contextbot')).toContain(
      'contextmod:cache:wiki-pages:entry:botconfig%2Fcontextbot'
    );
    await expect(cache.get('botconfig/contextbot')).resolves.toEqual({
      revision: 3,
    });
  });

  it('keeps only the newest entries when maxEntries is exceeded', async () => {
    const redis = new MemoryCacheRedis();
    const cache = createNamespacedRedisCache(redis, {
      namespace: 'author-cache',
      defaultTtlMs: 5 * 60_000,
      maxEntries: 2,
    });

    await cache.set('oldest', 'a', {
      now: new Date('2026-05-25T00:00:00Z'),
    });
    await cache.set('middle', 'b', {
      now: new Date('2026-05-25T00:01:00Z'),
    });
    await cache.set('newest', 'c', {
      now: new Date('2026-05-25T00:02:00Z'),
    });

    await expect(cache.get('oldest')).resolves.toBeUndefined();
    expect(
      (
        await cache.listRecent<string>({
          now: new Date('2026-05-25T00:02:30Z'),
        })
      ).map((entry) => entry.key)
    ).toEqual(['newest', 'middle']);
  });

  it('removes expired and stale indexed entries on read', async () => {
    const redis = new MemoryCacheRedis();
    const cache = createNamespacedRedisCache(redis, {
      namespace: 'activity-cache',
      defaultTtlMs: 1_000,
    });

    await cache.set('comment:t1_a', 'cached', {
      now: new Date('2026-05-25T00:00:00Z'),
    });

    await expect(
      cache.get('comment:t1_a', new Date('2026-05-25T00:00:02Z'))
    ).resolves.toBeUndefined();
    expect(await redis.zCard(cache.indexKey)).toBe(0);
    expect(redis.strings.has(cache.keyFor('comment:t1_a'))).toBe(false);
  });

  it('batch reads values and prunes corrupt records', async () => {
    const redis = new MemoryCacheRedis();
    const cache = createNamespacedRedisCache(redis, {
      namespace: 'rule-results',
      defaultTtlMs: 60_000,
    });

    await cache.set('valid', { matched: true });
    await redis.set(cache.keyFor('corrupt'), 'not-json');
    await redis.zAdd(cache.indexKey, { member: 'corrupt', score: 2 });

    const values = await cache.mGet<{ matched: boolean }>(['valid', 'corrupt']);

    expect(values.get('valid')).toEqual({ matched: true });
    expect(values.has('corrupt')).toBe(false);
    expect(await redis.zCard(cache.indexKey)).toBe(1);
  });
});
