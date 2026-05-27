import { Hono } from 'hono';
import {
  context,
  reddit,
  redis,
  scheduler,
  type TaskRequest,
  type TaskResponse,
} from '@devvit/web/server';
import {
  ConfigSourceError,
  loadConfiguredLegacyConfig,
} from '../config/configSource';
import {
  processDispatchRecordById,
  processDueDispatchRecords,
} from '../runtime/dispatchProcessor';
import {
  processModerationScan,
  normalizeModerationScanLimit,
  scheduleNextModerationScan,
  summarizeModerationScanResult,
  type ModerationScanSource,
} from '../runtime/moderationScanProcessor';
import {
  loadActionRuntimeSettings,
  loadModerationScanRuntimeSettings,
} from '../runtime/runtimeSettings';

export const scheduledTasks = new Hono();

type DispatchTaskData = {
  dispatchId?: string;
};

type ModerationScanTaskData = {
  source?: ModerationScanSource;
  limit?: number | string;
};

const logScheduledTaskError = (label: string, error: unknown) => {
  if (error instanceof ConfigSourceError && error.code === 'missing-config') {
    console.warn(`${label}: ${error.message}`);
    return;
  }

  console.error(`${label}:`, error);
};

scheduledTasks.post('/context-mod-dispatch', async (c) => {
  try {
    const request = await c.req.json<TaskRequest<DispatchTaskData>>();
    const source = await loadConfiguredLegacyConfig();
    const actionRuntime = await loadActionRuntimeSettings();
    const baseInput = {
      source,
      redditClient: reddit,
      redisClient: redis,
      actionRuntime,
      actionSchedulerClient: scheduler,
    };
    const result =
      request.data?.dispatchId === undefined
        ? await processDueDispatchRecords(baseInput)
        : await processDispatchRecordById({
            ...baseInput,
            dispatchId: request.data.dispatchId,
          });

    console.log(
      'ContextMod dispatch scheduler processed:',
      JSON.stringify(result, null, 2)
    );
  } catch (error) {
    logScheduledTaskError('ContextMod dispatch scheduler failed', error);
  }

  return c.json<TaskResponse>({}, 200);
});

scheduledTasks.post('/context-mod-moderation-scan', async (c) => {
  let scanSettings:
    | Awaited<ReturnType<typeof loadModerationScanRuntimeSettings>>
    | undefined;

  try {
    const request = await c.req.json<TaskRequest<ModerationScanTaskData>>();
    const actionRuntime = await loadActionRuntimeSettings();
    scanSettings = await loadModerationScanRuntimeSettings();

    if (!actionRuntime.appEnabled) {
      console.log(
        'ContextMod moderation scan skipped: event processing is disabled.'
      );
      return c.json<TaskResponse>({}, 200);
    }

    const source = await loadConfiguredLegacyConfig();
    const scanSources: ModerationScanSource[] =
      request.data?.source === 'modqueue' ||
      request.data?.source === 'unmoderated'
        ? [request.data.source]
        : ['modqueue', 'unmoderated'];
    const limit = normalizeModerationScanLimit(
      request.data?.limit,
      scanSettings.limit
    );
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
          limit,
        })
      );
    }

    console.log(
      'ContextMod moderation scan processed:',
      results.map(summarizeModerationScanResult).join('; ')
    );
  } catch (error) {
    logScheduledTaskError('ContextMod moderation scan failed', error);
  } finally {
    try {
      const settings =
        scanSettings ?? (await loadModerationScanRuntimeSettings());
      await scheduleNextModerationScan(scheduler, redis, {
        force: true,
        intervalMinutes: settings.intervalMinutes,
      });
    } catch (error) {
      console.error('ContextMod moderation scan reschedule failed:', error);
    }
  }

  return c.json<TaskResponse>({}, 200);
});
