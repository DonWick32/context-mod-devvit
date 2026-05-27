import JSON5 from 'json5';
import { parse as parseYaml } from 'yaml';
import {
  actionKinds,
  activityKinds,
  type ActionKind,
  type ConfigFormat,
  type ConfigInclude,
  type ConfigParseResult,
  type MigrationWarning,
  type NormalizedAction,
  type NormalizedCheck,
  type NormalizedConfig,
  type NormalizedRule,
  type NormalizedRun,
  pollOnKinds,
  ruleKinds,
  type RuleKind,
  type UnknownRecord,
} from './legacyTypes';

type ParserState = {
  warnings: MigrationWarning[];
};

const DEFAULT_SOURCE_NAME = 'inline config';

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const hasKind = <T extends readonly string[]>(
  kinds: T,
  kind: unknown
): kind is T[number] => isString(kind) && kinds.includes(kind);

const normalizeCondition = (value: unknown): 'AND' | 'OR' =>
  value === 'OR' ? 'OR' : 'AND';

const normalizeEnabled = (value: unknown): boolean => value !== false;

const addWarning = (
  state: ParserState,
  warning: Omit<MigrationWarning, 'severity'> & {
    severity?: MigrationWarning['severity'];
  }
) => {
  state.warnings.push({
    severity: warning.severity ?? 'warning',
    ...warning,
  });
};

const looksLikeJson5 = (text: string): boolean => {
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
};

export const detectLegacyConfigFormat = (text: string): ConfigFormat =>
  looksLikeJson5(text) ? 'json5' : 'yaml';

export const parseLegacyConfigDocument = (
  text: string,
  format: ConfigFormat
): unknown =>
  format === 'json5' ? JSON5.parse(text) : parseYaml(text);

const asInclude = (value: unknown): ConfigInclude | undefined => {
  if (isString(value) && /^(wiki|url):/.test(value)) {
    return { path: value };
  }

  if (isRecord(value) && isString(value.path)) {
    const include: ConfigInclude = { path: value.path };
    if (isString(value.type)) {
      include.type = value.type;
    }
    if (
      typeof value.ttl === 'number' ||
      typeof value.ttl === 'boolean' ||
      value.ttl === 'response'
    ) {
      include.ttl = value.ttl;
    }
    return include;
  }

  return undefined;
};

const inspectInclude = (include: ConfigInclude, state: ParserState, path: string) => {
  if (include.path.startsWith('url:')) {
    addWarning(state, {
      code: 'external-fetch-domain',
      path,
      severity: 'needs-decision',
      message:
        'External URL config fragments require exact fetch-domain approval or removal.',
    });
  }

  if (include.path.startsWith('wiki:') && include.path.includes('|')) {
    addWarning(state, {
      code: 'devvit-behavior-change',
      path,
      severity: 'needs-decision',
      message:
        'Cross-subreddit wiki config fragments need explicit Devvit feasibility testing and permissions review.',
    });
  }
};

const inspectObjectForFetchSensitiveFeatures = (
  config: UnknownRecord,
  state: ParserState,
  path: string
) => {
  if (config.kind === 'mhs') {
    addWarning(state, {
      code: 'unsupported-rule',
      path,
      severity: 'needs-decision',
      message:
        'The legacy MHS/toxicity provider is not compatible with the stated fetch policy; replace or remove this rule.',
    });
  }

  if (config.kind === 'repost' && JSON.stringify(config).includes('"external"')) {
    addWarning(state, {
      code: 'external-fetch-domain',
      path,
      severity: 'needs-decision',
      message:
        'Repost external facets may require API-specific fetch-domain approval.',
    });
  }

  if (config.kind === 'usernote') {
    addWarning(state, {
      code: 'devvit-behavior-change',
      path,
      severity: 'needs-decision',
      message:
        'Toolbox user notes require wiki read/write compatibility testing under Devvit.',
    });
  }
};

const normalizeRule = (
  raw: unknown,
  state: ParserState,
  path: string
): NormalizedRule => {
  const include = asInclude(raw);
  if (include) {
    inspectInclude(include, state, path);
    return { type: 'include', include };
  }

  if (isString(raw)) {
    return { type: 'reference', ref: raw };
  }

  if (!isRecord(raw)) {
    throw new Error(`${path} must be a rule object, rule set, reference, or include.`);
  }

  if (Array.isArray(raw.rules)) {
    const name = isString(raw.name) ? raw.name : undefined;
    return {
      type: 'ruleSet',
      ...(name === undefined ? {} : { name }),
      condition: normalizeCondition(raw.condition),
      rules: raw.rules.map((rule, index) =>
        normalizeRule(rule, state, `${path}.rules[${index}]`)
      ),
      config: raw,
    };
  }

  if (!hasKind(ruleKinds, raw.kind)) {
    addWarning(state, {
      code: 'unsupported-rule',
      path,
      severity: 'needs-decision',
      message: `Rule kind "${String(raw.kind)}" is not recognized by the legacy migration parser.`,
    });
    throw new Error(`${path}.kind must be one of: ${ruleKinds.join(', ')}.`);
  }

  inspectObjectForFetchSensitiveFeatures(raw, state, path);

  const name = isString(raw.name) ? raw.name : undefined;
  return {
    type: 'rule',
    kind: raw.kind as RuleKind,
    ...(name === undefined ? {} : { name }),
    config: raw,
  };
};

