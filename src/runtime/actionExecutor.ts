import type { RedditClient } from '@devvit/web/server';
import { isT1, isT3, type T1, type T3 } from '@devvit/shared-types/tid.js';
import {
  cancelDispatchRecords,
  enqueueDispatchRecord,
  findDispatchRecords,
  setDispatchSchedulerJobId,
  type DispatchQueueRedisClient,
  type DispatchQueueRecord,
} from '../storage/dispatchQueue';
import type { ActivitySnapshot } from './activityAdapter';
import { parseDurationComparison } from './comparison';
import type { PlannedAction } from './dryRunEngine';
import {
  evaluateModNoteCriteria,
  snapshotFromModNote,
  type ModNoteSnapshot,
} from './modNoteCriteria';
import {
  addToolboxUserNote,
  evaluateToolboxUserNoteCriteria,
  getToolboxUserNotesForAuthor,
} from './toolboxUserNotes';
import { parseRedditThingId } from './thingIds';
import { loadWikiPage, parseWikiPageReference } from './wikiPages';

type ReportableThing = Parameters<RedditClient['report']>[0];
export type RedditActionClient = Pick<
  RedditClient,
  | 'addModNote'
  | 'addRemovalNote'
  | 'approve'
  | 'approveUser'
  | 'banUser'
  | 'getCurrentUsername'
  | 'getCommentById'
  | 'getModNotes'
  | 'getPostById'
  | 'getWikiPage'
  | 'modMail'
  | 'remove'
  | 'removeUser'
  | 'removeUserFlair'
  | 'report'
  | 'sendPrivateMessage'
  | 'setPostFlair'
  | 'setUserFlair'
  | 'submitPost'
  | 'updateWikiPage'
>;
type LockableThing = ReportableThing & {
  lock(): Promise<void>;
};
type StateBackedThing = Partial<{
  approved: boolean;
  locked: boolean;
}>;
type AuthoredThing = ReportableThing & {
  authorName: string;
  subredditName: string;
};
type TemplatableThing = Partial<{
  authorName: string;
  body: string;
  collapsedBecauseCrowdControl: boolean;
  distinguishedBy: string;
  hidden: boolean;
  ignoringReports: boolean;
  locked: boolean;
  modReportReasons: string[];
  nsfw: boolean;
  numReports: number;
  numberOfReports: number;
  approved: boolean;
  subredditName: string;
  permalink: string;
  quarantined: boolean;
  removed: boolean;
  score: number;
  spam: boolean;
  spoiler: boolean;
  stickied: boolean;
  title: string;
  url: string;
  userReportReasons: string[];
}>;
type CreatedComment = {
  id?: T1;
  permalink?: string;
  lock?(): Promise<void>;
  distinguish?(makeSticky?: boolean): Promise<void>;
};
type CommentReplyTarget = ReportableThing & {
  reply(opts: Readonly<{ text: string }>): Promise<CreatedComment>;
};
type PostCommentTarget = ReportableThing & {
  addComment(opts: Readonly<{ text: string }>): Promise<CreatedComment>;
};
type CommentWithPostTarget = ReportableThing & {
  postId: T3;
};
type MessageDelivery =
  | {
      kind: 'private';
      options: Parameters<RedditClient['sendPrivateMessage']>[0];
    }
  | {
      kind: 'subreddit';
      options: Parameters<RedditClient['modMail']['createConversation']>[0];
      recipient: string;
      archive?: boolean;
    };
type CreatedPost = {
  id?: T3;
  lock?(): Promise<void>;
  distinguish?(): Promise<void>;
  sticky?(position?: 1 | 2 | 3 | 4): Promise<void>;
};

export type ActionRuntimeSettings = {
  appEnabled: boolean;
  dryRun: boolean;
  youtubeApiKey?: string;
  geminiApiKey?: string;
};

export type ActionWikiContentLoader = {
  getWikiPage(
    subredditName: string,
    pageName: string
  ): Promise<{ content: string }>;
  getWikiPages?(subredditName: string): Promise<string[]>;
};

export type ActionSchedulerClient = {
  runJob(job: {
    name: string;
    data?: Record<string, string>;
    runAt: Date;
  }): Promise<string>;
  cancelJob(jobId: string): Promise<void>;
};

export type ActionExecutionResources = {
  activity?: ActivitySnapshot;
  dispatchQueue?: {
    activity: ActivitySnapshot;
    now?: () => Date;
    redisClient: DispatchQueueRedisClient;
  };
  schedulerClient?: ActionSchedulerClient;
  wikiContentLoader?: ActionWikiContentLoader;
  notificationManager?: import('./notificationManager').NotificationManager;
  subredditName?: string;
  footer?: false | string;
  now?: () => Date;
  actionResults?: ActionExecutionResult[];
};

export type ActionExecutionResult = {
  kind: string;
  name?: string;
  status: 'executed' | 'failed' | 'skipped';
  reason: string;
  targetId?: string;
  permalink?: string;
};

export type ActionExecutionSummary = {
  appEnabled: boolean;
  dryRun: boolean;
  results: ActionExecutionResult[];
  executed: number;
  failed: number;
  skipped: number;
};

const DEFAULT_REPORT_REASON = 'ContextMod rule matched';
export const DISPATCH_SCHEDULER_JOB_NAME = 'contextModDispatch';
export const DEFAULT_ACTION_FOOTER =
  '\n*****\nThis action was performed by [a bot.]({{botLink}}) Mention a moderator or [send a modmail]({{modmailLink}}) if you have any ideas, questions, or concerns about this action.';
const BOT_LINK =
  'https://www.reddit.com/r/ContextModBot/comments/otz396/introduction_to_contextmodbot';
const REPORT_REASON_MAX_LENGTH = 100;
const REMOVAL_NOTE_MAX_LENGTH = 100;
const BAN_TEXT_MAX_LENGTH = 100;
const MOD_NOTE_MAX_LENGTH = 250;
// asModTeam is now supported as a distinguish approximation (see comment action handler)
const COMMENT_UNSUPPORTED_KEYS = ['asModTeam'] as const;
const MOD_NOTE_LABELS = [
  'BOT_BAN',
  'PERMA_BAN',
  'BAN',
  'ABUSE_WARNING',
  'SPAM_WARNING',
  'SPAM_WATCH',
  'SOLID_CONTRIBUTOR',
  'HELPFUL_USER',
] as const;

const getStringConfigValue = (
  action: PlannedAction,
  key: string
): string | undefined => {
  const value = action.config?.[key];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
};

type ResolvedStringConfigValue =
  | {
      value?: string;
    }
  | {
      error: string;
    };

const truncate = (value: string, maxLength: number): string =>
  value.length > maxLength ? value.slice(0, maxLength) : value;

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const firstDefined = <T>(...values: (T | undefined)[]): T | undefined =>
  values.find((value) => value !== undefined);

const joinReasons = (reasons: string[] | undefined): string | undefined =>
  reasons === undefined ? undefined : reasons.join(', ');

const getTemplateActivity = (
  resources: ActionExecutionResources
): ActivitySnapshot | undefined =>
  resources.activity ?? resources.dispatchQueue?.activity;

const getTemplateNow = (resources: ActionExecutionResources): Date =>
  resources.now?.() ?? resources.dispatchQueue?.now?.() ?? new Date();

const humanizeDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const units = [
    { name: 'year', seconds: 365 * 24 * 60 * 60 },
    { name: 'month', seconds: 30 * 24 * 60 * 60 },
    { name: 'week', seconds: 7 * 24 * 60 * 60 },
    { name: 'day', seconds: 24 * 60 * 60 },
    { name: 'hour', seconds: 60 * 60 },
    { name: 'minute', seconds: 60 },
  ] as const;

  for (const unit of units) {
    const count = Math.floor(seconds / unit.seconds);
    if (count >= 1) {
      return `${count} ${unit.name}${count === 1 ? '' : 's'}`;
    }
  }

  return '0 minutes';
};

const humanizeAge = (
  createdAt: Date | undefined,
  resources: ActionExecutionResources
): string | undefined =>
  createdAt === undefined
    ? undefined
    : humanizeDuration(getTemplateNow(resources).getTime() - createdAt.getTime());

