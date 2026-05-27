import type {
  ActionAuditRecord,
  ActionAuditRedisClient,
  ActionAuditStatus,
} from '../storage/actionAudit';
import {
  getActionAuditStatus,
  listRecentActionAuditRecords,
} from '../storage/actionAudit';
import type {
  AuditRedisClient,
  DryRunAuditRecord,
  DryRunAuditStatus,
} from '../storage/dryRunAudit';
import {
  getDryRunAuditStatus,
  listRecentDryRunAuditRecords,
} from '../storage/dryRunAudit';
import {
  listDispatchRecords,
  type DispatchQueueRecord,
  type DispatchQueueRedisClient,
} from '../storage/dispatchQueue';
import {
  listRecentConfigRevisionRecords,
  type ConfigHistoryRedisClient,
  type ConfigRevisionRecord,
} from '../storage/configHistory';
import type { LoadedConfigSource } from '../config/configSource';
import { parseLegacyConfigText } from '../config/legacyConfigParser';

export type DashboardRedisClient = AuditRedisClient &
  ActionAuditRedisClient &
  DispatchQueueRedisClient &
  ConfigHistoryRedisClient;

export type DashboardConfigState =
  | {
      ok: true;
      source: string;
      data: string;
    }
  | {
      ok: false;
      source: string;
      error: string;
    };

export type DashboardData = {
  generatedAt: string;
  runtime: {
    appEnabled: boolean;
    dryRun: boolean;
    configSource: string;
    configOk: boolean;
    configFormat: string;
    configError: string;
    runs: number;
    checks: {
      submissions: number;
      comments: number;
      total: number;
    };
    rules: number;
    actions: number;
    pollingSources: number;
    migrationWarnings: number;
    migrationDecisions: number;
    moderationScanLimit: number;
    moderationScanIntervalMinutes: number;
    serviceModel: 'devvit';
  };
  stats: {
    events: number;
    actions: number;
    rules: number;
    errors: number;
    dispatches: number;
  };
  grafana: {
    totals: {
      eventsTriggered: number;
      checksTriggered: number;
      checksEvaluated: number;
      rulesTriggered: number;
      rulesEvaluated: number;
      plannedActions: number;
      actionsExecuted: number;
      actionsSkipped: number;
      actionFailures: number;
      queuedDispatches: number;
      activeSubreddits: number;
      activeBots: number;
    };
    breakdowns: {
      eventsBySource: { label: string; value: number }[];
      eventsByType: { label: string; value: number }[];
      actionsByOutcome: { label: string; value: number }[];
      dispatchesBySubreddit: { label: string; value: number }[];
    };
    timeseries: {
      bucketMinutes: number;
      events: { timestamp: number; total: number; triggered: number }[];
      checks: { timestamp: number; evaluated: number; triggered: number }[];
      rules: { timestamp: number; evaluated: number; triggered: number }[];
      actions: { timestamp: number; executed: number; failed: number }[];
    };
    unsupported: {
      title: string;
      reason: string;
    }[];
  };
  activity: {
    id: string;
    timestamp: number;
    source: 'action' | 'dry-run';
    type: string;
    target: string;
    targetKind: string;
    targetUrl: string;
    authorName: string;
    title: string;
    checksEvaluated: number;
    checksTriggered: number;
    plannedActions: number;
    ruleDetails: string[];
    status: 'dry-run' | 'success' | 'error' | 'pending';
    message: string;
  }[];
  auditLogs: {
    id: string;
    timestamp: number;
    source: 'action' | 'dry-run';
    action: string;
    target: string;
    targetKind: string;
    targetUrl: string;
    authorName: string;
    title: string;
    rule: string;
    checksEvaluated: number;
    checksTriggered: number;
    plannedActions: number;
    executed: number;
    skipped: number;
    failed: number;
    ruleDetails: string[];
    configSource: string;
    status: 'dry-run' | 'success' | 'error';
  }[];
  config: DashboardConfigState & { history: ConfigRevisionRecord[] };
  dispatchQueue: {
    id: string;
    createdAt: string;
    runAt: string;
    target: string;
    targetUrl: string;
    targetKind: string;
    subredditName: string;
    rule: string;
    dryRun: boolean;
    retryCount: number;
    schedulerJobId: string;
    failed: boolean;
  }[];
  logs: {
    id: string;
    timestamp: number;
    level: 'info' | 'warn' | 'error';
    source: string;
    subredditName: string;
    message: string;
    targetUrl: string;
  }[];
  operations: {
    key: string;
    label: string;
    description: string;
    endpoint: string;
    method: 'POST';
    available: boolean;
    legacyOnly?: boolean;
  }[];
};

