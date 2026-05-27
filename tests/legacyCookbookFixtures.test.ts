import { describe, expect, it } from 'vitest';
import { parseLegacyConfigText } from '../src/config/legacyConfigParser';
import { collectActivityResourceNeeds } from '../src/runtime/redditResources';

const parseFixture = (text: string) => {
  const result = parseLegacyConfigText(text);
  if (!result.ok) {
    throw new Error(result.errors.join('\n'));
  }
  return result.config;
};

describe('legacy cookbook migration fixtures', () => {
  it('parses the low comment engagement history example', () => {
    const config = parseFixture(`
runs:
  - checks:
      - name: Low Comment Engagement
        description: Check if Author is submitting much more than they comment
        kind: submission
        rules:
          - name: lowComm
            kind: history
            criteria:
              - comment: '< 30%'
                window:
                  duration: 90 days
                  count: 100
        actions:
          - kind: report
            content: >-
              Low engagement: comments were {{rules.lowcomm.commentPercent}} of
              {{rules.lowcomm.activityTotal}} over {{rules.lowcomm.window}}
`);

    expect(config.runs[0]?.checks[0]).toMatchObject({
      name: 'Low Comment Engagement',
      kind: 'submission',
    });
    expect(collectActivityResourceNeeds(config)).toMatchObject({
      history: true,
    });
  });

  it('parses the burst post repeatActivity example', () => {
    const config = parseFixture(`
runs:
  - checks:
      - name: Burstpost Spam
        description: Check if Author is crossposting in short bursts
        kind: submission
        rules:
          - name: burstpost
            kind: repeatActivity
            useSubmissionAsReference: true
            gapAllowance: 3
            threshold: '>= 6'
            window:
              duration: 7 days
              count: 100
        actions:
          - kind: report
            content: >-
              Author has burst-posted this link {{rules.burstpost.largestRepeat}}
              times over {{rules.burstpost.window}}
`);

    expect(config.runs[0]?.checks[0]?.rules[0]).toMatchObject({
      kind: 'repeatActivity',
      config: {
        useSubmissionAsReference: true,
        gapAllowance: 3,
      },
    });
    expect(collectActivityResourceNeeds(config)).toMatchObject({
      history: true,
    });
  });

  it('parses the self-promotion attribution usernote example', () => {
    const config = parseFixture(`
runs:
  - checks:
      - name: Self Promo Activities
        description: >-
          Check if any of Author's aggregated submission origins are >10% of entire
          history
        kind: submission
        rules:
          - name: attr10all
            kind: attribution
            criteria:
              - threshold: '> 10%'
                window: 90 days
              - threshold: '> 10%'
                window: 100
        actions:
          - kind: usernote
            type: spamwarn
            content: >-
              Self Promotion: {{rules.attr10all.titlesDelim}}
              {{rules.attr10sub.largestPercent}}%
`);

    expect(config.runs[0]?.checks[0]?.rules[0]).toMatchObject({
      kind: 'attribution',
    });
    expect(config.runs[0]?.checks[0]?.actions[0]).toMatchObject({
      kind: 'usernote',
    });
    expect(collectActivityResourceNeeds(config)).toMatchObject({
      history: true,
    });
  });
});