const getTemplateValue = (
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3,
  path: string,
  resources: ActionExecutionResources = {}
): string => {
  const item = target as TemplatableThing;
  const activity = getTemplateActivity(resources);
  const normalizedPath = path.trim();
  const activityKind = activity?.kind ?? (isT3(targetId) ? 'submission' : 'comment');
  const authorName = firstDefined(item.authorName, activity?.authorName);
  const body = firstDefined(item.body, activity?.body);
  const rawPermalink = firstDefined(item.permalink, activity?.permalink);
  const subredditName = firstDefined(
    item.subredditName,
    resources.subredditName,
    activity?.subredditName
  );
  const rawTitle = firstDefined(item.title, activity?.title);
  const templateTitle =
    rawTitle ?? (body === undefined ? undefined : truncate(body, 50));
  const rawUrl = firstDefined(item.url, activity?.url);
  const permalink =
    rawPermalink === undefined
      ? undefined
      : rawPermalink.startsWith('http')
        ? rawPermalink
        : `https://reddit.com${rawPermalink.startsWith('/') ? '' : '/'}${
            rawPermalink
          }`;
  const modmailLink =
    subredditName === undefined || permalink === undefined
      ? undefined
      : `https://www.reddit.com/message/compose?to=%2Fr%2F${
          subredditName
        }&message=${encodeURIComponent(permalink)}`;
  const reports =
    firstDefined(item.numberOfReports, item.numReports, activity?.numReports) ??
    ((firstDefined(item.userReportReasons, activity?.userReportReasons)?.length ??
      0) +
      (firstDefined(item.modReportReasons, activity?.modReportReasons)?.length ??
        0));
  const shortTitle =
    templateTitle === undefined ? undefined : truncate(templateTitle, 15);
  const rulePath = normalizedPath.match(/^rules\.([^.]+)\.(.+)$/i);
  if (rulePath?.[1] !== undefined && rulePath[2] !== undefined) {
    const ruleName = rulePath[1].trim().toLowerCase().replace(/[\s_-]+/g, '');
    const field = rulePath[2].trim();
    const value =
      action.templateContext?.rules[ruleName]?.[field] ??
      action.templateContext?.rules[rulePath[1].trim().toLowerCase()]?.[field];
    return value === undefined ? '' : String(value);
  }

  // Action result templates: {{action.0.status}}, {{action.1.kind}}, etc.
  const actionResultPath = normalizedPath.match(/^action\.(\d+)\.(.+)$/i);
  if (actionResultPath?.[1] !== undefined && actionResultPath[2] !== undefined) {
    const actionIndex = parseInt(actionResultPath[1], 10);
    const field = actionResultPath[2].trim();
    const result = resources.actionResults?.[actionIndex];
    if (result === undefined) return '';
    const actionResultValues: Record<string, string | undefined> = {
      status: result.status,
      kind: result.kind,
      name: result.name,
      reason: result.reason,
      id: result.targetId,
      targetId: result.targetId,
      permalink: result.permalink,
      url: result.permalink,
    };
    return actionResultValues[field] ?? '';
  }

  const values: Record<string, string | number | boolean | undefined> = {
    botLink: BOT_LINK,
    modmailLink,
    modmaiLink: modmailLink,
    permaLink: permalink,
    permalink,
    subName: subredditName,
    'item.id': activity?.id ?? targetId,
    'item.kind': activityKind,
    'item.author': authorName,
    'item.author.name': authorName,
    'item.author.age': humanizeAge(activity?.authorAccountCreatedAt, resources),
    'item.author.linkKarma': activity?.authorLinkKarma,
    'item.author.commentKarma': activity?.authorCommentKarma,
    'item.author.totalKarma': activity?.authorTotalKarma,
    'item.author.verified': activity?.authorHasVerifiedEmail,
    'item.author.hasVerifiedEmail': activity?.authorHasVerifiedEmail,
    'item.author.shadowbanned': activity?.authorShadowbanned,
    'item.author.profileDescription': activity?.authorProfileDescription,
    'item.author.nsfw': activity?.authorNsfw,
    'item.author.moderator': activity?.authorIsModerator,
    'item.author.isModerator': activity?.authorIsModerator,
    'item.author.contributor': activity?.authorIsContributor,
    'item.author.isContributor': activity?.authorIsContributor,
    'item.author.flairText': activity?.authorFlairText,
    'item.author.flairCssClass': activity?.authorFlairCssClass,
    'item.author.flairTemplate': activity?.authorFlairTemplateId,
    'item.author.flairTemplateId': activity?.authorFlairTemplateId,
    'item.author.flairBackgroundColor': activity?.authorFlairBackgroundColor,
    'item.age': humanizeAge(activity?.createdAt, resources),
    'item.createdAt': activity?.createdAt.toISOString(),
    'item.approved': firstDefined(item.approved, activity?.approved),
    'item.approvedBy': activity?.approvedBy,
    'item.archived': activity?.archived,
    'item.collapsedBecauseCrowdControl': firstDefined(
      item.collapsedBecauseCrowdControl,
      activity?.collapsedBecauseCrowdControl
    ),
    'item.collapsed_because_crowd_control': firstDefined(
      item.collapsedBecauseCrowdControl,
      activity?.collapsedBecauseCrowdControl
    ),
    'item.deleted': activity?.deleted,
    'item.distinguished': firstDefined(
      item.distinguishedBy !== undefined ? true : undefined,
      activity?.distinguished
    ),
    'item.filtered': activity?.filtered,
    'item.hidden': firstDefined(item.hidden, activity?.hidden),
    'item.ignoringReports': firstDefined(
      item.ignoringReports,
      activity?.ignoringReports
    ),
    'item.ignoring_reports': firstDefined(
      item.ignoringReports,
      activity?.ignoringReports
    ),
    'item.isRedditMediaDomain': activity?.isRedditMediaDomain,
    'item.is_self': activity?.selfPost,
    'item.linkFlairText': activity?.linkFlairText,
    'item.linkFlairCssClass': activity?.linkFlairCssClass,
    'item.linkFlairTemplate': activity?.linkFlairTemplateId,
    'item.linkFlairTemplateId': activity?.linkFlairTemplateId,
    'item.linkFlairBackgroundColor': activity?.linkFlairBackgroundColor,
    'item.locked': firstDefined(item.locked, activity?.locked),
    'item.modReports': firstDefined(
      item.modReportReasons,
      activity?.modReportReasons
    )?.length,
    'item.modReportReasons': joinReasons(
      firstDefined(item.modReportReasons, activity?.modReportReasons)
    ),
    'item.nsfw': firstDefined(item.nsfw, activity?.nsfw),
    'item.op': activityKind === 'submission' ? true : activity?.commentIsOp,
    'item.quarantined': firstDefined(item.quarantined, activity?.quarantined),
    'item.redditMedia': activity?.isRedditMediaDomain,
    'item.removed': firstDefined(item.removed, activity?.removed),
    'item.removedBy': activity?.removedBy,
    'item.reports': reports,
    'item.score': firstDefined(item.score, activity?.score),
    'item.selfPost': activity?.selfPost,
    'item.shortTitle': shortTitle,
    'item.spam': firstDefined(item.spam, activity?.spam),
    'item.spoiler': firstDefined(item.spoiler, activity?.spoiler),
    'item.stickied': firstDefined(item.stickied, activity?.stickied),
    'item.subreddit': subredditName,
    'item.permalink': permalink,
    'item.permaLink': permalink,
    'item.title': templateTitle,
    'item.url': rawUrl,
    'item.userReports': firstDefined(
      item.userReportReasons,
      activity?.userReportReasons
    )?.length,
    'item.userReportReasons': joinReasons(
      firstDefined(item.userReportReasons, activity?.userReportReasons)
    ),
    'item.votes': firstDefined(item.score, activity?.score),
  };

  const value = values[normalizedPath];
  return value === undefined ? '' : String(value);
};

const renderActionTemplate = (
  value: string,
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources = {}
): string =>
  value.replace(/{{\s*([^}]+?)\s*}}/g, (_match, path: string) =>
    getTemplateValue(action, target, targetId, path, resources)
  );

const getTargetSubredditName = (
  target: ReportableThing
): string | undefined => {
  const item = target as TemplatableThing;
  return item.subredditName?.trim();
};

const resolveActionContentSource = async (
  rawValue: string,
  target: ReportableThing,
  resources: ActionExecutionResources
): Promise<ResolvedStringConfigValue> => {
  const trimmedValue = rawValue.trim();

  if (trimmedValue.startsWith('url:')) {
    return {
      error:
        'url-backed action content requires fetch-domain approval and is not enabled',
    };
  }

  if (!trimmedValue.startsWith('wiki:')) {
    return { value: rawValue };
  }

  if (resources.wikiContentLoader === undefined) {
    return { error: 'wiki-backed action content requires the wiki content loader' };
  }

  const subredditName =
    resources.subredditName?.trim() ??
    getTargetSubredditName(target);
  if (subredditName === undefined || subredditName.length === 0) {
    return { error: 'subreddit name is required for wiki-backed action content' };
  }

  const wikiReference = parseWikiPageReference(trimmedValue, subredditName);
  if (wikiReference === undefined) {
    return { error: 'wiki-backed action content page name is invalid' };
  }

  try {
    const page = await loadWikiPage(resources.wikiContentLoader, wikiReference);
    return { value: page.content };
  } catch (error) {
    return {
      error: `unable to load wiki-backed action content wiki:${wikiReference.pageName}: ${getErrorMessage(
        error
      )}`,
    };
  }
};

const getRenderedStringConfigValue = (
  action: PlannedAction,
  key: string,
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources = {}
): string | undefined => {
  const value = getStringConfigValue(action, key);
  if (value === undefined) {
    return undefined;
  }

  const rendered = renderActionTemplate(
    value,
    action,
    target,
    targetId,
    resources
  ).trim();
  return rendered.length === 0 ? undefined : rendered;
};

