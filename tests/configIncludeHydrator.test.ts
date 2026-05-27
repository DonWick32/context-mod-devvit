import { describe, expect, it, vi } from 'vitest';
import { parseLegacyConfigTextWithWikiIncludes } from '../src/config/configIncludeHydrator';
import type { NormalizedConfig } from '../src/config/legacyTypes';
import type { ActivitySnapshot } from '../src/runtime/activityAdapter';
import { runDryConfig } from '../src/runtime/dryRunEngine';

const commentActivity: ActivitySnapshot = {
  id: 't1_comment',
  kind: 'comment',
  authorName: 'Spammer42',
  subredditName: 'testsub',
  body: 'join my discord.gg/abc123',
  createdAt: new Date('2026-05-25T00:00:00Z'),
  permalink: '/r/testsub/comments/post/comment',
  score: 1,
  removed: false,
  approved: false,
  locked: false,
  spam: false,
  stickied: false,
  distinguished: false,
};

const createWikiLoader = (pages: Record<string, string>) => ({
  getWikiPage: vi.fn(async (subredditName: string, pageName: string) => {
    const content = pages[`${subredditName}/${pageName}`] ?? pages[pageName];
    if (content === undefined) {
      throw new Error('404 Not Found');
    }

    return { content };
  }),
});

const parseConfig = async (
  text: string,
  pages: Record<string, string>
): Promise<NormalizedConfig> => {
  const loader = createWikiLoader(pages);
  const result = await parseLegacyConfigTextWithWikiIncludes(text, {
    sourceName: 'test config',
    subredditName: 'testsub',
    wikiLoader: loader,
  });

  if (!result.ok) {
    throw new Error(result.errors.join('\n'));
  }

  return result.config;
};

