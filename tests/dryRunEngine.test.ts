import { describe, expect, it } from 'vitest';
import { parseLegacyConfigText } from '../src/config/legacyConfigParser';
import type { NormalizedConfig } from '../src/config/legacyTypes';
import type { ActivitySnapshot } from '../src/runtime/activityAdapter';
import {
  runDryConfig,
  summarizeDryRunResult,
} from '../src/runtime/dryRunEngine';

const parseConfig = (text: string): NormalizedConfig => {
  const result = parseLegacyConfigText(text);
  if (!result.ok) {
    throw new Error(result.errors.join('\n'));
  }
  return result.config;
};

const commentActivity: ActivitySnapshot = {
  id: 't1_comment',
  kind: 'comment',
  authorName: 'Spammer42',
  subredditName: 'testsub',
  body: 'join my discord.gg/abc123',
  createdAt: new Date('2026-05-24T00:00:00Z'),
  permalink: '/r/testsub/comments/post/comment',
  score: 1,
  removed: false,
  approved: false,
  locked: false,
  spam: false,
  stickied: false,
  distinguished: false,
  authorFlairText: 'Trusted Helper',
  authorFlairCssClass: 'trusted',
  authorFlairTemplateId: 'author-template',
  authorFlairBackgroundColor: '#ff4500',
};

const submissionActivity: ActivitySnapshot = {
  id: 't3_post',
  kind: 'submission',
  authorName: 'Poster42',
  subredditName: 'testsub',
  title: 'Weekly spam thread',
  body: 'join my discord.gg/post123',
  url: 'https://www.reddit.com/r/testsub/comments/post/weekly_spam_thread/',
  createdAt: new Date('2026-05-25T00:00:00Z'),
  permalink: '/r/testsub/comments/post/weekly_spam_thread/',
  score: 3,
  removed: false,
  approved: false,
  locked: false,
  spam: false,
  stickied: false,
  distinguished: false,
  nsfw: false,
  spoiler: false,
  selfPost: true,
  isRedditMediaDomain: false,
  linkFlairText: 'Needs Review',
  linkFlairCssClass: 'review',
  linkFlairTemplateId: 'post-template',
  linkFlairBackgroundColor: '#46d160',
  authorFlairText: 'Regular Poster',
  authorFlairCssClass: 'regular',
  authorFlairTemplateId: 'poster-template',
  authorFlairBackgroundColor: '#7193ff',
};