const normalizeAction = (
  raw: unknown,
  state: ParserState,
  path: string
): NormalizedAction => {
  const include = asInclude(raw);
  if (include) {
    inspectInclude(include, state, path);
    return { type: 'include', include };
  }

  if (isString(raw)) {
    return { type: 'reference', ref: raw };
  }

  if (!isRecord(raw)) {
    throw new Error(`${path} must be an action object, reference, or include.`);
  }

  if (!hasKind(actionKinds, raw.kind)) {
    addWarning(state, {
      code: 'unsupported-action',
      path,
      severity: 'needs-decision',
      message: `Action kind "${String(raw.kind)}" is not recognized by the legacy migration parser.`,
    });
    throw new Error(`${path}.kind must be one of: ${actionKinds.join(', ')}.`);
  }

  inspectObjectForFetchSensitiveFeatures(raw, state, path);

  const name = isString(raw.name) ? raw.name : undefined;
  return {
    type: 'action',
    kind: raw.kind as ActionKind,
    ...(name === undefined ? {} : { name }),
    enabled: normalizeEnabled(raw.enable),
    config: raw,
  };
};

const normalizeCheck = (
  raw: unknown,
  state: ParserState,
  path: string
): NormalizedCheck => {
  const include = asInclude(raw);
  if (include) {
    inspectInclude(include, state, path);
    throw new Error(
      `${path} is a config include. Include hydration is tracked but not implemented in this slice.`
    );
  }

  if (!isRecord(raw)) {
    throw new Error(`${path} must be a check object.`);
  }

  if (!isString(raw.name) || raw.name.trim().length === 0) {
    throw new Error(`${path}.name is required.`);
  }

  if (!hasKind(activityKinds, raw.kind)) {
    throw new Error(`${path}.kind must be "submission" or "comment".`);
  }

  const rules = raw.rules === undefined ? [] : raw.rules;
  const actions = raw.actions === undefined ? [] : raw.actions;

  if (!Array.isArray(rules)) {
    throw new Error(`${path}.rules must be an array when provided.`);
  }
  if (!Array.isArray(actions)) {
    throw new Error(`${path}.actions must be an array when provided.`);
  }

  const description = isString(raw.description) ? raw.description : undefined;
  return {
    name: raw.name.trim(),
    ...(description === undefined ? {} : { description }),
    kind: raw.kind,
    enabled: normalizeEnabled(raw.enable),
    condition: normalizeCondition(raw.condition),
    rules: rules.map((rule, index) =>
      normalizeRule(rule, state, `${path}.rules[${index}]`)
    ),
    actions: actions.map((action, index) =>
      normalizeAction(action, state, `${path}.actions[${index}]`)
    ),
    config: raw,
  };
};

const normalizeRun = (
  raw: unknown,
  state: ParserState,
  path: string,
  fallbackName: string
): NormalizedRun => {
  const include = asInclude(raw);
  if (include) {
    inspectInclude(include, state, path);
    throw new Error(
      `${path} is a config include. Include hydration is tracked but not implemented in this slice.`
    );
  }

  if (!isRecord(raw)) {
    throw new Error(`${path} must be a run object.`);
  }

  if (!Array.isArray(raw.checks)) {
    throw new Error(`${path}.checks must be an array.`);
  }

  return {
    name: isString(raw.name) && raw.name.trim().length > 0 ? raw.name.trim() : fallbackName,
    enabled: normalizeEnabled(raw.enable),
    checks: raw.checks.map((check, index) =>
      normalizeCheck(check, state, `${path}.checks[${index}]`)
    ),
    config: raw,
  };
};

