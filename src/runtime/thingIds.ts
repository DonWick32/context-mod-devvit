import { isT1, isT3, type T1, type T3 } from '@devvit/shared-types/tid.js';

const BARE_REDDIT_ID_PATTERN = /^[a-z0-9]+$/i;

const normalizeBareThingId = (
  prefix: 't1' | 't3',
  value: string | undefined
): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.includes('_')) {
    return trimmed;
  }

  return BARE_REDDIT_ID_PATTERN.test(trimmed)
    ? `${prefix}_${trimmed}`
    : undefined;
};

export const toCommentThingId = (value: string | undefined): T1 | undefined => {
  const normalized = normalizeBareThingId('t1', value);
  return normalized !== undefined && isT1(normalized) ? normalized : undefined;
};

export const toPostThingId = (value: string | undefined): T3 | undefined => {
  const normalized = normalizeBareThingId('t3', value);
  return normalized !== undefined && isT3(normalized) ? normalized : undefined;
};

export const parseRedditThingId = (
  value: string | undefined
): T1 | T3 | undefined => {
  const trimmedValue = value?.trim();
  if (!trimmedValue) {
    return undefined;
  }

  if (isT1(trimmedValue) || isT3(trimmedValue)) {
    return trimmedValue;
  }

  const thingIdMatch = trimmedValue.match(/\b(t[13]_[a-z0-9]+)\b/i);
  const thingId = thingIdMatch?.[1];
  if (thingId !== undefined && (isT1(thingId) || isT3(thingId))) {
    return thingId;
  }

  let pathname: string;
  try {
    pathname = new URL(
      trimmedValue.startsWith('http')
        ? trimmedValue
        : `https://reddit.com${trimmedValue.startsWith('/') ? '' : '/'}${
            trimmedValue
          }`
    ).pathname;
  } catch {
    return undefined;
  }

  const parts = pathname.split('/').filter(Boolean);
  const commentsIndex = parts.findIndex((part) => part === 'comments');
  const postId = parts[commentsIndex + 1];
  if (commentsIndex === -1 || postId === undefined || !/^[a-z0-9]+$/i.test(postId)) {
    return undefined;
  }

  const commentId = parts[commentsIndex + 3];
  if (commentId !== undefined && /^[a-z0-9]+$/i.test(commentId)) {
    return `t1_${commentId}` as T1;
  }

  return `t3_${postId}` as T3;
};