describe('runDryConfig', () => {
  it('plans actions for a matching current-activity regex rule', () => {
    const config = parseConfig(`
checks:
  - name: remove discord spam
    kind: comment
    rules:
      - name: linkOnlySpam
        kind: regex
        criteria:
          - regex: '/discord\\.gg\\/[\\w\\d]+/i'
    actions:
      - kind: remove
      - kind: report
        enable: false
        content: discord spam
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checksEvaluated).toBe(1);
    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions).toHaveLength(2);
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'remove',
      enabled: true,
      dryRun: true,
    });
    expect(summarizeDryRunResult(result)).toContain('1 triggered');
  });

  it('does not trigger when regex does not match', () => {
    const config = parseConfig(`
checks:
  - name: no match
    kind: comment
    rules:
      - kind: regex
        criteria:
          - regex: '/totallydifferent/i'
    actions:
      - kind: remove
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checksEvaluated).toBe(1);
    expect(result.checksTriggered).toBe(0);
    expect(result.plannedActions).toHaveLength(0);
  });

  it('supports basic author name rules', () => {
    const config = parseConfig(`
checks:
  - name: author check
    kind: comment
    rules:
      - kind: author
        include:
          - name:
              - Spammer42
    actions:
      - kind: report
        content: watched author
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions[0]?.kind).toBe('report');
  });

  it('supports local author flair filters', () => {
    const config = parseConfig(`
checks:
  - name: author flair check
    kind: comment
    authorIs:
      flairText: '/trusted helper/i'
      flairCssClass: trusted
      flairTemplate: author-template
      flairBackgroundColor: ff4500
    actions:
      - kind: report
        content: matched author flair
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checksEvaluated).toBe(1);
    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions).toHaveLength(1);
    expect(result.plannedActions[0]?.kind).toBe('report');
  });

  it('supports hydrated author profile and subreddit relationship filters', () => {
    const config = parseConfig(`
checks:
  - name: hydrated author state
    kind: comment
    authorIs:
      isMod: false
      isContributor: true
      age: '> 100 days'
      linkKarma: '>= 100'
      commentKarma: '< 50'
      totalKarma: '>= 120'
      verified: true
      shadowBanned: false
      profileDescription: '/context mod/i'
    actions:
      - kind: report
        content: matched hydrated author state
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      authorAccountCreatedAt: new Date('2025-01-01T00:00:00Z'),
      authorLinkKarma: 100,
      authorCommentKarma: 20,
      authorTotalKarma: 120,
      authorHasVerifiedEmail: true,
      authorShadowbanned: false,
      authorProfileDescription: 'Context Mod fixture profile',
      authorIsModerator: false,
      authorIsContributor: true,
    });

    expect(result.checksEvaluated).toBe(1);
    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions).toHaveLength(1);
    expect(result.checkResults[0]).toMatchObject({
      supported: true,
    });
  });

  it('supports basic history rule comment/submission thresholds', () => {
    const config = parseConfig(`
checks:
  - name: low comment history
    kind: submission
    rules:
      - name: lowComm
        kind: history
        criteria:
          - comment: '< 30%'
            minActivityCount: 1
            window:
              count: 10
    actions:
      - kind: report
        content: low comment engagement
`);

    const result = runDryConfig(config, {
      ...submissionActivity,
      authorHistory: [
        {
          ...submissionActivity,
          id: 't3_history1',
          subredditName: 'exampleone',
        },
        {
          ...submissionActivity,
          id: 't3_history2',
          subredditName: 'exampletwo',
        },
      ],
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      supported: true,
      triggered: true,
    });
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
    });
  });

  it('supports history rule ratio thresholds', () => {
    const config = parseConfig(`
checks:
  - name: concentrated subreddit history
    kind: submission
    rules:
      - name: ratioHistory
        kind: history
        include:
          - spamhub
        criteria:
          - total: '>= 3'
            minActivityCount: 1
            window:
              count: 10
            ratio:
              window:
                count: 2
              threshold: '>= 1.5'
    actions:
      - kind: report
        content: concentrated history
`);

    const result = runDryConfig(config, {
      ...submissionActivity,
      authorHistory: [
        {
          ...submissionActivity,
          id: 't3_history1',
          subredditName: 'spamhub',
        },
        {
          ...commentActivity,
          id: 't1_history2',
          subredditName: 'spamhub',
        },
        {
          ...submissionActivity,
          id: 't3_history3',
          subredditName: 'spamhub',
        },
        {
          ...commentActivity,
          id: 't1_history4',
          subredditName: 'generalchat',
        },
      ],
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      supported: true,
      triggered: true,
    });
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
    });
  });

  it('supports basic recentActivity subreddit thresholds', () => {
    const config = parseConfig(`
checks:
  - name: freekarma history
    kind: submission
    rules:
      - name: freekarma
        kind: recentActivity
        window:
          count: 10
        thresholds:
          - threshold: '>= 2'
            subreddits:
              - FreeKarma4U
              - upvote
    actions:
      - kind: report
        content: free karma history
`);

    const result = runDryConfig(config, {
      ...submissionActivity,
      authorHistory: [
        {
          ...submissionActivity,
          id: 't3_history1',
          subredditName: 'FreeKarma4U',
        },
        {
          ...commentActivity,
          id: 't1_history1',
          subredditName: 'upvote',
        },
        {
          ...submissionActivity,
          id: 't3_history2',
          subredditName: 'exampletwo',
        },
      ],
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      supported: true,
      triggered: true,
    });
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
    });
  });

  it('supports legacy SubredditCriteria objects in recent activity thresholds', () => {
    const config = parseConfig(`
checks:
  - name: adult subreddit history
    kind: submission
    rules:
      - name: adult history
        kind: recentActivity
        thresholds:
          - threshold: '>= 1'
            subreddits:
              - over18: true
                quarantine: false
    actions:
      - kind: report
        content: adult subreddit history
`);

    const result = runDryConfig(config, {
      ...submissionActivity,
      authorHistory: [
        {
          ...submissionActivity,
          id: 't3_history_adult',
          subredditName: 'adultsub',
          subredditNsfw: true,
          subredditQuarantined: false,
        },
        {
          ...commentActivity,
          id: 't1_history_safe',
          subredditName: 'generalsub',
          subredditNsfw: false,
          subredditQuarantined: false,
        },
      ],
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      supported: true,
      triggered: true,
    });
  });

  it('supports legacy SubredditCriteria objects in history include and exclude filters', () => {
    const config = parseConfig(`
checks:
  - name: filtered subreddit history
    kind: submission
    rules:
      - name: filtered history
        kind: history
        include:
          - name: '/spam/i'
          - isOwnProfile: true
        exclude:
          - quarantine: true
        criteria:
          - total: '>= 2'
            minActivityCount: 1
    actions:
      - kind: report
        content: filtered subreddit history
`);

    const result = runDryConfig(config, {
      ...submissionActivity,
      authorName: 'Spammer42',
      authorHistory: [
        {
          ...submissionActivity,
          id: 't3_history_spam',
          subredditName: 'spamhub',
          subredditQuarantined: false,
        },
        {
          ...commentActivity,
          id: 't1_history_profile',
          subredditName: 'u_Spammer42',
          subredditQuarantined: false,
        },
        {
          ...commentActivity,
          id: 't1_history_quarantine',
          subredditName: 'spamquarantine',
          subredditQuarantined: true,
        },
      ],
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      supported: true,
      triggered: true,
    });
  });

  it('supports regex history windows with activity match thresholds', () => {
    const config = parseConfig(`
checks:
  - name: repeated discord comments
    kind: comment
    rules:
      - name: discord history
        kind: regex
        criteria:
          - regex: '/discord\\.gg/i'
            matchThreshold: '>= 2'
            activityMatchThreshold: '>= 2'
            lookAt: comments
            window:
              count: 5
    actions:
      - kind: report
        content: repeated discord comments
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      body: 'discord.gg/one discord.gg/two',
      authorHistory: [
        {
          ...commentActivity,
          id: 't1_history1',
          body: 'discord.gg/three discord.gg/four',
        },
        {
          ...commentActivity,
          id: 't1_history2',
          body: 'discord.gg/five',
        },
        {
          ...submissionActivity,
          id: 't3_history1',
          body: 'discord.gg/six discord.gg/seven',
        },
      ],
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      supported: true,
      triggered: true,
    });
    expect(result.checkResults[0]?.rules[0]?.reason).toContain(
      'matched 2/3 activities'
    );
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
    });
  });

  it('supports regex total match thresholds across history windows', () => {
    const config = parseConfig(`
checks:
  - name: total spam mentions
    kind: comment
    rules:
      - name: spam totals
        kind: regex
        criteria:
          - regex: '/spam/i'
            totalMatchThreshold: '>= 4'
            window:
              count: 5
    actions:
      - kind: report
        content: total spam mentions
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      body: 'spam spam',
      authorHistory: [
        {
          ...commentActivity,
          id: 't1_history1',
          body: 'spam',
        },
        {
          ...commentActivity,
          id: 't1_history2',
          body: 'spam',
        },
      ],
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      supported: true,
      triggered: true,
    });
    expect(result.checkResults[0]?.rules[0]?.reason).toContain(
      '4 total occurrence'
    );
  });

  it('supports regex repeat thresholds across current and history matches', () => {
    const config = parseConfig(`
checks:
  - name: repeated invite mention
    kind: comment
    rules:
      - name: dupInvite
        kind: regex
        criteria:
          - regex: '/discord\\.gg\\/[a-z0-9]+/i'
            repeatThreshold: '>= 3'
            window:
              count: 5
    actions:
      - kind: report
        content: 'repeat {{rules.dupInvite.largestRepeat}} {{rules.dupInvite.largestRepeatValue}}'
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      body: 'discord.gg/same discord.gg/other',
      authorHistory: [
        {
          ...commentActivity,
          id: 't1_history1',
          body: 'discord.gg/same',
        },
        {
          ...commentActivity,
          id: 't1_history2',
          body: 'discord.gg/same',
        },
      ],
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      supported: true,
      triggered: true,
      templateData: {
        largestRepeat: 3,
        largestRepeatValue: 'discord.gg/same',
      },
    });
    expect(result.plannedActions[0]).toMatchObject({
      templateContext: {
        rules: {
          dupinvite: {
            largestRepeat: 3,
            largestRepeatValue: 'discord.gg/same',
          },
        },
      },
    });
  });

  it('supports repeatActivity reference matching with gap allowance', () => {
    const config = parseConfig(`
checks:
  - name: repeated link submission
    kind: submission
    rules:
      - name: xpost
        kind: repeatActivity
        threshold: '>= 3'
        gapAllowance: 1
        window:
          count: 10
    actions:
      - kind: report
        content: repeated link
`);

    const repeatedSubmission = {
      ...submissionActivity,
      selfPost: false,
      body: '',
      url: 'https://example.com/article',
    };
    const result = runDryConfig(config, {
      ...repeatedSubmission,
      authorHistory: [
        {
          ...repeatedSubmission,
          id: 't3_history1',
        },
        {
          ...commentActivity,
          id: 't1_gap',
          body: 'one normal comment between repeats',
        },
        {
          ...repeatedSubmission,
          id: 't3_history2',
        },
        {
          ...submissionActivity,
          id: 't3_other',
          selfPost: false,
          body: '',
          url: 'https://example.com/other',
        },
      ],
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      supported: true,
      triggered: true,
    });
    expect(result.checkResults[0]?.rules[0]?.reason).toContain(
      'largest repeat 3'
    );
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
      templateContext: {
        rules: {
          xpost: expect.objectContaining({
            largestRepeat: 3,
          }),
        },
      },
    });
  });

  it('supports repeatActivity fuzzy matchScore matching', () => {
    const config = parseConfig(`
checks:
  - name: repeated fuzzy comment
    kind: comment
    rules:
      - name: fuzzyRepeat
        kind: repeatActivity
        threshold: '>= 3'
        matchScore: 85
        window:
          count: 10
    actions:
      - kind: report
        content: repeated fuzzy comment
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      body: 'join my discord server for free rewards today',
      authorHistory: [
        {
          ...commentActivity,
          id: 't1_history1',
          body: 'join my discord server for free reward today',
        },
        {
          ...commentActivity,
          id: 't1_history2',
          body: 'join my discord server for free rewards now',
        },
        {
          ...commentActivity,
          id: 't1_history3',
          body: 'normal unrelated comment',
        },
      ],
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      supported: true,
      triggered: true,
    });
    expect(result.checkResults[0]?.rules[0]?.reason).toContain('matchScore 85');
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
      templateContext: {
        rules: {
          fuzzyrepeat: expect.objectContaining({
            largestRepeat: 3,
          }),
        },
      },
    });
  });

  it('marks repeatActivity unsupported until author history is hydrated', () => {
    const config = parseConfig(`
checks:
  - name: missing repeat history
    kind: submission
    rules:
      - kind: repeatActivity
        threshold: '>= 2'
    actions:
      - kind: report
        content: should not plan
`);

    const result = runDryConfig(config, submissionActivity);

    expect(result.checksTriggered).toBe(0);
    expect(result.plannedActions).toHaveLength(0);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      supported: false,
      triggered: false,
      reason: 'author history was not hydrated',
    });
  });

  it('supports attribution self-promotion thresholds over author history', () => {
    const config = parseConfig(`
checks:
  - name: attribution check
    kind: submission
    rules:
      - name: self promo
        kind: attribution
        criteria:
          - threshold: '>= 60%'
            minActivityCount: 1
            aggregateOn:
              - link
            window:
              count: 10
    actions:
      - kind: report
        content: attribution matched
`);

    const externalSubmission = {
      ...submissionActivity,
      selfPost: false,
      body: '',
      url: 'https://example.com/current',
    };
    const result = runDryConfig(config, {
      ...externalSubmission,
      authorHistory: [
        {
          ...externalSubmission,
          id: 't3_history1',
          url: 'https://example.com/one',
        },
        {
          ...externalSubmission,
          id: 't3_history2',
          url: 'https://example.com/two',
        },
        {
          ...commentActivity,
          id: 't1_history1',
          body: 'normal comment',
        },
        {
          ...commentActivity,
          id: 't1_history2',
          body: 'another normal comment',
        },
      ],
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      supported: true,
      triggered: true,
    });
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
    });
  });

  it('supports basic repost checks against hydrated duplicate candidates', () => {
    const config = parseConfig(`
checks:
  - name: repost check
    kind: submission
    rules:
      - name: duplicate repost
        kind: repost
        criteria:
          - searchOn:
              - duplicates
              - crossposts
            occurrences:
              criteria:
                - count:
                    test:
                      - '>= 2'
    actions:
      - kind: report
        content: repost matched
`);

    const result = runDryConfig(config, {
      ...submissionActivity,
      repostCandidates: [
        {
          ...submissionActivity,
          id: 't3_duplicate',
          repostCandidateSource: 'duplicates',
        },
        {
          ...submissionActivity,
          id: 't3_crosspost',
          repostCandidateSource: 'crossposts',
        },
      ],
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      supported: true,
      triggered: true,
    });
    expect(result.checkResults[0]?.rules[0]?.reason).toContain(
      '2 hydrated duplicate/crosspost/external candidate'
    );
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
    });
  });

  it('supports comment repost checks against hydrated candidate comments', () => {
    const config = parseConfig(`
checks:
  - name: comment repost check
    kind: comment
    rules:
      - name: comment repost
        kind: repost
        criteria:
          - searchOn:
              - duplicates
            occurrences:
              criteria:
                - count:
                    test:
                      - '>= 1'
    actions:
      - kind: report
        content: comment repost matched
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      body: 'This exact phrase keeps getting copied around',
      repostCandidates: [
        {
          ...commentActivity,
          id: 't1_repost',
          body: 'This exact phrase keeps getting copied around',
          repostCandidateSource: 'duplicates',
        },
      ],
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      supported: true,
      triggered: true,
    });
  });

  it('supports comment repost checks against external YouTube candidates', () => {
    const config = parseConfig(`
checks:
  - name: youtube comment repost check
    kind: comment
    rules:
      - name: youtube comment repost
        kind: repost
        criteria:
          - searchOn:
              - external
            occurrences:
              criteria:
                - count:
                    test:
                      - '>= 1'
    actions:
      - kind: report
        content: youtube comment repost matched
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      body: 'This exact phrase was copied from youtube',
      repostCandidates: [
        {
          ...commentActivity,
          id: 'yt_comment_1',
          body: 'This exact phrase was copied from youtube',
          permalink: 'https://youtube.com/watch?v=abc123xyz89&lc=comment_1',
          subredditName: 'youtube',
          repostCandidateSource: 'external',
          repostCandidateProvider: 'YouTube',
        },
      ],
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      supported: true,
      triggered: true,
    });
  });

  it('supports repost occurrence time criteria', () => {
    const config = parseConfig(`
checks:
  - name: repost time check
    kind: submission
    rules:
      - name: old repost
        kind: repost
        criteria:
          - searchOn:
              - duplicates
            occurrences:
              criteria:
                - count:
                    test:
                      - '>= 2'
                  time:
                    test:
                      - testOn: newest
                        condition: '> 1 day'
            occurredAt:
              criteria:
                - testOn: oldest
                  condition: '> 7 days'
    actions:
      - kind: report
        content: old repost matched
`);
    const now = Date.now();
    const result = runDryConfig(config, {
      ...submissionActivity,
      createdAt: new Date(now),
      repostCandidates: [
        {
          ...submissionActivity,
          id: 't3_oldest',
          createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000),
          repostCandidateSource: 'duplicates',
        },
        {
          ...submissionActivity,
          id: 't3_newest',
          createdAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
          repostCandidateSource: 'duplicates',
        },
      ],
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      supported: true,
      triggered: true,
    });
  });

  it('marks author resource filters unsupported until metadata is hydrated', () => {
    const config = parseConfig(`
checks:
  - name: needs author resources
    kind: comment
    authorIs:
      isMod: false
      age: '> 100 days'
    actions:
      - kind: report
        content: should remain planned but unsupported
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions).toHaveLength(1);
    expect(result.plannedActions[0]).toMatchObject({
      supported: false,
    });
    expect(result.checkResults[0]).toMatchObject({
      supported: false,
    });
    expect(result.checkResults[0]?.reason).toContain('unsupported fields');
  });

  it('supports check-level authorIs and itemIs filters with local fields', () => {
    const config = parseConfig(`
checks:
  - name: filtered check
    kind: comment
    authorIs:
      exclude:
        - name: OtherUser
    itemIs:
      approved: false
      removed: false
      distinguished: false
      score: '>= 1'
    actions:
      - kind: report
        content: matched current-state filters
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checksEvaluated).toBe(1);
    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions).toHaveLength(1);
    expect(result.plannedActions[0]?.kind).toBe('report');
  });

  it('supports deleted and filtered item state filters', () => {
    const config = parseConfig(`
checks:
  - name: deleted filtered state
    kind: comment
    itemIs:
      deleted: true
      filtered: true
    actions:
      - kind: report
        content: deleted filtered state matched
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      deleted: true,
      filtered: true,
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
      supported: true,
    });
  });

  it('supports moderator-name removed and approved item filters when metadata is hydrated', () => {
    const config = parseConfig(`
checks:
  - name: moderator state
    kind: comment
    itemIs:
      removed: automod
      approved:
        name: ModOne
    actions:
      - kind: report
        content: moderator state matched
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      removed: true,
      removedBy: 'AutoModerator',
      approved: true,
      approvedBy: 'ModOne',
    });
    const unsupported = runDryConfig(config, {
      ...commentActivity,
      removed: true,
      approved: true,
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
      supported: true,
    });
    expect(unsupported.checkResults[0]).toMatchObject({
      supported: false,
    });
  });

  it('supports Devvit post and comment moderation state fields', () => {
    const submissionConfig = parseConfig(`
checks:
  - name: post state
    kind: submission
    itemIs:
      archived: true
      quarantined: true
      hidden: true
      ignoringReports: true
    actions:
      - kind: report
        content: post state matched
`);
    const commentConfig = parseConfig(`
checks:
  - name: comment state
    kind: comment
    itemIs:
      collapsed_because_crowd_control: true
      ignoring_reports: true
    actions:
      - kind: report
        content: comment state matched
`);

    const submissionResult = runDryConfig(submissionConfig, {
      ...submissionActivity,
      archived: true,
      quarantined: true,
      hidden: true,
      ignoringReports: true,
    });
    const commentResult = runDryConfig(commentConfig, {
      ...commentActivity,
      collapsedBecauseCrowdControl: true,
      ignoringReports: true,
    });

    expect(submissionResult.checksTriggered).toBe(1);
    expect(commentResult.checksTriggered).toBe(1);
  });

  it('supports hydrated subreddit quarantine item filters', () => {
    const config = parseConfig(`
checks:
  - name: subreddit metadata
    kind: submission
    itemIs:
      subredditQuarantined: true
      subredditType: public
    actions:
      - kind: report
        content: subreddit metadata matched
`);

    const result = runDryConfig(config, {
      ...submissionActivity,
      subredditQuarantined: true,
      subredditType: 'public',
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
      supported: true,
    });
  });

  it('supports author modActions filters when mod notes are hydrated', () => {
    const config = parseConfig(`
checks:
  - name: prior spam warning
    kind: comment
    authorIs:
      modActions:
        - noteType: SPAM_WARNING
          note: spam warning
          referencesCurrentActivity: true
          search: total
          count: '>= 1'
    actions:
      - kind: report
        content: prior mod note matched
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      authorModNotes: [
        {
          id: 'ModNote_1',
          type: 'NOTE',
          createdAt: new Date('2026-05-25T00:00:00Z'),
          label: 'SPAM_WARNING',
          note: 'Prior spam warning',
          redditId: 't1_comment',
        },
      ],
    });
    const unsupported = runDryConfig(config, commentActivity);

    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
    });
    expect(unsupported.checkResults[0]).toMatchObject({
      supported: false,
    });
    expect(unsupported.checkResults[0]?.reason).toContain(
      'authorIs include criteria need unsupported fields'
    );
  });

  it('supports Toolbox userNotes author filters when notes are hydrated', () => {
    const config = parseConfig(`
checks:
  - name: prior toolbox usernote
    kind: comment
    authorIs:
      userNotes:
        - type: spamwatch
          note: '/spam warning/i'
          search: total
          count: '>= 1'
    actions:
      - kind: report
        content: prior usernote matched
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      authorUserNotes: [
        {
          text: 'Prior spam warning',
          type: 'spamwatch',
          moderator: 'ModOne',
          createdAt: new Date('2026-05-25T00:00:00Z'),
          link: 'https://reddit.com/r/testsub/comments/post/comment',
        },
      ],
    });
    const unsupported = runDryConfig(config, commentActivity);

    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
    });
    expect(unsupported.checkResults[0]).toMatchObject({
      supported: false,
    });
    expect(unsupported.checkResults[0]?.reason).toContain(
      'authorIs include criteria need unsupported fields'
    );
  });

  it('supports current activity sentiment rules with template data', () => {
    const config = parseConfig(`
checks:
  - name: negative sentiment
    kind: comment
    rules:
      - name: badtone
        kind: sentiment
        sentiment: is very negative
    actions:
      - kind: report
        content: sentiment {{rules.badtone.averageScore}}
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      body: 'I hate this awful scam',
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
      templateContext: {
        rules: {
          badtone: {
            sentiment: 'extremely negative',
            sentimentTest: 'very negative (<= -0.3)',
          },
        },
      },
    });
  });

  it('supports historical sentiment thresholds from hydrated author history', () => {
    const config = parseConfig(`
checks:
  - name: historical negative sentiment
    kind: comment
    rules:
      - name: historytone
        kind: sentiment
        sentiment: is negative
        historical:
          sentiment: is very negative
          totalMatching: '>= 2'
    actions:
      - kind: report
        content: historical sentiment matched
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      body: 'ok',
      authorHistory: [
        {
          ...commentActivity,
          id: 't1_history1',
          body: 'This is bad terrible awful',
        },
        {
          ...commentActivity,
          id: 't1_history2',
          body: 'I hate this awful scam',
        },
        {
          ...commentActivity,
          id: 't1_history3',
          body: 'wonderful amazing great',
        },
      ],
    });
    const unsupported = runDryConfig(config, commentActivity);

    expect(result.checksTriggered).toBe(1);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      name: 'historytone',
      supported: true,
      triggered: true,
    });
    expect(unsupported.checkResults[0]?.rules[0]).toMatchObject({
      supported: false,
      reason: 'author history was not hydrated',
    });
  });

  it('supports item source filters for trigger and dispatch metadata', () => {
    const config = parseConfig(`
checks:
  - name: source check
    kind: comment
    itemIs:
      source: dispatch
    actions:
      - kind: report
        content: matched dispatch source
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      source: 'dispatch:followup',
    });
    const nonMatch = runDryConfig(config, {
      ...commentActivity,
      source: 'poll:newComm',
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
    });
    expect(nonMatch.checksTriggered).toBe(0);
  });

  it('can start dry-run evaluation at a dispatch goto target', () => {
    const config = parseConfig(`
runs:
  - name: default
    checks:
      - name: first check
        kind: comment
        actions:
          - kind: report
            content: first
      - name: second check
        kind: comment
        actions:
          - kind: report
            content: second
`);

    const result = runDryConfig(config, commentActivity, {
      startAt: 'second check',
    });

    expect(result.checksEvaluated).toBe(1);
    expect(result.checkResults[0]?.name).toBe('second check');
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
      config: {
        content: 'second',
      },
    });
  });

  it('supports age, createdOn, and total report item filters', () => {
    const config = parseConfig(`
checks:
  - name: aged reported comment
    kind: comment
    itemIs:
      age: '> 12 hours'
      createdOn: sunday
      reports: '>= 2'
    actions:
      - kind: report
        content: aged reported item
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      numReports: 2,
    });

    expect(result.checksEvaluated).toBe(1);
    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions).toHaveLength(1);
    expect(result.plannedActions[0]?.kind).toBe('report');
  });

  it('supports report type and reason item filters from hydrated report reasons', () => {
    const userReportConfig = parseConfig(`
checks:
  - name: user report reason
    kind: comment
    itemIs:
      reports: '>= 1 user "misinformation"'
    actions:
      - kind: report
        content: misinformation report
`);
    const modReportConfig = parseConfig(`
checks:
  - name: mod report regex
    kind: comment
    itemIs:
      reports: '>= 1 mod /rule\\s+1/i'
    actions:
      - kind: report
        content: mod report
`);

    const activityWithReports = {
      ...commentActivity,
      numReports: 3,
      userReportReasons: ['misinformation', 'spam'],
      modReportReasons: ['Rule 1'],
    };
    const userReportResult = runDryConfig(userReportConfig, activityWithReports);
    const modReportResult = runDryConfig(modReportConfig, activityWithReports);

    expect(userReportResult.checksTriggered).toBe(1);
    expect(userReportResult.plannedActions).toHaveLength(1);
    expect(modReportResult.checksTriggered).toBe(1);
    expect(modReportResult.plannedActions).toHaveLength(1);
  });

  it('marks report time-window filters unsupported without report storage', () => {
    const config = parseConfig(`
checks:
  - name: recent reports
    kind: comment
    itemIs:
      reports: '> 0 in 20 minutes'
    actions:
      - kind: report
        content: recent report
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      numReports: 1,
      userReportReasons: ['spam'],
      modReportReasons: [],
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
      supported: false,
    });
    expect(result.checkResults[0]?.reason).toContain(
      'itemIs include criteria need unsupported fields'
    );
  });

  it('supports comment op and depth item filters when metadata is available', () => {
    const config = parseConfig(`
checks:
  - name: op top-level comment
    kind: comment
    itemIs:
      op: true
      depth: 0
    actions:
      - kind: report
        content: op top-level comment
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      commentIsOp: true,
      commentDepth: 0,
    });

    expect(result.checksEvaluated).toBe(1);
    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions).toHaveLength(1);
    expect(result.plannedActions[0]?.kind).toBe('report');
  });

  it('supports comment parent submission-state filters when parent metadata is hydrated', () => {
    const config = parseConfig(`
checks:
  - name: parent submission state
    kind: comment
    itemIs:
      submissionState:
        - is_self: true
          title: '/weekly spam/i'
          link_flair_text: '/needs review/i'
    actions:
      - kind: report
        content: parent submission matched
`);

    const result = runDryConfig(config, {
      ...commentActivity,
      parentSubmission: submissionActivity,
    });
    const unsupported = runDryConfig(config, commentActivity);

    expect(result.checksEvaluated).toBe(1);
    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions).toHaveLength(1);
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
      supported: true,
    });
    expect(unsupported.checkResults[0]).toMatchObject({
      supported: false,
    });
    expect(unsupported.checkResults[0]?.reason).toContain(
      'itemIs include criteria need unsupported fields'
    );
  });

  it('skips checks when supported author filters do not pass', () => {
    const config = parseConfig(`
checks:
  - name: ignored author
    kind: comment
    authorIs:
      exclude:
        - name: Spammer42
    actions:
      - kind: report
        content: should not plan
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checksEvaluated).toBe(0);
    expect(result.checksTriggered).toBe(0);
    expect(result.plannedActions).toHaveLength(0);
    expect(result.checkResults[0]).toMatchObject({
      skipped: true,
      reason: 'authorIs criteria did not pass',
    });
  });

  it('marks partially supported filters as unsupported without blocking dry-run planning', () => {
    const config = parseConfig(`
checks:
  - name: mixed support filter
    kind: comment
    authorIs:
      include:
        - name: Spammer42
          isMod: true
    actions:
      - kind: report
        content: unsupported author filter field is present
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions).toHaveLength(1);
    expect(result.checkResults[0]).toMatchObject({
      supported: false,
    });
    expect(result.checkResults[0]?.reason).toContain('unsupported fields');
  });

  it('applies action-level filters before planning actions', () => {
    const config = parseConfig(`
checks:
  - name: action filters
    kind: comment
    rules:
      - kind: regex
        criteria:
          - regex: '/discord\\.gg/i'
    actions:
      - kind: remove
        itemIs:
          score: '> 10'
      - kind: report
        itemIs:
          score: '<= 1'
        content: low score match
      - kind: comment
        authorIs:
          exclude:
            - name: Spammer42
        content: should not plan
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions.map((action) => action.kind)).toEqual([
      'report',
    ]);
  });

  it('applies rule-level filters before evaluating a rule', () => {
    const config = parseConfig(`
checks:
  - name: rule filters
    kind: comment
    rules:
      - kind: regex
        authorIs:
          exclude:
            - name: Spammer42
        criteria:
          - regex: '/discord\\.gg/i'
    actions:
      - kind: remove
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checksTriggered).toBe(0);
    expect(result.plannedActions).toHaveLength(0);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      triggered: false,
      reason: 'authorIs criteria did not pass',
    });
  });

  it('supports submission item filters for local post state', () => {
    const config = parseConfig(`
checks:
  - name: filtered submission
    kind: submission
    itemIs:
      over_18: false
      spoiler: false
      is_self: true
      pinned: false
      title: '/weekly spam/i'
      link_flair_text: '/needs review/i'
    actions:
      - kind: report
        content: matching submission state
`);

    const result = runDryConfig(config, submissionActivity);

    expect(result.checksEvaluated).toBe(1);
    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions).toHaveLength(1);
    expect(result.plannedActions[0]?.kind).toBe('report');
  });

  it('supports expanded submission link flair filters', () => {
    const config = parseConfig(`
checks:
  - name: expanded flair submission
    kind: submission
    itemIs:
      link_flair_text: '/needs review/i'
      link_flair_css_class: review
      link_flair_background_color: 46d160
      flairTemplate: post-template
    actions:
      - kind: report
        content: matching expanded link flair state
`);

    const result = runDryConfig(config, submissionActivity);

    expect(result.checksEvaluated).toBe(1);
    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions).toHaveLength(1);
    expect(result.plannedActions[0]?.kind).toBe('report');
  });

  it('supports Reddit-hosted media submission filters', () => {
    const config = parseConfig(`
checks:
  - name: reddit media submission
    kind: submission
    itemIs:
      isRedditMediaDomain: true
    actions:
      - kind: report
        content: reddit media matched
`);

    const result = runDryConfig(config, {
      ...submissionActivity,
      isRedditMediaDomain: true,
    });
    const nonMatch = runDryConfig(config, submissionActivity);

    expect(result.checksEvaluated).toBe(1);
    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions[0]?.kind).toBe('report');
    expect(nonMatch.checksTriggered).toBe(0);
  });

  it('skips submission checks when local post-state filters do not pass', () => {
    const config = parseConfig(`
checks:
  - name: skipped submission
    kind: submission
    itemIs:
      spoiler: true
    actions:
      - kind: report
        content: should not plan
`);

    const result = runDryConfig(config, submissionActivity);

    expect(result.checksEvaluated).toBe(0);
    expect(result.checksTriggered).toBe(0);
    expect(result.plannedActions).toHaveLength(0);
    expect(result.checkResults[0]).toMatchObject({
      skipped: true,
      reason: 'itemIs criteria did not pass',
    });
  });

  it('applies top-level filter defaults to checks', () => {
    const config = parseConfig(`
filterCriteriaDefaults:
  authorIs:
    exclude:
      - name: Spammer42
checks:
  - name: default excluded author
    kind: comment
    actions:
      - kind: report
        content: should not plan
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checksEvaluated).toBe(0);
    expect(result.plannedActions).toHaveLength(0);
    expect(result.checkResults[0]).toMatchObject({
      skipped: true,
      reason: 'authorIs criteria did not pass',
    });
  });

  it('supports replace behavior for filter defaults', () => {
    const config = parseConfig(`
filterCriteriaDefaults:
  authorIsBehavior: replace
  authorIs:
    exclude:
      - name: Spammer42
checks:
  - name: explicit author replaces default
    kind: comment
    authorIs:
      name: Spammer42
    actions:
      - kind: report
        content: explicit author matched
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checksEvaluated).toBe(1);
    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions[0]?.kind).toBe('report');
  });

  it('uses run-level filter defaults for checks before top-level defaults', () => {
    const config = parseConfig(`
filterCriteriaDefaults:
  authorIs:
    exclude:
      - name: Spammer42
runs:
  - name: run override
    filterCriteriaDefaults:
      authorIsBehavior: replace
      authorIs:
        name: Spammer42
    checks:
      - name: run default author
        kind: comment
        actions:
          - kind: report
            content: run default matched
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checksEvaluated).toBe(1);
    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions[0]?.kind).toBe('report');
  });

  it('uses legacy nextRun as the default post-trigger flow behavior', () => {
    const config = parseConfig(`
runs:
  - name: first run
    checks:
      - name: first check
        kind: comment
        actions:
          - kind: report
            content: first
      - name: skipped by default nextRun
        kind: comment
        actions:
          - kind: remove
  - name: second run
    checks:
      - name: next run check
        kind: comment
        actions:
          - kind: report
            content: second run
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checkResults.map((check) => check.name)).toEqual([
      'first check',
      'next run check',
    ]);
    expect(result.checkResults[0]?.postBehavior).toBe('nextRun');
    expect(result.plannedActions.map((action) => action.kind)).toEqual([
      'report',
      'report',
    ]);
  });

  it('supports explicit next and stop post-check flow behavior', () => {
    const nextConfig = parseConfig(`
checks:
  - name: continue after trigger
    kind: comment
    postTrigger: next
    actions:
      - kind: report
        content: first
  - name: reached by next
    kind: comment
    actions:
      - kind: remove
`);
    const stopConfig = parseConfig(`
runs:
  - name: first run
    checks:
      - name: stop after trigger
        kind: comment
        postTrigger: stop
        actions:
          - kind: report
            content: first
  - name: second run
    checks:
      - name: skipped by stop
        kind: comment
        actions:
          - kind: remove
`);

    const nextResult = runDryConfig(nextConfig, commentActivity);
    const stopResult = runDryConfig(stopConfig, commentActivity);

    expect(nextResult.checkResults.map((check) => check.name)).toEqual([
      'continue after trigger',
      'reached by next',
    ]);
    expect(nextResult.plannedActions.map((action) => action.kind)).toEqual([
      'report',
      'remove',
    ]);
    expect(stopResult.checkResults.map((check) => check.name)).toEqual([
      'stop after trigger',
    ]);
    expect(stopResult.checkResults[0]?.postBehavior).toBe('stop');
  });

  it('supports same-run and cross-run goto flow behavior', () => {
    const config = parseConfig(`
runs:
  - name: first run
    checks:
      - name: route in same run
        kind: comment
        postTrigger: 'goto:.same run target'
        actions:
          - kind: report
            content: route
      - name: skipped same run check
        kind: comment
        actions:
          - kind: remove
      - name: same run target
        kind: comment
        postTrigger: 'goto:second run.cross run target'
        actions:
          - kind: report
            content: same run target
  - name: second run
    checks:
      - name: skipped cross run check
        kind: comment
        actions:
          - kind: remove
      - name: cross run target
        kind: comment
        actions:
          - kind: report
            content: cross run target
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checkResults.map((check) => check.name)).toEqual([
      'route in same run',
      'same run target',
      'cross run target',
    ]);
    expect(result.plannedActions.map((action) => action.kind)).toEqual([
      'report',
      'report',
      'report',
    ]);
  });

  it('hydrates named rule references across checks', () => {
    const config = parseConfig(`
checks:
  - name: defines named rule
    kind: comment
    enable: false
    rules:
      - name: discord spam rule
        kind: regex
        criteria:
          - regex: '/discord\\.gg/i'
  - name: reuses named rule
    kind: comment
    rules:
      - discord spam rule
    actions:
      - kind: report
        content: named rule matched
`);

    const result = runDryConfig(config, commentActivity);
    const reusedCheck = result.checkResults.find(
      (check) => check.name === 'reuses named rule'
    );

    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions[0]?.kind).toBe('report');
    expect(reusedCheck?.rules[0]).toMatchObject({
      name: 'discord spam rule',
      triggered: true,
      supported: true,
    });
    expect(reusedCheck?.rules[0]?.reason).toContain('resolved named rule');
  });

  it('hydrates named action references across checks', () => {
    const config = parseConfig(`
checks:
  - name: defines named action
    kind: comment
    enable: false
    actions:
      - name: report discord
        kind: report
        content: named action matched
  - name: reuses named action
    kind: comment
    rules:
      - kind: regex
        criteria:
          - regex: '/discord\\.gg/i'
    actions:
      - report discord
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
      name: 'report discord',
      enabled: true,
    });
    expect(result.plannedActions[0]?.reason).toContain('resolved named action');
  });

  it('hydrates named author filter references across checks and actions', () => {
    const config = parseConfig(`
checks:
  - name: defines named author filter
    kind: comment
    enable: false
    authorIs:
      include:
        - name: trusted helper
          criteria:
            name: Spammer42
            flairText: '/trusted/i'
  - name: reuses named author filter
    kind: comment
    authorIs: trusted helper
    actions:
      - kind: report
        authorIs:
          include:
            - trusted helper
        content: named author filter matched
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
      enabled: true,
    });
    expect(result.checkResults[1]).toMatchObject({
      supported: true,
    });
  });

  it('hydrates named item filter references across checks', () => {
    const config = parseConfig(`
checks:
  - name: defines named item filter
    kind: submission
    enable: false
    itemIs:
      include:
        - name: clean self post
          criteria:
            removed: false
            is_self: true
            link_flair_text: '/needs review/i'
  - name: reuses named item filter
    kind: submission
    itemIs:
      include:
        - clean self post
    actions:
      - kind: report
        content: named item filter matched
`);

    const result = runDryConfig(config, submissionActivity);

    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'report',
      enabled: true,
    });
    expect(result.checkResults[1]).toMatchObject({
      supported: true,
    });
  });

  it('marks missing named references as unsupported planned placeholders', () => {
    const config = parseConfig(`
checks:
  - name: missing named refs
    kind: comment
    rules:
      - missing rule
    actions:
      - missing action
`);

    const result = runDryConfig(config, commentActivity);

    expect(result.checksTriggered).toBe(0);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      name: 'missing rule',
      supported: false,
      reason: 'named rule reference was not found',
    });
    expect(result.plannedActions).toHaveLength(0);
  });

  // === Feature 1: Subreddit quarantine metadata ===

  it('supports itemIs quarantined filter on submissions', () => {
    const config = parseConfig(`
checks:
  - name: quarantined post filter
    kind: submission
    itemIs:
      quarantined: true
    actions:
      - kind: report
        content: post is quarantined
`);

    const triggered = runDryConfig(config, {
      ...submissionActivity,
      quarantined: true,
    });
    expect(triggered.checksTriggered).toBe(1);
    expect(triggered.plannedActions[0]).toMatchObject({ kind: 'report' });

    const notTriggered = runDryConfig(config, {
      ...submissionActivity,
      quarantined: false,
    });
    expect(notTriggered.checksTriggered).toBe(0);
  });

  // === Feature 2: SubredditCriteria (include/exclude subreddit filters) ===

  it('supports history rule with subreddit include filter', () => {
    const config = parseConfig(`
checks:
  - name: spamhub only
    kind: submission
    rules:
      - name: spamhub history
        kind: history
        include:
          - spamhub
        criteria:
          - total: '>= 2'
            minActivityCount: 1
            window:
              count: 10
    actions:
      - kind: report
        content: spamhub history
`);

    const result = runDryConfig(config, {
      ...submissionActivity,
      authorHistory: [
        { ...submissionActivity, id: 't3_h1', subredditName: 'spamhub' },
        { ...submissionActivity, id: 't3_h2', subredditName: 'spamhub' },
        { ...submissionActivity, id: 't3_h3', subredditName: 'cleanSub' },
      ],
    });

    expect(result.checksTriggered).toBe(1);
    expect(result.checkResults[0]?.rules[0]).toMatchObject({
      supported: true,
      triggered: true,
    });
  });

  it('supports history rule with subreddit exclude filter', () => {
    const config = parseConfig(`
checks:
  - name: exclude cleanSub
    kind: submission
    rules:
      - name: exclude filter
        kind: history
        exclude:
          - cleanSub
        criteria:
          - total: '>= 2'
            minActivityCount: 1
            window:
              count: 10
    actions:
      - kind: report
        content: non-clean history
`);

    const triggered = runDryConfig(config, {
      ...submissionActivity,
      authorHistory: [
        { ...submissionActivity, id: 't3_h1', subredditName: 'spamhub' },
        { ...submissionActivity, id: 't3_h2', subredditName: 'spamhub' },
        { ...submissionActivity, id: 't3_h3', subredditName: 'cleanSub' },
      ],
    });
    expect(triggered.checksTriggered).toBe(1);

    const notTriggered = runDryConfig(config, {
      ...submissionActivity,
      authorHistory: [
        { ...submissionActivity, id: 't3_h1', subredditName: 'cleanSub' },
        { ...submissionActivity, id: 't3_h2', subredditName: 'cleanSub' },
      ],
    });
    expect(notTriggered.checksTriggered).toBe(0);
  });

  it('supports repeatActivity with subreddit include filter', () => {
    const config = parseConfig(`
checks:
  - name: repeat in target sub
    kind: submission
    rules:
      - name: targeted repeat
        kind: repeatActivity
        threshold: '>= 2'
        include:
          - testsub
        window:
          count: 10
    actions:
      - kind: report
        content: repeated in target sub
`);

    const repeatedSubmission = {
      ...submissionActivity,
      selfPost: false,
      body: '',
      url: 'https://example.com/article',
    };

    const result = runDryConfig(config, {
      ...repeatedSubmission,
      authorHistory: [
        { ...repeatedSubmission, id: 't3_h1', subredditName: 'testsub' },
        { ...repeatedSubmission, id: 't3_h2', subredditName: 'otherSub' },
        { ...repeatedSubmission, id: 't3_h3', subredditName: 'testsub' },
      ],
    });

    expect(result.checksTriggered).toBe(1);
  });

  it('supports attribution criteria with subreddit include filter', () => {
    const config = parseConfig(`
checks:
  - name: attribution in target sub
    kind: submission
    rules:
      - name: promo check
        kind: attribution
        criteria:
          - threshold: '>= 50%'
            minActivityCount: 1
            include:
              - testsub
            aggregateOn:
              - link
            window:
              count: 10
    actions:
      - kind: report
        content: attribution in target sub
`);

    const externalSubmission = {
      ...submissionActivity,
      selfPost: false,
      body: '',
      url: 'https://example.com/article',
    };

    const result = runDryConfig(config, {
      ...externalSubmission,
      authorHistory: [
        { ...externalSubmission, id: 't3_h1', url: 'https://example.com/one', subredditName: 'testsub' },
        { ...externalSubmission, id: 't3_h2', url: 'https://example.com/two', subredditName: 'testsub' },
        { ...externalSubmission, id: 't3_h3', url: 'https://other.com/three', subredditName: 'otherSub' },
      ],
    });

    expect(result.checksTriggered).toBe(1);
  });

  // === Feature 3: Subreddit metadata itemIs fields ===

  it('supports itemIs subredditNsfw filter', () => {
    const config = parseConfig(`
checks:
  - name: nsfw subreddit filter
    kind: submission
    itemIs:
      subredditNsfw: true
    actions:
      - kind: report
        content: post in nsfw subreddit
`);

    const triggered = runDryConfig(config, {
      ...submissionActivity,
      subredditNsfw: true,
    });
    expect(triggered.checksTriggered).toBe(1);

    const notTriggered = runDryConfig(config, {
      ...submissionActivity,
      subredditNsfw: false,
    });
    expect(notTriggered.checksTriggered).toBe(0);
  });

  it('supports itemIs subredditType filter', () => {
    const config = parseConfig(`
checks:
  - name: public subreddit filter
    kind: submission
    itemIs:
      subredditType: public
    actions:
      - kind: report
        content: post in public subreddit
`);

    const triggered = runDryConfig(config, {
      ...submissionActivity,
      subredditType: 'public',
    });
    expect(triggered.checksTriggered).toBe(1);

    const notTriggered = runDryConfig(config, {
      ...submissionActivity,
      subredditType: 'private',
    });
    expect(notTriggered.checksTriggered).toBe(0);
  });

  it('supports itemIs subredditName regex filter', () => {
    const config = parseConfig(`
checks:
  - name: subreddit name filter
    kind: submission
    itemIs:
      subredditName: '/^test/i'
    actions:
      - kind: report
        content: post in test subreddit
`);

    const triggered = runDryConfig(config, submissionActivity);
    expect(triggered.checksTriggered).toBe(1);

    const notTriggered = runDryConfig(config, {
      ...submissionActivity,
      subredditName: 'othersub',
    });
    expect(notTriggered.checksTriggered).toBe(0);
  });

  it('supports itemIs is_user_profile and is_own_profile filters', () => {
    const profileConfig = parseConfig(`
checks:
  - name: user profile check
    kind: submission
    itemIs:
      is_user_profile: true
    actions:
      - kind: report
        content: posted on user profile
`);

    const ownProfileConfig = parseConfig(`
checks:
  - name: own profile check
    kind: submission
    itemIs:
      is_own_profile: true
    actions:
      - kind: report
        content: posted on own profile
`);

    const profileResult = runDryConfig(profileConfig, {
      ...submissionActivity,
      subredditName: 'u_SomeUser',
    });
    expect(profileResult.checksTriggered).toBe(1);

    const nonProfileResult = runDryConfig(profileConfig, submissionActivity);
    expect(nonProfileResult.checksTriggered).toBe(0);

    const ownResult = runDryConfig(ownProfileConfig, {
      ...submissionActivity,
      subredditName: 'u_Poster42',
      authorName: 'Poster42',
    });
    expect(ownResult.checksTriggered).toBe(1);

    const notOwnResult = runDryConfig(ownProfileConfig, {
      ...submissionActivity,
      subredditName: 'u_SomeoneElse',
      authorName: 'Poster42',
    });
    expect(notOwnResult.checksTriggered).toBe(0);
  });
});