const getFirstRenderedStringConfigValue = (
  action: PlannedAction,
  keys: string[],
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources = {}
): string | undefined => {
  for (const key of keys) {
    const value = getRenderedStringConfigValue(
      action,
      key,
      target,
      targetId,
      resources
    );
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
};

const getResolvedRenderedStringConfigValue = async (
  action: PlannedAction,
  key: string,
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources
): Promise<ResolvedStringConfigValue> => {
  const value = getStringConfigValue(action, key);
  if (value === undefined) {
    return {};
  }

  return resolveAndRenderActionString(value, action, target, targetId, resources);
};

const resolveAndRenderActionString = async (
  value: string,
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources,
  options: { trim?: boolean } = {}
): Promise<ResolvedStringConfigValue> => {
  const source = await resolveActionContentSource(value, target, resources);
  if ('error' in source) {
    return source;
  }

  const rendered = renderActionTemplate(
    source.value ?? '',
    action,
    target,
    targetId,
    resources
  );
  if (rendered.trim().length === 0) {
    return {};
  }

  return { value: options.trim === false ? rendered : rendered.trim() };
};

const getFirstResolvedRenderedStringConfigValue = async (
  action: PlannedAction,
  keys: string[],
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources
): Promise<ResolvedStringConfigValue> => {
  for (const key of keys) {
    if (getStringConfigValue(action, key) === undefined) {
      continue;
    }

    const result = await getResolvedRenderedStringConfigValue(
      action,
      key,
      target,
      targetId,
      resources
    );
    if ('error' in result || result.value !== undefined) {
      return result;
    }
  }

  return {};
};

export const getReportReason = (
  action: PlannedAction,
  target?: ReportableThing,
  targetId?: T1 | T3
): string => {
  const content =
    target === undefined || targetId === undefined
      ? getStringConfigValue(action, 'content')
      : getRenderedStringConfigValue(action, 'content', target, targetId);

  return truncate(content ?? DEFAULT_REPORT_REASON, REPORT_REASON_MAX_LENGTH);
};

const getResolvedReportReason = async (
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources
): Promise<ResolvedStringConfigValue> => {
  const content = await getResolvedRenderedStringConfigValue(
    action,
    'content',
    target,
    targetId,
    resources
  );
  if ('error' in content) {
    return content;
  }

  return {
    value: truncate(content.value ?? DEFAULT_REPORT_REASON, REPORT_REASON_MAX_LENGTH),
  };
};

const getRawActionFooter = (
  action: PlannedAction,
  resources: ActionExecutionResources
): false | string | undefined | { error: string } => {
  if (action.config !== undefined && 'footer' in action.config) {
    const actionFooter = action.config.footer;
    if (actionFooter === false || typeof actionFooter === 'string') {
      return actionFooter;
    }
    if (actionFooter !== undefined) {
      return { error: 'action footer must be false or a string' };
    }
  }

  return resources.footer;
};

const resolveActionFooter = async (
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources
): Promise<ResolvedStringConfigValue> => {
  const rawFooter = getRawActionFooter(action, resources);
  if (typeof rawFooter === 'object') {
    return rawFooter;
  }
  if (rawFooter === false || rawFooter === undefined) {
    return { value: '' };
  }

  const footer = await resolveAndRenderActionString(
    rawFooter,
    action,
    target,
    targetId,
    resources,
    { trim: false }
  );
  if ('error' in footer) {
    return footer;
  }

  return { value: footer.value ?? '' };
};

const appendActionFooter = async (
  body: string,
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources
): Promise<ResolvedStringConfigValue> => {
  const footer = await resolveActionFooter(action, target, targetId, resources);
  if ('error' in footer) {
    return footer;
  }

  return { value: `${body}${footer.value ?? ''}` };
};

const getRemoveSpamFlag = (action: PlannedAction): boolean =>
  action.config?.spam === true;

const hasAuthorAndSubreddit = (target: ReportableThing): target is AuthoredThing =>
  'authorName' in target &&
  typeof target.authorName === 'string' &&
  target.authorName.trim().length > 0 &&
  'subredditName' in target &&
  typeof target.subredditName === 'string' &&
  target.subredditName.trim().length > 0;

const getPostFlairOptions = (
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources
):
  | Parameters<RedditClient['setPostFlair']>[0]
  | { error: string } => {
  if (!isT3(targetId)) {
    return { error: 'flair can only run on posts' };
  }

  const flairTemplateId =
    getRenderedStringConfigValue(
      action,
      'flair_template_id',
      target,
      targetId,
      resources
    ) ??
    getRenderedStringConfigValue(
      action,
      'flairTemplateId',
      target,
      targetId,
      resources
    );
  const text = getRenderedStringConfigValue(
    action,
    'text',
    target,
    targetId,
    resources
  );
  const cssClass =
    getRenderedStringConfigValue(action, 'css', target, targetId, resources) ??
    getRenderedStringConfigValue(
      action,
      'cssClass',
      target,
      targetId,
      resources
    );
  const backgroundColor = getRenderedStringConfigValue(
    action,
    'backgroundColor',
    target,
    targetId,
    resources
  );
  const textColorValue = getRenderedStringConfigValue(
    action,
    'textColor',
    target,
    targetId,
    resources
  );
  const textColor =
    textColorValue === undefined ||
    textColorValue === 'light' ||
    textColorValue === 'dark'
      ? textColorValue
      : undefined;
  if (textColorValue !== undefined && textColor === undefined) {
    return { error: 'flair textColor must be light or dark' };
  }

  if (
    flairTemplateId === undefined &&
    text === undefined &&
    cssClass === undefined &&
    backgroundColor === undefined &&
    textColor === undefined
  ) {
    return { error: 'flair text, css, template, or color is required' };
  }

  return {
    subredditName: target.subredditName,
    postId: targetId,
    ...(flairTemplateId === undefined ? {} : { flairTemplateId }),
    ...(text === undefined ? {} : { text }),
    ...(cssClass === undefined ? {} : { cssClass }),
    ...(backgroundColor === undefined ? {} : { backgroundColor }),
    ...(textColor === undefined ? {} : { textColor }),
  };
};

const getUserFlairOptions = (
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources
):
  | Parameters<RedditClient['setUserFlair']>[0]
  | { remove: Parameters<RedditClient['removeUserFlair']> }
  | { error: string } => {
  if (!hasAuthorAndSubreddit(target)) {
    return { error: 'target author and subreddit are required for userflair' };
  }

  const flairTemplateId =
    getRenderedStringConfigValue(
      action,
      'flair_template_id',
      target,
      targetId,
      resources
    ) ??
    getRenderedStringConfigValue(
      action,
      'flairTemplateId',
      target,
      targetId,
      resources
    );
  if (flairTemplateId !== undefined) {
    return {
      subredditName: target.subredditName,
      username: target.authorName,
      flairTemplateId,
    };
  }

  const text = getRenderedStringConfigValue(
    action,
    'text',
    target,
    targetId,
    resources
  );
  const cssClass =
    getRenderedStringConfigValue(action, 'css', target, targetId, resources) ??
    getRenderedStringConfigValue(
      action,
      'cssClass',
      target,
      targetId,
      resources
    );
  const backgroundColor = getRenderedStringConfigValue(
    action,
    'backgroundColor',
    target,
    targetId,
    resources
  );
  const textColorValue = getRenderedStringConfigValue(
    action,
    'textColor',
    target,
    targetId,
    resources
  );
  const textColor =
    textColorValue === undefined ||
    textColorValue === 'light' ||
    textColorValue === 'dark'
      ? textColorValue
      : undefined;
  if (textColorValue !== undefined && textColor === undefined) {
    return { error: 'userflair textColor must be light or dark' };
  }

  if (
    text === undefined &&
    cssClass === undefined &&
    backgroundColor === undefined &&
    textColor === undefined
  ) {
    return { remove: [target.subredditName, target.authorName] };
  }

  return {
    subredditName: target.subredditName,
    username: target.authorName,
    ...(text === undefined ? {} : { text }),
    ...(cssClass === undefined ? {} : { cssClass }),
    ...(backgroundColor === undefined ? {} : { backgroundColor }),
    ...(textColor === undefined ? {} : { textColor }),
  };
};

const getBanOptions = async (
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources
): Promise<Parameters<RedditClient['banUser']>[0] | { error: string }> => {
  if (!hasAuthorAndSubreddit(target)) {
    return { error: 'target author and subreddit are required for ban' };
  }

  const rawDuration = action.config?.duration;
  const duration =
    typeof rawDuration === 'number' && Number.isInteger(rawDuration)
      ? rawDuration
      : undefined;
  if (
    rawDuration !== undefined &&
    (duration === undefined || duration < 1 || duration > 999)
  ) {
    return { error: 'ban duration must be an integer from 1 to 999 days' };
  }

  const message = await getResolvedRenderedStringConfigValue(
    action,
    'message',
    target,
    targetId,
    resources
  );
  if ('error' in message) {
    return message;
  }
  const messageWithFooter =
    message.value === undefined
      ? message
      : await appendActionFooter(
          message.value,
          action,
          target,
          targetId,
          resources
        );
  if ('error' in messageWithFooter) {
    return messageWithFooter;
  }

  const reason = await getResolvedRenderedStringConfigValue(
    action,
    'reason',
    target,
    targetId,
    resources
  );
  if ('error' in reason) {
    return reason;
  }

  const note = await getResolvedRenderedStringConfigValue(
    action,
    'note',
    target,
    targetId,
    resources
  );
  if ('error' in note) {
    return note;
  }

  return {
    username: target.authorName,
    subredditName: target.subredditName,
    context: targetId,
    ...(messageWithFooter.value === undefined || messageWithFooter.value.length === 0
      ? {}
      : { message: messageWithFooter.value }),
    ...(reason.value === undefined
      ? {}
      : { reason: truncate(reason.value, BAN_TEXT_MAX_LENGTH) }),
    ...(note.value === undefined
      ? {}
      : { note: truncate(note.value, BAN_TEXT_MAX_LENGTH) }),
    ...(duration === undefined ? {} : { duration }),
  };
};

const getContributorOptions = (
  action: PlannedAction,
  target: ReportableThing,
  resources: ActionExecutionResources
): { username: string; subredditName: string; action: 'add' | 'remove' } | { error: string } => {
  if (!hasAuthorAndSubreddit(target)) {
    return { error: 'target author and subreddit are required for contributor' };
  }

  if (action.config?.action !== 'add' && action.config?.action !== 'remove') {
    return { error: 'contributor action must be add or remove' };
  }

  // Pre-check if we know the user's contributor status in this subreddit
  if (resources.activity !== undefined && resources.activity.subredditName === target.subredditName) {
    const isContributor = resources.activity.authorIsContributor;
    if (isContributor !== undefined) {
      if (action.config.action === 'add' && isContributor) {
        return { error: 'Author is already a contributor, cannot add them' };
      }
      if (action.config.action === 'remove' && !isContributor) {
        return { error: 'Author is not a contributor, cannot remove them' };
      }
    }
  }

  return {
    username: target.authorName,
    subredditName: target.subredditName,
    action: action.config.action,
  };
};

const isModNoteLabel = (
  value: string
): value is (typeof MOD_NOTE_LABELS)[number] =>
  MOD_NOTE_LABELS.some((label) => label === value);

type ExistingModNote = Awaited<
  ReturnType<ReturnType<RedditClient['getModNotes']>['all']>
>[number];

const modNoteMatchesExisting = (
  modNote: ExistingModNote,
  note: string,
  label: string | undefined,
  targetId: T1 | T3,
  referenceActivity: boolean
): boolean => {
  const userNote = modNote.userNote;
  if (userNote === undefined) {
    return false;
  }

  if (userNote.note !== note) {
    return false;
  }

  if (label !== undefined && userNote.label !== label) {
    return false;
  }

  return !referenceActivity || userNote.redditId === targetId;
};

const hasExistingModNote = async (
  redditClient: RedditActionClient,
  target: AuthoredThing,
  note: string,
  label: string | undefined,
  targetId: T1 | T3,
  referenceActivity: boolean
): Promise<boolean> => {
  const notes = await redditClient
    .getModNotes({
      subreddit: target.subredditName,
      user: target.authorName,
      filter: 'NOTE',
      limit: 25,
    })
    .all();

  return notes.some((modNote) =>
    modNoteMatchesExisting(modNote, note, label, targetId, referenceActivity)
  );
};

const getAuthorModNoteSnapshots = async (
  redditClient: RedditActionClient,
  target: AuthoredThing
): Promise<ModNoteSnapshot[]> => {
  const notes = await redditClient
    .getModNotes({
      subreddit: target.subredditName,
      user: target.authorName,
      filter: 'NOTE',
      limit: 100,
    })
    .all();

  return notes.map(snapshotFromModNote);
};

const existingModNoteCheckPasses = async (
  redditClient: RedditActionClient,
  target: AuthoredThing,
  rawExistingNoteCheck: unknown,
  note: string,
  label: string | undefined,
  targetId: T1 | T3,
  referenceActivity: boolean
): Promise<{ passed: boolean; reason?: string } | { error: string }> => {
  if (rawExistingNoteCheck === false) {
    return { passed: true };
  }

  if (rawExistingNoteCheck === undefined || rawExistingNoteCheck === true) {
    const exists = await hasExistingModNote(
      redditClient,
      target,
      note,
      label,
      targetId,
      referenceActivity
    );
    return exists
      ? {
          passed: false,
          reason: 'matching modnote already exists for this activity',
        }
      : { passed: true };
  }

  if (!isRecord(rawExistingNoteCheck)) {
    return { error: 'modnote existingNoteCheck must be a boolean or object' };
  }

  const evaluation = evaluateModNoteCriteria(
    await getAuthorModNoteSnapshots(redditClient, target),
    rawExistingNoteCheck,
    targetId
  );
  if (!evaluation.supported) {
    return { error: evaluation.reason };
  }

  return evaluation.passed
    ? { passed: true, reason: evaluation.reason }
    : {
        passed: false,
        reason: `modnote existingNoteCheck criteria did not pass: ${evaluation.reason}`,
      };
};

const getModNoteOptions = async (
  redditClient: RedditActionClient,
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources
): Promise<Parameters<RedditClient['addModNote']>[0] | { error: string }> => {
  if (!hasAuthorAndSubreddit(target)) {
    return { error: 'target author and subreddit are required for modnote' };
  }

  const note = await getFirstResolvedRenderedStringConfigValue(
    action,
    ['content', 'note'],
    target,
    targetId,
    resources
  );
  if ('error' in note) {
    return note;
  }
  if (note.value === undefined) {
    return { error: 'modnote content is required' };
  }

  const rawLabel =
    getStringConfigValue(action, 'type') ?? getStringConfigValue(action, 'label');
  if (rawLabel !== undefined && !isModNoteLabel(rawLabel)) {
    return { error: 'modnote type is not supported by Reddit mod notes' };
  }

  const referenceActivity = action.config?.referenceActivity !== false;
  const existingNoteCheck = action.config?.existingNoteCheck;
  const existingNoteCheckResult = await existingModNoteCheckPasses(
    redditClient,
    target,
    existingNoteCheck,
    note.value,
    rawLabel,
    targetId,
    referenceActivity
  );
  if ('error' in existingNoteCheckResult) {
    return { error: existingNoteCheckResult.error };
  }
  if (!existingNoteCheckResult.passed) {
    return {
      error:
        existingNoteCheckResult.reason ??
        'modnote existingNoteCheck criteria did not pass',
    };
  }

  return {
    subreddit: target.subredditName,
    user: target.authorName,
    note: truncate(note.value, MOD_NOTE_MAX_LENGTH),
    ...(rawLabel === undefined ? {} : { label: rawLabel }),
    ...(referenceActivity ? { redditId: targetId } : {}),
  };
};

const getUserNoteExistingCriteria = (
  action: PlannedAction,
  noteType: string,
  noteText: string
): unknown | undefined | { error: string } => {
  if (action.config?.allowDuplicate === true) {
    return undefined;
  }

  const existingNoteCheck = action.config?.existingNoteCheck;
  if (existingNoteCheck === false) {
    return undefined;
  }

  if (existingNoteCheck !== undefined && existingNoteCheck !== true) {
    return isRecord(existingNoteCheck)
      ? existingNoteCheck
      : { error: 'usernote existingNoteCheck must be a boolean or object' };
  }

  return {
    type: noteType,
    ...(noteText.length === 0 ? {} : { note: [noteText] }),
    search: 'current',
    count: '< 1',
  };
};

const executeUserNoteAction = async (
  redditClient: RedditActionClient,
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources
): Promise<ActionExecutionResult> => {
  if (!hasAuthorAndSubreddit(target)) {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: 'target author and subreddit are required for usernote',
    };
  }

  const noteType = getRenderedStringConfigValue(
    action,
    'type',
    target,
    targetId,
    resources
  );
  if (noteType === undefined) {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: 'usernote type is required',
    };
  }

  const noteContent = await getFirstResolvedRenderedStringConfigValue(
    action,
    ['content', 'note'],
    target,
    targetId,
    resources
  );
  if ('error' in noteContent) {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: noteContent.error,
    };
  }

  const wikiPage = await redditClient.getWikiPage(
    target.subredditName,
    'usernotes'
  );
  const noteText = noteContent.value ?? '';
  const existingCriteria = getUserNoteExistingCriteria(
    action,
    noteType,
    noteText
  );
  if (isRecord(existingCriteria) && typeof existingCriteria.error === 'string') {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: existingCriteria.error,
    };
  }

  if (existingCriteria !== undefined) {
    const existingNotes = getToolboxUserNotesForAuthor(
      wikiPage.content,
      target.authorName
    );
    const existingCheckPassed = evaluateToolboxUserNoteCriteria(
      existingNotes,
      existingCriteria,
      targetId
    );
    if (existingCheckPassed !== true) {
      return {
        ...getActionName(action),
        status: 'skipped',
        reason:
          existingCheckPassed === false
            ? 'usernote existingNoteCheck criteria did not pass'
            : 'usernote existingNoteCheck criteria could not be evaluated',
      };
    }
  }

  const currentUsername =
    (await redditClient.getCurrentUsername()) ?? 'ContextMod';
  const item = target as TemplatableThing;
  const updated = addToolboxUserNote(wikiPage.content, {
    username: target.authorName,
    moderatorName: currentUsername,
    noteType,
    noteText,
    activityId: targetId,
    activityKind: isT3(targetId) ? 'submission' : 'comment',
    ...(hasPostId(target) ? { postId: target.postId } : {}),
    ...(item.permalink === undefined ? {} : { permalink: item.permalink }),
  });

  await redditClient.updateWikiPage({
    subredditName: target.subredditName,
    page: 'usernotes',
    content: updated.content,
    reason: updated.wikiReason,
  });

  return {
    ...getActionName(action),
    status: 'executed',
    reason: `added Toolbox usernote (${noteType})`,
  };
};

