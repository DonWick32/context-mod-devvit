import { Hono } from 'hono';
import { isT1, isT3, type T1, type T3 } from '@devvit/shared-types/tid.js';
import {
  reddit,
  redis,
  scheduler,
  type RedditClient,
} from '@devvit/web/server';
import type { UiResponse } from '@devvit/web/shared';
import { loadConfiguredLegacyConfig } from '../config/configSource';
import {
  snapshotFromComment,
  snapshotFromPost,
} from '../runtime/activityAdapter';
import { processContextModActivity } from '../runtime/contextModProcessor';
import { loadActionRuntimeSettings } from '../runtime/runtimeSettings';
import { parseRedditThingId } from '../runtime/thingIds';

export const forms = new Hono();

type RunByPermalinkValues = {
  target?: string;
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const processTargetId = async (
  targetId: T1 | T3
): Promise<string> => {
  let target: Parameters<RedditClient['report']>[0] | undefined;
  let activity;

  if (isT1(targetId)) {
    const comment = await reddit.getCommentById(targetId);
    const post = await reddit.getPostById(comment.postId);
    target = comment;
    activity = snapshotFromComment(comment, { parentPost: post, source: 'user' });
  } else if (isT3(targetId)) {
    const post = await reddit.getPostById(targetId);
    target = post;
    activity = snapshotFromPost(post, { source: 'user' });
  }

  if (activity === undefined || target === undefined) {
    return 'ContextMod manual run failed: unsupported target.';
  }

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

  if (processed.ok) {
    console.log(
      'ContextMod permalink run result:',
      JSON.stringify(processed.dryRunResult, null, 2)
    );
    console.log(
      'ContextMod permalink action execution result:',
      JSON.stringify(processed.actionExecution, null, 2)
    );
  } else {
    console.log(
      'ContextMod permalink config parse result:',
      JSON.stringify(processed.parseResult, null, 2)
    );
  }

  return processed.message;
};

forms.post('/run-context-mod-by-permalink-submit', async (c) => {
  try {
    const values = await c.req.json<RunByPermalinkValues>();
    const targetId = parseRedditThingId(values.target);
    if (targetId === undefined) {
      return c.json<UiResponse>(
        {
          showToast:
            'ContextMod manual run failed: enter a t1_/t3_ id or Reddit permalink.',
        },
        200
      );
    }

    return c.json<UiResponse>(
      {
        showToast: await processTargetId(targetId),
      },
      200
    );
  } catch (error) {
    const message = getErrorMessage(error);
    console.error('ContextMod permalink run failed:', error);

    return c.json<UiResponse>(
      {
        showToast: `ContextMod manual run failed: ${message}`,
      },
      200
    );
  }
});
