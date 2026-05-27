import type { Comment, Post, RedditClient, RedisClient } from '@devvit/web/server';
import { isT3 } from '@devvit/shared-types/tid.js';
import type {
  NormalizedAction,
  NormalizedConfig,
  NormalizedRule,
  UnknownRecord,
} from '../config/legacyTypes';
import {
  createNamespacedRedisCache,
  type NamespacedCacheRedisClient,
} from '../storage/namespacedCache';
import {
  snapshotFromComment,
  snapshotFromPost,
  type ActivitySnapshot,
} from './activityAdapter';
import {
  snapshotFromModNote,
  type ModNoteSnapshot,
} from './modNoteCriteria';
import {
  getToolboxUserNotesForAuthor,
  type ToolboxUserNote,
} from './toolboxUserNotes';
import { YouTubeClient, extractYouTubeVideoId } from './youtubeClient';
import { fetchAndHashImage } from './imageComparison';
import { classifyToxicity } from './geminiToxicity';
import type { ActionRuntimeSettings } from './actionExecutor';

export type RedditResourceClient = Pick<
  RedditClient,
  | 'getApprovedUsers'
  | 'getComments'
  | 'getCommentsAndPostsByUser'
  | 'getDuplicatesForPost'
  | 'getModNotes'
  | 'getModerators'
  | 'getSubredditInfoByName'
  | 'getUserByUsername'
  | 'getWikiPage'
>;

export type RedditResourceRedisClient = Pick<
  RedisClient,
  'del' | 'expire' | 'get' | 'mGet' | 'set' | 'zAdd' | 'zCard' | 'zRange' | 'zRem'
>;

export type ActivityResourceNeeds = {
  profile: boolean;
  moderator: boolean;
  contributor: boolean;
  history: boolean;
  modActions: boolean;
  userNotes?: boolean;
  repostCandidates?: boolean;
  subredditMetadata?: boolean;
  youtubeVideoInfo?: boolean;
  imageHash?: boolean;
  toxicity?: boolean;
};

type CachedAuthorProfile = {
  version: 1;
  username: string;
  fetchedAt: string;
  found: boolean;
  shadowbanned?: boolean;
  createdAt?: string;
  linkKarma?: number;
  commentKarma?: number;
  totalKarma?: number;
  verified?: boolean;
  profileDescription?: string;
  nsfw?: boolean;
  error?: string;
};

type CachedAuthorRelationship = {
  version: 1;
  username: string;
  subredditName: string;
  fetchedAt: string;
  value?: boolean;
  error?: string;
};

type CachedAuthorModNotes = {
  version: 1;
  username: string;
  subredditName: string;
  fetchedAt: string;
  notes: ModNoteSnapshot[];
  error?: string;
};

type CachedAuthorUserNotes = {
  version: 1;
  username: string;
  subredditName: string;
  fetchedAt: string;
  notes: (Omit<ToolboxUserNote, 'createdAt'> & { createdAt: string })[];
  error?: string;
};

type ListingLike<T> = {
  all(): Promise<T[]>;
};

type UserLike = {
  username: string;
  createdAt: Date;
  linkKarma: number;
  commentKarma: number;
  hasVerifiedEmail: boolean;
  about: string;
  nsfw: boolean;
};

const USER_PROFILE_TTL_MS = 6 * 60 * 60 * 1000;
const SUBREDDIT_RELATIONSHIP_TTL_MS = 5 * 60 * 1000;
const AUTHOR_CACHE_MAX_ENTRIES = 250;
const AUTOMODERATOR = 'automoderator';

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const emptyNeeds = (): ActivityResourceNeeds => ({
  profile: false,
  moderator: false,
  contributor: false,
  history: false,
  modActions: false,
  subredditMetadata: false,
  youtubeVideoInfo: false,
  imageHash: false,
  toxicity: false,
});

export const hasActivityResourceNeeds = (needs: ActivityResourceNeeds): boolean =>
  needs.profile ||
  needs.moderator ||
  needs.contributor ||
  needs.history ||
  needs.modActions ||
  needs.userNotes === true ||
  needs.repostCandidates === true ||
  needs.subredditMetadata === true ||
  needs.youtubeVideoInfo === true ||
  needs.imageHash === true ||
  needs.toxicity === true;

