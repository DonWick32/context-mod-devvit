import { describe, expect, it, vi } from 'vitest';
import {
  loadWikiPage,
  parseWikiPageReference,
} from '../src/runtime/wikiPages';

describe('wiki page helpers', () => {
  it('normalizes full Reddit wiki URLs', () => {
    expect(
      parseWikiPageReference(
        'https://www.reddit.com/r/Context_Mod_Dev/wiki/botconfig/contextbot?utm=x',
        'fallback'
      )
    ).toEqual({
      subredditName: 'Context_Mod_Dev',
      pageName: 'botconfig/contextbot',
    });
  });

  it('normalizes legacy wiki tokens with cross-subreddit suffixes', () => {
    expect(
      parseWikiPageReference('wiki:/botconfig/shared|r/SharedConfig', 'fallback')
    ).toEqual({
      subredditName: 'SharedConfig',
      pageName: 'botconfig/shared',
    });
  });

  it('falls back to lower-case wiki page names after a 404', async () => {
    const notFound = Object.assign(new Error('404 Not Found'), {
      details: 'grpc invocation failed with status 2; 404 Not Found',
    });
    const client = {
      getWikiPage: vi
        .fn()
        .mockRejectedValueOnce(notFound)
        .mockResolvedValueOnce({ content: 'checks: []' }),
    };

    await expect(
      loadWikiPage(client, {
        subredditName: 'testsub',
        pageName: 'BotConfig/ContextBot',
      })
    ).resolves.toEqual({ content: 'checks: []' });
    expect(client.getWikiPage).toHaveBeenNthCalledWith(
      1,
      'testsub',
      'BotConfig/ContextBot'
    );
    expect(client.getWikiPage).toHaveBeenNthCalledWith(
      2,
      'testsub',
      'botconfig/contextbot'
    );
  });

  it('uses listed wiki pages as a final canonical-name fallback', async () => {
    const notFound = Object.assign(new Error('404 Not Found'), {
      details: 'grpc invocation failed with status 2; 404 Not Found',
    });
    const client = {
      getWikiPage: vi
        .fn()
        .mockRejectedValueOnce(notFound)
        .mockResolvedValueOnce({ content: 'checks: []', name: 'Config/Main' }),
      getWikiPages: vi.fn().mockResolvedValue(['Config/Main']),
    };

    await expect(
      loadWikiPage(client, {
        subredditName: 'testsub',
        pageName: 'config/main',
      })
    ).resolves.toEqual({ content: 'checks: []', name: 'Config/Main' });
    expect(client.getWikiPages).toHaveBeenCalledWith('testsub');
    expect(client.getWikiPage).toHaveBeenLastCalledWith(
      'testsub',
      'Config/Main'
    );
  });
});