const normalizeMessageRecipient = (
  rawRecipient: string
): string | undefined => {
  const recipient = rawRecipient.trim();
  const subredditMatch = recipient.match(/^\/?r\/([A-Za-z0-9_]+)$/);
  if (subredditMatch?.[1] !== undefined) {
    return `/r/${subredditMatch[1]}`;
  }

  const userMatch = recipient.match(/^(?:\/?u\/)?([A-Za-z0-9_-]+)$/);
  return userMatch?.[1];
};

const getMessageDelivery = async (
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources
): Promise<MessageDelivery | { error: string }> => {
  if (!hasAuthorAndSubreddit(target)) {
    return { error: 'target author and subreddit are required for message' };
  }

  const content = await getResolvedRenderedStringConfigValue(
    action,
    'content',
    target,
    targetId,
    resources
  );
  if ('error' in content) {
    return content;
  }
  if (content.value === undefined) {
    return { error: 'message content is required' };
  }
  const contentWithFooter = await appendActionFooter(
    content.value,
    action,
    target,
    targetId,
    resources
  );
  if ('error' in contentWithFooter) {
    return contentWithFooter;
  }
  const renderedContent = contentWithFooter.value ?? content.value;

  const recipient = await getResolvedRenderedStringConfigValue(
    action,
    'to',
    target,
    targetId,
    resources
  );
  if ('error' in recipient) {
    return recipient;
  }

  const rawRecipient = recipient.value ?? target.authorName;
  const to = normalizeMessageRecipient(rawRecipient);
  if (to === undefined) {
    return { error: 'message to must be a username or r/subreddit' };
  }
  if (action.config?.asSubreddit === true && to.startsWith('/r/')) {
    return {
      error: 'message asSubreddit cannot target another subreddit',
    };
  }

  const subject = await getResolvedRenderedStringConfigValue(
    action,
    'title',
    target,
    targetId,
    resources
  );
  if ('error' in subject) {
    return subject;
  }

  const renderedSubject =
    subject.value ?? `Concerning your ${isT3(targetId) ? 'Submission' : 'Comment'}`;

  return action.config?.asSubreddit === true
    ? {
        kind: 'subreddit',
        recipient: to,
        archive: action.config?.archive === true,
        options: {
          subredditName: target.subredditName,
          subject: renderedSubject,
          body: renderedContent,
          to,
          isAuthorHidden: action.config?.isAuthorHidden !== false,
        },
      }
    : {
        kind: 'private',
        options: {
          to,
          subject: renderedSubject,
          text: renderedContent,
        },
      };
};

