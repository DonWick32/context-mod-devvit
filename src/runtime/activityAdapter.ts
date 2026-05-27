import type { Comment, Post } from '@devvit/web/server';
import { isT3 } from '@devvit/shared-types/tid.js';
import type { ModNoteSnapshot } from './modNoteCriteria';
import type { ToolboxUserNote } from './toolboxUserNotes';
import type { ToxicityResult } from './geminiToxicity';

export type ActivitySnapshot = {
  id: string;
  kind: 'submission' | 'comment';
  authorName: string;
  subredditName: string;
  subredditNsfw?: boolean;
  subredditQuarantined?: boolean;
  subredditType?: string;
  title?: string;
  body: string;
  url?: string;
  createdAt: Date;
  permalink: string;
  score: number;
  numReports?: number;
  userReportReasons?: string[];
  modReportReasons?: string[];
  reportHistory?: { type: 'user' | 'mod'; reason: string; timestamp: number }[];
  removed: boolean;
  removedBy?: string;
  deleted?: boolean;
  filtered?: boolean;
  approved: boolean;
  approvedBy?: string;
  approvedAtUtc?: number;
  locked: boolean;
  spam: boolean;
  stickied: boolean;
  distinguished: boolean;
  archived?: boolean;
  quarantined?: boolean;
  hidden?: boolean;
  ignoringReports?: boolean;
  collapsedBecauseCrowdControl?: boolean;
  nsfw?: boolean;
  spoiler?: boolean;
  selfPost?: boolean;
  isRedditMediaDomain?: boolean;
  upvoteRatio?: number;
  linkFlairText?: string;
  linkFlairCssClass?: string;
  youtubeChannel?: string;
  youtubePublishAgeMs?: number;
  imageHash?: string;
  flippedImageHash?: string;
  linkFlairTemplateId?: string;
  linkFlairBackgroundColor?: string;
  authorFlairText?: string;
  authorFlairCssClass?: string;
  authorFlairTemplateId?: string;
  authorFlairBackgroundColor?: string;
  authorAccountCreatedAt?: Date;
  authorLinkKarma?: number;
  authorCommentKarma?: number;
  authorTotalKarma?: number;
  authorHasVerifiedEmail?: boolean;
  authorShadowbanned?: boolean;
  authorProfileDescription?: string;
  authorNsfw?: boolean;
  authorIsModerator?: boolean;
  authorIsContributor?: boolean;
  toxicity?: ToxicityResult;
  authorModNotes?: ModNoteSnapshot[];
  authorUserNotes?: ToolboxUserNote[];
  authorHistory?: ActivitySnapshot[];
  repostCandidates?: ActivitySnapshot[];
  repostCandidateSource?: 'title' | 'url' | 'duplicates' | 'crossposts' | 'external';
  repostCandidateProvider?: string;
  authorResourceErrors?: string[];
  source?: string;
  parentId?: string;
  postId?: string;
  parentSubmission?: ActivitySnapshot;
  commentDepth?: number;
  commentIsOp?: boolean;
};

const isProbablySelfPost = (post: Post): boolean =>
  post.body !== undefined ||
  post.url === post.permalink ||
  post.url.endsWith(post.permalink) ||
  post.url.includes(`/r/${post.subredditName}/comments/`);

const REDDIT_MEDIA_HOSTS = new Set([
  'i.redd.it',
  'v.redd.it',
  'preview.redd.it',
]);

const isRedditMediaUrl = (url: string | undefined): boolean => {
  if (url === undefined || url.trim().length === 0) {
    return false;
  }

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return (
      REDDIT_MEDIA_HOSTS.has(hostname) ||
      (hostname === 'reddit.com' && parsed.pathname.startsWith('/gallery/'))
    );
  } catch {
    return false;
  }
};

const isRedditMediaPost = (post: Post): boolean => {
  const mediaPost = post as Post & {
    gallery?: unknown[];
  };
  return (
    mediaPost.secureMedia?.redditVideo !== undefined ||
    (Array.isArray(mediaPost.gallery) && mediaPost.gallery.length > 0) ||
    isRedditMediaUrl(post.url)
  );
};

const getRemovedByCategory = (item: Post | Comment): string | undefined => {
  const withRemovalCategory = item as { removedByCategory?: string };
  return withRemovalCategory.removedByCategory;
};

const isDeletedActivity = (item: Post | Comment): boolean =>
  item.authorName === '[deleted]' || getRemovedByCategory(item) === 'deleted';

const isFilteredActivity = (item: Post | Comment): boolean =>
  getRemovedByCategory(item) === 'automod_filtered';

