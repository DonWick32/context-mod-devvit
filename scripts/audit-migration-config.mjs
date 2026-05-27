#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import JSON5 from 'json5';
import YAML from 'yaml';

const SUPPORTED_RULE_KINDS = new Set([
  'author',
  'attribution',
  'history',
  'mhs',
  'recentActivity',
  'regex',
  'repeatActivity',
  'repost',
  'sentiment',
  'toxicity',
]);

const SUPPORTED_ACTION_KINDS = new Set([
  'approve',
  'ban',
  'cancelDispatch',
  'comment',
  'contributor',
  'dispatch',
  'flair',
  'lock',
  'message',
  'modnote',
  'remove',
  'report',
  'submission',
  'userflair',
  'usernote',
]);

const REDDIT_FACETS = new Set(['title', 'url', 'duplicates', 'crossposts']);

const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asArray = (value) => (Array.isArray(value) ? value : []);

const detectFormat = (text) => {
  const trimmed = text.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json5' : 'yaml';
};

export const parseConfigText = (text, format = detectFormat(text)) => {
  if (format === 'json5') {
    return JSON5.parse(text);
  }
  return YAML.parse(text);
};

const addFinding = (findings, severity, message, path, detail) => {
  findings.push({
    severity,
    message,
    path,
    ...(detail === undefined ? {} : { detail }),
  });
};

const addFetchDomain = (report, domain) => {
  report.fetchDomains.add(domain);
};

const getIncludePath = (value) => {
  if (typeof value === 'string' && /^(wiki|url):/.test(value)) {
    return value;
  }

  if (
    isRecord(value) &&
    typeof value.path === 'string' &&
    /^(wiki|url):/.test(value.path)
  ) {
    return value.path;
  }

  return undefined;
};

const getEntries = (document, key) => {
  if (!isRecord(document)) {
    return [];
  }

  return asArray(document[key]);
};

const getRuns = (document) => {
  const runs = getEntries(document, 'runs');
  if (runs.length > 0) {
    return runs;
  }

  const checks = getEntries(document, 'checks');
  return checks.length > 0 ? [{ name: 'default', checks }] : [];
};

const getFacetKinds = (entry) => {
  if (typeof entry === 'string') {
    return [entry];
  }

  if (!isRecord(entry)) {
    return [];
  }

  return Array.isArray(entry.kind) ? entry.kind : [entry.kind];
};

const hasExternalRepostFacet = (searchOn, checkKind) => {
  if (searchOn === undefined) {
    return checkKind === 'comment';
  }

  return asArray(searchOn)
    .flatMap(getFacetKinds)
    .includes('external');
};

const hasRedditFacet = (searchOn, checkKind) => {
  const facets =
    searchOn === undefined
      ? checkKind === 'comment'
        ? ['external', 'duplicates', 'crossposts']
        : ['title', 'url', 'duplicates', 'crossposts']
      : asArray(searchOn).flatMap(getFacetKinds);
  return facets.some((facet) => REDDIT_FACETS.has(facet));
};

const inspectStringValue = (value, path, report) => {
  if (value.startsWith('url:')) {
    addFinding(
      report.findings,
      'blocker',
      'URL-backed config/action content is not ported.',
      path,
      'Move this content into a subreddit wiki page and reference it with wiki:path.'
    );
    report.blockers++;
  }

  if (/discord\.com\/api\/webhooks/i.test(value)) {
    addFetchDomain(report, 'discord.com');
    addFinding(
      report.findings,
      'action',
      'Discord webhook notification needs fetch-domain approval.',
      path,
      'Keep discord.com in devvit.json and document the notification use in README before upload.'
    );
  }
};

const walkStrings = (value, path, report) => {
  if (typeof value === 'string') {
    inspectStringValue(value.trim(), path, report);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      walkStrings(entry, `${path}[${index}]`, report)
    );
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    walkStrings(entry, path === '$' ? `$.${key}` : `${path}.${key}`, report);
  }
};

const inspectInclude = (value, path, report) => {
  const includePath = getIncludePath(value);
  if (includePath === undefined) {
    return false;
  }

  if (includePath.startsWith('wiki:')) {
    report.includes.wiki++;
    if (includePath.includes('|')) {
      addFinding(
        report.findings,
        'warning',
        'Cross-subreddit wiki include needs access testing.',
        path,
        'The Devvit app can hydrate it only when Reddit permissions allow reading that wiki.'
      );
    }
    return true;
  }

  report.includes.url++;
  addFinding(
    report.findings,
    'blocker',
    'External URL include is not ported.',
    path,
    'Move the fragment to a same-subreddit or accessible cross-subreddit wiki page.'
  );
  report.blockers++;
  return true;
};