export type DashboardInput = {
  dryRunStatus: DryRunAuditStatus;
  actionStatus: ActionAuditStatus;
  dryRuns: DryRunAuditRecord[];
  actionRuns: ActionAuditRecord[];
  dispatches: DispatchQueueRecord[];
  config: DashboardConfigState;
  configHistory?: ConfigRevisionRecord[];
  runtime?: {
    appEnabled?: boolean;
    dryRun?: boolean;
    moderationScanLimit?: number;
    moderationScanIntervalMinutes?: number;
  };
  generatedAt?: Date;
};

const actionStatusFor = (
  record: ActionAuditRecord
): 'success' | 'error' =>
  record.actionExecution.failed > 0 ? 'error' : 'success';

const countRulesEvaluated = (records: DryRunAuditRecord[]): number =>
  records.reduce(
    (total, record) =>
      total +
      record.result.checkResults.reduce(
        (ruleTotal, check) => ruleTotal + check.rules.length,
        0
      ),
    0
  );

const dryRunRuleDetails = (record: DryRunAuditRecord): string[] =>
  record.result.checkResults.flatMap((check) =>
    check.rules.map((rule) => {
      const status = rule.triggered ? 'passed' : 'did not match';
      return `${check.name} / ${rule.name}: ${status}${rule.reason ? ` - ${rule.reason}` : ''}`;
    })
  );

const dryRunAuditLog = (record: DryRunAuditRecord) => ({
  id: record.id,
  timestamp: new Date(record.createdAt).getTime(),
  source: 'dry-run' as const,
  action: 'dry run',
  target: record.targetId,
  targetKind: record.activity.kind,
  targetUrl: redditUrl(record.activity.permalink),
  authorName: record.activity.authorName,
  title: record.activity.title ?? record.activity.url ?? '',
  rule: `${record.result.checksTriggered}/${record.result.checksEvaluated} check(s) triggered`,
  checksEvaluated: record.result.checksEvaluated,
  checksTriggered: record.result.checksTriggered,
  plannedActions: record.result.plannedActions.length,
  executed: 0,
  skipped: 0,
  failed: 0,
  ruleDetails: dryRunRuleDetails(record),
  configSource: record.configSource,
  status: 'dry-run' as const,
});

const findNearbyDryRun = (
  actionRun: ActionAuditRecord,
  dryRuns: DryRunAuditRecord[]
): DryRunAuditRecord | undefined => {
  const actionTimestamp = new Date(actionRun.createdAt).getTime();
  return dryRuns.find((dryRun) => {
    if (dryRun.targetId !== actionRun.targetId) {
      return false;
    }
    const dryRunTimestamp = new Date(dryRun.createdAt).getTime();
    return Math.abs(actionTimestamp - dryRunTimestamp) <= 5 * 60 * 1000;
  });
};

const actionAuditLog = (
  record: ActionAuditRecord,
  matchingDryRun: DryRunAuditRecord | undefined
) => ({
  id: record.id,
  timestamp: new Date(record.createdAt).getTime(),
  source: 'action' as const,
  action: `${record.actionExecution.executed} executed, ${record.actionExecution.skipped} skipped`,
  target: record.targetId,
  targetKind: record.activity.kind,
  targetUrl: redditUrl(record.activity.permalink),
  authorName: record.activity.authorName,
  title: record.activity.title ?? record.activity.url ?? '',
  rule: `${record.dryRunSummary.plannedActionCount} planned action(s)`,
  checksEvaluated: record.dryRunSummary.checksEvaluated,
  checksTriggered: record.dryRunSummary.checksTriggered,
  plannedActions: record.dryRunSummary.plannedActionCount,
  executed: record.actionExecution.executed,
  skipped: record.actionExecution.skipped,
  failed: record.actionExecution.failed,
  ruleDetails:
    matchingDryRun === undefined ? [] : dryRunRuleDetails(matchingDryRun),
  configSource: record.configSource,
  status: actionStatusFor(record),
});

const hasNearbyActionForDryRun = (
  dryRun: DryRunAuditRecord,
  actionRuns: ActionAuditRecord[]
): boolean => {
  const dryRunTimestamp = new Date(dryRun.createdAt).getTime();
  return actionRuns.some((actionRun) => {
    if (actionRun.targetId !== dryRun.targetId) {
      return false;
    }
    const actionTimestamp = new Date(actionRun.createdAt).getTime();
    return Math.abs(actionTimestamp - dryRunTimestamp) <= 5 * 60 * 1000;
  });
};

