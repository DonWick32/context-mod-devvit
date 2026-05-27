import { describe, expect, it } from 'vitest';
import {
  auditMigrationConfig,
  parseConfigText,
  renderMarkdownReport,
} from '../scripts/audit-migration-config.mjs';

describe('migration audit script', () => {
  it('reports blockers, fetch domains, and inventory for legacy configs', () => {
    const document = parseConfigText(`
checks:
  - name: migration audit
    kind: comment
    rules:
      - kind: repost
        criteria:
          - searchOn:
              - external
      - kind: regex
        criteria:
          - regex: url:https://example.com/regex.txt
      - kind: mhs
    actions:
      - kind: comment
        asModTeam: true
        content: wiki:botconfig/replies/test
      - kind: report
        content: https://discord.com/api/webhooks/example
`);

    const report = auditMigrationConfig(document);

    expect(report).toMatchObject({
      runs: 1,
      checks: 1,
      rules: {
        total: 3,
        byKind: {
          repost: 1,
          regex: 1,
          mhs: 1,
        },
      },
      actions: {
        total: 2,
        byKind: {
          comment: 1,
          report: 1,
        },
      },
      blockers: 3,
      fetchDomains: [
        'discord.com',
        'generativelanguage.googleapis.com',
        'youtube.googleapis.com',
      ],
    });
    expect(report.findings.map((finding) => finding.message)).toEqual(
      expect.arrayContaining([
        'Discord webhook notification needs fetch-domain approval.',
        'Legacy toxicity/MHS rule needs Gemini setup.',
        'Repost external facet needs YouTube setup.',
        'URL-backed config/action content is not ported.',
        'URL-backed regex content is not ported.',
        '`comment.asModTeam` public reply parity is not exposed by Devvit.',
      ])
    );
  });

  it('renders a moderator-readable markdown report', () => {
    const report = auditMigrationConfig({
      checks: [
        {
          name: 'ok',
          kind: 'submission',
          rules: [{ kind: 'regex' }],
          actions: [{ kind: 'report' }],
        },
      ],
    });

    expect(renderMarkdownReport(report, 'legacy.yml')).toContain(
      '# ContextMod Devvit Migration Audit'
    );
    expect(renderMarkdownReport(report, 'legacy.yml')).toContain(
      'No blockers or warnings found'
    );
  });
});
