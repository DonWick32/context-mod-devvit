export const activityKinds = ['submission', 'comment'] as const;
export type ActivityKind = (typeof activityKinds)[number];

export const ruleKinds = [
  'recentActivity',
  'repeatActivity',
  'author',
  'attribution',
  'history',
  'regex',
  'repost',
  'sentiment',
  'mhs',
  'toxicity',
] as const;
export type RuleKind = (typeof ruleKinds)[number];

export const actionKinds = [
  'comment',
  'submission',
  'lock',
  'remove',
  'report',
  'approve',
  'ban',
  'flair',
  'usernote',
  'message',
  'userflair',
  'dispatch',
  'cancelDispatch',
  'contributor',
  'modnote',
] as const;
export type ActionKind = (typeof actionKinds)[number];

export const pollOnKinds = ['unmoderated', 'modqueue', 'newSub', 'newComm'] as const;
export type PollOnKind = (typeof pollOnKinds)[number];

export type UnknownRecord = Record<string, unknown>;

export type MigrationWarningCode =
  | 'legacy-polling'
  | 'external-fetch-domain'
  | 'unsupported-rule'
  | 'unsupported-action'
  | 'unsupported-config'
  | 'storage-decision'
  | 'devvit-behavior-change';

export type MigrationWarningSeverity = 'info' | 'warning' | 'needs-decision';

export type MigrationWarning = {
  code: MigrationWarningCode;
  message: string;
  path: string;
  severity: MigrationWarningSeverity;
};

export type ConfigFormat = 'yaml' | 'json5';

export type ConfigReference = {
  ref: string;
};

export type ConfigInclude = {
  path: string;
  type?: string;
  ttl?: number | boolean | 'response';
};

export type NormalizedRule =
  | {
      type: 'rule';
      kind: RuleKind;
      name?: string;
      config: UnknownRecord;
    }
  | {
      type: 'ruleSet';
      name?: string;
      condition: 'AND' | 'OR';
      rules: NormalizedRule[];
      config: UnknownRecord;
    }
  | {
      type: 'reference';
      ref: string;
    }
  | {
      type: 'include';
      include: ConfigInclude;
    };

export type NormalizedAction =
  | {
      type: 'action';
      kind: ActionKind;
      name?: string;
      enabled: boolean;
      config: UnknownRecord;
    }
  | {
      type: 'reference';
      ref: string;
    }
  | {
      type: 'include';
      include: ConfigInclude;
    };

export type NormalizedCheck = {
  name: string;
  description?: string;
  kind: ActivityKind;
  enabled: boolean;
  condition: 'AND' | 'OR';
  rules: NormalizedRule[];
  actions: NormalizedAction[];
  config: UnknownRecord;
};

export type NormalizedRun = {
  name: string;
  enabled: boolean;
  checks: NormalizedCheck[];
  config: UnknownRecord;
};

export type NormalizedConfig = {
  format: ConfigFormat;
  sourceName: string;
  config: UnknownRecord;
  runs: NormalizedRun[];
  polling: unknown[];
  warnings: MigrationWarning[];
};

export type ConfigParseResult =
  | {
      ok: true;
      config: NormalizedConfig;
    }
  | {
      ok: false;
      format?: ConfigFormat;
      sourceName: string;
      errors: string[];
      warnings: MigrationWarning[];
    };
