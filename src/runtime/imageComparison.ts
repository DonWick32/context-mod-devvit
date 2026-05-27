import { computeImageHashAndFlipped, hashSimilarityPercent } from './imageHash';
import type { RedisClient } from '@devvit/public-api';

const IMAGE_HASH_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const HTTP_TIMEOUT_MS = 10000; // 10 seconds

export const fetchAndHashImage = async (
  url: string,
  redisClient?: Pick<RedisClient, 'get' | 'set' | 'expire'>
): Promise<{ hash: string; flippedHash: string } | undefined> => {
  const cacheKey = `img_hash:${url}`;
  
  if (redisClient) {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      const [hash, flippedHash] = cached.split('|');
      if (hash && flippedHash) {
        return { hash, flippedHash };
      }
    }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    
    if (!response.ok) {
      return undefined;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/jpeg') && !contentType.startsWith('image/png') && !contentType.startsWith('image/jpg')) {
      return undefined;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    
    const [hash, flippedHash] = computeImageHashAndFlipped(buffer, contentType);

    if (redisClient) {
      await redisClient.set(cacheKey, `${hash}|${flippedHash}`);
      await redisClient.expire(cacheKey, IMAGE_HASH_TTL_SECONDS);
    }

    return { hash, flippedHash };
  } catch (error) {
    console.error(`Failed to fetch and hash image ${url}:`, error);
    return undefined;
  }
};

export const compareImages = (
  hash1: string,
  flippedHash1: string,
  hash2: string,
  similarityThreshold = 95
): boolean => {
  const simOriginal = hashSimilarityPercent(hash1, hash2);
  if (simOriginal >= similarityThreshold) {
    return true;
  }

  const simFlipped = hashSimilarityPercent(flippedHash1, hash2);
  if (simFlipped >= similarityThreshold) {
    return true;
  }

  return false;
};