const normalizeName = (name: string): string => name.trim().toLowerCase();

const isDeletedAuthorName = (name: string): boolean =>
  normalizeName(name) === '[deleted]';

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const safeCacheGet = async <T>(
  cache: ReturnType<typeof createNamespacedRedisCache>,
  key: string
): Promise<T | undefined> => {
  try {
    return await cache.get<T>(key);
  } catch {
    return undefined;
  }
};

const safeCacheSet = async <T>(
  cache: ReturnType<typeof createNamespacedRedisCache>,
  key: string,
  value: T,
  ttlMs: number
): Promise<void> => {
  try {
    await cache.set(key, value, {
      maxEntries: AUTHOR_CACHE_MAX_ENTRIES,
      ttlMs,
    });
  } catch {
    // Cache writes are an optimization; rule evaluation can continue without them.
  }
};

const relationshipCacheKey = (
  subredditName: string,
  username: string
): string => `${normalizeName(subredditName)}:${normalizeName(username)}`;

const userMatchesUsername = (user: { username?: string }, username: string): boolean =>
  user.username !== undefined && normalizeName(user.username) === normalizeName(username);

const fetchAuthorProfile = async (
  redditClient: RedditResourceClient,
  username: string,
  now: Date
): Promise<CachedAuthorProfile> => {
  if (isDeletedAuthorName(username)) {
    return {
      version: 1,
      username,
      fetchedAt: now.toISOString(),
      found: false,
      shadowbanned: false,
      error: 'author account is deleted',
    };
  }

  try {
    const user = (await redditClient.getUserByUsername(username)) as
      | UserLike
      | undefined;
    if (user === undefined) {
      return {
        version: 1,
        username,
        fetchedAt: now.toISOString(),
        found: false,
        shadowbanned: true,
      };
    }

    return {
      version: 1,
      username: user.username,
      fetchedAt: now.toISOString(),
      found: true,
      shadowbanned: false,
      createdAt: user.createdAt.toISOString(),
      linkKarma: user.linkKarma,
      commentKarma: user.commentKarma,
      totalKarma: user.linkKarma + user.commentKarma,
      verified: user.hasVerifiedEmail,
      profileDescription: user.about,
      nsfw: user.nsfw,
    };
  } catch (error) {
    return {
      version: 1,
      username,
      fetchedAt: now.toISOString(),
      found: false,
      error: getErrorMessage(error),
    };
  }
};

const getAuthorProfile = async (
  redditClient: RedditResourceClient,
  redisClient: NamespacedCacheRedisClient,
  username: string,
  now: Date
): Promise<CachedAuthorProfile> => {
  const cache = createNamespacedRedisCache(redisClient, {
    namespace: 'author-profile',
    defaultTtlMs: USER_PROFILE_TTL_MS,
    maxEntries: AUTHOR_CACHE_MAX_ENTRIES,
  });
  const key = normalizeName(username);
  const cached = await safeCacheGet<CachedAuthorProfile>(cache, key);
  if (cached !== undefined) {
    return cached;
  }

  const profile = await fetchAuthorProfile(redditClient, username, now);
  await safeCacheSet(cache, key, profile, USER_PROFILE_TTL_MS);
  return profile;
};

const getSubredditMetadata = async (
  redditClient: RedditResourceClient,
  redisClient: NamespacedCacheRedisClient,
  subredditName: string
): Promise<
  { nsfw?: boolean; quarantined?: boolean; type?: string } | undefined
> => {
  const cache = createNamespacedRedisCache(redisClient, {
    namespace: 'subreddit-metadata',
    defaultTtlMs: 24 * 60 * 60 * 1000,
    maxEntries: 100,
  });
  const key = normalizeName(subredditName);
  const cached = await safeCacheGet<{
    nsfw?: boolean;
    quarantined?: boolean;
    type?: string;
  }>(cache, key);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const info = await redditClient.getSubredditInfoByName(subredditName);
    const metadata: { nsfw?: boolean; quarantined?: boolean; type?: string } = {
      ...(info.isNsfw === undefined ? {} : { nsfw: info.isNsfw }),
      ...(info.isQuarantined === undefined
        ? {}
        : { quarantined: info.isQuarantined }),
      ...(info.type === undefined ? {} : { type: info.type }),
    };
    await safeCacheSet(cache, key, metadata, 24 * 60 * 60 * 1000);
    return metadata;
  } catch (error) {
    return undefined;
  }
};