const getOptionalString = (
  item: Post | Comment,
  key: string
): string | undefined => {
  const value = (item as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
};

const optionalStringProperty = <Key extends string>(
  key: Key,
  value: string | undefined
): Partial<Record<Key, string>> =>
  value === undefined ? {} : { [key]: value } as Record<Key, string>;

type FlairLike = {
  text?: string | undefined;
  cssClass?: string | undefined;
  templateId?: string | undefined;
  backgroundColor?: string | undefined;
};

const snapshotFlair = (
  flair: FlairLike | undefined,
  prefix: 'linkFlair' | 'authorFlair'
) => {
  if (flair === undefined) {
    return {};
  }

  return {
    ...(flair.text === undefined ? {} : { [`${prefix}Text`]: flair.text }),
    ...(flair.cssClass === undefined
      ? {}
      : { [`${prefix}CssClass`]: flair.cssClass }),
    ...(flair.templateId === undefined
      ? {}
      : { [`${prefix}TemplateId`]: flair.templateId }),
    ...(flair.backgroundColor === undefined
      ? {}
      : { [`${prefix}BackgroundColor`]: flair.backgroundColor }),
  };
};

type ActivitySnapshotOptions = {
  source?: string;
};

export const snapshotFromPost = (
  post: Post,
  options: ActivitySnapshotOptions = {}
): ActivitySnapshot => ({
  id: post.id,
  kind: 'submission',
  authorName: post.authorName,
  subredditName: post.subredditName,
  title: post.title,
  body: post.body ?? '',
  url: post.url,
  createdAt: post.createdAt,
  permalink: post.permalink,
  score: post.score,
  numReports: post.numberOfReports,
  userReportReasons: post.userReportReasons,
  modReportReasons: post.modReportReasons,
  removed: post.removed,
  ...(post.removedBy === undefined ? {} : { removedBy: post.removedBy }),
  deleted: isDeletedActivity(post),
  filtered: isFilteredActivity(post),
  approved: post.approved,
  ...optionalStringProperty('approvedBy', getOptionalString(post, 'approvedBy')),
  approvedAtUtc: post.approvedAtUtc,
  locked: post.locked,
  spam: post.spam,
  stickied: post.stickied,
  distinguished: post.distinguishedBy !== undefined,
  archived: post.archived,
  quarantined: post.quarantined,
  subredditQuarantined: post.quarantined,
  hidden: post.hidden,
  ignoringReports: post.ignoringReports,
  nsfw: post.nsfw,
  spoiler: post.spoiler,
  selfPost: isProbablySelfPost(post),
  isRedditMediaDomain: isRedditMediaPost(post),
  ...((post as Post & { upVoteRatio?: number }).upVoteRatio !== undefined
    ? { upvoteRatio: (post as Post & { upVoteRatio?: number }).upVoteRatio }
    : {}),
  ...snapshotFlair(post.flair, 'linkFlair'),
  ...snapshotFlair(post.authorFlair, 'authorFlair'),
  ...(options.source === undefined ? {} : { source: options.source }),
});

type CommentSnapshotOptions = ActivitySnapshotOptions & {
  parentPost?: Post;
};

type CommentSubmitterFields = {
  isSubmitter?: boolean;
  isOp?: boolean;
};

const snapshotCommentOpState = (
  comment: Comment,
  parentPost: Post | undefined
): { commentIsOp?: boolean } => {
  if (parentPost !== undefined) {
    return {
      commentIsOp:
        parentPost.authorName.toLowerCase() === comment.authorName.toLowerCase(),
    };
  }

  const submitterFields = comment as Comment & CommentSubmitterFields;
  if (submitterFields.isSubmitter === true || submitterFields.isOp === true) {
    return { commentIsOp: true };
  }
  if (submitterFields.isSubmitter === false || submitterFields.isOp === false) {
    return { commentIsOp: false };
  }

  return {};
};

export const snapshotFromComment = (
  comment: Comment,
  options: CommentSnapshotOptions = {}
): ActivitySnapshot => ({
  id: comment.id,
  kind: 'comment',
  authorName: comment.authorName,
  subredditName: comment.subredditName,
  body: comment.body,
  createdAt: comment.createdAt,
  permalink: comment.permalink,
  score: comment.score,
  numReports: comment.numReports,
  userReportReasons: comment.userReportReasons,
  modReportReasons: comment.modReportReasons,
  removed: comment.removed,
  ...optionalStringProperty('removedBy', getOptionalString(comment, 'removedBy')),
  deleted: isDeletedActivity(comment),
  filtered: isFilteredActivity(comment),
  approved: comment.approved,
  ...optionalStringProperty(
    'approvedBy',
    getOptionalString(comment, 'approvedBy')
  ),
  approvedAtUtc: comment.approvedAtUtc,
  locked: comment.locked,
  spam: comment.spam,
  stickied: comment.stickied,
  distinguished: comment.distinguishedBy !== undefined,
  ignoringReports: comment.ignoringReports,
  collapsedBecauseCrowdControl: comment.collapsedBecauseCrowdControl,
  parentId: comment.parentId,
  postId: comment.postId,
  ...(options.source === undefined ? {} : { source: options.source }),
  ...snapshotFlair(comment.authorFlair, 'authorFlair'),
  ...(isT3(comment.parentId) ? { commentDepth: 0 } : {}),
  ...snapshotCommentOpState(comment, options.parentPost),
  ...(options.parentPost === undefined
    ? {}
    : {
        parentSubmission: snapshotFromPost(options.parentPost),
      }),
});

export const getActivityText = (activity: ActivitySnapshot): string =>
  [activity.title, activity.body, activity.url].filter(Boolean).join('\n');
