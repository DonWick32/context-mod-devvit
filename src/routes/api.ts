import { Hono } from 'hono';
import {
  context,
  redis,
  reddit,
  scheduler,
  settings,
} from '@devvit/web/server';
import { loadConfiguredLegacyConfig, isWikiPageNotFoundError } from '../config/configSource';
import { loadDashboardData } from './dashboardData';
import { validateContextModConfigText } from '../config/configValidation';
import { parseWikiPageReference } from '../runtime/wikiPages';
import {
  processModerationScan,
  summarizeModerationScanResult,
  type ModerationScanSource,
} from '../runtime/moderationScanProcessor';
import {
  loadActionRuntimeSettings,
  loadModerationScanRuntimeSettings,
} from '../runtime/runtimeSettings';
import {
  appendConfigRevisionRecord,
  getConfigRevisionRecord,
  deleteConfigRevisionRecord,
} from '../storage/configHistory';

export const api = new Hono();

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

api.get('/health', (c) =>
  c.json({
    app: 'context-mod-devvit',
    status: 'ok',
  })
);

api.get('/dashboard', async (c) => {
  const subredditName = c.req.query('subredditName')?.trim();
  const [
    appEnabled,
    dryRun,
    moderationScanLimit,
    moderationScanIntervalMinutes,
  ] = await Promise.all([
    settings.get<boolean>('enabled'),
    settings.get<boolean>('dryRun'),
    settings.get<number>('moderationScanLimit'),
    settings.get<number>('moderationScanIntervalMinutes'),
  ]);
  const runtime = {
    ...(appEnabled === undefined ? {} : { appEnabled }),
    ...(dryRun === undefined ? {} : { dryRun }),
    ...(moderationScanLimit === undefined ? {} : { moderationScanLimit }),
    ...(moderationScanIntervalMinutes === undefined
      ? {}
      : { moderationScanIntervalMinutes }),
  };

  return c.json(
    await loadDashboardData(
      redis,
      () => loadConfiguredLegacyConfig(subredditName),
      runtime
    )
  );
});

api.get('/config/revision/:id', async (c) => {
  const revision = await getConfigRevisionRecord(redis, c.req.param('id'));
  if (revision === undefined) {
    return c.json({ error: 'Config revision not found' }, 404);
  }

  return c.json({ revision });
});