const fetchRelationship = async (
  listUsers: () => ListingLike<{ username?: string }>,
  subredditName: string,
  username: string,
  now: Date
): Promise<CachedAuthorRelationship> => {
  try {
    const users = await listUsers().all();
    return {
      version: 1,
      username,
      subredditName,
      fetchedAt: now.toISOString(),
      value: users.some((user) => userMatchesUsername(user, username)),
    };
  } catch (error) {
    return {
      version: 1,
      username,
      subredditName,
      fetchedAt: now.toISOString(),
      error: getErrorMessage(error),
    };
  }
};

const fetchAuthorModNotes = async (
  redditClient: RedditResourceClient,
  subredditName: string,
  username: string,
  now: Date
): Promise<CachedAuthorModNotes> => {
  try {
    const notes = await redditClient
      .getModNotes({
        subreddit: subredditName,
        user: username,
        filter: 'NOTE',
        limit: 100,
      })
      .all();

    return {
      version: 1,
      username,
      subredditName,
      fetchedAt: now.toISOString(),
      notes: notes.map(snapshotFromModNote),
    };
  } catch (error) {
    return {
      version: 1,
      username,
      subredditName,
      fetchedAt: now.toISOString(),
      notes: [],
      error: getErrorMessage(error),
    };
  }
};

const fetchAuthorUserNotes = async (
  redditClient: RedditResourceClient,
  subredditName: string,
  username: string,
  now: Date
): Promise<CachedAuthorUserNotes> => {
  try {
    const page = await redditClient.getWikiPage(subredditName, 'usernotes');
    const notes = getToolboxUserNotesForAuthor(page.content, username).map(
      (note) => ({
        ...note,
        createdAt: note.createdAt.toISOString(),
      })
    );

    return {
      version: 1,
      username,
      subredditName,
      fetchedAt: now.toISOString(),
      notes,
    };
  } catch (error) {
    return {
      version: 1,
      username,
      subredditName,
      fetchedAt: now.toISOString(),
      notes: [],
      error: getErrorMessage(error),
    };
  }
};

const getRelationship = async (
  redisClient: NamespacedCacheRedisClient,
  namespace: string,
  key: string,
  fetchValue: () => Promise<CachedAuthorRelationship>
): Promise<CachedAuthorRelationship> => {
  const cache = createNamespacedRedisCache(redisClient, {
    namespace,
    defaultTtlMs: SUBREDDIT_RELATIONSHIP_TTL_MS,
    maxEntries: AUTHOR_CACHE_MAX_ENTRIES,
  });
  const cached = await safeCacheGet<CachedAuthorRelationship>(cache, key);
  if (cached !== undefined) {
    return cached;
  }

  const relationship = await fetchValue();
  await safeCacheSet(cache, key, relationship, SUBREDDIT_RELATIONSHIP_TTL_MS);
  return relationship;
};

const getAuthorModNotes = async (
  redditClient: RedditResourceClient,
  redisClient: NamespacedCacheRedisClient,
  subredditName: string,
  username: string,
  now: Date
): Promise<CachedAuthorModNotes> => {
  const cache = createNamespacedRedisCache(redisClient, {
    namespace: 'author-modnotes',
    defaultTtlMs: SUBREDDIT_RELATIONSHIP_TTL_MS,
    maxEntries: AUTHOR_CACHE_MAX_ENTRIES,
  });
  const key = relationshipCacheKey(subredditName, username);
  const cached = await safeCacheGet<CachedAuthorModNotes>(cache, key);
  if (cached !== undefined) {
    return cached;
  }

  const notes = await fetchAuthorModNotes(
    redditClient,
    subredditName,
    username,
    now
  );
  await safeCacheSet(cache, key, notes, SUBREDDIT_RELATIONSHIP_TTL_MS);
  return notes;
};

