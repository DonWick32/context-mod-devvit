import { Hono } from 'hono';
import {
  reddit,
  redis,
  scheduler,
  settings,
  type RedditClient,
} from '@devvit/web/server';
import type {
  OnAppInstallRequest,
  OnCommentSubmitRequest,
  OnPostSubmitRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import {
  ConfigSourceError,
  isWikiPageNotFoundError,
  loadConfiguredLegacyConfig,
} from '../config/configSource';
import {
  snapshotFromComment,
  snapshotFromPost,
} from '../runtime/activityAdapter';
import { processContextModActivity } from '../runtime/contextModProcessor';
import { scheduleNextModerationScan } from '../runtime/moderationScanProcessor';
import {
  isEventProcessingEnabled,
  loadActionRuntimeSettings,
  loadModerationScanRuntimeSettings,
} from '../runtime/runtimeSettings';
import { toCommentThingId, toPostThingId } from '../runtime/thingIds';
import {
  loadWikiPage,
  normalizeSubredditName,
  parseWikiPageReference,
} from '../runtime/wikiPages';

export const triggers = new Hono();

type ReportableThing = Parameters<RedditClient['report']>[0];

const logTriggerError = (label: string, error: unknown) => {
  if (error instanceof ConfigSourceError && error.code === 'missing-config') {
    console.warn(`${label}: ${error.message}`);
    return;
  }

  console.error(`${label}:`, error);
};

const triggerSuccess = () => ({ status: 'success' });

const isAuthoredByApp = async (
  authorName: string | undefined,
  label: string
): Promise<boolean> => {
  if (authorName === undefined || authorName.trim().length === 0) {
    return false;
  }

  try {
    const appUser = await reddit.getAppUser();
    console.log(`[DEBUG] isAuthoredByApp: authorName="${authorName}", appUser="${appUser?.username}"`);
    
    if (!appUser?.username) {
      return false;
    }

    // In playtest environments, the app user's username matches the developer's username (e.g., nitish, DonWick32).
    // In production, the bot user's username is the app name ('hexa-mod') or contains "bot".
    // We only want to skip if the author is the actual production bot to prevent infinite trigger loops.
    const appUsernameLower = appUser.username.toLowerCase();
    const isProductionBot =
      appUsernameLower === 'hexa-mod' ||
      appUsernameLower.includes('bot') ||
      appUsernameLower.includes('context-mod') ||
      appUsernameLower.includes('contextmod');

    if (!isProductionBot) {
      // In development/playtest mode, do not skip posts authored by the developer/app user
      return false;
    }

    return appUsernameLower === authorName.toLowerCase();
  } catch (error) {
    console.warn(`${label}: unable to compare author with app user`, error);
    return false;
  }
};

const processSubmittedThing = async (
  label: string,
  targetId: Parameters<typeof processContextModActivity>[0]['targetId'],
  target: ReportableThing,
  activity: Parameters<typeof processContextModActivity>[0]['activity']
): Promise<void> => {
  const source = await loadConfiguredLegacyConfig();
  const actionRuntime = await loadActionRuntimeSettings();
  const processed = await processContextModActivity({
    source,
    activity,
    target,
    targetId,
    redditClient: reddit,
    redisClient: redis,
    actionRuntime,
    actionSchedulerClient: scheduler,
    configFragmentLoader: reddit,
    actionWikiContentLoader: reddit,
  });

  console.log(`${label}: ${processed.message}`);
  if (processed.ok && processed.auditError !== undefined) {
    console.error(`${label} audit write failed:`, processed.auditError);
  }
};

triggers.post('/on-app-install', async (c) => {
  const input = await c.req.json<OnAppInstallRequest>();
  console.log(
    'ContextMod Devvit installed to subreddit: r/' + input.subreddit?.name
  );

  try {
    const scanSettings = await loadModerationScanRuntimeSettings();
    const scanRecord = await scheduleNextModerationScan(scheduler, redis, {
      intervalMinutes: scanSettings.intervalMinutes,
    });
    console.log(
      `ContextMod moderation scan scheduled for ${scanRecord.runAt}.`
    );
  } catch (error) {
    console.error('ContextMod moderation scan install scheduling failed:', error);
  }

  if (input.subreddit?.name) {
    try {
      const wikiPageSetting = await settings.get<string>('configWikiPage');
      const wikiPageName = wikiPageSetting?.trim() || 'botconfig/contextbot';
      const wikiReference = parseWikiPageReference(
        wikiPageName,
        input.subreddit.name
      );
      if (wikiReference === undefined) {
        console.warn(
          `ContextMod config wiki page setting is invalid: ${wikiPageName}`
        );
        return c.json<TriggerResponse>(triggerSuccess(), 200);
      }

      if (
        normalizeSubredditName(wikiReference.subredditName).toLowerCase() !==
        normalizeSubredditName(input.subreddit.name).toLowerCase()
      ) {
        console.log(
          `ContextMod config wiki page ${wikiReference.pageName} is configured for r/${wikiReference.subredditName}; skipping install-time creation in r/${input.subreddit.name}.`
        );
        return c.json<TriggerResponse>(triggerSuccess(), 200);
      }
      
      try {
        let needsCreation = false;
        try {
          const page = await loadWikiPage(reddit, wikiReference);
          if (!page.content || page.content.trim().length === 0 || page.content.includes('PAGE_NOT_CREATED')) {
            needsCreation = true;
          } else {
            console.log(
              `ContextMod config wiki page already exists at ${wikiReference.pageName}`
            );
          }
        } catch (error) {
          if (isWikiPageNotFoundError(error)) {
            console.log(
              `ContextMod config wiki page ${wikiReference.pageName} does not exist yet.`
            );
            needsCreation = true;
          } else {
            throw error;
          }
        }

        if (needsCreation) {
          console.log(
            `Creating default ContextMod wiki page at ${wikiReference.pageName}...`
          );
          const defaultYaml = `---
# ContextMod Configuration
# See documentation for all available options: https://github.com/FoxxMD/reddit-context-bot
runs:
  - name: "Example Run"
    checks:
      - name: "Example Check"
        kind: comment
        rules:
          - kind: author
            name: "Is new user"
            accountAge: "< 7 days"
        actions:
          - kind: modnote
            type: SPAM_WATCH
            content: "New user comment"
`;

          await reddit.createWikiPage({
            subredditName: input.subreddit.name,
            page: wikiReference.pageName,
            content: defaultYaml,
            reason: 'Initial setup by ContextMod Devvit app',
          });

          console.log(
            `Created ContextMod config wiki page at ${wikiReference.pageName}`
          );
        }
      } catch (error) {
        console.error('Failed to setup config wiki page:', error);
      }
    } catch (error) {
      console.error('Failed to setup config wiki page:', error);
    }
  }

  return c.json<TriggerResponse>(triggerSuccess(), 200);
});

triggers.post('/on-comment-submit', async (c) => {
  const input = await c.req.json<OnCommentSubmitRequest>();
  const targetId = toCommentThingId(input.comment?.id);

  try {
    if (!(await isEventProcessingEnabled())) {
      console.log(
        'ContextMod comment submit skipped: event processing is disabled.'
      );
      return c.json<TriggerResponse>(triggerSuccess(), 200);
    }

    if (targetId === undefined) {
      console.warn(
        'ContextMod comment submit skipped: event has no supported comment id.'
      );
      return c.json<TriggerResponse>(triggerSuccess(), 200);
    }

    if (await isAuthoredByApp(input.author?.name, 'ContextMod comment submit')) {
      console.log(
        'ContextMod comment submit skipped: item was authored by app.'
      );
      return c.json<TriggerResponse>(triggerSuccess(), 200);
    }

    const comment = await reddit.getCommentById(targetId);
    const post = await reddit.getPostById(comment.postId);
    await processSubmittedThing(
      'ContextMod comment submit processed',
      targetId,
      comment,
      snapshotFromComment(comment, { parentPost: post, source: 'poll:newComm' })
    );
  } catch (error) {
    logTriggerError('ContextMod comment submit failed', error);
  }

  return c.json<TriggerResponse>(triggerSuccess(), 200);
});

triggers.post('/on-post-submit', async (c) => {
  const input = await c.req.json<OnPostSubmitRequest>();
  const targetId = toPostThingId(input.post?.id);

  try {
    if (!(await isEventProcessingEnabled())) {
      console.log(
        'ContextMod post submit skipped: event processing is disabled.'
      );
      return c.json<TriggerResponse>(triggerSuccess(), 200);
    }

    if (targetId === undefined) {
      console.warn(
        'ContextMod post submit skipped: event has no supported post id.'
      );
      return c.json<TriggerResponse>(triggerSuccess(), 200);
    }

    if (await isAuthoredByApp(input.author?.name, 'ContextMod post submit')) {
      console.log(
        'ContextMod post submit skipped: item was authored by app.'
      );
      return c.json<TriggerResponse>(triggerSuccess(), 200);
    }

    const post = await reddit.getPostById(targetId);
    await processSubmittedThing(
      'ContextMod post submit processed',
      targetId,
      post,
      snapshotFromPost(post, { source: 'poll:newSub' })
    );
  } catch (error) {
    logTriggerError('ContextMod post submit failed', error);
  }

  return c.json<TriggerResponse>(triggerSuccess(), 200);
});