const inspectRule = (rule, path, report, checkKind) => {
  if (inspectInclude(rule, path, report)) {
    return;
  }

  if (!isRecord(rule)) {
    return;
  }

  if (Array.isArray(rule.rules)) {
    rule.rules.forEach((childRule, index) =>
      inspectRule(childRule, `${path}.rules[${index}]`, report, checkKind)
    );
    return;
  }

  const kind = typeof rule.kind === 'string' ? rule.kind : 'unknown';
  report.rules.total++;
  report.rules.byKind[kind] = (report.rules.byKind[kind] ?? 0) + 1;

  if (!SUPPORTED_RULE_KINDS.has(kind)) {
    addFinding(
      report.findings,
      'warning',
      `Rule kind "${kind}" is not recognized by the Devvit port.`,
      path
    );
  }

  if (kind === 'mhs' || kind === 'toxicity') {
    addFetchDomain(report, 'generativelanguage.googleapis.com');
    addFinding(
      report.findings,
      'action',
      'Legacy toxicity/MHS rule needs Gemini setup.',
      path,
      'Set the Gemini API key app setting and test against representative toxic/non-toxic content.'
    );
  }

  if (kind === 'repost') {
    const criteria = asArray(rule.criteria ?? [{}]);
    criteria.forEach((criterion, index) => {
      if (!isRecord(criterion)) {
        return;
      }

      if (hasExternalRepostFacet(criterion.searchOn, checkKind)) {
        addFetchDomain(report, 'youtube.googleapis.com');
        addFinding(
          report.findings,
          'action',
          'Repost external facet needs YouTube setup.',
          `${path}.criteria[${index}]`,
          'Set the YouTube Data API key app setting. The Devvit port supports YouTube top-level comments.'
        );
      }

      if (!hasRedditFacet(criterion.searchOn, checkKind)) {
        addFinding(
          report.findings,
          'info',
          'Repost criterion only uses external candidates.',
          `${path}.criteria[${index}]`,
          'This is valid for YouTube comment repost checks, but it will not search Reddit duplicates/crossposts.'
        );
      }
    });
  }

  if (kind === 'regex') {
    asArray(rule.criteria).forEach((criterion, index) => {
      if (
        isRecord(criterion) &&
        typeof criterion.regex === 'string' &&
        criterion.regex.trim().startsWith('url:')
      ) {
        addFinding(
          report.findings,
          'blocker',
          'URL-backed regex content is not ported.',
          `${path}.criteria[${index}].regex`,
          'Move the regex body into a wiki page and reference it with wiki:path.'
        );
        report.blockers++;
      }
    });
  }

  if (JSON.stringify(rule).includes('imageDetection')) {
    addFetchDomain(report, 'i.redd.it');
    addFetchDomain(report, 'preview.redd.it');
    addFinding(
      report.findings,
      'action',
      'Image comparison needs Reddit image fetch domains.',
      path,
      'Test hash-based image matching under Devvit time limits with representative image posts.'
    );
  }
};

const inspectAction = (action, path, report) => {
  if (inspectInclude(action, path, report)) {
    return;
  }

  if (!isRecord(action)) {
    return;
  }

  const kind = typeof action.kind === 'string' ? action.kind : 'unknown';
  report.actions.total++;
  report.actions.byKind[kind] = (report.actions.byKind[kind] ?? 0) + 1;

  if (!SUPPORTED_ACTION_KINDS.has(kind)) {
    addFinding(
      report.findings,
      'warning',
      `Action kind "${kind}" is not recognized by the Devvit port.`,
      path
    );
  }

  if (kind === 'comment' && action.asModTeam === true) {
    addFinding(
      report.findings,
      'blocker',
      '`comment.asModTeam` public reply parity is not exposed by Devvit.',
      `${path}.asModTeam`,
      'Use a normal app reply or switch the workflow to modmail/message.'
    );
    report.blockers++;
  }

  if (
    (kind === 'submission' || kind === 'message') &&
    typeof action.subreddit === 'string' &&
    action.subreddit.trim().length > 0
  ) {
    addFinding(
      report.findings,
      'warning',
      'Cross-subreddit action targets need manual review.',
      `${path}.subreddit`,
      'The Devvit port keeps moderator actions scoped to the installed subreddit unless explicitly supported.'
    );
  }
};