const getAuthorUserNotes = async (
  redditClient: RedditResourceClient,
  redisClient: NamespacedCacheRedisClient,
  subredditName: string,
  username: string,
  now: Date
): Promise<CachedAuthorUserNotes> => {
  const cache = createNamespacedRedisCache(redisClient, {
    namespace: 'author-usernotes',
    defaultTtlMs: SUBREDDIT_RELATIONSHIP_TTL_MS,
    maxEntries: AUTHOR_CACHE_MAX_ENTRIES,
  });
  const key = relationshipCacheKey(subredditName, username);
  const cached = await safeCacheGet<CachedAuthorUserNotes>(cache, key);
  if (cached !== undefined) {
    return cached;
  }

  const notes = await fetchAuthorUserNotes(
    redditClient,
    subredditName,
    username,
    now
  );
  await safeCacheSet(cache, key, notes, SUBREDDIT_RELATIONSHIP_TTL_MS);
  return notes;
};

const isPostLike = (activity: Post | Comment): activity is Post =>
  typeof activity.id === 'string' && isT3(activity.id);

const fetchAuthorHistory = async (
  redditClient: RedditResourceClient,
  activity: ActivitySnapshot
): Promise<ActivitySnapshot[]> => {
  const history = await redditClient
    .getCommentsAndPostsByUser({
      username: activity.authorName,
      sort: 'new',
      timeframe: 'all',
      limit: 100,
      pageSize: 100,
    })
    .all();

  return history
    .filter((entry) => entry.id !== activity.id)
    .map((entry) =>
      isPostLike(entry) ? snapshotFromPost(entry) : snapshotFromComment(entry)
    );
};

const fetchRepostCandidates = async (
  redditClient: RedditResourceClient,
  activity: ActivitySnapshot
): Promise<ActivitySnapshot[]> => {
  const postId =
    activity.kind === 'submission'
      ? activity.id
      : activity.kind === 'comment'
        ? activity.postId
        : undefined;
  if (postId === undefined) {
    return [];
  }

  type DuplicateOptions = Parameters<
    RedditResourceClient['getDuplicatesForPost']
  >[0];
  const duplicateLimit = activity.kind === 'comment' ? 10 : 50;
  const baseOptions = {
    postId: postId as DuplicateOptions['postId'],
    sort: 'num_comments' as const,
    limit: duplicateLimit,
    pageSize: duplicateLimit,
    show: 'all',
  };
  const [duplicates, crossposts] = await Promise.all([
    redditClient.getDuplicatesForPost(baseOptions).all(),
    redditClient
      .getDuplicatesForPost({
        ...baseOptions,
        crosspostsOnly: true,
      })
      .all(),
  ]);
  if (activity.kind === 'comment') {
    const snapshots = new Map<string, ActivitySnapshot>();
    const collectCandidateComments = async (
      post: Post,
      source: 'duplicates' | 'crossposts'
    ) => {
      if (post.id === postId) {
        return;
      }

      const comments = await redditClient
        .getComments({
          postId: post.id,
          limit: 20,
          pageSize: 20,
          sort: 'top',
        })
        .all();

      for (const comment of comments) {
        if (comment.id === activity.id) {
          continue;
        }
        snapshots.set(comment.id, {
          ...snapshotFromComment(comment, {
            parentPost: post,
          }),
          repostCandidateSource: source,
        });
      }
    };

    for (const post of duplicates) {
      await collectCandidateComments(post, 'duplicates');
    }
    for (const post of crossposts) {
      await collectCandidateComments(post, 'crossposts');
    }

    return [...snapshots.values()];
  }

  const snapshots = new Map<string, ActivitySnapshot>();

  for (const post of duplicates) {
    if (post.id === postId) {
      continue;
    }
    snapshots.set(post.id, {
      ...snapshotFromPost(post),
      repostCandidateSource: 'duplicates',
    });
  }

  for (const post of crossposts) {
    if (post.id === postId) {
      continue;
    }
    snapshots.set(post.id, {
      ...snapshotFromPost(post),
      repostCandidateSource: 'crossposts',
    });
  }

  return [...snapshots.values()];
};