const redditUrl = (permalink: string): string => {
  if (/^https?:\/\//i.test(permalink)) {
    return permalink;
  }
  return `https://www.reddit.com${permalink.startsWith('/') ? '' : '/'}${permalink}`;
};

const configRuntime = (
  config: DashboardConfigState,
  runtime: DashboardInput['runtime']
): DashboardData['runtime'] => {
  const result =
    config.ok === true
      ? parseLegacyConfigText(config.data, { sourceName: config.source })
      : undefined;
  const runs = result?.ok === true ? result.config.runs : [];
  const checks = runs.flatMap((run) => run.checks);
  const warnings =
    result?.ok === true ? result.config.warnings : result?.warnings ?? [];
  return {
    appEnabled: runtime?.appEnabled === true,
    dryRun: runtime?.dryRun !== false,
    configSource: config.source,
    configOk: result?.ok === true,
    configFormat:
      result?.ok === true ? result.config.format : result?.format ?? 'unknown',
    configError:
      config.ok === false
        ? config.error
        : result?.ok === false
          ? result.errors[0] ?? 'Invalid config.'
          : '',
    runs: runs.length,
    checks: {
      submissions: checks.filter((check) => check.kind === 'submission').length,
      comments: checks.filter((check) => check.kind === 'comment').length,
      total: checks.length,
    },
    rules: checks.reduce((total, check) => total + check.rules.length, 0),
    actions: checks.reduce((total, check) => total + check.actions.length, 0),
    pollingSources:
      result?.ok === true && Array.isArray(result.config.polling)
        ? result.config.polling.length
        : 0,
    migrationWarnings: warnings.length,
    migrationDecisions: warnings.filter(
      (warning) => warning.severity === 'needs-decision'
    ).length,
    moderationScanLimit: runtime?.moderationScanLimit ?? 25,
    moderationScanIntervalMinutes: runtime?.moderationScanIntervalMinutes ?? 10,
    serviceModel: 'devvit',
  };
};

const buildLogs = (
  auditLogs: DashboardData['auditLogs'],
  dispatchQueue: DashboardData['dispatchQueue'],
  config: DashboardConfigState
): DashboardData['logs'] => {
  const configLogs: DashboardData['logs'] = [
    {
      id: 'config-current',
      timestamp: Date.now(),
      level: config.ok ? 'info' : 'error',
      source: 'config',
      subredditName: '',
      message: config.ok
        ? `Loaded configuration from ${config.source}.`
        : `Configuration load failed: ${config.error}`,
      targetUrl: '',
    },
  ];
  const auditDerived = auditLogs.map((entry) => ({
    id: `audit-${entry.id}`,
    timestamp: entry.timestamp,
    level: entry.status === 'error' ? ('error' as const) : ('info' as const),
    source: entry.source,
    subredditName: '',
    message:
      entry.source === 'dry-run'
        ? `${entry.targetKind} ${entry.target}: ${entry.checksTriggered}/${entry.checksEvaluated} checks triggered, ${entry.plannedActions} planned actions.`
        : `${entry.targetKind} ${entry.target}: ${entry.executed} executed, ${entry.skipped} skipped, ${entry.failed} failed.`,
    targetUrl: entry.targetUrl,
  }));
  const dispatchDerived = dispatchQueue.map((entry) => ({
    id: `dispatch-${entry.id}`,
    timestamp: new Date(entry.createdAt).getTime(),
    level: entry.failed ? ('warn' as const) : ('info' as const),
    source: 'dispatch',
    subredditName: entry.subredditName,
    message: `Queued ${entry.rule} for ${entry.targetKind} ${entry.target}; runs at ${entry.runAt}.`,
    targetUrl: entry.targetUrl,
  }));

  return [...configLogs, ...auditDerived, ...dispatchDerived]
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, 100);
};

const incrementMap = (
  map: Map<string, number>,
  key: string | undefined,
  value = 1
) => {
  const label = key && key.trim().length > 0 ? key : 'unknown';
  map.set(label, (map.get(label) ?? 0) + value);
};

const mapToBreakdown = (map: Map<string, number>) =>
  [...map.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label));

const bucketTimestamp = (timestamp: number, bucketMinutes: number): number => {
  const bucketMs = bucketMinutes * 60 * 1000;
  return Math.floor(timestamp / bucketMs) * bucketMs;
};

