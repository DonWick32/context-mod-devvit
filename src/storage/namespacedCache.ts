import type { RedisClient } from '@devvit/web/server';
import {
  pruneOldestIndexedRecords,
  removeIndexedRecords,
  type IndexedRetentionResult,
} from './retention';

export type NamespacedCacheRedisClient = Pick<
  RedisClient,
  | 'del'
  | 'expire'
  | 'get'
  | 'mGet'
  | 'set'
  | 'zAdd'
  | 'zCard'
  | 'zRange'
  | 'zRem'
>;

export type CacheEntry<T = unknown> = {
  version: 1;
  namespace: string;
  key: string;
  createdAt: string;
  value: T;
  expiresAt?: string;
};

export type NamespacedRedisCacheOptions = {
  namespace: string;
  defaultTtlMs?: number;
  keyPrefix?: string;
  maxEntries?: number;
  now?: () => Date;
};

export type CacheSetOptions = {
  ttlMs?: number;
  maxEntries?: number;
  now?: Date;
};

export type CacheListOptions = {
  count?: number;
  now?: Date;
};

const DEFAULT_KEY_PREFIX = 'contextmod';
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_MAX_ENTRIES = 100;

const sanitizeSegment = (value: string, label: string): string => {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (sanitized.length === 0) {
    throw new Error(`${label} must contain at least one key-safe character`);
  }

  return sanitized;
};