api.delete('/config/revision/:id', async (c) => {
  try {
    await deleteConfigRevisionRecord(redis, c.req.param('id'));
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

api.post('/config', async (c) => {
  try {
    const { subredditName, yaml, reason: customReason, skipRevision } = await c.req.json<{ subredditName: string; yaml: string; reason?: string; skipRevision?: boolean }>();
    if (!subredditName || !yaml) {
      return c.json({ error: 'Missing subredditName or yaml content' }, 400);
    }

    const validation = validateContextModConfigText(yaml, {
      sourceName: `dashboard edit for r/${subredditName}`,
    });
    if (!validation.ok) {
      return c.json(
        {
          error: validation.message,
          validation,
        },
        400
      );
    }

    const wikiPageSetting = await settings.get<string>('configWikiPage');
    const wikiPageName =
      wikiPageSetting && wikiPageSetting.trim().length > 0
        ? wikiPageSetting.trim()
        : 'botconfig/contextbot';

    const wikiReference = parseWikiPageReference(wikiPageName, subredditName);
    if (!wikiReference) {
      return c.json({ error: `Invalid wiki page path: ${wikiPageName}` }, 400);
    }

    let reason = customReason && customReason.trim().length > 0 
      ? customReason.trim() 
      : 'Updated via ContextMod dashboard UI';
    try {
      await reddit.updateWikiPage({
        subredditName: wikiReference.subredditName,
        page: wikiReference.pageName,
        content: yaml,
        reason,
      });
    } catch (updateError: unknown) {
      if (isWikiPageNotFoundError(updateError)) {
        reason = customReason && customReason.trim().length > 0 
          ? customReason.trim() 
          : 'Created via ContextMod dashboard UI';
        await reddit.createWikiPage({
          subredditName: wikiReference.subredditName,
          page: wikiReference.pageName,
          content: yaml,
          reason,
        });
      } else {
        throw updateError;
      }
    }

    if (!skipRevision) {
      await appendConfigRevisionRecord(redis, {
        source: `r/${wikiReference.subredditName}/wiki/${wikiReference.pageName}`,
        subredditName: wikiReference.subredditName,
        pageName: wikiReference.pageName,
        reason,
        content: yaml,
      });
    }

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Failed to save config to wiki page:', error);
    return c.json({ error: getErrorMessage(error) }, 500);
  }
});

api.post('/config/validate', async (c) => {
  try {
    const { yaml, sourceName } = await c.req.json<{
      yaml: string;
      sourceName?: string;
    }>();
    if (!yaml || yaml.trim().length === 0) {
      return c.json({ ok: false, error: 'Config text is empty.' }, 400);
    }

    const validation = validateContextModConfigText(yaml, {
      sourceName: sourceName ?? 'dashboard editor',
    });
    return c.json(validation, validation.ok ? 200 : 400);
  } catch (error: unknown) {
    return c.json({ ok: false, error: getErrorMessage(error) }, 500);
  }
});

api.post('/actions/validate-config', async (c) => {
  try {
    const source = await loadConfiguredLegacyConfig(
      c.req.query('subredditName')?.trim()
    );
    const validation = validateContextModConfigText(source.text, {
      sourceName: source.sourceName,
    });
    return c.json({
      ok: validation.ok,
      message: validation.message,
      result: validation,
    });
  } catch (error: unknown) {
    return c.json({ ok: false, error: getErrorMessage(error) }, 500);
  }
});

api.post('/actions/run-moderation-scan', async (c) => {
  try {
    const subredditName =
      c.req.query('subredditName')?.trim() || context.subredditName;
    const source = await loadConfiguredLegacyConfig(subredditName);
    const actionRuntime = await loadActionRuntimeSettings();
    const scanSettings = await loadModerationScanRuntimeSettings();
    const scanSources: ModerationScanSource[] = ['modqueue', 'unmoderated'];
    const results = [];

    for (const scanSource of scanSources) {
      results.push(
        await processModerationScan({
          source,
          scanSource,
          subredditName,
          redditClient: reddit,
          redisClient: redis,
          actionRuntime,
          actionSchedulerClient: scheduler,
          limit: scanSettings.limit,
        })
      );
    }

    return c.json({
      ok: true,
      message: results.map(summarizeModerationScanResult).join('; '),
      results,
    });
  } catch (error: unknown) {
    console.error('Dashboard moderation scan failed:', error);
    return c.json({ ok: false, error: getErrorMessage(error) }, 500);
  }
});

api.post('/actions/fix-wiki-permissions', async (c) => {
  try {
    const subredditName =
      c.req.query('subredditName')?.trim() || context.subredditName;
    const wikiPageSetting = await settings.get<string>('configWikiPage');
    const wikiPageName = wikiPageSetting?.trim() || 'botconfig/contextbot';
    const wikiReference = parseWikiPageReference(wikiPageName, subredditName);
    if (wikiReference === undefined) {
      return c.json({ ok: false, error: `Invalid wiki page path: ${wikiPageName}` }, 400);
    }

    await reddit.updateWikiPageSettings({
      subredditName: wikiReference.subredditName,
      page: wikiReference.pageName,
      listed: true,
      permLevel: 0,
    });
    return c.json({
      ok: true,
      message: `Wiki page ${wikiReference.pageName} is now publicly readable.`,
    });
  } catch (error: unknown) {
    return c.json({ ok: false, error: getErrorMessage(error) }, 500);
  }
});