const canLock = (target: ReportableThing): target is LockableThing =>
  'lock' in target && typeof target.lock === 'function';

const getTargetBooleanState = (
  target: unknown,
  key: keyof StateBackedThing
): boolean | undefined => {
  if (!isRecord(target)) {
    return undefined;
  }

  const value = target[key];
  return typeof value === 'boolean' ? value : undefined;
};

const canReplyToComment = (
  target: ReportableThing
): target is CommentReplyTarget =>
  'reply' in target && typeof target.reply === 'function';

const canAddCommentToPost = (
  target: ReportableThing
): target is PostCommentTarget =>
  'addComment' in target && typeof target.addComment === 'function';

const hasPostId = (target: ReportableThing): target is CommentWithPostTarget =>
  'postId' in target &&
  typeof target.postId === 'string' &&
  isT3(target.postId);

const getUnsupportedCommentKeys = (action: PlannedAction): string[] =>
  COMMENT_UNSUPPORTED_KEYS.filter(
    (key) => action.config?.[key] === true
  );

type CommentTarget =
  | 'self'
  | 'parent'
  | {
      kind: 'permalink';
      rawTarget: string;
      targetId: T1 | T3;
    };
type ApproveTarget = 'self' | 'parent';
type DispatchTarget = 'self' | 'parent';
type CancelDispatchTarget = DispatchTarget | 'any';
type ResolvedActionTarget = {
  label: string;
  targetId: T1 | T3;
};
type ResolvedSubmissionTarget = {
  label: string;
  subredditName: string;
};
type ResolvedSubmissionPostOptions = {
  options: Parameters<RedditClient['submitPost']>[0];
  postType: 'self' | 'link';
  ignoredLinkBody: boolean;
};

