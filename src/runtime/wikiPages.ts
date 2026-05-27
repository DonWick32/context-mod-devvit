export type WikiPageClient = {
  getWikiPage(
    subredditName: string,
    pageName: string
  ): Promise<{ content: string; name?: string }>;
  getWikiPages?(subredditName: string): Promise<string[]>;
};

export type WikiPageReference = {
  subredditName: string;
  pageName: string;
};

const errorText = (error: unknown): string => {
  if (error instanceof Error) {
    const details =
      'details' in error && typeof error.details === 'string'
        ? ` ${error.details}`
        : '';
    return `${error.message}${details}`;
  }

  return String(error);
};

export const isWikiPageNotFoundError = (error: unknown): boolean => {
  const message = errorText(error);
  return /\b404\b/.test(message) && /not found/i.test(message);
};

export const normalizeSubredditName = (value: string): string =>
  value.trim().replace(/^\/?r\//i, '').replace(/^\/+|\/+$/g, '');

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const normalizeWikiPageName = (value: string): string =>
  safeDecodeURIComponent(value)
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/^\/+/, '')
    .replace(/^wiki\//i, '')
    .replace(/\/+$/g, '')
    .replace(/\/{2,}/g, '/');

const parseUrlWikiReference = (
  value: string,
  defaultSubredditName: string
): WikiPageReference | undefined => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  const parts = url.pathname
    .split('/')
    .filter(Boolean)
    .map(safeDecodeURIComponent);
  if (parts[0]?.toLowerCase() === 'r' && parts[2]?.toLowerCase() === 'wiki') {
    const subredditName = normalizeSubredditName(parts[1] ?? '');
    const pageName = normalizeWikiPageName(parts.slice(3).join('/'));
    return subredditName.length === 0 || pageName.length === 0
      ? undefined
      : { subredditName, pageName };
  }

  if (parts[0]?.toLowerCase() === 'wiki') {
    const pageName = normalizeWikiPageName(parts.slice(1).join('/'));
    return pageName.length === 0
      ? undefined
      : { subredditName: defaultSubredditName, pageName };
  }

  return undefined;
};

export const parseWikiPageReference = (
  rawValue: string,
  defaultSubredditName: string
): WikiPageReference | undefined => {
  const defaultSubreddit = normalizeSubredditName(defaultSubredditName);
  let value = rawValue.trim();
  if (value.startsWith('wiki:')) {
    value = value.slice('wiki:'.length).trim();
  }

  const parts = value.split('|');
  if (parts.length > 2) {
    return undefined;
  }

  const explicitSubreddit = parts[1]?.trim();
  const fallbackSubreddit =
    explicitSubreddit === undefined || explicitSubreddit.length === 0
      ? defaultSubreddit
      : normalizeSubredditName(explicitSubreddit);
  const locator = parts[0]?.trim() ?? '';
  if (locator.length === 0 || fallbackSubreddit.length === 0) {
    return undefined;
  }

  const urlReference = parseUrlWikiReference(locator, fallbackSubreddit);
  if (urlReference !== undefined) {
    return {
      subredditName:
        explicitSubreddit === undefined
          ? urlReference.subredditName
          : fallbackSubreddit,
      pageName: urlReference.pageName,
    };
  }

  const normalizedLocator = normalizeWikiPageName(locator);
  const subredditPathMatch = normalizedLocator.match(
    /^r\/([^/]+)\/wiki\/(.+)$/i
  );
  if (subredditPathMatch !== null) {
    const subredditName =
      explicitSubreddit === undefined
        ? normalizeSubredditName(subredditPathMatch[1] ?? '')
        : fallbackSubreddit;
    const pageName = normalizeWikiPageName(subredditPathMatch[2] ?? '');
    return subredditName.length === 0 || pageName.length === 0
      ? undefined
      : { subredditName, pageName };
  }

  const pageName = normalizeWikiPageName(normalizedLocator);
  return pageName.length === 0
    ? undefined
    : { subredditName: fallbackSubreddit, pageName };
};

const addCandidate = (candidates: string[], value: string) => {
  const normalized = normalizeWikiPageName(value);
  if (normalized.length > 0 && !candidates.includes(normalized)) {
    candidates.push(normalized);
  }
};

const getWikiPageCandidates = (pageName: string): string[] => {
  const candidates: string[] = [];
  addCandidate(candidates, pageName);
  addCandidate(candidates, pageName.toLowerCase());
  return candidates;
};

const findListedWikiPage = (
  pages: string[],
  pageName: string
): string | undefined => {
  const target = normalizeWikiPageName(pageName).toLowerCase();
  return pages.find(
    (page) => normalizeWikiPageName(page).toLowerCase() === target
  );
};

export const loadWikiPage = async (
  client: WikiPageClient,
  reference: WikiPageReference
): Promise<{ content: string; name?: string }> => {
  const attempted: string[] = [];
  let notFoundError: unknown;

  for (const pageName of getWikiPageCandidates(reference.pageName)) {
    attempted.push(pageName);
    try {
      return await client.getWikiPage(reference.subredditName, pageName);
    } catch (error) {
      if (!isWikiPageNotFoundError(error)) {
        throw error;
      }
      notFoundError = error;
    }
  }

  if (client.getWikiPages !== undefined) {
    const pages = await client.getWikiPages(reference.subredditName);
    const listedPage = findListedWikiPage(pages, reference.pageName);
    if (listedPage !== undefined && !attempted.includes(listedPage)) {
      try {
        return await client.getWikiPage(reference.subredditName, listedPage);
      } catch (error) {
        if (!isWikiPageNotFoundError(error)) {
          throw error;
        }
        notFoundError = error;
      }
    }
  }

  throw notFoundError ?? new Error(`Wiki page ${reference.pageName} not found.`);
};