const getYouTubeSourceUrl = (activity: ActivitySnapshot): string | undefined => {
  const candidates = [
    activity.url,
    activity.parentSubmission?.url,
    activity.body,
    activity.parentSubmission?.body,
  ];

  return candidates.find(
    (candidate) => extractYouTubeVideoId(candidate) !== undefined
  );
};

const REDDIT_IMAGE_FETCH_HOSTS = new Set(['i.redd.it', 'preview.redd.it']);

const isFetchAllowedRedditImageUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return REDDIT_IMAGE_FETCH_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
};

const hydrateProfileFields = (
  activity: ActivitySnapshot,
  profile: CachedAuthorProfile
): ActivitySnapshot => ({
  ...activity,
  ...(profile.createdAt === undefined
    ? {}
    : { authorAccountCreatedAt: new Date(profile.createdAt) }),
  ...(profile.linkKarma === undefined ? {} : { authorLinkKarma: profile.linkKarma }),
  ...(profile.commentKarma === undefined
    ? {}
    : { authorCommentKarma: profile.commentKarma }),
  ...(profile.totalKarma === undefined
    ? {}
    : { authorTotalKarma: profile.totalKarma }),
  ...(profile.verified === undefined
    ? {}
    : { authorHasVerifiedEmail: profile.verified }),
  ...(profile.shadowbanned === undefined
    ? {}
    : { authorShadowbanned: profile.shadowbanned }),
  ...(profile.profileDescription === undefined
    ? {}
    : { authorProfileDescription: profile.profileDescription }),
  ...(profile.nsfw === undefined ? {} : { authorNsfw: profile.nsfw }),
  ...(profile.error === undefined
    ? {}
    : {
        authorResourceErrors: [
          ...(activity.authorResourceErrors ?? []),
          `author profile: ${profile.error}`,
        ],
      }),
});

const collectNeedsFromAuthorCriteria = (
  value: unknown,
  needs: ActivityResourceNeeds
) => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectNeedsFromAuthorCriteria(entry, needs);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  if (value.criteria !== undefined) {
    collectNeedsFromAuthorCriteria(value.criteria, needs);
  }
  if (value.include !== undefined) {
    collectNeedsFromAuthorCriteria(value.include, needs);
  }
  if (value.exclude !== undefined) {
    collectNeedsFromAuthorCriteria(value.exclude, needs);
  }

  for (const key of Object.keys(value)) {
    switch (key) {
      case 'age':
      case 'linkKarma':
      case 'commentKarma':
      case 'totalKarma':
      case 'verified':
      case 'hasVerifiedEmail':
      case 'shadowBanned':
      case 'shadowbanned':
      case 'description':
      case 'profileDescription':
      case 'about':
      case 'nsfw':
        needs.profile = true;
        break;
      case 'isMod':
      case 'isModerator':
        needs.moderator = true;
        break;
      case 'isContributor':
        needs.contributor = true;
        break;
      case 'userNotes':
        needs.userNotes = true;
        break;
      case 'modActions':
        needs.modActions = true;
        break;
      default:
        break;
    }
  }
};

const collectNeedsFromItemCriteria = (
  value: unknown,
  needs: ActivityResourceNeeds
) => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectNeedsFromItemCriteria(entry, needs);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  if (value.criteria !== undefined) {
    collectNeedsFromItemCriteria(value.criteria, needs);
  }
  if (value.include !== undefined) {
    collectNeedsFromItemCriteria(value.include, needs);
  }
  if (value.exclude !== undefined) {
    collectNeedsFromItemCriteria(value.exclude, needs);
  }

  for (const key of Object.keys(value)) {
    switch (key) {
      case 'subredditNsfw':
      case 'subreddit_nsfw':
      case 'subredditQuarantined':
      case 'subreddit_quarantined':
      case 'subredditType':
      case 'subreddit_type':
        needs.subredditMetadata = true;
        break;
      case 'youtubeChannelRegex':
      case 'youtubeMinPublishAgeMs':
        needs.youtubeVideoInfo = true;
        break;
      default:
        break;
    }
  }
};

