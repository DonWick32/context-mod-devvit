import { Hono } from 'hono';
import { isT1, isT3, type T1, type T3 } from '@devvit/shared-types/tid.js';
import {
  context,
  reddit,
  redis,
  scheduler,
  settings,
  type RedditClient,
} from '@devvit/web/server';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import type { FormField } from '@devvit/shared-types/shared/form.js';
import {
  ConfigSourceError,
  loadConfiguredLegacyConfig,
} from '../config/configSource';
import { parseLegacyConfigTextWithWikiIncludes } from '../config/configIncludeHydrator';
import {
  summarizeConfigParseResult,
} from '../config/legacyConfigParser';
import {
  snapshotFromComment,
  snapshotFromPost,
} from '../runtime/activityAdapter';
import { processContextModActivity } from '../runtime/contextModProcessor';
import {
  processModerationScan,
  summarizeModerationScanResult,
  type ModerationScanSource,
} from '../runtime/moderationScanProcessor';
import {
  commentParentModifierFixture,
  submissionFilterFlairFixture,
  type ContextModPlaytestFixture,
} from '../runtime/playtestFixtures';
import {
  loadActionRuntimeSettings,
  loadModerationScanRuntimeSettings,
} from '../runtime/runtimeSettings';
import {
  getActionAuditStatus,
  summarizeActionAuditStatus,
} from '../storage/actionAudit';
import {
  getDryRunAuditStatus,
  summarizeDryRunAuditStatus,
} from '../storage/dryRunAudit';

export const menu = new Hono();

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const logMenuError = (label: string, error: unknown) => {
  if (error instanceof ConfigSourceError && error.code === 'missing-config') {
    console.warn(`${label}: ${error.message}`);
    return;
  }

  console.error(`${label}:`, error);
};

const fixtureActionRuntime = {
  appEnabled: true,
  dryRun: true,
};

const permalinkRunFields: FormField[] = [
  {
    name: 'target',
    label: 'Reddit permalink or thing ID',
    type: 'string',
    helpText: 'Paste a post/comment permalink, t3_ post ID, or t1_ comment ID.',
    required: true,
  },
];

const runFixtureOnComment = async (
  fixture: ContextModPlaytestFixture
): Promise<string> => {
  const post = await reddit.submitPost({
    subredditName: context.subredditName,
    title: `ContextMod fixture host ${Date.now()}`,
    text: 'Temporary post created by the ContextMod Devvit fixture runner.',
  });
  const comment = await post.addComment({
    text: fixture.triggerText,
  });
  const processed = await processContextModActivity({
    source: {
      sourceName: fixture.sourceName,
      text: fixture.configText,
    },
    activity: snapshotFromComment(comment, { parentPost: post, source: 'user' }),
    target: comment,
    targetId: comment.id,
    redditClient: reddit,
    redisClient: redis,
    actionRuntime: fixtureActionRuntime,
    actionSchedulerClient: scheduler,
    configFragmentLoader: reddit,
    actionWikiContentLoader: reddit,
  });

  return `Comment fixture created ${comment.id}. ${processed.message}`;
};

const runFixtureOnSubmission = async (
  fixture: ContextModPlaytestFixture
): Promise<string> => {
  const post = await reddit.submitPost({
    subredditName: context.subredditName,
    title: fixture.triggerText,
    text: 'Temporary post created by the ContextMod Devvit fixture runner.',
  });
  const processed = await processContextModActivity({
    source: {
      sourceName: fixture.sourceName,
      text: fixture.configText,
    },
    activity: snapshotFromPost(post, { source: 'user' }),
    target: post,
    targetId: post.id,
    redditClient: reddit,
    redisClient: redis,
    actionRuntime: fixtureActionRuntime,
    actionSchedulerClient: scheduler,
    configFragmentLoader: reddit,
    actionWikiContentLoader: reddit,
  });

  return `Submission fixture created ${post.id}. ${processed.message}`;
};

menu.post('/status', async (c) => {
  try {
    const auditStatus = await getDryRunAuditStatus(redis);
    const actionAuditStatus = await getActionAuditStatus(redis);
    return c.json<UiResponse>(
      {
        showToast: `${summarizeDryRunAuditStatus(auditStatus)} ${summarizeActionAuditStatus(
          actionAuditStatus
        )}`,
      },
      200
    );
  } catch (error) {
    console.error('ContextMod status audit lookup failed:', error);
    return c.json<UiResponse>(
      {
        showToast:
          'ContextMod Devvit scaffold is installed. Dry-run audit status is unavailable.',
      },
      200
    );
  }
});