const normalizeSubredditName = (value: string): string =>
  value.trim().replace(/^\/?r\//i, '').toLowerCase();

const getCurrentSubredditName = (
  target: ReportableThing,
  resources: ActionExecutionResources
): string | undefined => {
  const subredditName =
    resources.subredditName?.trim() ?? getTargetSubredditName(target);
  return subredditName === undefined || subredditName.length === 0
    ? undefined
    : subredditName;
};

const getCommentTargets = (
  action: PlannedAction
): CommentTarget[] | { error: string } => {
  const rawTargets = action.config?.targets;
  if (rawTargets === undefined) {
    return ['self'];
  }

  const targets = Array.isArray(rawTargets) ? rawTargets : [rawTargets];
  if (targets.length === 0) {
    return { error: 'comment targets must include self or parent' };
  }

  const resolvedTargets: CommentTarget[] = [];
  for (const target of targets) {
    if (target === 'self' || target === 'parent') {
      resolvedTargets.push(target);
      continue;
    }

    if (typeof target !== 'string') {
      return {
        error:
          'comment target must be self, parent, a thing id, or a reddit permalink',
      };
    }

    const targetId = parseRedditThingId(target);
    if (targetId === undefined) {
      return {
        error: `comment target could not be parsed as self, parent, or reddit permalink: ${target}`,
      };
    }

    resolvedTargets.push({
      kind: 'permalink',
      rawTarget: target,
      targetId,
    });
  }

  return resolvedTargets;
};

const normalizeActionTargets = (
  rawTargets: unknown,
  allowedTargets: readonly string[]
): string[] | { error: string } => {
  if (rawTargets === undefined) {
    return ['self'];
  }

  const targets = Array.isArray(rawTargets) ? rawTargets : [rawTargets];
  if (targets.length === 0) {
    return { error: 'target must include at least one value' };
  }

  if (
    targets.some(
      (target) =>
        typeof target !== 'string' || !allowedTargets.includes(target)
    )
  ) {
    return {
      error: `target must be one of: ${allowedTargets.join(', ')}`,
    };
  }

  return targets;
};

const getApproveTargets = (
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3
): ResolvedActionTarget[] | { error: string } => {
  const targets = normalizeActionTargets(action.config?.targets, [
    'self',
    'parent',
  ]);
  if (!Array.isArray(targets)) {
    return targets;
  }

  if (isT3(targetId)) {
    return [{ label: 'self', targetId }];
  }

  const resolved: ResolvedActionTarget[] = [];
  const seen = new Set<string>();
  for (const rawTarget of targets as ApproveTarget[]) {
    let resolvedTarget: ResolvedActionTarget;
    if (rawTarget === 'parent') {
      if (!hasPostId(target)) {
        return { error: 'target parent post is unavailable for approve' };
      }
      resolvedTarget = { label: 'parent', targetId: target.postId };
    } else {
      resolvedTarget = { label: 'self', targetId };
    }

    if (!seen.has(resolvedTarget.targetId)) {
      resolved.push(resolvedTarget);
      seen.add(resolvedTarget.targetId);
    }
  }

  return resolved;
};

const getApproveTargetApprovedState = async (
  redditClient: RedditActionClient,
  target: ReportableThing,
  approveTarget: ResolvedActionTarget
): Promise<boolean | undefined> => {
  if (approveTarget.label === 'self') {
    return getTargetBooleanState(target, 'approved');
  }
  if (!isT3(approveTarget.targetId)) {
    return undefined;
  }

  try {
    const parentPost = await redditClient.getPostById(approveTarget.targetId);
    return getTargetBooleanState(parentPost, 'approved');
  } catch {
    return undefined;
  }
};

const getDispatchTargets = (
  action: PlannedAction
): DispatchTarget[] | { error: string } => {
  const targets = normalizeActionTargets(action.config?.target, [
    'self',
    'parent',
  ]);
  if (!Array.isArray(targets)) {
    return targets;
  }

  return targets.map((target) => (target === 'parent' ? 'parent' : 'self'));
};

const getCancelDispatchTargets = (
  action: PlannedAction
): CancelDispatchTarget[] | { error: string } => {
  const targets = normalizeActionTargets(action.config?.target, [
    'self',
    'parent',
    'any',
  ]);
  if (!Array.isArray(targets)) {
    return targets;
  }

  return targets.map((target) =>
    target === 'parent' ? 'parent' : target === 'any' ? 'any' : 'self'
  );
};

const getSubmissionTargets = (
  action: PlannedAction,
  target: ReportableThing,
  resources: ActionExecutionResources
): ResolvedSubmissionTarget[] | { error: string } => {
  const currentSubredditName = getCurrentSubredditName(target, resources);
  if (currentSubredditName === undefined) {
    return { error: 'target subreddit is required for submission' };
  }

  const rawTargets = action.config?.targets ?? action.config?.target;
  const targets = rawTargets === undefined
    ? ['self']
    : Array.isArray(rawTargets)
      ? rawTargets
      : [rawTargets];
  if (targets.length === 0) {
    return { error: 'submission targets must include self or current subreddit' };
  }

  const currentSubredditKey = normalizeSubredditName(currentSubredditName);
  const resolvedTargets: ResolvedSubmissionTarget[] = [];
  const seenSubreddits = new Set<string>();

  for (const rawTarget of targets) {
    if (typeof rawTarget !== 'string' || rawTarget.trim().length === 0) {
      return { error: 'submission targets must be non-empty strings' };
    }

    const rawTargetName = rawTarget.trim();
    const targetSubredditKey =
      rawTargetName === 'self'
        ? currentSubredditKey
        : normalizeSubredditName(rawTargetName);

    if (targetSubredditKey !== currentSubredditKey) {
      return {
        error: `submission targets outside the current subreddit are not ported: ${rawTargetName}`,
      };
    }

    if (!seenSubreddits.has(targetSubredditKey)) {
      const subredditName =
        targetSubredditKey === currentSubredditKey
          ? currentSubredditName
          : rawTargetName.replace(/^\/?r\//, '');
      resolvedTargets.push({
        label: rawTargetName === 'self' ? 'self' : `r/${subredditName}`,
        subredditName,
      });
      seenSubreddits.add(targetSubredditKey);
    }
  }

  return resolvedTargets;
};

const getSubmissionPostOptions = async (
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3,
  subredditName: string,
  resources: ActionExecutionResources
): Promise<ResolvedSubmissionPostOptions | { error: string }> => {
  const title = await getResolvedRenderedStringConfigValue(
    action,
    'title',
    target,
    targetId,
    resources
  );
  if ('error' in title) {
    return title;
  }
  if (title.value === undefined) {
    return { error: 'submission title is required' };
  }

  const body = await getFirstResolvedRenderedStringConfigValue(
    action,
    ['content', 'body', 'text'],
    target,
    targetId,
    resources
  );
  if ('error' in body) {
    return body;
  }
  const bodyWithFooter =
    body.value === undefined
      ? body
      : await appendActionFooter(body.value, action, target, targetId, resources);
  if ('error' in bodyWithFooter) {
    return bodyWithFooter;
  }

  const url = await getResolvedRenderedStringConfigValue(
    action,
    'url',
    target,
    targetId,
    resources
  );
  if ('error' in url) {
    return url;
  }

  const flairId = getFirstRenderedStringConfigValue(
    action,
    ['flairId', 'flair_id', 'flairTemplateId', 'flair_template_id'],
    target,
    targetId,
    resources
  );
  const flairText = getFirstRenderedStringConfigValue(
    action,
    ['flairText', 'flair_text'],
    target,
    targetId,
    resources
  );
  const rawNsfw = action.config?.nsfw;
  const rawSpoiler = action.config?.spoiler;
  const rawSendReplies = action.config?.sendreplies ?? action.config?.sendReplies;
  const commonOptions = {
    subredditName,
    title: title.value,
    ...(typeof rawNsfw === 'boolean' ? { nsfw: rawNsfw } : {}),
    ...(typeof rawSpoiler === 'boolean' ? { spoiler: rawSpoiler } : {}),
    ...(typeof rawSendReplies === 'boolean' ? { sendreplies: rawSendReplies } : {}),
    ...(flairId === undefined ? {} : { flairId }),
    ...(flairText === undefined ? {} : { flairText }),
  };

  if (url.value !== undefined) {
    return {
      options: {
        ...commonOptions,
        url: url.value,
      },
      postType: 'link',
      ignoredLinkBody: bodyWithFooter.value !== undefined,
    };
  }

  return {
    options: {
      ...commonOptions,
      text: bodyWithFooter.value ?? '',
    },
    postType: 'self',
    ignoredLinkBody: false,
  };
};

const getDispatchDelayMs = (action: PlannedAction): number | { error: string } => {
  const rawDelay = action.config?.delay;
  if (rawDelay === undefined) {
    return 0;
  }

  if (typeof rawDelay === 'number' && Number.isFinite(rawDelay)) {
    return Math.max(0, Math.floor(rawDelay));
  }

  const parsed = parseDurationComparison(rawDelay);
  if (parsed === undefined) {
    return { error: 'dispatch delay must be a duration such as "10 minutes"' };
  }

  return Math.max(0, Math.floor(parsed.milliseconds));
};

const getDispatchIdentifier = (
  action: PlannedAction
): string | undefined | { error: string } => {
  const rawIdentifier = action.config?.identifier;
  if (rawIdentifier === undefined) {
    return undefined;
  }

  if (typeof rawIdentifier === 'string' && rawIdentifier.trim().length > 0) {
    return rawIdentifier.trim();
  }

  return { error: 'dispatch identifier must be a non-empty string' };
};

const getCancelDispatchIdentifiers = (
  action: PlannedAction
): (string | null)[] | undefined | { error: string } => {
  const rawIdentifier = action.config?.identifier;
  if (rawIdentifier === undefined) {
    return undefined;
  }

  const values = Array.isArray(rawIdentifier) ? rawIdentifier : [rawIdentifier];
  const identifiers: (string | null)[] = [];
  for (const value of values) {
    if (value === null) {
      identifiers.push(null);
      continue;
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      identifiers.push(value.trim());
      continue;
    }

    return {
      error: 'cancelDispatch identifier must be a string, null, or array of those values',
    };
  }

  return identifiers.length === 0 ? undefined : identifiers;
};

const getDispatchTargetInfo = (
  dispatchTarget: DispatchTarget,
  target: ReportableThing,
  targetId: T1 | T3
):
  | {
      targetId: T1 | T3;
      activityKind: ActivitySnapshot['kind'];
      label: string;
    }
  | { error: string } => {
  if (dispatchTarget === 'parent') {
    if (isT3(targetId)) {
      return { error: 'submission target has no parent dispatch target' };
    }

    if (!hasPostId(target)) {
      return { error: 'target parent post is unavailable for dispatch' };
    }

    return {
      targetId: target.postId,
      activityKind: 'submission',
      label: 'parent submission',
    };
  }

  return {
    targetId,
    activityKind: isT3(targetId) ? 'submission' : 'comment',
    label: 'self',
  };
};

const getCancelDispatchTargetId = (
  cancelTarget: CancelDispatchTarget,
  target: ReportableThing,
  targetId: T1 | T3
): string | undefined | { error: string } => {
  if (cancelTarget === 'any') {
    return undefined;
  }

  if (cancelTarget === 'parent') {
    if (isT3(targetId)) {
      return { error: 'submission target has no parent dispatch target' };
    }

    if (!hasPostId(target)) {
      return { error: 'target parent post is unavailable for dispatch' };
    }

    return target.postId;
  }

  return targetId;
};

const getActionName = (
  action: PlannedAction
): Pick<ActionExecutionResult, 'kind' | 'name'> => ({
  kind: action.kind,
  ...(action.name === undefined ? {} : { name: action.name }),
});

const executeCommentAction = async (
  redditClient: RedditActionClient,
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources
): Promise<ActionExecutionResult> => {
  const content = await getResolvedRenderedStringConfigValue(
    action,
    'content',
    target,
    targetId,
    resources
  );
  if ('error' in content) {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: content.error,
    };
  }
  if (content.value === undefined || content.value.trim().length === 0) {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: 'comment content is required',
    };
  }
  const contentWithFooter = await appendActionFooter(
    content.value,
    action,
    target,
    targetId,
    resources
  );
  if ('error' in contentWithFooter) {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: contentWithFooter.error,
    };
  }
  const renderedContent = contentWithFooter.value ?? content.value;

  const unsupportedKeys = getUnsupportedCommentKeys(action);
  if (unsupportedKeys.length > 0) {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: `comment options are not ported on Devvit: ${unsupportedKeys.join(', ')}`,
    };
  }

  const commentTargets = getCommentTargets(action);
  if (!Array.isArray(commentTargets)) {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: commentTargets.error,
    };
  }

  const createdTargets: string[] = [];
  const createdIds: string[] = [];
  const createdPermalinks: string[] = [];
  const modifierResults: string[] = [];
  if (commentTargets.includes('parent') && canAddCommentToPost(target)) {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: 'submission target has no parent',
    };
  }
  if (
    commentTargets.includes('parent') &&
    !hasPostId(target)
  ) {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: 'target parent post is unavailable',
    };
  }

  for (const commentTarget of commentTargets) {
    let createdComment: CreatedComment;

    if (commentTarget === 'self' && canReplyToComment(target)) {
      createdComment = await target.reply({ text: renderedContent });
      createdTargets.push('comment reply');
    } else if (commentTarget === 'self' && canAddCommentToPost(target)) {
      createdComment = await target.addComment({ text: renderedContent });
      createdTargets.push('top-level comment');
    } else if (commentTarget === 'parent' && hasPostId(target)) {
      const post = await redditClient.getPostById(target.postId);
      createdComment = await post.addComment({ text: renderedContent });
      createdTargets.push('parent top-level comment');
    } else if (typeof commentTarget === 'object') {
      try {
        if (isT1(commentTarget.targetId)) {
          const comment = await redditClient.getCommentById(commentTarget.targetId);
          createdComment = await comment.reply({ text: renderedContent });
          createdTargets.push(`permalink comment ${commentTarget.targetId}`);
        } else {
          const post = await redditClient.getPostById(commentTarget.targetId);
          createdComment = await post.addComment({ text: renderedContent });
          createdTargets.push(`permalink submission ${commentTarget.targetId}`);
        }
      } catch (error) {
        return {
          ...getActionName(action),
          status: 'skipped',
          reason: `unable to resolve comment permalink target ${commentTarget.rawTarget}: ${getErrorMessage(
            error
          )}`,
        };
      }
    } else {
      return {
        ...getActionName(action),
        status: 'skipped',
        reason: 'target does not support comment replies',
      };
    }

    if (typeof createdComment.id === 'string') {
      createdIds.push(createdComment.id);
    }
    if (typeof createdComment.permalink === 'string') {
      createdPermalinks.push(createdComment.permalink);
    }

    if (action.config?.lock === true) {
      if (typeof createdComment.lock !== 'function') {
        modifierResults.push('lock skipped: reply does not support lock');
      } else {
        await createdComment.lock();
        modifierResults.push('locked');
      }
    }

    const shouldDistinguish =
      action.config?.distinguish === true ||
      action.config?.sticky === true ||
      action.config?.asModTeam === true;
    if (shouldDistinguish) {
      if (typeof createdComment.distinguish !== 'function') {
        modifierResults.push(
          'distinguish skipped: reply does not support distinguish'
        );
      } else {
        await createdComment.distinguish(action.config?.sticky === true);
        modifierResults.push(
          action.config?.sticky === true
            ? 'distinguished and stickied'
            : 'distinguished'
        );
      }
    }
  }

  const reason = [
    `created ${createdTargets.join(', ')}`,
    ...modifierResults,
  ].join('; ');
  return {
    ...getActionName(action),
    status: 'executed',
    reason,
    ...(createdIds.length === 0 ? {} : { targetId: createdIds.join(', ') }),
    ...(createdPermalinks.length === 0
      ? {}
      : { permalink: createdPermalinks.join(', ') }),
  };
};