const getPolling = (
  document: UnknownRecord,
  state: ParserState
): unknown[] => {
  if (document.polling === undefined) {
    return ['unmoderated'];
  }

  if (!Array.isArray(document.polling)) {
    addWarning(state, {
      code: 'legacy-polling',
      path: 'polling',
      message: 'Polling config must be an array; using an empty normalized polling list.',
    });
    return [];
  }

  for (const [index, entry] of document.polling.entries()) {
    const pollOn = isString(entry) ? entry : isRecord(entry) ? entry.pollOn : undefined;
    if (!hasKind(pollOnKinds, pollOn)) {
      addWarning(state, {
        code: 'legacy-polling',
        path: `polling[${index}]`,
        severity: 'needs-decision',
        message:
          'Legacy polling source must be mapped to Devvit triggers or scheduled scans.',
      });
    }
  }

  return document.polling;
};

const inspectTopLevelConfig = (document: UnknownRecord, state: ParserState) => {
  if (document.notifications !== undefined) {
    addWarning(state, {
      code: 'external-fetch-domain',
      path: 'notifications',
      severity: 'needs-decision',
      message:
        'Discord notifications require fetch-domain documentation if retained.',
    });
  }

  if (document.databaseStatistics !== undefined || document.retention !== undefined) {
    addWarning(state, {
      code: 'storage-decision',
      path: 'databaseStatistics',
      severity: 'needs-decision',
      message:
        'Legacy database/statistics retention needs a Redis-bounded design or Supabase decision.',
    });
  }

  if (document.sharing !== undefined) {
    addWarning(state, {
      code: 'devvit-behavior-change',
      path: 'sharing',
      severity: 'needs-decision',
      message:
        'Config sharing ACLs need a Devvit-specific design, especially across subreddits.',
    });
  }
};

export const normalizeLegacyConfig = (
  document: unknown,
  format: ConfigFormat,
  sourceName = DEFAULT_SOURCE_NAME
): NormalizedConfig => {
  const state: ParserState = { warnings: [] };
  let root: UnknownRecord;
  let runs: NormalizedRun[];

  if (Array.isArray(document)) {
    root = { checks: document };
    runs = [
      normalizeRun(
        { name: 'default', checks: document },
        state,
        'runs[0]',
        'default'
      ),
    ];
  } else if (isRecord(document)) {
    root = document;
    inspectTopLevelConfig(root, state);

    if (Array.isArray(root.runs)) {
      runs = root.runs.map((run, index) =>
        normalizeRun(run, state, `runs[${index}]`, `Run ${index + 1}`)
      );
    } else if (Array.isArray(root.checks)) {
      runs = [
        normalizeRun(
          { name: 'default', checks: root.checks },
          state,
          'runs[0]',
          'default'
        ),
      ];
    } else {
      throw new Error('Config must define either "runs", "checks", or be a check array.');
    }
  } else {
    throw new Error('Config root must be an object or an array of checks.');
  }

  if (runs.length === 0) {
    throw new Error('Config must contain at least one run.');
  }

  addWarning(state, {
    code: 'devvit-behavior-change',
    path: 'polling',
    severity: 'info',
    message:
      'Legacy polling is not an always-on loop in Devvit; each source must be trigger or scheduler backed.',
  });

  return {
    format,
    sourceName,
    config: root,
    runs,
    polling: getPolling(root, state),
    warnings: state.warnings,
  };
};

export const parseLegacyConfigText = (
  text: string,
  options: { sourceName?: string; format?: ConfigFormat } = {}
): ConfigParseResult => {
  const sourceName = options.sourceName ?? DEFAULT_SOURCE_NAME;
  const warnings: MigrationWarning[] = [];

  if (text.trim().length === 0) {
    return {
      ok: false,
      sourceName,
      errors: ['Config text is empty.'],
      warnings,
    };
  }

  const format = options.format ?? detectLegacyConfigFormat(text);

  try {
    const document = parseLegacyConfigDocument(text, format);
    return {
      ok: true,
      config: normalizeLegacyConfig(document, format, sourceName),
    };
  } catch (error) {
    return {
      ok: false,
      format,
      sourceName,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings,
    };
  }
};

export const summarizeConfigParseResult = (result: ConfigParseResult): string => {
  if (!result.ok) {
    return `Invalid ContextMod config: ${result.errors[0] ?? 'unknown error'}`;
  }

  const checks = result.config.runs.reduce((total, run) => total + run.checks.length, 0);
  const rules = result.config.runs.reduce(
    (total, run) =>
      total +
      run.checks.reduce((runTotal, check) => runTotal + check.rules.length, 0),
    0
  );
  const actions = result.config.runs.reduce(
    (total, run) =>
      total +
      run.checks.reduce((runTotal, check) => runTotal + check.actions.length, 0),
    0
  );
  const decisionCount = result.config.warnings.filter(
    (warning) => warning.severity === 'needs-decision'
  ).length;

  return `Valid ContextMod config: ${result.config.runs.length} run(s), ${checks} check(s), ${rules} rule(s), ${actions} action(s), ${decisionCount} migration decision(s).`;
};