const encodeCacheKey = (key: string): string => encodeURIComponent(key);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseCacheEntry = <T>(
  rawValue: string | null | undefined,
  namespace: string,
  key?: string
): CacheEntry<T> | undefined => {
  if (rawValue === null || rawValue === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      parsed.namespace === namespace &&
      typeof parsed.key === 'string' &&
      (key === undefined || parsed.key === key) &&
      typeof parsed.createdAt === 'string' &&
      Object.prototype.hasOwnProperty.call(parsed, 'value') &&
      (parsed.expiresAt === undefined || typeof parsed.expiresAt === 'string')
    ) {
      return parsed as CacheEntry<T>;
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const isExpired = (entry: CacheEntry, now: Date): boolean =>
  entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= now.getTime();

const normalizePositiveInteger = (
  value: number | undefined,
  fallback: number,
  label: string
): number => {
  const normalized = Math.floor(value ?? fallback);
  if (!Number.isFinite(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive integer`);
  }

  return normalized;
};

export class NamespacedRedisCache {
  readonly #redis: NamespacedCacheRedisClient;
  readonly #namespace: string;
  readonly #baseKey: string;
  readonly #indexKey: string;
  readonly #defaultTtlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => Date;

  constructor(
    redis: NamespacedCacheRedisClient,
    options: NamespacedRedisCacheOptions
  ) {
    const keyPrefix = sanitizeSegment(
      options.keyPrefix ?? DEFAULT_KEY_PREFIX,
      'cache keyPrefix'
    );
    this.#namespace = sanitizeSegment(options.namespace, 'cache namespace');
    this.#redis = redis;
    this.#baseKey = `${keyPrefix}:cache:${this.#namespace}`;
    this.#indexKey = `${this.#baseKey}:index`;
    this.#defaultTtlMs = normalizePositiveInteger(
      options.defaultTtlMs,
      DEFAULT_CACHE_TTL_MS,
      'cache defaultTtlMs'
    );
    this.#maxEntries = normalizePositiveInteger(
      options.maxEntries,
      DEFAULT_CACHE_MAX_ENTRIES,
      'cache maxEntries'
    );
    this.#now = options.now ?? (() => new Date());
  }

  get namespace(): string {
    return this.#namespace;
  }

  get indexKey(): string {
    return this.#indexKey;
  }

  keyFor(logicalKey: string): string {
    return `${this.#baseKey}:entry:${encodeCacheKey(logicalKey)}`;
  }

  async set<T>(
    key: string,
    value: T,
    options: CacheSetOptions = {}
  ): Promise<CacheEntry<T>> {
    if (key.trim().length === 0) {
      throw new Error('cache key must not be empty');
    }
    if (value === undefined) {
      throw new Error('cache value must be JSON serializable');
    }

    const now = options.now ?? this.#now();
    const ttlMs = normalizePositiveInteger(
      options.ttlMs,
      this.#defaultTtlMs,
      'cache ttlMs'
    );
    const maxEntries = normalizePositiveInteger(
      options.maxEntries,
      this.#maxEntries,
      'cache maxEntries'
    );
    const entry: CacheEntry<T> = {
      version: 1,
      namespace: this.#namespace,
      key,
      createdAt: now.toISOString(),
      value,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };

    await this.#redis.set(this.keyFor(key), JSON.stringify(entry), {
      expiration: new Date(now.getTime() + ttlMs),
    });
    await this.#redis.zAdd(this.#indexKey, {
      member: key,
      score: now.getTime(),
    });
    await this.#redis.expire(this.#indexKey, Math.ceil(ttlMs / 1000));
    await this.prune(maxEntries);

    return entry;
  }

  async get<T>(key: string, now = this.#now()): Promise<T | undefined> {
    const rawValue = await this.#redis.get(this.keyFor(key));
    const entry = parseCacheEntry<T>(rawValue, this.#namespace, key);
    if (entry === undefined || isExpired(entry, now)) {
      await removeIndexedRecords(this.#redis, {
        indexKey: this.#indexKey,
        members: [key],
        recordKey: (member) => this.keyFor(member),
      });
      return undefined;
    }

    return entry.value;
  }

  async mGet<T>(
    keys: string[],
    now = this.#now()
  ): Promise<Map<string, T>> {
    if (keys.length === 0) {
      return new Map();
    }

    const values = await this.#redis.mGet(keys.map((key) => this.keyFor(key)));
    const staleKeys: string[] = [];
    const result = new Map<string, T>();

    for (const [index, rawValue] of values.entries()) {
      const key = keys[index];
      if (key === undefined) {
        continue;
      }

      const entry = parseCacheEntry<T>(rawValue, this.#namespace, key);
      if (entry === undefined || isExpired(entry, now)) {
        staleKeys.push(key);
        continue;
      }

      result.set(key, entry.value);
    }

    await this.remove(staleKeys);
    return result;
  }

  async listRecent<T>(options: CacheListOptions = {}): Promise<CacheEntry<T>[]> {
    const count = Math.floor(options.count ?? 10);
    if (count <= 0) {
      return [];
    }

    const members = await this.#redis.zRange(this.#indexKey, 0, count - 1, {
      by: 'rank',
      reverse: true,
    });
    const keys = members.map((member) => member.member);
    const values = await this.#redis.mGet(keys.map((key) => this.keyFor(key)));
    const now = options.now ?? this.#now();
    const staleKeys: string[] = [];
    const entries: CacheEntry<T>[] = [];

    for (const [index, rawValue] of values.entries()) {
      const key = keys[index];
      const entry = parseCacheEntry<T>(rawValue, this.#namespace, key);
      if (key === undefined) {
        continue;
      }
      if (entry === undefined || isExpired(entry, now)) {
        staleKeys.push(key);
        continue;
      }

      entries.push(entry);
    }

    await this.remove(staleKeys);
    return entries;
  }

  async remove(keys: string[]): Promise<IndexedRetentionResult> {
    return removeIndexedRecords(this.#redis, {
      indexKey: this.#indexKey,
      members: keys,
      recordKey: (member) => this.keyFor(member),
    });
  }

  async prune(maxEntries = this.#maxEntries): Promise<IndexedRetentionResult> {
    return pruneOldestIndexedRecords(this.#redis, {
      indexKey: this.#indexKey,
      maxRecords: maxEntries,
      recordKey: (member) => this.keyFor(member),
    });
  }
}

export const createNamespacedRedisCache = (
  redis: NamespacedCacheRedisClient,
  options: NamespacedRedisCacheOptions
): NamespacedRedisCache => new NamespacedRedisCache(redis, options);