const collectNeedsFromTemplateString = (
  value: string,
  needs: ActivityResourceNeeds
) => {
  for (const match of value.matchAll(/{{\s*([^}]+?)\s*}}/g)) {
    const path = match[1]?.trim().toLowerCase();
    if (path === undefined || !path.startsWith('item.author.')) {
      continue;
    }

    const field = path.slice('item.author.'.length).replace(/[\s_-]+/g, '');
    switch (field) {
      case 'age':
      case 'linkkarma':
      case 'commentkarma':
      case 'totalkarma':
      case 'verified':
      case 'hasverifiedemail':
      case 'shadowbanned':
      case 'description':
      case 'profiledescription':
      case 'about':
      case 'nsfw':
        needs.profile = true;
        break;
      case 'ismod':
      case 'moderator':
      case 'ismoderator':
        needs.moderator = true;
        break;
      case 'contributor':
      case 'iscontributor':
        needs.contributor = true;
        break;
      default:
        break;
    }
  }
};

const collectNeedsFromTemplateConfig = (
  value: unknown,
  needs: ActivityResourceNeeds
) => {
  if (typeof value === 'string') {
    collectNeedsFromTemplateString(value, needs);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectNeedsFromTemplateConfig(entry, needs);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const entry of Object.values(value)) {
    collectNeedsFromTemplateConfig(entry, needs);
  }
};

const collectNeedsFromRunnableConfig = (
  config: UnknownRecord,
  needs: ActivityResourceNeeds
) => {
  collectNeedsFromItemCriteria(config.itemIs, needs);
  collectNeedsFromAuthorCriteria(config.authorIs, needs);
  collectNeedsFromTemplateConfig(config, needs);
};

const collectNeedsFromRule = (
  rule: NormalizedRule,
  needs: ActivityResourceNeeds
) => {
  if (rule.type === 'ruleSet') {
    collectNeedsFromRunnableConfig(rule.config, needs);
    for (const childRule of rule.rules) {
      collectNeedsFromRule(childRule, needs);
    }
    return;
  }

  if (rule.type !== 'rule') {
    return;
  }

  collectNeedsFromRunnableConfig(rule.config, needs);
  if (rule.kind === 'author') {
    collectNeedsFromAuthorCriteria(rule.config, needs);
  }
  if (
    rule.kind === 'history' ||
    rule.kind === 'recentActivity' ||
    rule.kind === 'repeatActivity' ||
    rule.kind === 'attribution' ||
    (rule.kind === 'sentiment' && rule.config.historical !== undefined)
  ) {
    needs.history = true;
  }
  if (rule.kind === 'repost') {
    needs.repostCandidates = true;
    needs.imageHash = true;
  }
  if (rule.kind === 'recentActivity') {
    needs.imageHash = true;
  }
  if (
    rule.kind === 'regex' &&
    JSON.stringify(rule.config).includes('"window"')
  ) {
    needs.history = true;
  }
  if (rule.kind === 'mhs' || (rule.kind as string) === 'toxicity') {
    needs.toxicity = true;
  }
};

const collectNeedsFromAction = (
  action: NormalizedAction,
  needs: ActivityResourceNeeds
) => {
  if (action.type === 'action') {
    collectNeedsFromRunnableConfig(action.config, needs);
  }
};

const collectNeedsFromDefaults = (
  config: UnknownRecord,
  needs: ActivityResourceNeeds
) => {
  if (isRecord(config.filterCriteriaDefaults)) {
    collectNeedsFromAuthorCriteria(config.filterCriteriaDefaults.authorIs, needs);
  }
};

export const collectActivityResourceNeeds = (
  config: NormalizedConfig
): ActivityResourceNeeds => {
  const needs = emptyNeeds();
  collectNeedsFromDefaults(config.config, needs);

  for (const run of config.runs) {
    collectNeedsFromDefaults(run.config, needs);
    collectNeedsFromRunnableConfig(run.config, needs);
    for (const check of run.checks) {
      collectNeedsFromRunnableConfig(check.config, needs);
      for (const rule of check.rules) {
        collectNeedsFromRule(rule, needs);
      }
      for (const action of check.actions) {
        collectNeedsFromAction(action, needs);
      }
    }
  }

  return needs;
};