const buildGrafanaMetrics = (
  auditLogs: DashboardData['auditLogs'],
  dispatchQueue: DashboardData['dispatchQueue']
): DashboardData['grafana'] => {
  const bucketMinutes = 15;
  const eventsBySource = new Map<string, number>();
  const eventsByType = new Map<string, number>();
  const actionsByOutcome = new Map<string, number>();
  const dispatchesBySubreddit = new Map<string, number>();
  const activeSubreddits = new Set<string>();
  const eventBuckets = new Map<number, { timestamp: number; total: number; triggered: number }>();
  const checkBuckets = new Map<number, { timestamp: number; evaluated: number; triggered: number }>();
  const ruleBuckets = new Map<number, { timestamp: number; evaluated: number; triggered: number }>();
  const actionBuckets = new Map<number, { timestamp: number; executed: number; failed: number }>();

  let checksEvaluated = 0;
  let checksTriggered = 0;
  let rulesEvaluated = 0;
  let rulesTriggered = 0;
  let plannedActions = 0;
  let actionsExecuted = 0;
  let actionsSkipped = 0;
  let actionFailures = 0;

  for (const entry of auditLogs) {
    incrementMap(eventsBySource, entry.source);
    incrementMap(eventsByType, entry.targetKind);
    if (entry.source === 'action') {
      incrementMap(actionsByOutcome, entry.status === 'error' ? 'failed' : 'success');
    }
    checksEvaluated += entry.checksEvaluated;
    checksTriggered += entry.checksTriggered;
    rulesEvaluated += entry.ruleDetails.length;
    rulesTriggered += entry.ruleDetails.filter((detail) => detail.includes(': passed')).length;
    plannedActions += entry.plannedActions;
    actionsExecuted += entry.executed;
    actionsSkipped += entry.skipped;
    actionFailures += entry.failed;

    const bucket = bucketTimestamp(entry.timestamp, bucketMinutes);
    const eventBucket =
      eventBuckets.get(bucket) ?? { timestamp: bucket, total: 0, triggered: 0 };
    eventBucket.total += 1;
    eventBucket.triggered += entry.checksTriggered > 0 ? 1 : 0;
    eventBuckets.set(bucket, eventBucket);

    const checkBucket =
      checkBuckets.get(bucket) ?? { timestamp: bucket, evaluated: 0, triggered: 0 };
    checkBucket.evaluated += entry.checksEvaluated;
    checkBucket.triggered += entry.checksTriggered;
    checkBuckets.set(bucket, checkBucket);

    const ruleBucket =
      ruleBuckets.get(bucket) ?? { timestamp: bucket, evaluated: 0, triggered: 0 };
    ruleBucket.evaluated += entry.ruleDetails.length;
    ruleBucket.triggered += entry.ruleDetails.filter((detail) => detail.includes(': passed')).length;
    ruleBuckets.set(bucket, ruleBucket);

    const actionBucket =
      actionBuckets.get(bucket) ?? { timestamp: bucket, executed: 0, failed: 0 };
    actionBucket.executed += entry.executed;
    actionBucket.failed += entry.failed;
    actionBuckets.set(bucket, actionBucket);
  }

  for (const entry of dispatchQueue) {
    incrementMap(dispatchesBySubreddit, entry.subredditName);
    if (entry.subredditName) {
      activeSubreddits.add(entry.subredditName);
    }
  }

  return {
    totals: {
      eventsTriggered: auditLogs.filter((entry) => entry.checksTriggered > 0).length,
      checksTriggered,
      checksEvaluated,
      rulesTriggered,
      rulesEvaluated,
      plannedActions,
      actionsExecuted,
      actionsSkipped,
      actionFailures,
      queuedDispatches: dispatchQueue.length,
      activeSubreddits: activeSubreddits.size,
      activeBots: 1,
    },
    breakdowns: {
      eventsBySource: mapToBreakdown(eventsBySource),
      eventsByType: mapToBreakdown(eventsByType),
      actionsByOutcome: mapToBreakdown(actionsByOutcome),
      dispatchesBySubreddit: mapToBreakdown(dispatchesBySubreddit),
    },
    timeseries: {
      bucketMinutes,
      events: [...eventBuckets.values()].sort((left, right) => left.timestamp - right.timestamp),
      checks: [...checkBuckets.values()].sort((left, right) => left.timestamp - right.timestamp),
      rules: [...ruleBuckets.values()].sort((left, right) => left.timestamp - right.timestamp),
      actions: [...actionBuckets.values()].sort((left, right) => left.timestamp - right.timestamp),
    },
    unsupported: [
      {
        title: 'Average Total API Quota Usage',
        reason: 'Devvit does not expose Reddit API quota counters to this app.',
      },
      {
        title: 'Average Processing Time / Queued Time',
        reason: 'The current audit records do not persist per-item duration timings yet.',
      },
    ],
  };
};