const executeSubmissionAction = async (
  redditClient: RedditActionClient,
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources
): Promise<ActionExecutionResult> => {
  const submissionTargets = getSubmissionTargets(action, target, resources);
  if (!Array.isArray(submissionTargets)) {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: submissionTargets.error,
    };
  }

  const createdPosts: string[] = [];
  const createdPostIds: string[] = [];
  const modifierResults: string[] = [];
  for (const submissionTarget of submissionTargets) {
    const postOptions = await getSubmissionPostOptions(
      action,
      target,
      targetId,
      submissionTarget.subredditName,
      resources
    );
    if ('error' in postOptions) {
      return {
        ...getActionName(action),
        status: 'skipped',
        reason: postOptions.error,
      };
    }

    const post = (await redditClient.submitPost(
      postOptions.options
    )) as CreatedPost;
    if (typeof post.id === 'string') {
      createdPostIds.push(post.id);
    }
    createdPosts.push(
      `${postOptions.postType} post in ${submissionTarget.label}${
        post.id === undefined ? '' : ` (${post.id})`
      }`
    );
    if (postOptions.ignoredLinkBody) {
      modifierResults.push('link post body ignored by Devvit submitPost');
    }

    if (action.config?.lock === true) {
      if (typeof post.lock !== 'function') {
        modifierResults.push('lock skipped: created post does not support lock');
      } else {
        await post.lock();
        modifierResults.push('locked');
      }
    }

    if (action.config?.distinguish === true || action.config?.sticky === true) {
      if (typeof post.distinguish !== 'function') {
        modifierResults.push(
          'distinguish skipped: created post does not support distinguish'
        );
      } else {
        await post.distinguish();
        modifierResults.push('distinguished');
      }
    }

    if (action.config?.sticky === true) {
      if (typeof post.sticky !== 'function') {
        modifierResults.push('sticky skipped: created post does not support sticky');
      } else {
        await post.sticky();
        modifierResults.push('stickied');
      }
    }
  }

  return {
    ...getActionName(action),
    status: 'executed',
    reason: [`created ${createdPosts.join(', ')}`, ...modifierResults].join('; '),
    ...(createdPostIds.length === 0 ? {} : { targetId: createdPostIds.join(', ') }),
  };
};

const executeDispatchAction = async (
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources
): Promise<ActionExecutionResult> => {
  if (resources.dispatchQueue === undefined) {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: 'dispatch queue resources are unavailable',
    };
  }

  const delayMs = getDispatchDelayMs(action);
  if (typeof delayMs !== 'number') {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: delayMs.error,
    };
  }

  const identifier = getDispatchIdentifier(action);
  if (typeof identifier === 'object') {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: identifier.error,
    };
  }

  const targets = getDispatchTargets(action);
  if (!Array.isArray(targets)) {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: targets.error,
    };
  }

  const goto = getStringConfigValue(action, 'goto');
  const onExistingFound =
    action.config?.onExistingFound === 'skip' ||
    action.config?.onExistingFound === 'replace'
      ? action.config.onExistingFound
      : 'ignore';
  const queued: DispatchQueueRecord[] = [];
  const skipped: string[] = [];
  const replaced: number[] = [];
  const replacedSchedulerJobIds = new Set<string>();
  const scheduled: string[] = [];

  for (const dispatchTarget of targets) {
    const targetInfo = getDispatchTargetInfo(dispatchTarget, target, targetId);
    if ('error' in targetInfo) {
      skipped.push(targetInfo.error);
      continue;
    }

    const match = {
      targetId: targetInfo.targetId,
      ...(identifier === undefined ? {} : { identifiers: [identifier] }),
    };
    const existing = await findDispatchRecords(
      resources.dispatchQueue.redisClient,
      match
    );
    if (existing.length > 0 && onExistingFound === 'skip') {
      skipped.push(
        `${targetInfo.label} already has ${existing.length} dispatch record(s)`
      );
      continue;
    }

    if (existing.length > 0 && onExistingFound === 'replace') {
      const canceled = await cancelDispatchRecords(
        resources.dispatchQueue.redisClient,
        match
      );
      replaced.push(canceled.length);
      for (const record of canceled) {
        if (record.schedulerJobId !== undefined) {
          replacedSchedulerJobIds.add(record.schedulerJobId);
        }
      }
    }

    const record = await enqueueDispatchRecord(
      resources.dispatchQueue.redisClient,
      {
        activity: resources.dispatchQueue.activity,
        activityKind: targetInfo.activityKind,
        delayMs,
        ...(action.config?.dryRun === true ? { dryRun: true } : {}),
        ...(goto === undefined ? {} : { goto }),
        ...(identifier === undefined ? {} : { identifier }),
        subredditName: resources.dispatchQueue.activity.subredditName,
        targetId: targetInfo.targetId,
      },
      resources.dispatchQueue.now === undefined
        ? {}
        : { now: resources.dispatchQueue.now() }
    );
    queued.push(record);

    if (resources.schedulerClient !== undefined) {
      const schedulerJobId = await resources.schedulerClient.runJob({
        name: DISPATCH_SCHEDULER_JOB_NAME,
        data: { dispatchId: record.id },
        runAt: new Date(record.runAt),
      });
      await setDispatchSchedulerJobId(
        resources.dispatchQueue.redisClient,
        record.id,
        schedulerJobId
      );
      scheduled.push(schedulerJobId);
    }
  }

  if (resources.schedulerClient !== undefined) {
    for (const schedulerJobId of replacedSchedulerJobIds) {
      await resources.schedulerClient.cancelJob(schedulerJobId);
    }
  }

  if (queued.length === 0) {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason:
        skipped.length === 0
          ? 'no dispatch records were queued'
          : skipped.join('; '),
    };
  }

  const replacedCount = replaced.reduce((total, count) => total + count, 0);
  const details = [
    `queued ${queued.length} dispatch record(s)`,
    `delay ${delayMs}ms`,
    ...(identifier === undefined ? [] : [`identifier ${identifier}`]),
    ...(goto === undefined ? [] : [`goto ${goto}`]),
    ...(replacedCount === 0 ? [] : [`replaced ${replacedCount}`]),
    scheduled.length === 0
      ? 'scheduler execution pending'
      : `scheduled ${scheduled.length} Devvit job(s)`,
  ];

  return {
    ...getActionName(action),
    status: 'executed',
    reason: details.join('; '),
  };
};

const executeCancelDispatchAction = async (
  action: PlannedAction,
  target: ReportableThing,
  targetId: T1 | T3,
  resources: ActionExecutionResources
): Promise<ActionExecutionResult> => {
  if (resources.dispatchQueue === undefined) {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: 'dispatch queue resources are unavailable',
    };
  }

  const targets = getCancelDispatchTargets(action);
  if (!Array.isArray(targets)) {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: targets.error,
    };
  }

  const identifiers = getCancelDispatchIdentifiers(action);
  if (typeof identifiers === 'object' && 'error' in identifiers) {
    return {
      ...getActionName(action),
      status: 'skipped',
      reason: identifiers.error,
    };
  }

  const canceledIds = new Set<string>();
  const canceledSchedulerJobIds = new Set<string>();
  for (const cancelTarget of targets) {
    const targetIdMatch = getCancelDispatchTargetId(
      cancelTarget,
      target,
      targetId
    );
    if (typeof targetIdMatch === 'object') {
      return {
        ...getActionName(action),
        status: 'skipped',
        reason: targetIdMatch.error,
      };
    }

    const canceled = await cancelDispatchRecords(
      resources.dispatchQueue.redisClient,
      {
        ...(targetIdMatch === undefined ? {} : { targetId: targetIdMatch }),
        ...(identifiers === undefined ? {} : { identifiers }),
      }
    );
    for (const record of canceled) {
      canceledIds.add(record.id);
      if (record.schedulerJobId !== undefined) {
        canceledSchedulerJobIds.add(record.schedulerJobId);
      }
    }
  }

  if (resources.schedulerClient !== undefined) {
    for (const schedulerJobId of canceledSchedulerJobIds) {
      await resources.schedulerClient.cancelJob(schedulerJobId);
    }
  }

  return {
    ...getActionName(action),
    status: 'executed',
    reason:
      canceledIds.size === 0
        ? 'no dispatch records matched'
        : `canceled ${canceledIds.size} dispatch record(s)${
            canceledSchedulerJobIds.size === 0
              ? ''
              : ` and ${canceledSchedulerJobIds.size} scheduler job(s)`
          }`,
  };
};

