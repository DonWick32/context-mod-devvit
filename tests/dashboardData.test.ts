import { describe, expect, it } from 'vitest';
import { buildDashboardData } from '../src/routes/dashboardData';
import type { ActionAuditRecord } from '../src/storage/actionAudit';
import type { DryRunAuditRecord } from '../src/storage/dryRunAudit';
import type { DispatchQueueRecord } from '../src/storage/dispatchQueue';

const dryRunRecord: DryRunAuditRecord = {
  version: 1,
  id: 'dry-1',
  createdAt: '2026-05-25T00:00:00.000Z',
  configSource: 'subreddit setting configText',
  targetId: 't1_comment',
  activity: {
    id: 't1_comment',
    kind: 'comment',
    authorName: 'TestUser',
    subredditName: 'testsub',
    permalink: '/r/testsub/comments/post/comment',
    createdAt: '2026-05-25T00:00:00.000Z',
  },
  result: {
    activityId: 't1_comment',
    checksEvaluated: 1,
    checksTriggered: 1,
    plannedActions: [],
    checkResults: [
      {
        name: 'check',
        kind: 'comment',
        triggered: true,
        supported: true,
        skipped: false,
        reason: 'matched',
        rules: [
          {
            name: 'rule',
            triggered: true,
            supported: true,
            reason: 'matched',
          },
        ],
        plannedActions: [],
      },
    ],
  },
};

const actionRecord: ActionAuditRecord = {
  version: 1,
  id: 'action-1',
  createdAt: '2026-05-25T00:01:00.000Z',
  configSource: 'subreddit setting configText',
  targetId: 't1_comment',
  activity: dryRunRecord.activity,
  dryRunSummary: {
    checksEvaluated: 1,
    checksTriggered: 1,
    plannedActionCount: 1,
  },
  actionExecution: {
    appEnabled: true,
    dryRun: false,
    executed: 1,
    skipped: 0,
    failed: 0,
    results: [],
  },
};

const dispatchRecord: DispatchQueueRecord = {
  version: 1,
  id: 'dispatch-1',
  createdAt: '2026-05-25T00:00:00.000Z',
  runAt: '2026-05-25T00:05:00.000Z',
  targetId: 't1_comment',
  activityKind: 'comment',
  subredditName: 'testsub',
  source: 'dispatch',
  status: 'pending',
  identifier: 'followup',
  retryCount: 0,
};

describe('dashboard data', () => {
  it('builds moderator dashboard stats from audit and dispatch records', () => {
    const data = buildDashboardData({
      dryRunStatus: { totalRecords: 1, latest: dryRunRecord },
      actionStatus: { totalRecords: 1, latest: actionRecord },
      dryRuns: [dryRunRecord],
      actionRuns: [actionRecord],
      dispatches: [dispatchRecord],
      config: {
        ok: true,
        source: 'subreddit setting configText',
        data: 'checks: []',
      },
      configHistory: [
        {
          version: 1,
          id: 'revision-1',
          createdAt: '2026-05-25T00:09:00.000Z',
          source: 'r/testsub/wiki/botconfig/contextbot',
          subredditName: 'testsub',
          pageName: 'botconfig/contextbot',
          reason: 'Updated via ContextMod dashboard UI',
          sizeBytes: 10,
          preview: 'checks: []',
          content: 'checks: []',
        },
      ],
      generatedAt: new Date('2026-05-25T00:10:00.000Z'),
    });

    expect(data.stats).toEqual({
      events: 1,
      actions: 1,
      rules: 1,
      errors: 0,
      dispatches: 1,
    });
    expect(data.auditLogs[0]).toMatchObject({
      action: '1 executed, 0 skipped',
      status: 'success',
      targetUrl: 'https://www.reddit.com/r/testsub/comments/post/comment',
      authorName: 'TestUser',
    });
    expect(data.auditLogs).toHaveLength(1);
    expect(data.activity[0]).toMatchObject({
      targetUrl: 'https://www.reddit.com/r/testsub/comments/post/comment',
    });
    expect(data.config.history[0]).toMatchObject({
      id: 'revision-1',
      pageName: 'botconfig/contextbot',
    });
    expect(data.dispatchQueue[0]).toMatchObject({
      id: 'dispatch-1',
      rule: 'followup',
      failed: false,
    });
    expect(data.grafana.totals).toMatchObject({
      eventsTriggered: 1,
      checksTriggered: 1,
      checksEvaluated: 1,
      rulesTriggered: 1,
      rulesEvaluated: 1,
      actionsExecuted: 1,
      actionFailures: 0,
      queuedDispatches: 1,
    });
    expect(data.grafana.breakdowns.eventsBySource).toEqual([
      { label: 'action', value: 1 },
    ]);
    expect(data.grafana.timeseries.events[0]).toMatchObject({
      total: 1,
      triggered: 1,
    });
  });
});