export const buildDashboardData = (input: DashboardInput): DashboardData => {
  const visibleDryRuns = input.dryRuns.filter(
    (record) => !hasNearbyActionForDryRun(record, input.actionRuns)
  );
  const auditLogs = [
    ...input.actionRuns.map((record) =>
      actionAuditLog(record, findNearbyDryRun(record, input.dryRuns))
    ),
    ...visibleDryRuns.map(dryRunAuditLog),
  ].sort((left, right) => right.timestamp - left.timestamp);

  const activity = auditLogs.slice(0, 10).map((entry) => ({
    id: entry.id,
    timestamp: entry.timestamp,
    source: entry.source,
    type: entry.action,
    target: entry.target,
    targetKind: entry.targetKind,
    targetUrl: entry.targetUrl,
    authorName: entry.authorName,
    title: entry.title,
    checksEvaluated: entry.checksEvaluated,
    checksTriggered: entry.checksTriggered,
    plannedActions: entry.plannedActions,
    ruleDetails: entry.ruleDetails,
    status: entry.status,
    message: entry.rule,
  }));

  const dispatchQueue = input.dispatches.map((record) => ({
    id: record.id,
    createdAt: record.createdAt,
    runAt: record.runAt,
    target: record.targetId,
    targetUrl: redditUrl(
      record.activityKind === 'submission'
        ? `/comments/${record.targetId.replace(/^t3_/, '')}`
        : `/api/info?id=${record.targetId}`
    ),
    targetKind: record.activityKind,
    subredditName: record.subredditName,
    rule: record.identifier ?? record.goto ?? 'dispatch',
    dryRun: record.dryRun ?? false,
    retryCount: record.retryCount ?? 0,
    schedulerJobId: record.schedulerJobId ?? '',
    failed: (record.retryCount ?? 0) > 0,
  }));
  const runtime = configRuntime(input.config, input.runtime);

  return {
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    runtime,
    stats: {
      events: input.dryRunStatus.totalRecords,
      actions: input.actionStatus.totalRecords,
      rules: countRulesEvaluated(input.dryRuns),
      errors: input.actionRuns.reduce(
        (total, record) => total + record.actionExecution.failed,
        0
      ),
      dispatches: input.dispatches.length,
    },
    grafana: buildGrafanaMetrics(auditLogs, dispatchQueue),
    activity,
    auditLogs,
    config: {
      ...input.config,
      history: input.configHistory ?? [],
    },
    dispatchQueue,
    logs: buildLogs(auditLogs, dispatchQueue, input.config),
    operations: [
      {
        key: 'validate-config',
        label: 'Validate Config',
        description: 'Parse the active ContextMod YAML/JSON5 and report migration warnings.',
        endpoint: '/api/actions/validate-config',
        method: 'POST',
        available: true,
      },
      {
        key: 'run-moderation-scan',
        label: 'Scan Modqueue',
        description: 'Run ContextMod against modqueue and unmoderated listings now.',
        endpoint: '/api/actions/run-moderation-scan',
        method: 'POST',
        available: true,
      },
      {
        key: 'start-stop-bot',
        label: 'Start / Stop Bot',
        description: 'Legacy daemon controls are represented by Devvit app settings and triggers.',
        endpoint: '',
        method: 'POST',
        available: false,
        legacyOnly: true,
      },
    ],
  };
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const loadDashboardData = async (
  redis: DashboardRedisClient,
  configLoader: () => Promise<LoadedConfigSource>,
  runtime?: DashboardInput['runtime']
): Promise<DashboardData> => {
  const [
    dryRunStatus,
    actionStatus,
    dryRuns,
    actionRuns,
    dispatches,
    configHistory,
    config,
  ] =
    await Promise.all([
      getDryRunAuditStatus(redis),
      getActionAuditStatus(redis),
      listRecentDryRunAuditRecords(redis, 25),
      listRecentActionAuditRecords(redis, 25),
      listDispatchRecords(redis, 25),
      listRecentConfigRevisionRecords(redis, 25),
      configLoader()
        .then(
          (source): DashboardConfigState => ({
            ok: true,
            source: source.sourceName,
            data: source.text,
          })
        )
        .catch(
          (error): DashboardConfigState => ({
            ok: false,
            source: 'configured ContextMod source',
            error: getErrorMessage(error),
          })
        ),
    ]);

  return buildDashboardData({
    dryRunStatus,
    actionStatus,
    dryRuns,
    actionRuns,
    dispatches,
    config,
    configHistory,
    ...(runtime === undefined ? {} : { runtime }),
  });
};