export const auditMigrationConfig = (document) => {
  const report = {
    runs: 0,
    checks: 0,
    rules: {
      total: 0,
      byKind: {},
    },
    actions: {
      total: 0,
      byKind: {},
    },
    includes: {
      wiki: 0,
      url: 0,
    },
    fetchDomains: new Set(),
    blockers: 0,
    findings: [],
  };

  walkStrings(document, '$', report);

  const runs = getRuns(document);
  report.runs = runs.length;

  runs.forEach((run, runIndex) => {
    if (inspectInclude(run, `$.runs[${runIndex}]`, report)) {
      return;
    }

    const checks = getEntries(run, 'checks');
    report.checks += checks.length;

    checks.forEach((check, checkIndex) => {
      if (
        inspectInclude(
          check,
          `$.runs[${runIndex}].checks[${checkIndex}]`,
          report
        )
      ) {
        return;
      }

      const checkKind =
        isRecord(check) && typeof check.kind === 'string'
          ? check.kind
          : undefined;
      asArray(check.rules).forEach((rule, ruleIndex) =>
        inspectRule(
          rule,
          `$.runs[${runIndex}].checks[${checkIndex}].rules[${ruleIndex}]`,
          report,
          checkKind
        )
      );
      asArray(check.actions).forEach((action, actionIndex) =>
        inspectAction(
          action,
          `$.runs[${runIndex}].checks[${checkIndex}].actions[${actionIndex}]`,
          report
        )
      );
    });
  });

  return {
    ...report,
    fetchDomains: [...report.fetchDomains].sort(),
    findings: report.findings.sort((left, right) => {
      const severityRank = { blocker: 0, action: 1, warning: 2, info: 3 };
      return (
        severityRank[left.severity] - severityRank[right.severity] ||
        left.path.localeCompare(right.path)
      );
    }),
  };
};

const renderMap = (values) => {
  const entries = Object.entries(values).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return entries.length === 0
    ? '- none'
    : entries.map(([key, count]) => `- ${key}: ${count}`).join('\n');
};

export const renderMarkdownReport = (report, sourceName) => {
  const findings =
    report.findings.length === 0
      ? '- No blockers or warnings found by the static audit.'
      : report.findings
          .map((finding) => {
            const detail =
              finding.detail === undefined ? '' : `\n  - ${finding.detail}`;
            return `- ${finding.severity.toUpperCase()} ${finding.path}: ${finding.message}${detail}`;
          })
          .join('\n');

  const fetchDomains =
    report.fetchDomains.length === 0
      ? '- none'
      : report.fetchDomains.map((domain) => `- ${domain}`).join('\n');

  return `# ContextMod Devvit Migration Audit

Source: ${sourceName}

## Summary

- Runs: ${report.runs}
- Checks: ${report.checks}
- Rules: ${report.rules.total}
- Actions: ${report.actions.total}
- Wiki includes: ${report.includes.wiki}
- URL includes: ${report.includes.url}
- Blockers: ${report.blockers}

## Rule Kinds

${renderMap(report.rules.byKind)}

## Action Kinds

${renderMap(report.actions.byKind)}

## Required Fetch Domains

${fetchDomains}

## Findings

${findings}

## Next Steps

1. Fix every BLOCKER before enabling real actions.
2. Move supported config into the Devvit Raw configuration override or r/<subreddit>/wiki/botconfig/contextbot.
3. Run Validate ContextMod config in the subreddit menu.
4. Keep Dry run actions enabled and test manual runs against representative posts/comments.
5. Enable event processing while keeping Dry run actions enabled, then create new matching content.
6. Disable Dry run actions only after dashboard/status output matches expectations.
`;
};

const usage = () => `Usage:
  npm run migrate:audit -- <legacy-config.yml>
  npm run migrate:audit -- --json <legacy-config.yml>
  cat legacy-config.yml | npm run migrate:audit -- -
`;

const main = async () => {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const positional = args.filter((arg) => arg !== '--json');
  const sourceName = positional[0];

  if (
    sourceName === undefined ||
    sourceName === '--help' ||
    sourceName === '-h'
  ) {
    process.stdout.write(usage());
    return;
  }

  const text =
    sourceName === '-'
      ? await new Promise((resolve, reject) => {
          let data = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (chunk) => {
            data += chunk;
          });
          process.stdin.on('end', () => resolve(data));
          process.stdin.on('error', reject);
        })
      : await readFile(sourceName, 'utf8');

  const document = parseConfigText(text);
  const report = auditMigrationConfig(document);
  process.stdout.write(
    json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderMarkdownReport(report, sourceName)
  );
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
