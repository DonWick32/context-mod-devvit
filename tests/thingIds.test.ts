import { describe, expect, it } from 'vitest';
import {
  parseRedditThingId,
  toCommentThingId,
  toPostThingId,
} from '../src/runtime/thingIds';

describe('thing id helpers', () => {
  it('keeps full post and comment thing ids', () => {
    expect(toPostThingId('t3_abc123')).toBe('t3_abc123');
    expect(toCommentThingId('t1_def456')).toBe('t1_def456');
  });

  it('adds kind prefixes to bare reddit ids', () => {
    expect(toPostThingId('abc123')).toBe('t3_abc123');
    expect(toCommentThingId('def456')).toBe('t1_def456');
  });

  it('rejects empty, malformed, or wrong-kind ids', () => {
    expect(toPostThingId(undefined)).toBeUndefined();
    expect(toPostThingId('')).toBeUndefined();
    expect(toPostThingId('not valid')).toBeUndefined();
    expect(toPostThingId('t1_comment')).toBeUndefined();
    expect(toCommentThingId('t3_post')).toBeUndefined();
  });

  it('parses full thing ids and reddit permalinks', () => {
    expect(parseRedditThingId('t1_def456')).toBe('t1_def456');
    expect(parseRedditThingId('t3_abc123')).toBe('t3_abc123');
    expect(
      parseRedditThingId('https://reddit.com/r/test/comments/abc123/title/')
    ).toBe('t3_abc123');
    expect(
      parseRedditThingId('/r/test/comments/abc123/title/def456/')
    ).toBe('t1_def456');
    expect(parseRedditThingId('see t1_def456 please')).toBe('t1_def456');
  });
});
