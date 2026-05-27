import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getWikiPage: vi.fn(),
  settingsGet: vi.fn(),
}));

vi.mock('@devvit/web/server', () => ({
  context: {
    subredditName: 'context_mod_dev',
  },
  reddit: {
    getWikiPage: mocks.getWikiPage,
  },
  settings: {
    get: mocks.settingsGet,
  },
}));

import {
  ConfigSourceError,
  isWikiPageNotFoundError,
  loadConfiguredLegacyConfig,
} from '../src/config/configSource';

describe('loadConfiguredLegacyConfig', () => {
  beforeEach(() => {
    mocks.getWikiPage.mockReset();
    mocks.settingsGet.mockReset();
  });

  it('uses the raw config override before wiki config', async () => {
    mocks.settingsGet.mockResolvedValueOnce('checks: []');

    await expect(loadConfiguredLegacyConfig()).resolves.toEqual({
      sourceName: 'subreddit setting configText',
      text: 'checks: []',
    });
    expect(mocks.getWikiPage).not.toHaveBeenCalled();
  });

  it('loads the configured wiki page when no raw override exists', async () => {
    mocks.settingsGet.mockResolvedValueOnce('').mockResolvedValueOnce('botconfig/contextbot');
    mocks.getWikiPage.mockResolvedValueOnce({ content: 'checks: []' });

    await expect(loadConfiguredLegacyConfig()).resolves.toEqual({
      sourceName: 'r/context_mod_dev/wiki/botconfig/contextbot',
      text: 'checks: []',
    });
    expect(mocks.getWikiPage).toHaveBeenCalledWith(
      'context_mod_dev',
      'botconfig/contextbot'
    );
  });

  it('turns wiki 404s into a setup-oriented config source error', async () => {
    const wikiError = Object.assign(
      new Error('2 UNKNOWN: grpc invocation failed with status 2; 404 Not Found'),
      {
        code: 2,
        details: 'grpc invocation failed with status 2; 404 Not Found',
      }
    );

    mocks.settingsGet.mockResolvedValueOnce('').mockResolvedValueOnce('');
    mocks.getWikiPage.mockRejectedValueOnce(wikiError);

    await expect(loadConfiguredLegacyConfig()).rejects.toMatchObject({
      code: 'missing-config',
      message:
        'ContextMod config not found. Add YAML/JSON5 to the Raw configuration override setting or create r/context_mod_dev/wiki/botconfig/contextbot.',
      sourceName: 'r/context_mod_dev/wiki/botconfig/contextbot',
    });
  });
});

describe('isWikiPageNotFoundError', () => {
  it('matches Devvit wiki 404 errors', () => {
    const wikiError = Object.assign(new Error('grpc invocation failed'), {
      details: 'grpc invocation failed with status 2; 404 Not Found',
    });

    expect(isWikiPageNotFoundError(wikiError)).toBe(true);
  });

  it('does not match non-404 wiki errors', () => {
    expect(
      isWikiPageNotFoundError(
        new ConfigSourceError('Forbidden', 'wiki-load-failed', 'wiki')
      )
    ).toBe(false);
  });
});