export const hydrateActivityResources = async (
  redditClient: RedditResourceClient,
  redisClient: RedditResourceRedisClient,
  activity: ActivitySnapshot,
  needs: ActivityResourceNeeds,
  actionRuntime?: Pick<ActionRuntimeSettings, 'youtubeApiKey' | 'geminiApiKey'>
): Promise<ActivitySnapshot> => {
  if (!hasActivityResourceNeeds(needs)) {
    return activity;
  }

  const now = new Date();
  const username = activity.authorName;
  const normalizedUsername = normalizeName(username);
  let hydrated = { ...activity };

  if (needs.profile) {
    hydrated = hydrateProfileFields(
      hydrated,
      await getAuthorProfile(redditClient, redisClient, username, now)
    );
  }

  if (needs.moderator) {
    const moderator =
      normalizedUsername === AUTOMODERATOR
        ? {
            version: 1 as const,
            username,
            subredditName: activity.subredditName,
            fetchedAt: now.toISOString(),
            value: true,
          }
        : await getRelationship(
            redisClient,
            'subreddit-moderators',
            relationshipCacheKey(activity.subredditName, username),
            () =>
              fetchRelationship(
                () =>
                  redditClient.getModerators({
                    subredditName: activity.subredditName,
                    username,
                    limit: 1,
                    pageSize: 1,
                  }),
                activity.subredditName,
                username,
                now
              )
          );
    hydrated = {
      ...hydrated,
      ...(moderator.value === undefined
        ? {}
        : { authorIsModerator: moderator.value }),
      ...(moderator.error === undefined
        ? {}
        : {
            authorResourceErrors: [
              ...(hydrated.authorResourceErrors ?? []),
              `moderator lookup: ${moderator.error}`,
            ],
          }),
    };
  }

  if (needs.contributor) {
    const contributor = await getRelationship(
      redisClient,
      'subreddit-contributors',
      relationshipCacheKey(activity.subredditName, username),
      () =>
        fetchRelationship(
          () =>
            redditClient.getApprovedUsers({
              subredditName: activity.subredditName,
              username,
              limit: 1,
              pageSize: 1,
            }),
          activity.subredditName,
          username,
          now
        )
    );
    hydrated = {
      ...hydrated,
      ...(contributor.value === undefined
        ? {}
        : { authorIsContributor: contributor.value }),
      ...(contributor.error === undefined
        ? {}
        : {
            authorResourceErrors: [
              ...(hydrated.authorResourceErrors ?? []),
              `contributor lookup: ${contributor.error}`,
            ],
          }),
    };
  }

  if (needs.modActions) {
    const modNotes = await getAuthorModNotes(
      redditClient,
      redisClient,
      activity.subredditName,
      username,
      now
    );
    hydrated = {
      ...hydrated,
      authorModNotes: modNotes.notes,
      ...(modNotes.error === undefined
        ? {}
        : {
            authorResourceErrors: [
              ...(hydrated.authorResourceErrors ?? []),
              `mod notes lookup: ${modNotes.error}`,
            ],
          }),
    };
  }

  if (needs.userNotes === true) {
    const userNotes = await getAuthorUserNotes(
      redditClient,
      redisClient,
      activity.subredditName,
      username,
      now
    );
    hydrated = {
      ...hydrated,
      authorUserNotes: userNotes.notes.map((note) => ({
        ...note,
        createdAt: new Date(note.createdAt),
      })),
      ...(userNotes.error === undefined
        ? {}
        : {
            authorResourceErrors: [
              ...(hydrated.authorResourceErrors ?? []),
              `usernotes lookup: ${userNotes.error}`,
            ],
          }),
    };
  }

  if (needs.history) {
    try {
      hydrated = {
        ...hydrated,
        authorHistory: await fetchAuthorHistory(redditClient, activity),
      };
    } catch (error) {
      hydrated = {
        ...hydrated,
        authorResourceErrors: [
          ...(hydrated.authorResourceErrors ?? []),
          `author history: ${getErrorMessage(error)}`,
        ],
      };
    }
  }

  if (needs.repostCandidates === true) {
    try {
      hydrated = {
        ...hydrated,
        repostCandidates: await fetchRepostCandidates(redditClient, activity),
      };
    } catch (error) {
      hydrated = {
        ...hydrated,
        authorResourceErrors: [
          ...(hydrated.authorResourceErrors ?? []),
          `repost candidates: ${getErrorMessage(error)}`,
        ],
      };
    }
  }

  if (needs.subredditMetadata === true) {
    const metadata = await getSubredditMetadata(
      redditClient,
      redisClient,
      activity.subredditName
    );
    if (metadata !== undefined) {
      hydrated = {
        ...hydrated,
        ...(metadata.nsfw !== undefined ? { subredditNsfw: metadata.nsfw } : {}),
        ...(metadata.quarantined !== undefined
          ? { subredditQuarantined: metadata.quarantined }
          : {}),
        ...(metadata.type !== undefined ? { subredditType: metadata.type } : {}),
      };
    }
  }

  if (
    (needs.youtubeVideoInfo || needs.repostCandidates) &&
    actionRuntime?.youtubeApiKey !== undefined
  ) {
    const youtubeSourceUrl = getYouTubeSourceUrl(hydrated);
    const videoId = extractYouTubeVideoId(youtubeSourceUrl);
    if (videoId !== undefined) {
      const client = new YouTubeClient(actionRuntime.youtubeApiKey);
      if (needs.youtubeVideoInfo) {
        const info = await client.getVideoInfo(videoId);
        if (info !== undefined) {
          hydrated.youtubeChannel = info.channelTitle;
          hydrated.youtubePublishAgeMs = Date.now() - new Date(info.publishedAt).getTime();
        }
      }
      if (needs.repostCandidates) {
        const comments = await client.getVideoTopComments(videoId);
        if (comments !== undefined && comments.length > 0) {
          const externalCandidates: ActivitySnapshot[] = comments.map(c => ({
            id: `yt_${c.id}`,
            kind: 'comment',
            body: c.text,
            createdAt: new Date(c.publishedAt),
            authorName: c.author,
            subredditName: 'youtube',
            permalink: `https://youtube.com/watch?v=${c.videoId}&lc=${c.id}`,
            score: c.likeCount,
            removed: false,
            approved: false,
            locked: false,
            spam: false,
            stickied: false,
            distinguished: false,
            repostCandidateSource: 'external',
            repostCandidateProvider: 'YouTube',
          }));
          hydrated.repostCandidates = [
            ...(hydrated.repostCandidates ?? []),
            ...externalCandidates
          ];
        }
      }
    }
  }

  if (needs.imageHash === true) {
    const urlsToHash = new Map<string, ActivitySnapshot[]>();

    const addUrl = (act: ActivitySnapshot) => {
      if (
        act.url &&
        !act.url.includes('/comments/') &&
        isFetchAllowedRedditImageUrl(act.url)
      ) {
        let acts = urlsToHash.get(act.url);
        if (!acts) {
          acts = [];
          urlsToHash.set(act.url, acts);
        }
        acts.push(act);
      }
    };

    addUrl(hydrated);
    if (hydrated.repostCandidates) {
      for (const rep of hydrated.repostCandidates) addUrl(rep);
    }
    if (hydrated.authorHistory) {
      for (const hist of hydrated.authorHistory) addUrl(hist);
    }

    const promises = Array.from(urlsToHash.entries()).map(async ([url, acts]) => {
      const hashes = await fetchAndHashImage(url, redisClient);
      if (hashes) {
        for (const act of acts) {
          act.imageHash = hashes.hash;
          act.flippedImageHash = hashes.flippedHash;
        }
      }
    });

    await Promise.all(promises);
  }

  if (needs.toxicity === true && actionRuntime?.geminiApiKey !== undefined) {
    const textToAnalyze =
      hydrated.kind === 'submission'
        ? `${hydrated.title ?? ''}\n${hydrated.body ?? ''}`
        : hydrated.body ?? '';
    const toxicityResult = await classifyToxicity(textToAnalyze, actionRuntime.geminiApiKey);
    if (toxicityResult) {
      hydrated.toxicity = toxicityResult;
    }
  }

  return hydrated;
};
