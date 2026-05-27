import {
  detectLegacyConfigFormat,
  normalizeLegacyConfig,
  parseLegacyConfigDocument,
} from './legacyConfigParser';
import type {
  ConfigFormat,
  ConfigParseResult,
  MigrationWarning,
  UnknownRecord,
} from './legacyTypes';
import {
  loadWikiPage,
  parseWikiPageReference,
} from '../runtime/wikiPages';

export type ConfigFragmentWikiLoader = {
  getWikiPage(
    subredditName: string,
    pageName: string
  ): Promise<{ content: string }>;
  getWikiPages?(subredditName: string): Promise<string[]>;
};

export type ParseLegacyConfigWithIncludesOptions = {
  sourceName?: string;
  format?: ConfigFormat;
  subredditName: string;
  wikiLoader: ConfigFragmentWikiLoader;
  maxDepth?: number;
};

type IncludeContext = 'run' | 'check' | 'rule' | 'action';

type HydrationOptions = Required<
  Pick<ParseLegacyConfigWithIncludesOptions, 'subredditName' | 'wikiLoader'>
> & {
  maxDepth: number;
  stack: string[];
};
const DEFAULT_SOURCE_NAME = 'inline config';
const DEFAULT_MAX_INCLUDE_DEPTH = 6;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getIncludePath = (value: unknown): string | undefined => {
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

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const contextLabel = (context: IncludeContext): string => {
  switch (context) {
    case 'run':
      return 'run';
    case 'check':
      return 'check';
    case 'rule':
      return 'rule';
    case 'action':
      return 'action';
  }
};

const unsupportedIncludeReason = (path: string): string | undefined => {
  if (path.startsWith('url:')) {
    return 'external URL config fragments need fetch-domain approval and are not implemented';
  }

  return undefined;
};

const shouldLeaveUnresolved = (context: IncludeContext): boolean =>
  context === 'rule' || context === 'action';

const flattenRunChecks = (fragment: UnknownRecord): unknown[] | undefined => {
  if (!Array.isArray(fragment.runs)) {
    return undefined;
  }

  const checks: unknown[] = [];
  for (const run of fragment.runs) {
    if (isRecord(run) && Array.isArray(run.checks)) {
      checks.push(...run.checks);
    }
  }

  return checks.length > 0 ? checks : undefined;
};

const extractFragmentEntries = (
  fragment: unknown,
  context: IncludeContext
): unknown[] => {
  if (Array.isArray(fragment)) {
    return fragment;
  }

  if (isRecord(fragment)) {
    if (context === 'run' && Array.isArray(fragment.runs)) {
      return fragment.runs;
    }

    if (context === 'check') {
      if (Array.isArray(fragment.checks)) {
        return fragment.checks;
      }

      const runChecks = flattenRunChecks(fragment);
      if (runChecks !== undefined) {
        return runChecks;
      }
    }
  }

  return [fragment];
};

const loadFragmentDocument = async (
  path: string,
  options: HydrationOptions
): Promise<unknown> => {
  const wikiReference = parseWikiPageReference(path, options.subredditName);
  if (wikiReference === undefined) {
    const reason = unsupportedIncludeReason(path) ?? 'unsupported include path';
    throw new Error(`${path}: ${reason}`);
  }

  const stackKey = `wiki:${wikiReference.subredditName}/${wikiReference.pageName}`;
  if (options.stack.includes(stackKey)) {
    throw new Error(`Circular config include detected for ${path}.`);
  }

  if (options.stack.length >= options.maxDepth) {
    throw new Error(
      `Config include depth exceeded ${options.maxDepth} while loading ${path}.`
    );
  }

  let content: string;
  try {
    const page = await loadWikiPage(options.wikiLoader, wikiReference);
    content = page.content;
  } catch (error) {
    throw new Error(
      `Unable to load config fragment ${path}: ${getErrorMessage(error)}`,
      { cause: error }
    );
  }

  if (content.trim().length === 0) {
    throw new Error(`Config fragment ${path} is empty.`);
  }

  try {
    return parseLegacyConfigDocument(
      content,
      detectLegacyConfigFormat(content)
    );
  } catch (error) {
    throw new Error(
      `Unable to parse config fragment ${path}: ${getErrorMessage(error)}`,
      { cause: error }
    );
  }
};

const hydrateSameSubredditWikiContentToken = async (
  rawValue: string,
  options: HydrationOptions,
  label: string
): Promise<string> => {
  const trimmedValue = rawValue.trim();
  if (!trimmedValue.startsWith('wiki:')) {
    return rawValue;
  }

  const wikiReference = parseWikiPageReference(
    trimmedValue,
    options.subredditName
  );
  if (wikiReference === undefined) {
    return rawValue;
  }

  try {
    const page = await loadWikiPage(options.wikiLoader, wikiReference);
    return page.content;
  } catch (error) {
    throw new Error(
      `Unable to load ${label} ${trimmedValue}: ${getErrorMessage(error)}`,
      { cause: error }
    );
  }
};

const hydrateRegexRuleContentTokens = async (
  value: UnknownRecord,
  options: HydrationOptions
): Promise<UnknownRecord> => {
  if (value.kind !== 'regex' || !Array.isArray(value.criteria)) {
    return value;
  }

  let changed = false;
  const criteria: unknown[] = [];
  for (const criterion of value.criteria) {
    if (!isRecord(criterion) || typeof criterion.regex !== 'string') {
      criteria.push(criterion);
      continue;
    }

    const hydratedRegex = await hydrateSameSubredditWikiContentToken(
      criterion.regex,
      options,
      'regex content token'
    );
    changed ||= hydratedRegex !== criterion.regex;
    criteria.push(
      hydratedRegex === criterion.regex
        ? criterion
        : {
            ...criterion,
            regex: hydratedRegex,
          }
    );
  }

  return changed ? { ...value, criteria } : value;
};

const hydrateObjectConfigArrays = async (
  value: UnknownRecord,
  options: HydrationOptions
): Promise<UnknownRecord> => {
  const hydrated: UnknownRecord = { ...value };

  if (Array.isArray(value.runs)) {
    hydrated.runs = await hydrateEntryArray(value.runs, 'run', options);
  }

  if (Array.isArray(value.checks)) {
    hydrated.checks = await hydrateEntryArray(value.checks, 'check', options);
  }

  if (Array.isArray(value.rules)) {
    hydrated.rules = await hydrateEntryArray(value.rules, 'rule', options);
  }

  if (Array.isArray(value.actions)) {
    hydrated.actions = await hydrateEntryArray(value.actions, 'action', options);
  }

  return hydrateRegexRuleContentTokens(hydrated, options);
};

const hydrateInclude = async (
  path: string,
  context: IncludeContext,
  options: HydrationOptions
): Promise<unknown[]> => {
  const unsupportedReason = unsupportedIncludeReason(path);
  if (unsupportedReason !== undefined) {
    if (shouldLeaveUnresolved(context)) {
      return [{ path }];
    }

    throw new Error(
      `${contextLabel(context)} include ${path} is not supported yet: ${unsupportedReason}.`
    );
  }

  const wikiReference = parseWikiPageReference(path, options.subredditName);
  if (wikiReference === undefined) {
    throw new Error(`${contextLabel(context)} include ${path} is invalid.`);
  }

  const stackKey = `wiki:${wikiReference.subredditName}/${wikiReference.pageName}`;
  const fragment = await loadFragmentDocument(path, options);
  const entries = extractFragmentEntries(fragment, context);
  return hydrateEntryArray(entries, context, {
    ...options,
    stack: [...options.stack, stackKey],
  });
};

const hydrateEntryArray = async (
  entries: unknown[],
  context: IncludeContext,
  options: HydrationOptions
): Promise<unknown[]> => {
  const hydrated: unknown[] = [];

  for (const entry of entries) {
    const includePath = getIncludePath(entry);
    if (includePath !== undefined) {
      hydrated.push(...(await hydrateInclude(includePath, context, options)));
      continue;
    }

    if (isRecord(entry)) {
      hydrated.push(await hydrateObjectConfigArrays(entry, options));
      continue;
    }

    hydrated.push(entry);
  }

  return hydrated;
};

export const hydrateLegacyConfigIncludes = async (
  document: unknown,
  options: Omit<HydrationOptions, 'stack' | 'maxDepth'> & { maxDepth?: number }
): Promise<unknown> => {
  const hydrationOptions: HydrationOptions = {
    subredditName: options.subredditName,
    wikiLoader: options.wikiLoader,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_INCLUDE_DEPTH,
    stack: [],
  };

  if (Array.isArray(document)) {
    return hydrateEntryArray(document, 'check', hydrationOptions);
  }

  if (isRecord(document)) {
    return hydrateObjectConfigArrays(document, hydrationOptions);
  }

  return document;
};

export const parseLegacyConfigTextWithWikiIncludes = async (
  text: string,
  options: ParseLegacyConfigWithIncludesOptions
): Promise<ConfigParseResult> => {
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
    const hydratedDocument = await hydrateLegacyConfigIncludes(document, {
      subredditName: options.subredditName,
      wikiLoader: options.wikiLoader,
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    });

    return {
      ok: true,
      config: normalizeLegacyConfig(hydratedDocument, format, sourceName),
    };
  } catch (error) {
    return {
      ok: false,
      format,
      sourceName,
      errors: [getErrorMessage(error)],
      warnings,
    };
  }
};
