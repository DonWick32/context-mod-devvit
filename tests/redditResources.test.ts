import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseLegacyConfigText } from '../src/config/legacyConfigParser';
import type { ActivitySnapshot } from '../src/runtime/activityAdapter';
import {
  collectActivityResourceNeeds,
  hydrateActivityResources,
  type RedditResourceClient,
  type RedditResourceRedisClient,
} from '../src/runtime/redditResources';
import { deflateToolboxUserNotesBlob } from '../src/runtime/toolboxUserNotes';

class MemoryResourceRedis implements RedditResourceRedisClient {
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
    _options?: Parameters<RedditResourceRedisClient['set']>[2]
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
    options?: Parameters<RedditResourceRedisClient['zRange']>[3]
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
  body: 'hello',
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

const createListing = (users: { username: string }[]) => ({
  all: vi.fn<() => Promise<{ username: string }[]>>().mockResolvedValue(users),
});

const createHistoryListing = (items: unknown[]) => ({
  all: vi.fn<() => Promise<unknown[]>>().mockResolvedValue(items),
});

const parseNeeds = (text: string) => {
  const parsed = parseLegacyConfigText(text);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join('\n'));
  }

  return collectActivityResourceNeeds(parsed.config);
};

describe('reddit resources adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('collects author resource needs from filters and hydrates cached metadata', async () => {
    const needs = parseNeeds(`
checks:
  - name: author resources
    kind: comment
    authorIs:
      age: '> 30 days'
      verified: true
      isMod: false
      isContributor: true
    actions:
      - kind: report
`);
    const redis = new MemoryResourceRedis();
    const redditClient = {
      getUserByUsername: vi.fn().mockResolvedValue({
        username: 'Spammer42',
        createdAt: new Date('2025-01-01T00:00:00Z'),
        linkKarma: 11,
        commentKarma: 22,
        hasVerifiedEmail: true,
        about: 'ContextMod profile',
        nsfw: false,
      }),
      getModerators: vi.fn().mockReturnValue(createListing([])),
      getApprovedUsers: vi
        .fn()
        .mockReturnValue(createListing([{ username: 'Spammer42' }])),
    } as unknown as RedditResourceClient;

    const hydrated = await hydrateActivityResources(
      redditClient,
      redis,
      activity,
      needs
    );
    const cachedHydrated = await hydrateActivityResources(
      redditClient,
      redis,
      activity,
      needs
    );

    expect(needs).toMatchObject({
      profile: true,
      moderator: true,
      contributor: true,
      history: false,
      modActions: false,
    });
    expect(hydrated).toMatchObject({
      authorAccountCreatedAt: new Date('2025-01-01T00:00:00Z'),
      authorLinkKarma: 11,
      authorCommentKarma: 22,
      authorTotalKarma: 33,
      authorHasVerifiedEmail: true,
      authorShadowbanned: false,
      authorProfileDescription: 'ContextMod profile',
      authorNsfw: false,
      authorIsModerator: false,
      authorIsContributor: true,
    });
    expect(cachedHydrated.authorTotalKarma).toBe(33);
    expect(redditClient.getUserByUsername).toHaveBeenCalledOnce();
    expect(redditClient.getModerators).toHaveBeenCalledOnce();
    expect(redditClient.getApprovedUsers).toHaveBeenCalledOnce();
  });

  it('collects author resource needs from action templates', () => {
    const needs = parseNeeds(`
checks:
  - name: templated author resources
    kind: comment
    actions:
      - kind: report
        content: 'karma={{item.author.totalKarma}} age={{ item.author.age }} mod={{item.author.isModerator}} contributor={{item.author.isContributor}}'
`);

    expect(needs).toMatchObject({
      profile: true,
      moderator: true,
      contributor: true,
      history: false,
      modActions: false,
    });
  });

  it('hydrates subreddit metadata for current item filters', async () => {
    const needs = parseNeeds(`
checks:
  - name: subreddit metadata
    kind: submission
    itemIs:
      subredditNsfw: true
      subredditQuarantined: true
      subredditType: public
    actions:
      - kind: report
`);
    const redditClient = {
      getSubredditInfoByName: vi.fn().mockResolvedValue({
        isNsfw: true,
        isQuarantined: true,
        type: 'public',
      }),
    } as unknown as RedditResourceClient;
    const redis = new MemoryResourceRedis();

    const hydrated = await hydrateActivityResources(
      redditClient,
      redis,
      activity,
      needs
    );
    const cachedHydrated = await hydrateActivityResources(
      redditClient,
      redis,
      activity,
      needs
    );

    expect(needs.subredditMetadata).toBe(true);
    expect(hydrated).toMatchObject({
      subredditNsfw: true,
      subredditQuarantined: true,
      subredditType: 'public',
    });
    expect(cachedHydrated.subredditQuarantined).toBe(true);
    expect(redditClient.getSubredditInfoByName).toHaveBeenCalledOnce();
    expect(redditClient.getSubredditInfoByName).toHaveBeenCalledWith('testsub');
  });

  it('treats AutoModerator as a moderator without a relationship lookup', async () => {
    const redditClient = {
      getUserByUsername: vi.fn(),
      getModerators: vi.fn(),
      getApprovedUsers: vi.fn(),
    } as unknown as RedditResourceClient;

    const hydrated = await hydrateActivityResources(
      redditClient,
      new MemoryResourceRedis(),
      {
        ...activity,
        authorName: 'AutoModerator',
      },
      {
        profile: false,
        moderator: true,
        contributor: false,
        history: false,
        modActions: false,
      }
    );

    expect(hydrated.authorIsModerator).toBe(true);
    expect(redditClient.getModerators).not.toHaveBeenCalled();
  });

  it('marks missing user profiles as shadowbanned for legacy criteria parity', async () => {
    const redditClient = {
      getUserByUsername: vi.fn().mockResolvedValue(undefined),
      getModerators: vi.fn(),
      getApprovedUsers: vi.fn(),
    } as unknown as RedditResourceClient;

    const hydrated = await hydrateActivityResources(
      redditClient,
      new MemoryResourceRedis(),
      activity,
      {
        profile: true,
        moderator: false,
        contributor: false,
        history: false,
        modActions: false,
      }
    );

    expect(hydrated.authorShadowbanned).toBe(true);
  });

  it('leaves relationship fields unset when the Reddit lookup fails', async () => {
    const redditClient = {
      getUserByUsername: vi.fn(),
      getModerators: vi.fn(),
      getApprovedUsers: vi.fn().mockReturnValue({
        all: vi.fn().mockRejectedValue(new Error('Forbidden')),
      }),
    } as unknown as RedditResourceClient;

    const hydrated = await hydrateActivityResources(
      redditClient,
      new MemoryResourceRedis(),
      activity,
      {
        profile: false,
        moderator: false,
        contributor: true,
        history: false,
        modActions: false,
      }
    );

    expect(hydrated.authorIsContributor).toBeUndefined();
    expect(hydrated.authorResourceErrors?.[0]).toContain('Forbidden');
  });

  it('hydrates author mod notes for modActions filters', async () => {
    const needs = parseNeeds(`
checks:
  - name: author mod notes
    kind: comment
    authorIs:
      modActions:
        - noteType: SPAM_WARNING
          note: spam warning
          count: '>= 1'
    actions:
      - kind: report
`);
    const redditClient = {
      getUserByUsername: vi.fn(),
      getModerators: vi.fn(),
      getApprovedUsers: vi.fn(),
      getModNotes: vi.fn().mockReturnValue(
        createHistoryListing([
          {
            id: 'ModNote_1',
            type: 'NOTE',
            createdAt: new Date('2026-05-25T00:00:00Z'),
            operator: {},
            subreddit: { name: 'testsub' },
            user: { name: 'Spammer42' },
            userNote: {
              label: 'SPAM_WARNING',
              note: 'Prior spam warning',
              redditId: 't1_comment',
            },
          },
        ])
      ),
    } as unknown as RedditResourceClient;
    const redis = new MemoryResourceRedis();

    const hydrated = await hydrateActivityResources(
      redditClient,
      redis,
      activity,
      needs
    );
    const cachedHydrated = await hydrateActivityResources(
      redditClient,
      redis,
      activity,
      needs
    );

    expect(needs).toMatchObject({
      modActions: true,
    });
    expect(hydrated.authorModNotes).toEqual([
      {
        id: 'ModNote_1',
        type: 'NOTE',
        createdAt: new Date('2026-05-25T00:00:00Z'),
        label: 'SPAM_WARNING',
        note: 'Prior spam warning',
        redditId: 't1_comment',
      },
    ]);
    expect(cachedHydrated.authorModNotes).toHaveLength(1);
    expect(redditClient.getModNotes).toHaveBeenCalledOnce();
    expect(redditClient.getModNotes).toHaveBeenCalledWith({
      subreddit: 'testsub',
      user: 'Spammer42',
      filter: 'NOTE',
      limit: 100,
    });
  });

  it('hydrates Toolbox usernotes for author userNotes filters', async () => {
    const needs = parseNeeds(`
checks:
  - name: author toolbox usernotes
    kind: comment
    authorIs:
      userNotes:
        - type: spamwatch
          count: '>= 1'
    actions:
      - kind: report
`);
    const usernotesContent = JSON.stringify({
      ver: 6,
      constants: {
        users: ['ModOne'],
        warnings: ['spamwatch'],
      },
      blob: deflateToolboxUserNotesBlob({
        Spammer42: {
          ns: [
            {
              n: 'Prior spam warning',
              t: 1_764_028_800,
              m: 0,
              l: 'l,post,comment',
              w: 0,
            },
          ],
        },
      }),
    });
    const redditClient = {
      getWikiPage: vi.fn().mockResolvedValue({
        content: usernotesContent,
      }),
    } as unknown as RedditResourceClient;
    const redis = new MemoryResourceRedis();

    const hydrated = await hydrateActivityResources(
      redditClient,
      redis,
      activity,
      needs
    );
    const cachedHydrated = await hydrateActivityResources(
      redditClient,
      redis,
      activity,
      needs
    );

    expect(needs).toMatchObject({
      userNotes: true,
    });
    expect(hydrated.authorUserNotes).toEqual([
      {
        text: 'Prior spam warning',
        type: 'spamwatch',
        moderator: 'ModOne',
        createdAt: new Date('2025-11-25T00:00:00.000Z'),
        link: 'https://www.reddit.com/comments/post/_/comment',
      },
    ]);
    expect(cachedHydrated.authorUserNotes).toHaveLength(1);
    expect(redditClient.getWikiPage).toHaveBeenCalledOnce();
    expect(redditClient.getWikiPage).toHaveBeenCalledWith(
      'testsub',
      'usernotes'
    );
  });

  it('collects history needs and hydrates recent author overview', async () => {
    const needs = parseNeeds(`
checks:
  - name: recent activity
    kind: comment
    rules:
      - kind: recentActivity
        thresholds:
          - threshold: '>= 1'
            subreddits:
              - FreeKarma4U
    actions:
      - kind: report
`);
    const redditClient = {
      getUserByUsername: vi.fn(),
      getModerators: vi.fn(),
      getApprovedUsers: vi.fn(),
      getCommentsAndPostsByUser: vi.fn().mockReturnValue(
        createHistoryListing([
          {
            id: 't1_history',
            authorName: 'Spammer42',
            subredditName: 'FreeKarma4U',
            body: 'history comment',
            createdAt: new Date('2026-05-24T00:00:00Z'),
            permalink: '/r/FreeKarma4U/comments/post/comment',
            score: 3,
            numReports: 0,
            removed: false,
            approved: false,
            locked: false,
            spam: false,
            stickied: false,
            distinguishedBy: undefined,
            parentId: 't3_post',
            postId: 't3_post',
          },
        ])
      ),
    } as unknown as RedditResourceClient;

    const hydrated = await hydrateActivityResources(
      redditClient,
      new MemoryResourceRedis(),
      activity,
      needs
    );

    expect(needs).toMatchObject({
      history: true,
    });
    expect(redditClient.getCommentsAndPostsByUser).toHaveBeenCalledWith({
      username: 'Spammer42',
      sort: 'new',
      timeframe: 'all',
      limit: 100,
      pageSize: 100,
    });
    expect(hydrated.authorHistory).toHaveLength(1);
    expect(hydrated.authorHistory?.[0]).toMatchObject({
      id: 't1_history',
      kind: 'comment',
      subredditName: 'FreeKarma4U',
    });
  });

  it('collects repost needs and hydrates duplicate candidates for submissions', async () => {
    const needs = parseNeeds(`
checks:
  - name: repost check
    kind: submission
    rules:
      - kind: repost
        criteria:
          - searchOn:
              - duplicates
              - crossposts
    actions:
      - kind: report
`);
    const submissionActivity: ActivitySnapshot = {
      ...activity,
      id: 't3_current',
      kind: 'submission',
      title: 'Current linked post',
      body: '',
      url: 'https://example.com/current',
      permalink: '/r/testsub/comments/current/current_linked_post/',
      selfPost: false,
    };
    const duplicatePost = {
      id: 't3_duplicate',
      authorName: 'OtherPoster',
      subredditName: 'elsewhere',
      title: 'Current linked post',
      url: 'https://example.com/current',
      createdAt: new Date('2026-05-24T00:00:00Z'),
      permalink: '/r/elsewhere/comments/duplicate/current_linked_post/',
      score: 12,
      numberOfReports: 0,
      removed: false,
      approved: false,
      locked: false,
      spam: false,
      stickied: false,
      distinguishedBy: undefined,
      nsfw: false,
      spoiler: false,
    };
    const crosspost = {
      ...duplicatePost,
      id: 't3_crosspost',
      permalink: '/r/elsewhere/comments/crosspost/current_linked_post/',
    };
    const redditClient = {
      getUserByUsername: vi.fn(),
      getModerators: vi.fn(),
      getApprovedUsers: vi.fn(),
      getCommentsAndPostsByUser: vi.fn(),
      getDuplicatesForPost: vi
        .fn()
        .mockReturnValueOnce(createHistoryListing([duplicatePost]))
        .mockReturnValueOnce(createHistoryListing([crosspost])),
    } as unknown as RedditResourceClient;

    const hydrated = await hydrateActivityResources(
      redditClient,
      new MemoryResourceRedis(),
      submissionActivity,
      needs
    );

    expect(needs).toMatchObject({
      repostCandidates: true,
    });
    expect(redditClient.getDuplicatesForPost).toHaveBeenCalledTimes(2);
    expect(hydrated.repostCandidates).toHaveLength(2);
    expect(hydrated.repostCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 't3_duplicate',
          repostCandidateSource: 'duplicates',
        }),
        expect.objectContaining({
          id: 't3_crosspost',
          repostCandidateSource: 'crossposts',
        }),
      ])
    );
  });

  it('only fetches image hashes from declared Reddit image domains', async () => {
    const needs = parseNeeds(`
checks:
  - name: image repost check
    kind: submission
    rules:
      - kind: repost
        criteria:
          - searchOn:
              - duplicates
    actions:
      - kind: report
`);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);
    vi.stubGlobal('fetch', fetcher);
    const redditClient = {
      getDuplicatesForPost: vi.fn().mockReturnValue(createHistoryListing([])),
    } as unknown as RedditResourceClient;

    await hydrateActivityResources(
      redditClient,
      new MemoryResourceRedis(),
      {
        ...activity,
        id: 't3_external',
        kind: 'submission',
        title: 'External image',
        body: '',
        url: 'https://images.example.com/current.jpg',
        isRedditMediaDomain: true,
      },
      needs
    );
    expect(fetcher).not.toHaveBeenCalled();

    await hydrateActivityResources(
      redditClient,
      new MemoryResourceRedis(),
      {
        ...activity,
        id: 't3_reddit_image',
        kind: 'submission',
        title: 'Reddit image',
        body: '',
        url: 'https://i.redd.it/current.png',
        isRedditMediaDomain: true,
      },
      needs
    );

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://i.redd.it/current.png');
  });

  it('hydrates candidate comments for comment repost checks', async () => {
    const needs = parseNeeds(`
checks:
  - name: comment repost check
    kind: comment
    rules:
      - kind: repost
        criteria:
          - searchOn:
              - duplicates
    actions:
      - kind: report
`);
    const duplicatePost = {
      id: 't3_duplicate',
      authorName: 'OtherPoster',
      subredditName: 'elsewhere',
      title: 'Duplicate host post',
      body: '',
      url: 'https://example.com/current',
      createdAt: new Date('2026-05-24T00:00:00Z'),
      permalink: '/r/elsewhere/comments/duplicate/duplicate_host_post/',
      score: 12,
      numberOfReports: 0,
      removed: false,
      approved: false,
      locked: false,
      spam: false,
      stickied: false,
      distinguishedBy: undefined,
      nsfw: false,
      spoiler: false,
    };
    const duplicateComment = {
      id: 't1_duplicate_comment',
      authorName: 'CommentCopier',
      subredditName: 'elsewhere',
      body: 'This exact phrase keeps getting copied around',
      createdAt: new Date('2026-05-24T00:01:00Z'),
      permalink: '/r/elsewhere/comments/duplicate/comment/',
      score: 4,
      numReports: 0,
      removed: false,
      approved: false,
      locked: false,
      spam: false,
      stickied: false,
      distinguishedBy: undefined,
      parentId: 't3_duplicate',
      postId: 't3_duplicate',
    };
    const redditClient = {
      getUserByUsername: vi.fn(),
      getModerators: vi.fn(),
      getApprovedUsers: vi.fn(),
      getCommentsAndPostsByUser: vi.fn(),
      getDuplicatesForPost: vi
        .fn()
        .mockReturnValueOnce(createHistoryListing([duplicatePost]))
        .mockReturnValueOnce(createHistoryListing([])),
      getComments: vi
        .fn()
        .mockReturnValue(createHistoryListing([duplicateComment])),
    } as unknown as RedditResourceClient;

    const hydrated = await hydrateActivityResources(
      redditClient,
      new MemoryResourceRedis(),
      {
        ...activity,
        postId: 't3_current',
        parentId: 't3_current',
      },
      needs
    );

    expect(redditClient.getDuplicatesForPost).toHaveBeenCalledWith({
      postId: 't3_current',
      sort: 'num_comments',
      limit: 10,
      pageSize: 10,
      show: 'all',
    });
    expect(redditClient.getComments).toHaveBeenCalledWith({
      postId: 't3_duplicate',
      limit: 20,
      pageSize: 20,
      sort: 'top',
    });
    expect(hydrated.repostCandidates).toEqual([
      expect.objectContaining({
        id: 't1_duplicate_comment',
        kind: 'comment',
        repostCandidateSource: 'duplicates',
      }),
    ]);
  });

  it('hydrates YouTube top comments from the parent submission URL for comment repost checks', async () => {
    const needs = parseNeeds(`
checks:
  - name: youtube comment repost check
    kind: comment
    rules:
      - kind: repost
        criteria:
          - searchOn:
              - external
    actions:
      - kind: report
`);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            id: 'thread-1',
            snippet: {
              topLevelComment: {
                id: 'comment-1',
                snippet: {
                  textOriginal: 'copied youtube comment text',
                  publishedAt: '2026-05-24T00:00:00Z',
                  authorDisplayName: 'YouTubeUser',
                  videoId: 'abc123xyz89',
                  likeCount: 7,
                },
              },
            },
          },
        ],
      }),
    } as Response);
    vi.stubGlobal('fetch', fetcher);

    const redditClient = {
      getDuplicatesForPost: vi
        .fn()
        .mockReturnValueOnce(createHistoryListing([]))
        .mockReturnValueOnce(createHistoryListing([])),
      getComments: vi.fn(),
    } as unknown as RedditResourceClient;

    const hydrated = await hydrateActivityResources(
      redditClient,
      new MemoryResourceRedis(),
      {
        ...activity,
        body: 'copied youtube comment text',
        postId: 't3_current',
        parentId: 't3_current',
        parentSubmission: {
          ...activity,
          id: 't3_current',
          kind: 'submission',
          title: 'YouTube post',
          body: '',
          url: 'https://www.youtube.com/watch?v=abc123xyz89',
        },
      },
      needs,
      {
        appEnabled: true,
        dryRun: true,
        youtubeApiKey: 'test-key',
      }
    );

    expect(fetcher).toHaveBeenCalledOnce();
    const requestedUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requestedUrl.searchParams.get('videoId')).toBe('abc123xyz89');
    expect(hydrated.repostCandidates).toEqual([
      expect.objectContaining({
        id: 'yt_comment-1',
        kind: 'comment',
        body: 'copied youtube comment text',
        repostCandidateSource: 'external',
        repostCandidateProvider: 'YouTube',
        score: 7,
      }),
    ]);
  });
});
