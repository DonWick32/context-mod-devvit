import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import * as monaco from 'monaco-editor';
import { configureMonacoYaml } from 'monaco-yaml';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import yamlWorker from 'monaco-yaml/yaml.worker?worker';
import appSchema from '../../public/schema/App.json';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import './style.css';

ModuleRegistry.registerModules([AllCommunityModule]);

const configModelUri = monaco.Uri.parse('file:///bot.yaml');

window.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'yaml') {
      return new yamlWorker();
    }
    return new editorWorker();
  },
};

configureMonacoYaml(monaco, {
  enableSchemaRequest: false,
  hover: true,
  completion: true,
  validate: true,
  format: true,
  schemas: [
    {
      uri: 'https://context-mod.local/schema/App.json',
      fileMatch: ['bot.yaml', configModelUri.toString(), '**/bot.yaml', '**/config.yaml'],
      schema: appSchema,
    },
  ],
});

const views = [
  { id: 'overview', label: 'Overview', icon: 'OV' },
  { id: 'status', label: 'Status', icon: 'ST' },
  { id: 'audit', label: 'Audit Log', icon: 'AU' },
  { id: 'logs', label: 'Logs', icon: 'LG' },
  { id: 'config', label: 'Config Viewer', icon: 'CF' },
  { id: 'dispatch', label: 'Dispatch Queue', icon: 'DQ' },
  { id: 'operations', label: 'Operations', icon: 'OP' },
];

const emptyStats = {
  events: 0,
  actions: 0,
  rules: 0,
  errors: 0,
  dispatches: 0,
};

const formatDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
};

const formatBytes = (value) => {
  if (!Number.isFinite(value)) {
    return '-';
  }
  if (value < 1024) {
    return `${value} B`;
  }
  return `${(value / 1024).toFixed(1)} KB`;
};

const statusClass = (status) => {
  if (status === 'success') return 'badge-success';
  if (status === 'error') return 'badge-error';
  if (status === 'dry-run') return 'badge-warning';
  return 'badge-info';
};

const subredditName = () => globalThis.devvit?.context?.subredditName ?? '';

const humanTargetKind = (kind) => {
  if (kind === 'submission') return 'post';
  if (kind === 'comment') return 'comment';
  return kind || 'item';
};

const humanEventType = (item) => {
  if (item.source === 'dry-run') return 'Checked moderation rules';
  if (item.status === 'error') return 'Action run failed';
  return 'Executed moderation actions';
};

const compactNumber = (value) =>
  Number(value ?? 0).toLocaleString(undefined, {
    notation: Math.abs(Number(value ?? 0)) >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  });

const chartTimeLabel = (timestamp) => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? '-'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const firstDefinedNumber = (...values) => {
  const value = values.find((entry) => Number.isFinite(Number(entry)));
  return Number(value ?? 0);
};

async function loadDashboardData() {
  const response = await fetch(
    `/api/dashboard?subredditName=${encodeURIComponent(subredditName())}`,
    { cache: 'no-store' }
  );
  if (!response.ok) {
    throw new Error(`Dashboard request failed with status ${response.status}`);
  }
  return response.json();
}

function Badge({ status, children }) {
  return <span className={`badge ${statusClass(status)}`}>{children ?? status}</span>;
}

function Spinner({ label = 'Loading' }) {
  return (
    <div className="loading-inline" role="status" aria-live="polite">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  );
}

function StatCard({ tone, label, value, helper, icon }) {
  return (
    <div className="stat-card">
      <div className={`stat-icon ${tone}`}>{icon}</div>
      <div className="stat-details">
        <span className="stat-value">{Number(value ?? 0).toLocaleString()}</span>
        <div>
          <span className="stat-label">{label}</span>
        {helper ? <span className="stat-helper">{helper}</span> : null}
        </div>
      </div>
    </div>
  );
}

function OpsMetric({ label, value, helper, tone = 'neutral', delta }) {
  return (
    <div className={`ops-metric ${tone}`}>
      <span className="ops-metric-label">{label}</span>
      <div className="ops-metric-main">
        <strong>{compactNumber(value)}</strong>
        {delta ? <span className="ops-delta">{delta}</span> : null}
      </div>
      <span className="ops-metric-helper">{helper}</span>
    </div>
  );
}

function ModerationLineChart({ rows }) {
  const chartRows = rows.length > 0
    ? rows
    : Array.from({ length: 10 }, (_, index) => ({
        timestamp: Date.now() - (9 - index) * 15 * 60 * 1000,
        primary: 0,
        secondary: 0,
      }));
  const width = 720;
  const height = 220;
  const pad = 22;
  const maxValue = Math.max(
    ...chartRows.flatMap((row) => [row.primary, row.secondary]),
    1
  );
  const xFor = (index) =>
    pad + (index * (width - pad * 2)) / Math.max(chartRows.length - 1, 1);
  const yFor = (value) =>
    height - pad - (Number(value ?? 0) / maxValue) * (height - pad * 2);
  const pointsFor = (field) =>
    chartRows
      .map((row, index) => `${xFor(index).toFixed(1)},${yFor(row[field]).toFixed(1)}`)
      .join(' ');
  const areaPoints = `${pad},${height - pad} ${pointsFor('primary')} ${width - pad},${height - pad}`;
  const last = chartRows[chartRows.length - 1] ?? { primary: 0 };
  const lastX = xFor(chartRows.length - 1);
  const lastY = yFor(last.primary);

  return (
    <div className="ops-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Checks over time">
        <defs>
          <linearGradient id="opsChartFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#42e3c8" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#42e3c8" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3].map((line) => {
          const y = pad + line * ((height - pad * 2) / 3);
          return <line key={line} x1={pad} x2={width - pad} y1={y} y2={y} className="ops-grid-line" />;
        })}
        <polygon points={areaPoints} className="ops-area" />
        <polyline points={pointsFor('secondary')} className="ops-line secondary" />
        <polyline points={pointsFor('primary')} className="ops-line primary" />
        <circle cx={lastX} cy={lastY} r="5.5" className="ops-line-dot" />
      </svg>
      <div className="ops-chart-axis">
        <span>{chartTimeLabel(chartRows[0]?.timestamp)}</span>
        <span>{chartTimeLabel(chartRows[Math.floor(chartRows.length / 2)]?.timestamp)}</span>
        <span>{chartTimeLabel(chartRows[chartRows.length - 1]?.timestamp)}</span>
      </div>
    </div>
  );
}

