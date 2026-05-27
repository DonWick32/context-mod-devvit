import { describe, expect, it } from 'vitest';
import { parseLegacyConfigText, summarizeConfigParseResult } from '../src/config/legacyConfigParser';

describe('parseLegacyConfigText', () => {
  it('normalizes a full YAML config with runs', () => {
    const result = parseLegacyConfigText(`
polling:
  - newSub
runs:
  - name: Spam run
    checks:
      - name: Freekarma removal
        kind: submission
        rules:
          - name: freekarma
            kind: recentActivity
            window: 100
        actions:
          - kind: report
            enable: false
            content: Remove candidate
          - kind: remove
            note: Freekarma activity
`);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.errors.join('\n'));
    }
    expect(result.config.format).toBe('yaml');
    expect(result.config.runs).toHaveLength(1);
    expect(result.config.runs[0]?.checks).toHaveLength(1);
    expect(result.config.runs[0]?.checks[0]?.rules[0]).toMatchObject({
      type: 'rule',
      kind: 'recentActivity',
      name: 'freekarma',
    });
    expect(result.config.runs[0]?.checks[0]?.actions).toHaveLength(2);
    expect(summarizeConfigParseResult(result)).toContain('1 run(s), 1 check(s)');
  });

  it('normalizes partial cookbook YAML check arrays', () => {
    const result = parseLegacyConfigText(`
      - name: low xp comment spam
        description: X-posted comment >=4x
        kind: comment
        rules:
          - name: xPostLowComm
            kind: repeatActivity
            threshold: '>= 4'
        actions:
          - kind: remove
            enable: true
            note: Posted same comment many times
`);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.errors.join('\n'));
    }
    expect(result.config.runs[0]?.name).toBe('default');
    expect(result.config.runs[0]?.checks[0]?.kind).toBe('comment');
  });

  it('parses JSON5 configs', () => {
    const result = parseLegacyConfigText(`{
      // JSON5 comments are valid legacy config input.
      checks: [
        {
          name: 'regex check',
          kind: 'comment',
          rules: [{ kind: 'regex', criteria: [{ regex: '/spam/i' }] }],
          actions: [{ kind: 'report', content: 'spam candidate' }],
        },
      ],
    }`);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.errors.join('\n'));
    }
    expect(result.config.format).toBe('json5');
    expect(result.config.runs[0]?.checks[0]?.rules[0]).toMatchObject({
      type: 'rule',
      kind: 'regex',
    });
  });

  it('flags fetch-sensitive legacy features', () => {
    const result = parseLegacyConfigText(`
notifications:
  providers:
    - name: discord
      type: discord
      url: https://discord.com/api/webhooks/example
runs:
  - checks:
      - name: toxicity
        kind: comment
        rules:
          - kind: mhs
            criteria:
              flagged: true
        actions:
          - kind: report
            content: toxicity
`);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.errors.join('\n'));
    }
    expect(result.config.warnings.some((warning) => warning.path === 'notifications')).toBe(
      true
    );
    expect(result.config.warnings.some((warning) => warning.path.endsWith('rules[0]'))).toBe(
      true
    );
  });

  it('rejects malformed checks', () => {
    const result = parseLegacyConfigText(`
checks:
  - name: missing kind
    rules: []
`);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected invalid config');
    }
    expect(result.errors[0]).toContain('kind');
  });
});