describe('parseLegacyConfigTextWithWikiIncludes', () => {
  it('hydrates same-subreddit wiki rule and action fragments', async () => {
    const loader = createWikiLoader({
      'botconfig/rules/discord': `
kind: regex
criteria:
  - regex: '/discord\\.gg\\/[\\w\\d]+/i'
`,
      'botconfig/actions/report': `
- kind: report
  content: discord fragment matched
`,
    });

    const result = await parseLegacyConfigTextWithWikiIncludes(
      `
checks:
  - name: wiki fragment check
    kind: comment
    rules:
      - wiki:botconfig/rules/discord
    actions:
      - wiki:botconfig/actions/report
`,
      {
        sourceName: 'test config',
        subredditName: 'testsub',
        wikiLoader: loader,
      }
    );

    expect(result.ok).toBe(true);
    expect(loader.getWikiPage).toHaveBeenCalledWith(
      'testsub',
      'botconfig/rules/discord'
    );
    expect(loader.getWikiPage).toHaveBeenCalledWith(
      'testsub',
      'botconfig/actions/report'
    );
    if (!result.ok) {
      throw new Error(result.errors.join('\n'));
    }

    const dryRun = runDryConfig(result.config, commentActivity);
    expect(dryRun.checksTriggered).toBe(1);
    expect(dryRun.plannedActions[0]).toMatchObject({
      kind: 'report',
      config: {
        content: 'discord fragment matched',
      },
    });
  });

  it('hydrates same-subreddit wiki check fragments', async () => {
    const config = await parseConfig(
      `
checks:
  - wiki:botconfig/checks/discord
`,
      {
        'botconfig/checks/discord': `
name: wiki check
kind: comment
rules:
  - kind: regex
    criteria:
      - regex: '/discord\\.gg/i'
actions:
  - kind: remove
`,
      }
    );

    expect(config.runs[0]?.checks).toHaveLength(1);
    expect(config.runs[0]?.checks[0]).toMatchObject({
      name: 'wiki check',
      kind: 'comment',
    });
    expect(config.runs[0]?.checks[0]?.rules[0]).toMatchObject({
      type: 'rule',
      kind: 'regex',
    });
  });

  it('hydrates same-subreddit wiki regex content tokens', async () => {
    const loader = createWikiLoader({
      'botconfig/regex/discord': '/discord\\.gg\\/[\\w\\d]+/i',
    });

    const result = await parseLegacyConfigTextWithWikiIncludes(
      `
checks:
  - name: wiki regex content
    kind: comment
    rules:
      - kind: regex
        criteria:
          - regex: wiki:botconfig/regex/discord
    actions:
      - kind: report
        content: wiki regex matched
`,
      {
        sourceName: 'test config',
        subredditName: 'testsub',
        wikiLoader: loader,
      }
    );

    expect(result.ok).toBe(true);
    expect(loader.getWikiPage).toHaveBeenCalledWith(
      'testsub',
      'botconfig/regex/discord'
    );
    if (!result.ok) {
      throw new Error(result.errors.join('\n'));
    }

    const dryRun = runDryConfig(result.config, commentActivity);
    expect(dryRun.checksTriggered).toBe(1);
    expect(dryRun.plannedActions[0]).toMatchObject({
      kind: 'report',
      config: {
        content: 'wiki regex matched',
      },
    });
  });

  it('hydrates cross-subreddit wiki rule and action fragments', async () => {
    const config = await parseConfig(
      `
checks:
  - name: cross subreddit fragments
    kind: comment
    rules:
      - wiki:botconfig/rules/shared|OtherSub
    actions:
      - wiki:botconfig/actions/shared|OtherSub
`,
      {
        'OtherSub/botconfig/rules/shared': `
kind: regex
criteria:
  - regex: '/discord\\.gg\\/[\\w\\d]+/i'
`,
        'OtherSub/botconfig/actions/shared': `
kind: report
content: cross subreddit fragment matched
`,
      }
    );

    const dryRun = runDryConfig(config, commentActivity);
    expect(dryRun.checksTriggered).toBe(1);
    expect(dryRun.plannedActions[0]).toMatchObject({
      kind: 'report',
      config: {
        content: 'cross subreddit fragment matched',
      },
    });
  });

  it('hydrates cross-subreddit wiki regex content tokens', async () => {
    const loader = createWikiLoader({
      'SharedConfig/botconfig/regex/discord': '/discord\\.gg\\/[\\w\\d]+/i',
    });

    const result = await parseLegacyConfigTextWithWikiIncludes(
      `
checks:
  - name: cross wiki regex content
    kind: comment
    rules:
      - kind: regex
        criteria:
          - regex: wiki:botconfig/regex/discord|SharedConfig
    actions:
      - kind: report
        content: cross wiki regex matched
`,
      {
        sourceName: 'test config',
        subredditName: 'testsub',
        wikiLoader: loader,
      }
    );

    expect(result.ok).toBe(true);
    expect(loader.getWikiPage).toHaveBeenCalledWith(
      'SharedConfig',
      'botconfig/regex/discord'
    );
    if (!result.ok) {
      throw new Error(result.errors.join('\n'));
    }

    const dryRun = runDryConfig(result.config, commentActivity);
    expect(dryRun.checksTriggered).toBe(1);
    expect(dryRun.plannedActions[0]).toMatchObject({
      kind: 'report',
      config: {
        content: 'cross wiki regex matched',
      },
    });
  });

  it('keeps unsupported regex content tokens from running as literal regexes', async () => {
    const config = await parseConfig(
      `
checks:
  - name: unresolved regex content
    kind: comment
    rules:
      - kind: regex
        criteria:
          - regex: url:https://example.com/regex.txt
    actions:
      - kind: report
        content: should not plan
`,
      {}
    );

    const dryRun = runDryConfig(config, commentActivity);
    expect(dryRun.checksTriggered).toBe(0);
    expect(dryRun.checkResults[0]?.rules[0]).toMatchObject({
      supported: false,
      reason:
        'url-backed regex content requires fetch-domain approval and is not enabled',
    });
  });

  it('rejects unsupported check-level URL fragments before normalization', async () => {
    const loader = createWikiLoader({});
    const result = await parseLegacyConfigTextWithWikiIncludes(
      `
checks:
  - url:https://example.com/check.yml
`,
      {
        sourceName: 'test config',
        subredditName: 'testsub',
        wikiLoader: loader,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected invalid config');
    }
    expect(result.errors[0]).toContain('fetch-domain approval');
  });
});
