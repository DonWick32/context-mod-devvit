import { context, reddit, settings } from '@devvit/web/server';
import {
  isWikiPageNotFoundError,
  loadWikiPage,
  parseWikiPageReference,
} from '../runtime/wikiPages';

export type LoadedConfigSource = {
  sourceName: string;
  text: string;
};

const DEFAULT_CONFIG_WIKI_PAGE = 'botconfig/contextbot';

export type ConfigSourceErrorCode = 'missing-config' | 'wiki-load-failed';

export class ConfigSourceError extends Error {
  override name = 'ConfigSourceError';
  readonly code: ConfigSourceErrorCode;
  readonly sourceName: string;

  constructor(message: string, code: ConfigSourceErrorCode, sourceName: string) {
    super(message);
    this.code = code;
    this.sourceName = sourceName;
  }
}

const errorText = (error: unknown): string => {
  if (error instanceof Error) {
    const details =
      'details' in error && typeof error.details === 'string' ? ` ${error.details}` : '';
    return `${error.message}${details}`;
  }

  return String(error);
};

export { isWikiPageNotFoundError };

export const loadConfiguredLegacyConfig = async (
  overrideSubredditName?: string
): Promise<LoadedConfigSource> => {
  const rawOverride = await settings.get<string>('configText');
  if (rawOverride && rawOverride.trim().length > 0) {
    return {
      sourceName: 'subreddit setting configText',
      text: rawOverride,
    };
  }

  const wikiPageSetting = await settings.get<string>('configWikiPage');
  const wikiPageName =
    wikiPageSetting && wikiPageSetting.trim().length > 0
      ? wikiPageSetting.trim()
      : DEFAULT_CONFIG_WIKI_PAGE;

  const currentSubredditName = (overrideSubredditName && overrideSubredditName.trim().length > 0)
    ? overrideSubredditName.trim()
    : context.subredditName;

  const wikiReference = parseWikiPageReference(
    wikiPageName,
    currentSubredditName
  );
  if (wikiReference === undefined) {
    throw new ConfigSourceError(
      `ContextMod config wiki page setting is invalid: ${wikiPageName}.`,
      'missing-config',
      wikiPageName
    );
  }

  const sourceName = `r/${wikiReference.subredditName}/wiki/${wikiReference.pageName}`;

  try {
    const page = await loadWikiPage(reddit, wikiReference!);
    return {
      sourceName,
      text: page.content,
    };
  } catch (error) {
    if (isWikiPageNotFoundError(error)) {
      throw new ConfigSourceError(
        `ContextMod config not found. Add YAML/JSON5 to the Raw configuration override setting or create ${sourceName}.`,
        'missing-config',
        sourceName
      );
    }

    throw new ConfigSourceError(
      `Unable to load ContextMod config from ${sourceName}: ${errorText(error)}`,
      'wiki-load-failed',
      sourceName
    );
  }
};