function MiniBarSummary({ title, value, helper, rows }) {
  const normalizedRows = rows.map((row) => ({
    ...row,
    value: Number.isFinite(Number(row.value)) ? Number(row.value) : 0,
  }));
  const max = Math.max(...normalizedRows.map((row) => row.value), 1);
  return (
    <section className="ops-panel mini-bars">
      <div className="ops-panel-header">
        <div>
          <span>{title}</span>
          <strong>{value}</strong>
        </div>
        <small>{helper}</small>
      </div>
      <div className="mini-bar-list">
        {normalizedRows.length === 0 ? <span className="empty-compact">No retained data</span> : null}
        {normalizedRows.map((row) => (
          <div className="mini-bar-row" key={row.label}>
            <span>{row.label}</span>
            <div className="mini-bar-track">
              <i style={{ height: `${Math.max(10, (row.value / max) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatBool(value, trueLabel = 'Enabled', falseLabel = 'Disabled') {
  return value ? trueLabel : falseLabel;
}

function TargetLink({ value, data }) {
  const href = data?.targetUrl;
  if (!href) {
    return <span className="mono">{value}</span>;
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className="target-link">
      {value}
    </a>
  );
}

function EntityLink({ href, children, className }) {
  if (!href) {
    return <span className={className}>{children}</span>;
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  );
}

function Overview({ data, loading }) {
  const stats = data?.stats ?? emptyStats;
  const activity = data?.activity ?? [];
  const runtime = data?.runtime;
  const grafana = data?.grafana;
  const logs = data?.logs ?? [];
  const dispatches = data?.dispatchQueue ?? [];
  const totals = grafana?.totals ?? {};
  const chartRows = useMemo(() => {
    const checks = grafana?.timeseries?.checks ?? [];
    if (checks.length > 0) {
      return checks.map((row) => ({
        timestamp: row.timestamp,
        primary: row.triggered,
        secondary: row.evaluated,
      }));
    }
    return (data?.auditLogs ?? [])
      .slice()
      .reverse()
      .slice(-12)
      .map((row) => ({
        timestamp: row.timestamp,
        primary: row.checksTriggered,
        secondary: row.checksEvaluated,
      }));
  }, [data?.auditLogs, grafana?.timeseries?.checks]);
  const latest = activity[0];
  const serviceNeeds =
    firstDefinedNumber(stats.errors) +
    dispatches.filter((entry) => entry.failed).length +
    (runtime?.configOk === false ? 1 : 0);
  const plannedActions = firstDefinedNumber(totals.plannedActions);
  const actionRows = grafana?.breakdowns?.actionsByOutcome ?? [];
  const sourceRows = grafana?.breakdowns?.eventsBySource ?? [];

  return (
    <div className="ops-dashboard">
      <section className="ops-hero">
        <div className="ops-title">
          <span>ContextMod Dashboard</span>
          <strong>{runtime?.configSource ?? 'Devvit runtime'}</strong>
        </div>
        <div className="ops-toolbar" aria-label="Dashboard status">
          <span>{runtime?.appEnabled ? 'Events on' : 'Events paused'}</span>
          <span>{runtime?.dryRun ? 'Dry run' : 'Live actions'}</span>
          {loading ? <Spinner label="Refreshing" /> : <Badge status={runtime?.configOk ? 'success' : 'error'}>{runtime?.configOk ? 'Config valid' : 'Config issue'}</Badge>}
        </div>
      </section>

      <section className="ops-metrics">
        <OpsMetric
          label="Checks Triggered"
          value={totals.checksTriggered ?? 0}
          helper={`${compactNumber(totals.checksEvaluated ?? 0)} evaluated`}
          tone="mint"
          delta={`${compactNumber(stats.events)} runs`}
        />
        <OpsMetric
          label="Action Runs"
          value={stats.actions}
          helper={`${compactNumber(totals.actionsExecuted ?? 0)} executed`}
          tone="rose"
          delta={stats.errors > 0 ? `${stats.errors} failed` : 'clean'}
        />
        <OpsMetric
          label="Need Service"
          value={serviceNeeds}
          helper="failures, retries, config issues"
          tone="amber"
          delta={`${compactNumber(dispatches.length)} queued`}
        />
        <OpsMetric
          label="All Activity"
          value={stats.events + stats.actions}
          helper={`${compactNumber(plannedActions)} planned actions`}
          tone="white"
          delta="retained"
        />
      </section>

      <section className="ops-workspace">
        <div className="ops-main-stack">
          <section className="ops-panel ops-chart-panel">
            <div className="ops-panel-header">
              <div>
                <span>Moderation Activity</span>
                <strong>This retained window</strong>
              </div>
              <span className="ghost-menu" aria-hidden="true">...</span>
            </div>
            <ModerationLineChart rows={chartRows} />
            <div className="ops-kpi-strip">
              <span><b>{compactNumber(stats.rules)}</b> rules evaluated</span>
              <span><b>{compactNumber(totals.rulesTriggered ?? 0)}</b> rules triggered</span>
              <span><b>{compactNumber(stats.dispatches)}</b> dispatches queued</span>
            </div>
          </section>

          <div className="ops-bottom-grid">
            <section className="ops-panel ops-log-panel">
              <div className="ops-panel-header">
                <div>
                  <span>Log Messages</span>
                  <strong>Recent system events</strong>
                </div>
              </div>
              <div className="ops-log-list">
                {logs.length === 0 ? <div className="empty-compact">No retained logs yet.</div> : null}
                {logs.slice(0, 6).map((item) => (
                  <EntityLink href={item.targetUrl} className="ops-log-row" key={item.id}>
                    <span>{item.level}</span>
                    <strong>{item.message}</strong>
                    <time>{formatDate(item.timestamp)}</time>
                  </EntityLink>
                ))}
              </div>
            </section>

            <MiniBarSummary
              title="Action Mix"
              value={`${compactNumber(totals.actionsExecuted ?? 0)} done`}
              helper={`${compactNumber(totals.actionsSkipped ?? 0)} skipped`}
              rows={actionRows}
            />
          </div>
        </div>

        <aside className="ops-side-stack">
          <section className="ops-panel target-panel">
            <div className="ops-panel-header">
              <div>
                <span>Recent Targets</span>
                <strong>All</strong>
              </div>
            </div>
            <div className="target-list">
              {activity.length === 0 ? <div className="empty-compact">No recent targets.</div> : null}
              {activity.slice(0, 8).map((item) => (
                <EntityLink href={item.targetUrl} className="target-row" key={item.id}>
                  <div>
                    <strong>{item.target}</strong>
                    <span>{item.title || `${humanTargetKind(item.targetKind)} by ${item.authorName || 'unknown'}`}</span>
                  </div>
                  <Badge status={item.status}>{item.status === 'dry-run' ? 'dry' : item.status}</Badge>
                </EntityLink>
              ))}
            </div>
          </section>

          <MiniBarSummary
            title="Event Sources"
            value={`${compactNumber(stats.events)} events`}
            helper="dry-run and action audit"
            rows={sourceRows}
          />

          <section className="ops-panel dispatch-panel">
            <div className="ops-panel-header">
              <div>
                <span>Dispatch Queue</span>
                <strong>{compactNumber(dispatches.length)} pending</strong>
              </div>
            </div>
            <div className="dispatch-mini-list">
              {dispatches.length === 0 ? <div className="empty-compact">No delayed work.</div> : null}
              {dispatches.slice(0, 4).map((item) => (
                <EntityLink href={item.targetUrl} className="dispatch-mini-row" key={item.id}>
                  <span>{item.rule}</span>
                  <strong>{chartTimeLabel(item.runAt)}</strong>
                </EntityLink>
              ))}
            </div>
          </section>
        </aside>
      </section>
    </div>
  );
}

function StatusView({ data }) {
  const runtime = data?.runtime;
  const stats = data?.stats ?? emptyStats;
  const queue = data?.dispatchQueue ?? [];
  const latest = data?.activity?.[0];

  return (
    <div className="view-container">
      <div className="stats-grid">
        <StatCard
          tone={runtime?.appEnabled ? 'green' : 'orange'}
          label="Event Processing"
          value={runtime?.appEnabled ? 1 : 0}
          helper={formatBool(runtime?.appEnabled)}
          icon="EV"
        />
        <StatCard
          tone={runtime?.dryRun ? 'orange' : 'green'}
          label="Action Mode"
          value={runtime?.dryRun ? 0 : 1}
          helper={runtime?.dryRun ? 'Dry run actions' : 'Live moderator actions'}
          icon="MO"
        />
        <StatCard tone="blue" label="Configured Runs" value={runtime?.runs} helper={`${runtime?.checks?.total ?? 0} checks loaded`} icon="RN" />
        <StatCard tone="violet" label="Scheduler Interval" value={runtime?.moderationScanIntervalMinutes} helper="minutes between scans" icon="SC" />
        <StatCard tone="red" label="Migration Decisions" value={runtime?.migrationDecisions} helper={`${runtime?.migrationWarnings ?? 0} total warnings`} icon="MD" />
      </div>

      <div className="status-layout">
        <section className="content-panel">
          <div className="panel-header">
            <div>
              <h3>Subreddit Status</h3>
              <p className="panel-subtitle">Devvit runtime equivalent of the legacy bot/subreddit status board.</p>
            </div>
            <Badge status={runtime?.configOk ? 'success' : 'error'}>
              {runtime?.configOk ? 'Config valid' : 'Config issue'}
            </Badge>
          </div>
          <div className="detail-grid">
            <DetailRow label="Service model" value="Devvit triggers and scheduler" />
            <DetailRow label="Config source" value={runtime?.configSource ?? '-'} />
            <DetailRow label="Config format" value={runtime?.configFormat ?? '-'} />
            <DetailRow label="Submission checks" value={runtime?.checks?.submissions ?? 0} />
            <DetailRow label="Comment checks" value={runtime?.checks?.comments ?? 0} />
            <DetailRow label="Rules" value={runtime?.rules ?? 0} />
            <DetailRow label="Actions" value={runtime?.actions ?? 0} />
            <DetailRow label="Legacy polling entries" value={runtime?.pollingSources ?? 0} />
            <DetailRow label="Scan limit" value={runtime?.moderationScanLimit ?? 25} />
            <DetailRow label="Queued dispatches" value={queue.length} />
            <DetailRow label="Recent dry runs" value={stats.events} />
            <DetailRow label="Recent action runs" value={stats.actions} />
          </div>
          {runtime?.configError ? <div className="inline-warning">{runtime.configError}</div> : null}
        </section>

        <section className="content-panel">
          <div className="panel-header">
            <div>
              <h3>Processing State</h3>
              <p className="panel-subtitle">The legacy queue/events controls are represented by settings and scheduled jobs.</p>
            </div>
          </div>
          <div className="state-list">
            <StateRow label="Bot" status="running" value="Installed" helper="Devvit invokes the app through Reddit triggers." />
            <StateRow
              label="Events"
              status={runtime?.appEnabled ? 'running' : 'paused'}
              value={formatBool(runtime?.appEnabled, 'Enabled', 'Paused')}
              helper="Controlled by the Enable event processing setting."
            />
            <StateRow
              label="Queue"
              status={queue.length > 0 ? 'pending' : 'running'}
              value={`${queue.length} delayed`}
              helper="Delayed dispatch records are persisted in Redis."
            />
            <StateRow
              label="Actions"
              status={runtime?.dryRun ? 'pending' : 'running'}
              value={runtime?.dryRun ? 'Dry run' : 'Live'}
              helper="Controlled by the Dry run actions setting."
            />
          </div>
          <div className="snapshot-list">
            <SnapshotRow
              label="Latest activity"
              value={latest?.title || latest?.target || 'Nothing processed yet'}
              href={latest?.targetUrl}
              helper={latest ? formatDate(latest.timestamp) : ''}
            />
            <SnapshotRow
              label="Action health"
              value={stats.errors === 0 ? 'No retained failures' : `${stats.errors} retained failures`}
              helper="Derived from action audit records"
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StateRow({ label, status, value, helper }) {
  const badgeStatus = status === 'running' ? 'success' : status === 'paused' ? 'warning' : 'pending';
  return (
    <div className="state-row">
      <div>
        <strong>{label}</strong>
        <span>{helper}</span>
      </div>
      <Badge status={badgeStatus}>{value}</Badge>
    </div>
  );
}

function SnapshotRow({ label, value, helper, href }) {
  return (
    <div className="snapshot-row">
      <span className="snapshot-label">{label}</span>
      <EntityLink href={href} className="snapshot-value">
        {value}
      </EntityLink>
      {helper ? <span className="snapshot-helper">{helper}</span> : null}
    </div>
  );
}

function SkeletonRows({ count }) {
  return Array.from({ length: count }, (_, index) => (
    <div className="skeleton-row" key={index}>
      <span />
      <span />
    </div>
  ));
}

function GridPanel({ title, subtitle, rowData, columnDefs, loading, searchPlaceholder, compact = false }) {
  const [quickFilterText, setQuickFilterText] = useState('');
  const defaultColDef = useMemo(
    () => ({
      sortable: true,
      filter: true,
      resizable: true,
      minWidth: 120,
      flex: 1,
    }),
    []
  );

  return (
    <section className={`content-panel full-height grid-panel ${compact ? 'compact-grid-panel' : ''}`}>
      <div className="panel-header">
        <div>
          <h3>{title}</h3>
          {subtitle ? <p className="panel-subtitle">{subtitle}</p> : null}
        </div>
        <input
          type="search"
          value={quickFilterText}
          onChange={(event) => setQuickFilterText(event.target.value)}
          placeholder={searchPlaceholder ?? 'Search rows...'}
          className="search-input"
        />
      </div>
      <div className={`grid-shell ag-theme-quartz-dark ${compact ? 'compact-grid-shell' : ''}`}>
        {loading ? <div className="grid-loading"><Spinner label="Loading rows" /></div> : null}
        <AgGridReact
          rowData={rowData}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          pagination
          paginationPageSize={10}
          paginationPageSizeSelector={[10, 25, 50]}
          quickFilterText={quickFilterText}
          animateRows
          rowHeight={compact ? 44 : 52}
          headerHeight={compact ? 42 : 48}
          overlayNoRowsTemplate="<span class='empty-state'>No records found.</span>"
        />
      </div>
    </section>
  );
}

function AuditLog({ data, loading }) {
  const columnDefs = useMemo(
    () => [
      {
        field: 'timestamp',
        headerName: 'When',
        valueFormatter: ({ value }) => formatDate(value),
        sort: 'desc',
        minWidth: 180,
      },
      {
        field: 'action',
        headerName: 'Event',
        minWidth: 220,
        cellRenderer: ({ data }) => (
          <div className="grid-primary-cell">
            <strong>{data?.source === 'dry-run' ? 'Checked rules' : 'Executed actions'}</strong>
            <span>{data?.rule}</span>
          </div>
        ),
      },
      { field: 'status', headerName: 'Status', cellRenderer: ({ value }) => <Badge status={value}>{value}</Badge>, minWidth: 120 },
      {
        field: 'title',
        headerName: 'Content',
        minWidth: 300,
        cellRenderer: ({ data }) => (
          <div className="grid-primary-cell">
            <EntityLink href={data?.targetUrl} className="grid-content-link">
              {data?.title || `${humanTargetKind(data?.targetKind)} ${data?.target}`}
            </EntityLink>
            <span>{data?.authorName ? `u/${data.authorName}` : 'unknown author'} / <span className="mono-muted">{data?.target}</span></span>
          </div>
        ),
      },
      { field: 'targetKind', headerName: 'Type', valueFormatter: ({ value }) => humanTargetKind(value), minWidth: 110 },
      { field: 'checksTriggered', headerName: 'Checks', valueFormatter: ({ data }) => `${data?.checksTriggered ?? 0}/${data?.checksEvaluated ?? 0}`, minWidth: 110 },
      { field: 'plannedActions', headerName: 'Planned', type: 'numericColumn', minWidth: 110 },
      { field: 'executed', headerName: 'Done', type: 'numericColumn', minWidth: 100 },
      { field: 'skipped', headerName: 'Skipped', type: 'numericColumn', minWidth: 110 },
      { field: 'failed', headerName: 'Failed', type: 'numericColumn', minWidth: 100 },
      { field: 'configSource', headerName: 'Config', minWidth: 220 },
    ],
    []
  );

  return (
    <GridPanel
      title="Action Audit Log"
      subtitle="Deduplicated by real executions so a normal run does not show as both dry-run and executed."
      rowData={data?.auditLogs ?? []}
      columnDefs={columnDefs}
      loading={loading}
      searchPlaceholder="Search audit records..."
    />
  );
}

function DispatchQueue({ data, loading }) {
  const columnDefs = useMemo(
    () => [
      { field: 'runAt', headerName: 'Runs At', valueFormatter: ({ value }) => formatDate(value), sort: 'asc', minWidth: 180 },
      { field: 'createdAt', headerName: 'Queued', valueFormatter: ({ value }) => formatDate(value), minWidth: 180 },
      {
        field: 'target',
        headerName: 'Target',
        minWidth: 220,
        cellRenderer: ({ data }) => (
          <div className="grid-primary-cell">
            <TargetLink value={data?.target} data={data} />
            <span>{humanTargetKind(data?.targetKind)}</span>
          </div>
        ),
      },
      { field: 'subredditName', headerName: 'Subreddit', valueFormatter: ({ value }) => (value ? `r/${value}` : '-'), minWidth: 150 },
      { field: 'rule', headerName: 'Rule or Follow-up', minWidth: 190 },
      { field: 'dryRun', headerName: 'Dry Run', valueFormatter: ({ value }) => (value ? 'Yes' : 'No'), minWidth: 120 },
      { field: 'retryCount', headerName: 'Retries', type: 'numericColumn', minWidth: 110 },
      {
        field: 'failed',
        headerName: 'Status',
        cellRenderer: ({ value }) => <Badge status={value ? 'error' : 'pending'}>{value ? 'Retry' : 'Pending'}</Badge>,
        minWidth: 120,
      },
      { field: 'schedulerJobId', headerName: 'Scheduler Job', minWidth: 220 },
      { field: 'id', headerName: 'Dispatch ID', minWidth: 220 },
    ],
    []
  );

  return (
    <GridPanel
      title="Dispatch Queue"
      subtitle="Sortable scheduled work with target links, retry state, and job metadata."
      rowData={data?.dispatchQueue ?? []}
      columnDefs={columnDefs}
      loading={loading}
      searchPlaceholder="Search dispatches..."
    />
  );
}

function LogsView({ data, loading }) {
  const columnDefs = useMemo(
    () => [
      {
        field: 'timestamp',
        headerName: 'When',
        valueFormatter: ({ value }) => formatDate(value),
        sort: 'desc',
        minWidth: 180,
      },
      { field: 'level', headerName: 'Level', cellRenderer: ({ value }) => <Badge status={value === 'error' ? 'error' : value === 'warn' ? 'warning' : 'info'}>{value}</Badge>, minWidth: 110 },
      { field: 'source', headerName: 'Source', minWidth: 130 },
      {
        field: 'message',
        headerName: 'Message',
        minWidth: 420,
        cellRenderer: ({ data }) => (
          <EntityLink href={data?.targetUrl} className="grid-content-link">
            {data?.message}
          </EntityLink>
        ),
      },
      { field: 'subredditName', headerName: 'Subreddit', valueFormatter: ({ value }) => (value ? `r/${value}` : '-'), minWidth: 140 },
    ],
    []
  );

  return (
    <GridPanel
      title="Runtime Logs"
      subtitle="Devvit cannot expose the old daemon log stream, so this view reconstructs operational logs from config, audit, and dispatch records."
      rowData={data?.logs ?? []}
      columnDefs={columnDefs}
      loading={loading}
      searchPlaceholder="Search logs..."
    />
  );
}

function OperationsView({ data, onRefresh }) {
  const [runningKey, setRunningKey] = useState('');
  const [message, setMessage] = useState('');
  const [messageTone, setMessageTone] = useState('info');

  const runOperation = useCallback(
    async (operation) => {
      if (!operation.available || !operation.endpoint) {
        return;
      }
      setRunningKey(operation.key);
      setMessage(`${operation.label} running...`);
      setMessageTone('info');
      try {
        const response = await fetch(
          `${operation.endpoint}?subredditName=${encodeURIComponent(subredditName())}`,
          { method: operation.method ?? 'POST' }
        );
        const result = await response.json();
        if (!response.ok || result.error) {
          throw new Error(result.error || `Failed with status ${response.status}`);
        }
        setMessage(result.message || `${operation.label} complete.`);
        setMessageTone(result.ok === false ? 'error' : 'success');
        await onRefresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
        setMessageTone('error');
      } finally {
        setRunningKey('');
      }
    },
    [onRefresh]
  );

  return (
    <div className="operations-layout">
      <section className="content-panel">
        <div className="panel-header">
          <div>
            <h3>Manual Operations</h3>
            <p className="panel-subtitle">Ported dashboard actions backed by Devvit APIs.</p>
          </div>
        </div>
        <div className="operation-list">
          {(data?.operations ?? []).map((operation) => (
            <div className="operation-row" key={operation.key}>
              <div>
                <strong>{operation.label}</strong>
                <span>{operation.description}</span>
              </div>
              <button
                className="btn btn-secondary"
                type="button"
                disabled={!operation.available || runningKey === operation.key}
                onClick={() => runOperation(operation)}
              >
                {runningKey === operation.key ? <span className="spinner mini" /> : <span className="btn-icon">GO</span>}
                {operation.available ? 'Run' : 'Legacy Only'}
              </button>
            </div>
          ))}
        </div>
        {message ? <div className={`operation-message ${messageTone}`}>{message}</div> : null}
      </section>

      <section className="content-panel">
        <div className="panel-header">
          <div>
            <h3>Legacy Control Mapping</h3>
            <p className="panel-subtitle">How old dashboard buttons translate in this Devvit port.</p>
          </div>
        </div>
        <div className="mapping-list">
          <DetailRow label="Start / stop bot" value="Use Devvit install state and Enable event processing setting" />
          <DetailRow label="Start / pause events" value="Enable event processing controls submit triggers" />
          <DetailRow label="Check modqueue" value="Run Scan Modqueue" />
          <DetailRow label="Reload config" value="Validate Config or Save Config" />
          <DetailRow label="Queue workers" value="Devvit scheduler and dispatch records" />
        </div>
      </section>
    </div>
  );
}

function ConfigViewer({ data, setData }) {
  const containerRef = useRef(null);
  const editorRef = useRef(null);
  const modelRef = useRef(null);
  const validationTimerRef = useRef(null);
  const [status, setStatus] = useState('');
  const [statusTone, setStatusTone] = useState('info');
  const [saving, setSaving] = useState(false);
  const [schemaErrors, setSchemaErrors] = useState([]);
  const [validatingSchema, setValidatingSchema] = useState(true);
  const [selectedRevision, setSelectedRevision] = useState(null);
  const [loadingRevision, setLoadingRevision] = useState(false);
  const [revisionError, setRevisionError] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [showRevisionModal, setShowRevisionModal] = useState(false);
  const [saveReason, setSaveReason] = useState('');
  const config = data?.config;
  const history = config?.history ?? [];
  const hasSchemaErrors = schemaErrors.length > 0;

  useEffect(() => {
    if (!containerRef.current || editorRef.current) {
      return;
    }
    const model =
      monaco.editor.getModel(configModelUri) ??
      monaco.editor.createModel('Loading configuration...', 'yaml', configModelUri);
    modelRef.current = model;

    editorRef.current = monaco.editor.create(containerRef.current, {
      model,
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
      fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
      lineNumbers: 'on',
      roundedSelection: true,
      scrollBeyondLastLine: false,
      readOnly: false,
      tabSize: 2,
      insertSpaces: true,
    });

    const syncMarkers = () => {
      const markers = monaco.editor
        .getModelMarkers({ resource: model.uri })
        .filter((marker) => marker.severity === monaco.MarkerSeverity.Error);
      setSchemaErrors(markers);
      setValidatingSchema(false);
      if (validationTimerRef.current !== null) {
        window.clearTimeout(validationTimerRef.current);
        validationTimerRef.current = null;
      }
    };
    const markerSubscription = monaco.editor.onDidChangeMarkers((resources) => {
      if (resources.some((resource) => resource.toString() === model.uri.toString())) {
        syncMarkers();
      }
    });
    const contentSubscription = model.onDidChangeContent(() => {
      setStatus('');
      setValidatingSchema(true);
      if (validationTimerRef.current !== null) {
        window.clearTimeout(validationTimerRef.current);
      }
      validationTimerRef.current = window.setTimeout(syncMarkers, 800);
    });
    const initialMarkerTimer = window.setTimeout(syncMarkers, 500);

    return () => {
      window.clearTimeout(initialMarkerTimer);
      if (validationTimerRef.current !== null) {
        window.clearTimeout(validationTimerRef.current);
      }
      markerSubscription.dispose();
      contentSubscription.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !config) {
      return;
    }
    const nextValue =
      config.ok === false ? config.error || 'Configuration not found.' : config.data || '';
    if (editor.getValue() !== nextValue) {
      editor.setValue(nextValue);
    }
  }, [config]);

  const collectSchemaErrors = useCallback(async () => {
    const model = modelRef.current;
    if (!model) {
      return [];
    }

    await new Promise((resolve) => window.setTimeout(resolve, 650));
    const markers = monaco.editor
      .getModelMarkers({ resource: model.uri })
      .filter((marker) => marker.severity === monaco.MarkerSeverity.Error);
    setSchemaErrors(markers);
    setValidatingSchema(false);
    return markers;
  }, []);

  const validateWithServer = useCallback(async (yaml) => {
    const response = await fetch('/api/config/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        yaml,
        sourceName: config?.source ?? 'dashboard editor',
      }),
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) {
      const schemaDetails = Array.isArray(result.schemaErrors) && result.schemaErrors.length > 0
        ? ` ${result.schemaErrors.slice(0, 3).join('; ')}`
        : '';
      throw new Error(result.message || result.error || `Config validation failed.${schemaDetails}`);
    }
    return result;
  }, [config?.source]);

  const persistConfig = useCallback(
    async (yaml, successMessage, customReason, skipRevision = false) => {
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subredditName: subredditName(), yaml, reason: customReason, skipRevision }),
      });
      const result = await response.json();
      if (!response.ok || result.error) {
        throw new Error(result.error || `Failed with status ${response.status}`);
      }
      const refreshed = await loadDashboardData();
      setData(refreshed);
      setStatus(successMessage);
      setStatusTone('success');
    },
    [setData]
  );

  const saveConfig = useCallback(async () => {
    const editor = editorRef.current;
    const yaml = editor?.getValue() ?? '';
    setSaving(true);
    setStatus('Saving configuration...');
    setStatusTone('info');

    const markers = await collectSchemaErrors();
    if (markers.length > 0) {
      setStatus(`Please fix schema validation errors before saving: ${markers[0]?.message ?? 'invalid config'}`);
      setStatusTone('error');
      setSaving(false);
      return;
    }

    try {
      setStatus('Validating configuration...');
      await validateWithServer(yaml);
      await persistConfig(yaml, 'Configuration saved successfully.', saveReason);
      setSaveReason('');
    } catch (error) {
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
      setStatusTone('error');
    } finally {
      setSaving(false);
    }
  }, [collectSchemaErrors, persistConfig, validateWithServer, saveReason]);

  const loadRevision = useCallback(async (revisionId) => {
    setLoadingRevision(true);
    setRevisionError('');
    setShowRevisionModal(true);
    try {
      const response = await fetch(`/api/config/revision/${encodeURIComponent(revisionId)}`, {
        cache: 'no-store',
      });
      const result = await response.json();
      if (!response.ok || result.error) {
        throw new Error(result.error || `Failed with status ${response.status}`);
      }
      setSelectedRevision(result.revision);
    } catch (error) {
      setRevisionError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingRevision(false);
    }
  }, []);

  const applyRevisionToEditor = useCallback(() => {
    if (!selectedRevision || !editorRef.current) {
      return;
    }
    editorRef.current.setValue(selectedRevision.content ?? '');
    setStatus(`Loaded revision from ${formatDate(selectedRevision.createdAt)} into the editor.`);
    setStatusTone('info');
    setShowRevisionModal(false);
  }, [selectedRevision]);

  const restoreRevision = useCallback(async () => {
    if (!selectedRevision) {
      return;
    }
    setSaving(true);
    setStatus('Restoring selected revision...');
    setStatusTone('info');
    setShowRevisionModal(false);
    try {
      await persistConfig(
        selectedRevision.content ?? '',
        `Restored revision from ${formatDate(selectedRevision.createdAt)}.`,
        `Restored: ${selectedRevision.reason || 'Previous config'}`,
        true
      );
    } catch (error) {
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
      setStatusTone('error');
    } finally {
      setSaving(false);
    }
  }, [persistConfig, selectedRevision]);

  const deleteRevision = useCallback(async () => {
    if (!selectedRevision) {
      return;
    }
    setSaving(true);
    setStatus('Deleting revision...');
    setStatusTone('info');
    try {
      const response = await fetch(`/api/config/revision/${encodeURIComponent(selectedRevision.id)}`, {
        method: 'DELETE',
      });
      const result = await response.json();
      if (!response.ok || result.error) {
        throw new Error(result.error || `Failed with status ${response.status}`);
      }
      
      const refreshed = await loadDashboardData();
      setData(refreshed);
      setStatus('Revision deleted successfully.');
      setStatusTone('success');
      setShowRevisionModal(false);
    } catch (error) {
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
      setStatusTone('error');
    } finally {
      setSaving(false);
    }
  }, [selectedRevision, loadDashboardData, setData]);

  return (
    <div className={`config-layout ${showHistory ? 'show-history' : ''}`}>
      <section className="content-panel full-height config-editor-panel">
        <div className="panel-header">
          <div>
            <h3>Active Configuration</h3>
            <p className="panel-subtitle">Edit YAML with schema validation before saving back to the configured wiki page.</p>
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <span className="badge badge-info">{config?.source ?? 'Unknown'}</span>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => setShowHistory(!showHistory)}>
              {showHistory ? 'Hide' : 'View History'}
            </button>
          </div>
        </div>
        <div className="editor-shell" ref={containerRef} />
        <div className="editor-footer">
          <span className={`save-status ${statusTone}`}>
            {status ||
              (validatingSchema
                ? 'Validating schema...'
                : hasSchemaErrors
                  ? `${schemaErrors.length} schema error${schemaErrors.length === 1 ? '' : 's'} found`
                  : 'Schema validation active')}
          </span>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <input
              type="text"
              className="search-input"
              style={{ width: '250px' }}
              placeholder="Title (e.g. Strict Rules)"
              value={saveReason}
              onChange={(e) => setSaveReason(e.target.value)}
              disabled={saving}
            />
            <button className="btn btn-primary" type="button" onClick={saveConfig} disabled={saving || hasSchemaErrors}>
              {saving ? <span className="spinner mini" /> : ""}
              {saving ? 'Saving' : 'Save'}
            </button>
          </div>
        </div>
      </section>

      {showHistory && (
        <RevisionHistory
          revisions={history}
          selectedRevision={selectedRevision}
          loadingRevision={loadingRevision}
          revisionError={revisionError}
          onViewRevision={loadRevision}
          onApplyRevision={applyRevisionToEditor}
          onRestoreRevision={restoreRevision}
          onDeleteRevision={deleteRevision}
          saving={saving}
          showRevisionModal={showRevisionModal}
          setShowRevisionModal={setShowRevisionModal}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  );
}

function RevisionHistory({
  revisions,
  selectedRevision,
  loadingRevision,
  revisionError,
  onViewRevision,
  onApplyRevision,
  onRestoreRevision,
  onDeleteRevision,
  saving,
  showRevisionModal,
  setShowRevisionModal,
  onClose,
}) {
  return (
    <>
      <section className="content-panel revision-panel slide-in-right">
        <div className="panel-header">
          <div>
            <h3>Recent Revisions</h3>
            <p className="panel-subtitle">Open a saved config, compare it, then load or restore it.</p>
          </div>
          <button className="btn btn-secondary btn-sm" type="button" onClick={onClose} style={{ marginLeft: 'auto' }}>
            Close
          </button>
        </div>
        <div className="revision-layout">
          <div className="revision-list" style={{ width: '100%' }}>
            {revisions.length === 0 ? <div className="empty-state">No dashboard-saved revisions yet.</div> : null}
            {revisions.map((revision) => (
              <button
                key={revision.id}
                type="button"
                className={`revision-item ${selectedRevision?.id === revision.id ? 'active' : ''}`}
                onClick={() => onViewRevision(revision.id)}
              >
                <span className="revision-time">{formatDate(revision.createdAt)}</span>
                <strong>{revision.reason}</strong>
                <span>{revision.pageName}</span>
                <span className="revision-meta">{formatBytes(revision.sizeBytes)} / {revision.source}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {showRevisionModal && (
        <div className="modal-overlay">
          <div className="modal-content revision-modal">
            <div className="modal-header">
              <h3>Revision Details</h3>
              <button className="btn-icon" onClick={() => setShowRevisionModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              {loadingRevision ? <Spinner label="Loading revision" /> : null}
              {revisionError ? <div className="error-banner">{revisionError}</div> : null}
              {selectedRevision && !loadingRevision ? (
                <>
                  <div className="revision-preview-header">
                    <div>
                      <strong>{selectedRevision.reason}</strong>
                      <span>{formatDate(selectedRevision.createdAt)} / {formatBytes(selectedRevision.sizeBytes)}</span>
                    </div>
                  </div>
                  <pre className="revision-code">{selectedRevision.content || selectedRevision.preview}</pre>
                </>
              ) : null}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" type="button" onClick={() => setShowRevisionModal(false)}>
                Back
              </button>
              {selectedRevision && !loadingRevision ? (
                <button className="btn btn-secondary" type="button" onClick={onDeleteRevision} disabled={saving} style={{ color: 'var(--red-400)', borderColor: 'var(--red-900)' }}>
                  {saving ? 'Deleting...' : 'Delete'}
                </button>
              ) : null}
              <div style={{ flex: 1 }}></div>
              {selectedRevision && !loadingRevision ? (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="btn btn-primary" type="button" onClick={onRestoreRevision} disabled={saving}>
                    {saving ? 'Restoring...' : 'Restore to Wiki'}
                  </button>
                  <button className="btn btn-primary" type="button" onClick={onApplyRevision}>
                    Load in Editor
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function App() {
  const [activeView, setActiveView] = useState('overview');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await loadDashboardData());
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeLabel = views.find((view) => view.id === activeView)?.label ?? 'Overview';

  return (
    <div className="app-container">
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <button 
            type="button"
            className="logo-icon" 
            style={{ border: 'none', cursor: 'pointer', padding: 0 }} 
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title="Toggle Sidebar"
          />
          <h2>ContextMod</h2>
        </div>
        <nav className="nav-menu">
          {views.map((view) => (
            <button
              type="button"
              key={view.id}
              className={`nav-item ${activeView === view.id ? 'active' : ''}`}
              onClick={() => setActiveView(view.id)}
              title={view.label}
            >
              <span className="nav-icon">{view.icon}</span>
              <span className="nav-label">{view.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="status-indicator online" />
          <span>Service Active</span>
        </div>
      </aside>

      <main className="main-content">
        <header className="top-header">
          <div>
            <h1>{activeLabel}</h1>
            <p className="header-subtitle">
              {data?.generatedAt ? `Last updated ${formatDate(data.generatedAt)}` : 'Loading dashboard data'}
            </p>
          </div>
          <button className="btn btn-secondary" type="button" onClick={refresh} disabled={loading}>
            {loading ? <span className="spinner mini" /> : ""}
            {loading ? 'Refreshing' : 'Refresh'}
          </button>
        </header>

        {error ? <div className="error-banner">{error}</div> : null}

        {activeView === 'overview' ? <Overview data={data} loading={loading} /> : null}
        {activeView === 'status' ? <StatusView data={data} /> : null}
        {activeView === 'audit' ? <AuditLog data={data} loading={loading} /> : null}
        {activeView === 'logs' ? <LogsView data={data} loading={loading} /> : null}
        {activeView === 'config' ? <ConfigViewer data={data} setData={setData} /> : null}
        {activeView === 'dispatch' ? <DispatchQueue data={data} loading={loading} /> : null}
        {activeView === 'operations' ? <OperationsView data={data} onRefresh={refresh} /> : null}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
