import { describe, expect, it } from 'vitest';
import type { Comment, Post } from '@devvit/web/server';
import {
  snapshotFromComment,
  snapshotFromPost,
} from '../src/runtime/activityAdapter';

const createPost = (overrides: Record<string, unknown> = {}): Post =>
  ({
    id: 't3_post',
    authorName: 'Poster42',
    subredditName: 'testsub',
    title: 'Media post',
    body: undefined,
    url: 'https://example.com/post',
    createdAt: new Date('2026-05-25T00:00:00Z'),
    permalink: '/r/testsub/comments/post/media_post/',
    score: 1,
    numberOfReports: 0,
    removed: false,
    removedBy: undefined,
    approved: false,
    approvedAtUtc: 0,
    locked: false,
    spam: false,
    stickied: false,
    distinguishedBy: undefined,
    archived: false,
    quarantined: false,
    hidden: false,
    ignoringReports: false,
    nsfw: false,
    spoiler: false,
    flair: undefined,
    authorFlair: undefined,
    userReportReasons: [],
    modReportReasons: [],
    secureMedia: undefined,
    gallery: [],
    ...overrides,
  }) as unknown as Post;

describe('snapshotFromPost', () => {
  it('detects Reddit-hosted media from urls, galleries, and reddit video metadata', () => {
    expect(
      snapshotFromPost(
        createPost({ url: 'https://i.redd.it/example.png' })
      ).isRedditMediaDomain
    ).toBe(true);
    expect(
      snapshotFromPost(
        createPost({ url: 'https://www.reddit.com/gallery/abc123' })
      ).isRedditMediaDomain
    ).toBe(true);
    expect(
      snapshotFromPost(createPost({ gallery: [{ url: 'https://i.redd.it/a.png' }] }))
        .isRedditMediaDomain
    ).toBe(true);
    expect(
      snapshotFromPost(
        createPost({
          secureMedia: {
            redditVideo: { fallbackUrl: 'https://v.redd.it/abc/DASH_720.mp4' },
          },
        })
      ).isRedditMediaDomain
    ).toBe(true);
  });

  it('does not treat external embeds as Reddit-hosted media', () => {
    expect(
      snapshotFromPost(
        createPost({
          secureMedia: {
            type: 'youtube.com',
            oembed: { providerName: 'YouTube' },
          },
          url: 'https://www.youtube.com/watch?v=abc123',
        })
      ).isRedditMediaDomain
    ).toBe(false);
  });

  it('copies Devvit report reasons into post snapshots', () => {
    expect(
      snapshotFromPost(
        createPost({
          numberOfReports: 3,
          userReportReasons: ['misinformation', 'spam'],
          modReportReasons: ['Rule 1'],
        })
      )
    ).toMatchObject({
      numReports: 3,
      userReportReasons: ['misinformation', 'spam'],
      modReportReasons: ['Rule 1'],
    });
  });

  it('copies additional Devvit moderation state into post snapshots', () => {
    expect(
      snapshotFromPost(
        createPost({
          removed: true,
          removedBy: 'AutoModerator',
          approved: true,
          approvedAtUtc: 1_779_638_400,
          approvedBy: 'ModOne',
          archived: true,
          quarantined: true,
          hidden: true,
          ignoringReports: true,
        })
      )
    ).toMatchObject({
      removed: true,
      removedBy: 'AutoModerator',
      approved: true,
      approvedBy: 'ModOne',
      approvedAtUtc: 1_779_638_400,
      archived: true,
      quarantined: true,
      subredditQuarantined: true,
      hidden: true,
      ignoringReports: true,
    });
  });
});

const createComment = (overrides: Record<string, unknown> = {}): Comment =>
  ({
    id: 't1_comment',
    authorName: 'Commenter42',
    subredditName: 'testsub',
    body: 'reported comment',
    createdAt: new Date('2026-05-25T00:00:00Z'),
    permalink: '/r/testsub/comments/post/media_post/comment/',
    score: 1,
    numReports: 0,
    removed: false,
    approved: false,
    approvedAtUtc: 0,
    locked: false,
    spam: false,
    stickied: false,
    distinguishedBy: undefined,
    collapsedBecauseCrowdControl: false,
    ignoringReports: false,
    parentId: 't3_post',
    postId: 't3_post',
    authorFlair: undefined,
    userReportReasons: [],
    modReportReasons: [],
    ...overrides,
  }) as unknown as Comment;

describe('snapshotFromComment', () => {
  it('copies Devvit report reasons into comment snapshots', () => {
    expect(
      snapshotFromComment(
        createComment({
          numReports: 2,
          userReportReasons: ['misinformation'],
          modReportReasons: ['Rule 1'],
        })
      )
    ).toMatchObject({
      numReports: 2,
      userReportReasons: ['misinformation'],
      modReportReasons: ['Rule 1'],
    });
  });

  it('copies additional Devvit moderation state into comment snapshots', () => {
    expect(
      snapshotFromComment(
        createComment({
          removed: true,
          removedBy: 'AutoModerator',
          approved: true,
          approvedBy: 'ModOne',
          approvedAtUtc: 1_779_638_400,
          collapsedBecauseCrowdControl: true,
          ignoringReports: true,
        })
      )
    ).toMatchObject({
      removed: true,
      removedBy: 'AutoModerator',
      approved: true,
      approvedBy: 'ModOne',
      approvedAtUtc: 1_779_638_400,
      collapsedBecauseCrowdControl: true,
      ignoringReports: true,
    });
  });
});