export const executePlannedActions = async (
  redditClient: RedditActionClient,
  target: ReportableThing,
  targetId: T1 | T3,
  actions: PlannedAction[],
  runtime: ActionRuntimeSettings,
  resources: ActionExecutionResources = {}
): Promise<ActionExecutionSummary> => {
  const results: ActionExecutionResult[] = [];

  for (const action of actions) {
    // Make prior results available to template rendering in subsequent actions
    const actionResources = { ...resources, actionResults: [...results] };
    if (!runtime.appEnabled) {
      results.push({
        ...getActionName(action),
        status: 'skipped',
        reason: 'app setting enabled is false',
      });
      continue;
    }

    if (runtime.dryRun) {
      results.push({
        ...getActionName(action),
        status: 'skipped',
        reason: 'app setting dryRun is true',
      });
      continue;
    }

    if (!action.enabled) {
      results.push({
        ...getActionName(action),
        status: 'skipped',
        reason: 'action is disabled in config',
      });
      continue;
    }

    if (action.config?.dryRun === true) {
      results.push({
        ...getActionName(action),
        status: 'skipped',
        reason: 'action dryRun is true',
      });
      continue;
    }

    if (action.supported === false) {
      results.push({
        ...getActionName(action),
        status: 'skipped',
        reason: 'planned action is blocked because check/filter evaluation was unsupported',
      });
      continue;
    }

    try {
      if (action.kind === 'approve') {
        const approveTargets = getApproveTargets(action, target, targetId);
        if (!Array.isArray(approveTargets)) {
          results.push({
            ...getActionName(action),
            status: 'skipped',
            reason: approveTargets.error,
          });
          continue;
        }

        const approvedLabels: string[] = [];
        const skippedLabels: string[] = [];
        for (const approveTarget of approveTargets) {
          const approvedState = await getApproveTargetApprovedState(
            redditClient,
            target,
            approveTarget
          );
          if (approvedState === true) {
            skippedLabels.push(`${approveTarget.label} already approved`);
            continue;
          }

          await redditClient.approve(approveTarget.targetId);
          approvedLabels.push(approveTarget.label);
        }

        if (approvedLabels.length === 0) {
          results.push({
            ...getActionName(action),
            status: 'skipped',
            reason: skippedLabels.join(', '),
          });
          continue;
        }

        results.push({
          ...getActionName(action),
          status: 'executed',
          reason: [
            `approved ${approvedLabels.join(', ')}`,
            ...(skippedLabels.length === 0
              ? []
              : [`skipped ${skippedLabels.join(', ')}`]),
          ].join('; '),
        });
        continue;
      }

      if (action.kind === 'ban') {
        const options = await getBanOptions(action, target, targetId, actionResources);
        if ('error' in options) {
          results.push({
            ...getActionName(action),
            status: 'skipped',
            reason: options.error,
          });
          continue;
        }

        await redditClient.banUser(options);
        results.push({
          ...getActionName(action),
          status: 'executed',
          reason:
            options.duration === undefined
              ? `banned ${options.username} permanently`
              : `banned ${options.username} for ${options.duration} day(s)`,
        });
        continue;
      }

      if (action.kind === 'comment') {
        results.push(
          await executeCommentAction(
            redditClient,
            action,
            target,
            targetId,
            actionResources
          )
        );
        continue;
      }

      if (action.kind === 'cancelDispatch') {
        results.push(
          await executeCancelDispatchAction(action, target, targetId, actionResources)
        );
        continue;
      }

      if (action.kind === 'contributor') {
        const options = getContributorOptions(action, target, actionResources);
        if ('error' in options) {
          results.push({
            ...getActionName(action),
            status: 'skipped',
            reason: options.error,
          });
          continue;
        }

        if (options.action === 'add') {
          await redditClient.approveUser(options.username, options.subredditName);
          results.push({
            ...getActionName(action),
            status: 'executed',
            reason: `added ${options.username} as contributor`,
          });
          continue;
        }

        await redditClient.removeUser(options.username, options.subredditName);
        results.push({
          ...getActionName(action),
          status: 'executed',
          reason: `removed ${options.username} as contributor`,
        });
        continue;
      }

      if (action.kind === 'dispatch') {
        results.push(
          await executeDispatchAction(action, target, targetId, actionResources)
        );
        continue;
      }

      if (action.kind === 'flair') {
        const options = getPostFlairOptions(action, target, targetId, actionResources);
        if ('error' in options) {
          results.push({
            ...getActionName(action),
            status: 'skipped',
            reason: options.error,
          });
          continue;
        }

        await redditClient.setPostFlair(options);
        results.push({
          ...getActionName(action),
          status: 'executed',
          reason: 'set post flair',
        });
        continue;
      }

      if (action.kind === 'modnote') {
        const options = await getModNoteOptions(
          redditClient,
          action,
          target,
          targetId,
          actionResources
        );
        if ('error' in options) {
          results.push({
            ...getActionName(action),
            status: 'skipped',
            reason: options.error,
          });
          continue;
        }

        await redditClient.addModNote(options);
        results.push({
          ...getActionName(action),
          status: 'executed',
          reason: 'added mod note',
        });
        continue;
      }

      if (action.kind === 'message') {
        const delivery = await getMessageDelivery(
          action,
          target,
          targetId,
          resources
        );
        if ('error' in delivery) {
          results.push({
            ...getActionName(action),
            status: 'skipped',
            reason: delivery.error,
          });
          continue;
        }

        if (delivery.kind === 'subreddit') {
          const modMailResponse = await redditClient.modMail.createConversation(
            delivery.options
          );
          results.push({
            ...getActionName(action),
            status: 'executed',
            reason: `sent subreddit message to ${delivery.recipient}`,
          });

          if (delivery.archive && modMailResponse.conversation?.id !== undefined) {
            await redditClient.modMail.archiveConversation(
              modMailResponse.conversation.id
            );
            results.push({
              ...getActionName(action),
              status: 'executed',
              reason: `archived subreddit message to ${delivery.recipient}`,
            });
          }
          continue;
        }

        await redditClient.sendPrivateMessage(delivery.options);
        results.push({
          ...getActionName(action),
          status: 'executed',
          reason: `sent message to ${delivery.options.to}`,
        });
        continue;
      }

      if (action.kind === 'submission') {
        results.push(
          await executeSubmissionAction(
            redditClient,
            action,
            target,
            targetId,
            resources
          )
        );
        continue;
      }

      if (action.kind === 'userflair') {
        const options = getUserFlairOptions(action, target, targetId, resources);
        if ('error' in options) {
          results.push({
            ...getActionName(action),
            status: 'skipped',
            reason: options.error,
          });
          continue;
        }

        if ('remove' in options) {
          await redditClient.removeUserFlair(...options.remove);
          results.push({
            ...getActionName(action),
            status: 'executed',
            reason: 'removed user flair',
          });
          continue;
        }

        await redditClient.setUserFlair(options);
        results.push({
          ...getActionName(action),
          status: 'executed',
          reason: 'set user flair',
        });
        continue;
      }

      if (action.kind === 'usernote') {
        results.push(
          await executeUserNoteAction(
            redditClient,
            action,
            target,
            targetId,
            resources
          )
        );
        continue;
      }

      if (action.kind === 'lock') {
        if (!canLock(target)) {
          results.push({
            ...getActionName(action),
            status: 'skipped',
            reason: 'target does not support lock',
          });
          continue;
        }
        if (getTargetBooleanState(target, 'locked') === true) {
          results.push({
            ...getActionName(action),
            status: 'skipped',
            reason: 'target is already locked',
          });
          continue;
        }

        await target.lock();
        results.push({
          ...getActionName(action),
          status: 'executed',
          reason: 'locked',
        });
        continue;
      }

      if (action.kind === 'remove') {
        const removalNote = await getResolvedRenderedStringConfigValue(
          action,
          'note',
          target,
          targetId,
          actionResources
        );
        if ('error' in removalNote) {
          results.push({
            ...getActionName(action),
            status: 'skipped',
            reason: removalNote.error,
          });
          continue;
        }

        await redditClient.remove(targetId, getRemoveSpamFlag(action));
        const reasonId =
          getRenderedStringConfigValue(
            action,
            'reasonId',
            target,
            targetId,
            actionResources
          ) ??
          '';
        const removalNoteOptions =
          reasonId.length > 0 || removalNote.value !== undefined
            ? {
                itemIds: [targetId],
                reasonId,
                ...(removalNote.value === undefined
                  ? {}
                  : {
                      modNote: truncate(
                        removalNote.value,
                        REMOVAL_NOTE_MAX_LENGTH
                      ),
                    }),
              }
            : undefined;

        if (removalNoteOptions !== undefined) {
          await redditClient.addRemovalNote(removalNoteOptions);
        }

        const reasonParts = [
          getRemoveSpamFlag(action) ? 'removed as spam' : 'removed',
          ...(reasonId.length > 0 ? [`reason ${reasonId}`] : []),
          ...(removalNote.value === undefined ? [] : ['removal note']),
        ];
        results.push({
          ...getActionName(action),
          status: 'executed',
          reason: reasonParts.join('; '),
        });
        continue;
      }

      if (action.kind === 'report') {
        const reason = await getResolvedReportReason(
          action,
          target,
          targetId,
          actionResources
        );
        if ('error' in reason) {
          results.push({
            ...getActionName(action),
            status: 'skipped',
            reason: reason.error,
          });
          continue;
        }

        await redditClient.report(target, {
          reason: reason.value ?? DEFAULT_REPORT_REASON,
        });
        results.push({
          ...getActionName(action),
          status: 'executed',
          reason: `reported: ${reason.value ?? DEFAULT_REPORT_REASON}`,
        });
        continue;
      }

      results.push({
        ...getActionName(action),
        status: 'skipped',
        reason: `${action.kind} execution is not ported in the Devvit migration`,
      });
    } catch (error) {
      results.push({
        ...getActionName(action),
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (
        action.config?.notifyDiscord !== undefined &&
      resources.notificationManager !== undefined
    ) {
      const lastResult = results[results.length - 1];
      if (lastResult !== undefined) {
        const title = `Action ${lastResult.status}: ${lastResult.name ?? action.kind}`;
        const providerName =
          typeof action.config.notifyDiscord === 'string'
            ? action.config.notifyDiscord
            : undefined;

        await resources.notificationManager.send(
          {
            logLevel: lastResult.status === 'failed' ? 'error' : 'info',
            title,
            body: `Reason: ${lastResult.reason}\nTarget: ${targetId}\nSubreddit: ${
              resources.subredditName ?? 'unknown'
            }`,
          },
          providerName
        );
      }
    }
  }
  }

  return {
    appEnabled: runtime.appEnabled,
    dryRun: runtime.dryRun,
    results,
    executed: results.filter((result) => result.status === 'executed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
  };
};

export const summarizeActionExecution = (
  summary: ActionExecutionSummary
): string => {
  if (summary.results.length === 0) {
    return 'No actions to execute.';
  }

  if (!summary.appEnabled) {
    return 'Actions not executed: app is disabled.';
  }

  if (summary.dryRun) {
    return 'Actions not executed: dry run is enabled.';
  }

  return `Action execution: ${summary.executed} executed, ${summary.skipped} skipped, ${summary.failed} failed.`;
};
