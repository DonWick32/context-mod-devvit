import { describe, expect, it } from 'vitest';
import { parseLegacyConfigText } from '../src/config/legacyConfigParser';
import type { ActivitySnapshot } from '../src/runtime/activityAdapter';
import {
  commentParentModifierFixture,
  submissionFilterFlairFixture,
} from '../src/runtime/playtestFixtures';
import { runDryConfig } from '../src/runtime/dryRunEngine';

const commentActivity: ActivitySnapshot = {
  id: 't1_fixture_comment',
  kind: 'comment',
  authorName: 'FixtureUser',
  subredditName: 'testsub',
  body: commentParentModifierFixture.triggerText,
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

const submissionActivity: ActivitySnapshot = {
  id: 't3_fixture_post',
  kind: 'submission',
  authorName: 'FixtureUser',
  subredditName: 'testsub',
  title: submissionFilterFlairFixture.triggerText,
  body: 'Temporary fixture post',
  createdAt: new Date('2026-05-25T00:00:00Z'),
  permalink: '/r/testsub/comments/post/fixture',
  score: 1,
  removed: false,
  approved: false,
  locked: false,
  spam: false,
  stickied: false,
  distinguished: false,
  nsfw: false,
  spoiler: false,
  selfPost: true,
};

const parseFixture = (text: string) => {
  const result = parseLegacyConfigText(text);
  if (!result.ok) {
    throw new Error(result.errors.join('\n'));
  }
  return result.config;
};

describe('playtest fixtures', () => {
  it('comment fixture plans a parent-target comment with modifiers', () => {
    const config = parseFixture(commentParentModifierFixture.configText);

    const result = runDryConfig(config, commentActivity);

    expect(result.checksEvaluated).toBe(1);
    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions).toHaveLength(1);
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'comment',
      config: {
        targets: 'parent',
        lock: true,
        distinguish: true,
        sticky: true,
      },
    });
  });

  it('submission fixture plans a post flair action', () => {
    const config = parseFixture(submissionFilterFlairFixture.configText);

    const result = runDryConfig(config, submissionActivity);

    expect(result.checksEvaluated).toBe(1);
    expect(result.checksTriggered).toBe(1);
    expect(result.plannedActions).toHaveLength(1);
    expect(result.plannedActions[0]).toMatchObject({
      kind: 'flair',
      config: {
        text: 'Needs Review',
        css: 'review',
      },
    });
  });
});