menu.post('/fix-wiki-permissions', async (c) => {
  try {
    const wikiPageSetting = await settings.get<string>('configWikiPage');
    const wikiPageName = wikiPageSetting?.trim() || 'botconfig/contextbot';
    await reddit.updateWikiPageSettings({
      subredditName: context.subredditName,
      page: wikiPageName,
      listed: true,
      permLevel: 0,
    });
    return c.json<UiResponse>(
      { showToast: `Wiki page ${wikiPageName} is now publicly readable.` },
      200
    );
  } catch (error) {
    return c.json<UiResponse>(
      { showToast: `Failed: ${error instanceof Error ? error.message : String(error)}` },
      200
    );
  }
});


menu.post('/run-moderation-scan', async (c) => {
  try {
    const source = await loadConfiguredLegacyConfig();
    const actionRuntime = await loadActionRuntimeSettings();
    const scanSettings = await loadModerationScanRuntimeSettings();
    const scanSources: ModerationScanSource[] = ['modqueue', 'unmoderated'];
    const results: Awaited<ReturnType<typeof processModerationScan>>[] = [];

    for (const scanSource of scanSources) {
      results.push(
        await processModerationScan({
          source,
          scanSource,
          subredditName: context.subredditName,
          redditClient: reddit,
          redisClient: redis,
          actionRuntime,
          actionSchedulerClient: scheduler,
          limit: scanSettings.limit,
        })
      );
    }

    return c.json<UiResponse>(
      {
        showToast: `ContextMod moderation scan: ${results
          .map(summarizeModerationScanResult)
          .join('; ')}`,
      },
      200
    );
  } catch (error) {
    const message = getErrorMessage(error);
    logMenuError('ContextMod moderation scan failed', error);

    return c.json<UiResponse>(
      {
        showToast: `ContextMod moderation scan failed: ${message}`,
      },
      200
    );
  }
});

menu.post('/run-context-mod-by-permalink', async (c) =>
  c.json<UiResponse>(
    {
      showForm: {
        name: 'runContextModByPermalink',
        form: {
          title: 'Run ContextMod',
          fields: permalinkRunFields,
          acceptLabel: 'Run',
          cancelLabel: 'Cancel',
        },
      },
    },
    200
  )
);

menu.post('/test-comment-fixture', async (c) => {
  try {
    return c.json<UiResponse>(
      {
        showToast: await runFixtureOnComment(commentParentModifierFixture),
      },
      200
    );
  } catch (error) {
    const message = getErrorMessage(error);
    logMenuError('ContextMod comment fixture failed', error);

    return c.json<UiResponse>(
      {
        showToast: `ContextMod comment fixture failed: ${message}`,
      },
      200
    );
  }
});

menu.post('/test-submission-fixture', async (c) => {
  try {
    return c.json<UiResponse>(
      {
        showToast: await runFixtureOnSubmission(submissionFilterFlairFixture),
      },
      200
    );
  } catch (error) {
    const message = getErrorMessage(error);
    logMenuError('ContextMod submission fixture failed', error);

    return c.json<UiResponse>(
      {
        showToast: `ContextMod submission fixture failed: ${message}`,
      },
      200
    );
  }
});

menu.post('/validate-config', async (c) => {
  try {
    const source = await loadConfiguredLegacyConfig();
    const result = await parseLegacyConfigTextWithWikiIncludes(source.text, {
      sourceName: source.sourceName,
      subredditName: context.subredditName,
      wikiLoader: reddit,
    });

    console.log(
      'ContextMod config validation result:',
      JSON.stringify(result, null, 2)
    );

    return c.json<UiResponse>(
      {
        showToast: summarizeConfigParseResult(result),
      },
      200
    );
  } catch (error) {
    const message = getErrorMessage(error);
    logMenuError('ContextMod config validation failed', error);

    return c.json<UiResponse>(
      {
        showToast: message,
      },
      200
    );
  }
});

