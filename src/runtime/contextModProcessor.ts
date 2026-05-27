import type { RedditClient } from '@devvit/web/server';
import type { T1, T3 } from '@devvit/shared-types/tid.js';
import type { LoadedConfigSource } from '../config/configSource';
import {
  parseLegacyConfigTextWithWikiIncludes,
  type ConfigFragmentWikiLoader,
} from '../config/configIncludeHydrator';
import {
  parseLegacyConfigText,
  summarizeConfigParseResult,
} from '../config/legacyConfigParser';
import type { ConfigParseResult, NormalizedConfig, UnknownRecord } from '../config/legacyTypes';
import {
  appendActionAuditRecord,
  type ActionAuditRecord,
  type ActionAuditRedisClient,
} from '../storage/actionAudit';
import type {
  AuditRedisClient,
  DryRunAuditRecord,
} from '../storage/dryRunAudit';
import type { DispatchQueueRedisClient } from '../storage/dispatchQueue';
import { appendDryRunAuditRecord } from '../storage/dryRunAudit';
import type { ActivitySnapshot } from './activityAdapter';
import {
  DEFAULT_ACTION_FOOTER,
  executePlannedActions,
  summarizeActionExecution,
  type ActionExecutionSummary,
  type ActionRuntimeSettings,
  type ActionSchedulerClient,
  type ActionWikiContentLoader,
  type RedditActionClient,
} from './actionExecutor';
import {
  runDryConfig,
  summarizeDryRunResult,
  type DryRunOptions,
  type DryRunResult,
} from './dryRunEngine';
import {
  collectActivityResourceNeeds,
  hydrateActivityResources,
  type RedditResourceClient,
  type RedditResourceRedisClient,
} from './redditResources';
import { saveReportHistory } from './reportHistory';
import { NotificationManager } from './notificationManager';

type ReportableThing = Parameters<RedditClient['report']>[0];
type ProcessRedisClient = AuditRedisClient &
  ActionAuditRedisClient &
  DispatchQueueRedisClient &
  RedditResourceRedisClient;

export type ContextModProcessInput = {
  source: LoadedConfigSource;
  activity: ActivitySnapshot;
  target: ReportableThing;
  targetId: T1 | T3;
  redditClient: RedditActionClient & RedditResourceClient;
  redisClient: ProcessRedisClient;
  actionRuntime: ActionRuntimeSettings;
  actionSchedulerClient?: ActionSchedulerClient;
  configFragmentLoader?: ConfigFragmentWikiLoader;
  actionWikiContentLoader?: ActionWikiContentLoader;
  dryRunOptions?: DryRunOptions;
};

export type ContextModProcessResult =
  | {
      ok: false;
      message: string;
      parseResult: ConfigParseResult;
    }
  | {
      ok: true;
      message: string;
      parseResult: ConfigParseResult;
      dryRunResult: DryRunResult;
      actionExecution: ActionExecutionSummary;
      auditMessage: string;
      auditRecord?: DryRunAuditRecord;
      auditError?: string;
      actionAuditMessage: string;
      actionAuditRecord?: ActionAuditRecord;
      actionAuditError?: string;
    };

const stringifyError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const moderatorNameValueIncludesSelf = (value: unknown): boolean => {
  if (typeof value === 'string') {
    return value.trim().toLowerCase() === 'self';
  }
  if (Array.isArray(value)) {
    return value.some(moderatorNameValueIncludesSelf);
  }
  if (isRecord(value)) {
    return moderatorNameValueIncludesSelf(value.name);
  }

  return false;
};

const configNeedsBotUsername = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(configNeedsBotUsername);
  }
  if (!isRecord(value)) {
    return false;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (
      (key === 'removed' || key === 'approved') &&
      moderatorNameValueIncludesSelf(entry)
    ) {
      return true;
    }
    if (configNeedsBotUsername(entry)) {
      return true;
    }
  }

  return false;
};

const getDryRunOptions = async (
  input: ContextModProcessInput,
  config: NormalizedConfig
): Promise<DryRunOptions | undefined> => {
  if (
    input.dryRunOptions?.botUsername !== undefined ||
    !configNeedsBotUsername(config)
  ) {
    return input.dryRunOptions;
  }

  try {
    const botUsername = await input.redditClient.getCurrentUsername();
    return botUsername === undefined || botUsername.trim().length === 0
      ? input.dryRunOptions
      : {
          ...input.dryRunOptions,
          botUsername,
        };
  } catch (error) {
    console.warn(
      `ContextMod self moderator-name matching unavailable: ${stringifyError(error)}`
    );
    return input.dryRunOptions;
  }
};

const getConfiguredFooter = (config: ConfigParseResult): false | string => {
  if (!config.ok) {
    return DEFAULT_ACTION_FOOTER;
  }

  const footer = config.config.config.footer;
  return footer === false || typeof footer === 'string'
    ? footer
    : DEFAULT_ACTION_FOOTER;
};

export const processContextModActivity = async (
  input: ContextModProcessInput
): Promise<ContextModProcessResult> => {
  const parseResult =
    input.configFragmentLoader === undefined
      ? parseLegacyConfigText(input.source.text, {
          sourceName: input.source.sourceName,
        })
      : await parseLegacyConfigTextWithWikiIncludes(input.source.text, {
          sourceName: input.source.sourceName,
          subredditName: input.activity.subredditName,
          wikiLoader: input.configFragmentLoader,
        });

  if (!parseResult.ok) {
    return {
      ok: false,
      message: summarizeConfigParseResult(parseResult),
      parseResult,
    };
  }

  const activity = await hydrateActivityResources(
    input.redditClient,
    input.redisClient,
    input.activity,
    collectActivityResourceNeeds(parseResult.config),
    input.actionRuntime
  );

  const reportHistory = await saveReportHistory(input.redisClient, activity);
  activity.reportHistory = reportHistory;

  const dryRunOptions = await getDryRunOptions(input, parseResult.config);
  const dryRunResult = runDryConfig(
    parseResult.config,
    activity,
    dryRunOptions
  );
  let auditMessage = ' Audit write failed.';
  let auditRecord: DryRunAuditRecord | undefined;
  let auditError: string | undefined;

  try {
    auditRecord = await appendDryRunAuditRecord(input.redisClient, {
      activity,
      configSource: input.source.sourceName,
      result: dryRunResult,
      targetId: input.targetId,
    });
    auditMessage = ` Audit saved: ${auditRecord.id}.`;
  } catch (error) {
    auditError = stringifyError(error);
  }

  const actionExecution = await executePlannedActions(
    input.redditClient,
    input.target,
    input.targetId,
    dryRunResult.plannedActions,
    input.actionRuntime,
    {
      activity,
      dispatchQueue: {
        activity,
        redisClient: input.redisClient,
      },
      footer: getConfiguredFooter(parseResult),
      subredditName: activity.subredditName,
      ...(input.actionSchedulerClient === undefined
        ? {}
        : { schedulerClient: input.actionSchedulerClient }),
      ...(input.actionWikiContentLoader === undefined
        ? {}
        : { wikiContentLoader: input.actionWikiContentLoader }),
      notificationManager: new NotificationManager(parseResult.config),
    }
  );
  let actionAuditMessage = '';
  let actionAuditRecord: ActionAuditRecord | undefined;
  let actionAuditError: string | undefined;

  if (
    input.actionRuntime.appEnabled &&
    !input.actionRuntime.dryRun &&
    (actionExecution.executed > 0 || actionExecution.failed > 0)
  ) {
    try {
      actionAuditRecord = await appendActionAuditRecord(input.redisClient, {
        activity,
        actionExecution,
        checksEvaluated: dryRunResult.checksEvaluated,
        checksTriggered: dryRunResult.checksTriggered,
        configSource: input.source.sourceName,
        plannedActionCount: dryRunResult.plannedActions.length,
        targetId: input.targetId,
      });
      actionAuditMessage = ` Action audit saved: ${actionAuditRecord.id}.`;
    } catch (error) {
      actionAuditError = stringifyError(error);
      actionAuditMessage = ' Action audit write failed.';
    }
  }

  const result = {
    ok: true,
    message: `${summarizeDryRunResult(dryRunResult)}${auditMessage} ${summarizeActionExecution(
      actionExecution
    )}${actionAuditMessage}`,
    parseResult,
    dryRunResult,
    actionExecution,
    auditMessage,
    actionAuditMessage,
    ...(auditRecord === undefined ? {} : { auditRecord }),
    ...(auditError === undefined ? {} : { auditError }),
    ...(actionAuditRecord === undefined ? {} : { actionAuditRecord }),
    ...(actionAuditError === undefined ? {} : { actionAuditError }),
  } satisfies ContextModProcessResult;

  return result;
};