menu.post('/run-context-mod-check', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  console.log('ContextMod manual run requested for target:', request.targetId);

  try {
    const targetId = request.targetId;
    let supportedTargetId: T1 | T3 | undefined;
    let target: Parameters<RedditClient['report']>[0] | undefined;
    let activity;

    if (isT1(targetId)) {
      const comment = await reddit.getCommentById(targetId);
      const post = await reddit.getPostById(comment.postId);
      supportedTargetId = targetId;
      target = comment;
      activity = snapshotFromComment(comment, { parentPost: post, source: 'user' });
    } else if (isT3(targetId)) {
      const post = await reddit.getPostById(targetId);
      supportedTargetId = targetId;
      target = post;
      activity = snapshotFromPost(post, { source: 'user' });
    }

    if (!activity || !target || !supportedTargetId) {
      return c.json<UiResponse>(
        {
          showToast: 'ContextMod dry run failed: unsupported target.',
        },
        200
      );
    }

    const source = await loadConfiguredLegacyConfig();
    const actionRuntime = await loadActionRuntimeSettings();
    const processed = await processContextModActivity({
      source,
      activity,
      target,
      targetId: supportedTargetId,
      redditClient: reddit,
      redisClient: redis,
      actionRuntime,
      actionSchedulerClient: scheduler,
      configFragmentLoader: reddit,
      actionWikiContentLoader: reddit,
    });

    if (processed.ok) {
      console.log(
        'ContextMod dry-run result:',
        JSON.stringify(processed.dryRunResult, null, 2)
      );
      if (processed.auditRecord !== undefined) {
        console.log('ContextMod dry-run audit saved:', processed.auditRecord.id);
      }
      if (processed.auditError !== undefined) {
        console.error(
          'ContextMod dry-run audit write failed:',
          processed.auditError
        );
      }
      console.log(
        'ContextMod action execution result:',
        JSON.stringify(processed.actionExecution, null, 2)
      );
    } else {
      console.log(
        'ContextMod config parse result:',
        JSON.stringify(processed.parseResult, null, 2)
      );
    }

    return c.json<UiResponse>(
      {
        showToast: processed.message,
      },
      200
    );
  } catch (error) {
    const message = getErrorMessage(error);
    logMenuError('ContextMod dry run failed', error);

    return c.json<UiResponse>(
      {
        showToast: `ContextMod dry run failed: ${message}`,
      },
      200
    );
  }
});

const DASHBOARD_POST_TITLE = 'ContextMod Dashboard';
const dashboardPostKey = (subredditName: string) => `contextmod:${subredditName.toLowerCase()}:dashboard-post`;

const hideDashboardPostFromPublicFeed = async (
  post: Awaited<ReturnType<typeof reddit.getPostById>>
) => {
  try {
    if (!post.locked) {
      await post.lock();
    }
  } catch (error: unknown) {
    console.warn('Could not lock ContextMod dashboard post.', error);
  }

  try {
    if (!post.removed) {
      await post.remove(false);
    }
  } catch (error: unknown) {
    console.warn('Could not remove ContextMod dashboard post.', error);
  }
};

const getOrCreateDashboardPost = async (subredditName: string) => {
  const key = dashboardPostKey(subredditName);
  const existingPostId = await redis.get(key);

  if (existingPostId) {
    try {
      const post = await reddit.getPostById(existingPostId as any);
      await hideDashboardPostFromPublicFeed(post);
      return post;
    } catch {
      await redis.del(key);
    }
  }

  const post = await reddit.submitCustomPost({
    subredditName,
    title: DASHBOARD_POST_TITLE,
    entry: 'default',
    sendreplies: false,
    spoiler: true,
    postData: {
      kind: 'contextmod-dashboard',
    },
    textFallback: {
      text: 'ContextMod moderation dashboard.',
    },
  });

  await hideDashboardPostFromPublicFeed(post);
  await redis.set(key, post.id);
  return post;
};

menu.post('/open-dashboard', async (c) => {
  try {
    const post = await getOrCreateDashboardPost(context.subredditName ?? '');
    console.info(`Opened ContextMod dashboard post=${post.id} subreddit=${context.subredditName}`);

    return c.json<UiResponse>(
      {
        navigateTo: `https://www.reddit.com${post.permalink}`,
        showToast: {
          text: 'Opening ContextMod dashboard...',
          appearance: 'success',
        },
      },
      200
    );
  } catch (error) {
    logMenuError('ContextMod dashboard creation failed', error);
    return c.json<UiResponse>(
      {
        showToast: `Failed to open dashboard: ${getErrorMessage(error)}`,
      },
      200
    );
  }
});
