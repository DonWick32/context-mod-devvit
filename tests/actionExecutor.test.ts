import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedditClient } from '@devvit/web/server';
import type { T1, T3 } from '@devvit/shared-types/tid.js';
import {
  enqueueDispatchRecord,
  listDispatchRecords,
  type DispatchQueueRedisClient,
} from '../src/storage/dispatchQueue';
import type { ActivitySnapshot } from '../src/runtime/activityAdapter';
import {
  executePlannedActions,
  getReportReason,
  summarizeActionExecution,
} from '../src/runtime/actionExecutor';
import type { PlannedAction } from '../src/runtime/dryRunEngine';
import {
  deflateToolboxUserNotesBlob,
  getToolboxUserNotesForAuthor,
} from '../src/runtime/toolboxUserNotes';

type ReportableThing = Parameters<RedditClient['report']>[0];
type PostThing = Awaited<ReturnType<RedditClient['getPostById']>>;

class MemoryDispatchRedis implements DispatchQueueRedisClient {
  readonly strings = new Map<string, string>();
  readonly sortedSets = new Map<string, { member: string; score: number }[]>();

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) {
      this.strings.delete(key);
      this.sortedSets.delete(key);
    }
  }

  async expire(_key: string, _seconds: number): Promise<void> {
    return undefined;
  }

  async mGet(keys: string[]): Promise<(string | null)[]> {
    return keys.map((key) => this.strings.get(key) ?? null);
  }

  async set(
    key: string,
    value: string,
    _options?: Parameters<DispatchQueueRedisClient['set']>[2]
  ): Promise<string> {
    this.strings.set(key, value);
    return 'OK';
  }

  async zAdd(
    key: string,
    ...members: { member: string; score: number }[]
  ): Promise<number> {
    const existing = this.sortedSets.get(key) ?? [];
    let added = 0;

    for (const member of members) {
      const index = existing.findIndex((item) => item.member === member.member);
      if (index === -1) {
        existing.push(member);
        added++;
      } else {
        existing[index] = member;
      }
    }

    this.sortedSets.set(key, existing);
    return added;
  }

  async zCard(key: string): Promise<number> {
    return this.sortedSets.get(key)?.length ?? 0;
  }

  async zRange(
    key: string,
    start: number,
    stop: number,
    options?: Parameters<DispatchQueueRedisClient['zRange']>[3]
  ): Promise<{ member: string; score: number }[]> {
    const members = [...(this.sortedSets.get(key) ?? [])].sort((left, right) =>
      left.score === right.score
        ? left.member.localeCompare(right.member)
        : left.score - right.score
    );
    if (options?.by === 'score') {
      return members.filter(
        (member) => member.score >= Number(start) && member.score <= Number(stop)
      );
    }
    if (options?.reverse) {
      members.reverse();
    }

    return members.slice(start, stop + 1);
  }

  async zRem(key: string, members: string[]): Promise<number> {
    const existing = this.sortedSets.get(key) ?? [];
    const remaining = existing.filter((item) => !members.includes(item.member));
    this.sortedSets.set(key, remaining);
    return existing.length - remaining.length;
  }
}

const lockTarget = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const target = {
  id: 't1_comment',
  lock: lockTarget,
} as unknown as ReportableThing;
const targetId = 't1_comment' as T1;
const activity: ActivitySnapshot = {
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

const createClient = () => ({
  addModNote: vi.fn<RedditClient['addModNote']>().mockResolvedValue({
    id: 'ModNote_1',
  } as Awaited<ReturnType<RedditClient['addModNote']>>),
  addRemovalNote: vi
    .fn<RedditClient['addRemovalNote']>()
    .mockResolvedValue(undefined),
  approve: vi.fn<RedditClient['approve']>().mockResolvedValue(undefined),
  approveUser: vi.fn<RedditClient['approveUser']>().mockResolvedValue(undefined),
  banUser: vi.fn<RedditClient['banUser']>().mockResolvedValue(undefined),
  getCurrentUsername: vi
    .fn<RedditClient['getCurrentUsername']>()
    .mockResolvedValue('ContextModBot'),
  getCommentById: vi.fn<RedditClient['getCommentById']>(),
  getModNotes: vi.fn<RedditClient['getModNotes']>().mockReturnValue({
    all: vi.fn().mockResolvedValue([]),
  } as ReturnType<RedditClient['getModNotes']>),
  getPostById: vi.fn<RedditClient['getPostById']>(),
  getWikiPage: vi.fn<RedditClient['getWikiPage']>(),
  modMail: {
    createConversation: vi.fn().mockResolvedValue({
      conversation: {
        id: 'modmail_1',
      },
      messages: [],
      modActions: [],
      user: {},
    }),
  } as unknown as RedditClient['modMail'],
  remove: vi.fn<RedditClient['remove']>().mockResolvedValue(undefined),
  removeUser: vi.fn<RedditClient['removeUser']>().mockResolvedValue(undefined),
  removeUserFlair: vi
    .fn<RedditClient['removeUserFlair']>()
    .mockResolvedValue(undefined),
  report: vi.fn<RedditClient['report']>().mockResolvedValue({ success: true }),
  sendPrivateMessage: vi
    .fn<RedditClient['sendPrivateMessage']>()
    .mockResolvedValue(undefined),
  setPostFlair: vi
    .fn<RedditClient['setPostFlair']>()
    .mockResolvedValue(undefined),
  setUserFlair: vi
    .fn<RedditClient['setUserFlair']>()
    .mockResolvedValue(undefined),
  submitPost: vi.fn<RedditClient['submitPost']>().mockResolvedValue({
    id: 't3_created',
    lock: vi.fn().mockResolvedValue(undefined),
    distinguish: vi.fn().mockResolvedValue(undefined),
    sticky: vi.fn().mockResolvedValue(undefined),
  } as Awaited<ReturnType<RedditClient['submitPost']>>),
  updateWikiPage: vi
    .fn<RedditClient['updateWikiPage']>()
    .mockResolvedValue({} as Awaited<ReturnType<RedditClient['updateWikiPage']>>),
});

const removeAction: PlannedAction = {
  kind: 'remove',
  enabled: true,
  dryRun: true,
  reason: 'planned',
  config: {
    spam: true,
  },
};

const reportAction: PlannedAction = {
  kind: 'report',
  enabled: true,
  dryRun: true,
  reason: 'planned',
  config: {
    content: 'discord spam',
  },
};

const approveAction: PlannedAction = {
  kind: 'approve',
  enabled: true,
  dryRun: true,
  reason: 'planned',
};

const lockAction: PlannedAction = {
  kind: 'lock',
  enabled: true,
  dryRun: true,
  reason: 'planned',
};

const commentAction: PlannedAction = {
  kind: 'comment',
  enabled: true,
  dryRun: true,
  reason: 'planned',
  config: {
    content: 'ContextMod test reply',
  },
};

const flairAction: PlannedAction = {
  kind: 'flair',
  enabled: true,
  dryRun: true,
  reason: 'planned',
  config: {
    text: 'Needs Review',
    css: 'review',
  },
};

const banAction: PlannedAction = {
  kind: 'ban',
  enabled: true,
  dryRun: true,
  reason: 'planned',
  config: {
    duration: 7,
    message: 'Please review the rules.',
    reason: 'repeat spam',
    note: 'ContextMod migration test',
  },
};

const userFlairAction: PlannedAction = {
  kind: 'userflair',
  enabled: true,
  dryRun: true,
  reason: 'planned',
  config: {
    text: 'Watched',
    css: 'watched',
  },
};

const contributorAddAction: PlannedAction = {
  kind: 'contributor',
  enabled: true,
  dryRun: true,
  reason: 'planned',
  config: {
    action: 'add',
  },
};

const dispatchAction: PlannedAction = {
  kind: 'dispatch',
  enabled: true,
  dryRun: true,
  reason: 'planned',
  config: {
    delay: '10 minutes',
    identifier: 'followup',
    goto: 'review later',
  },
};

const cancelDispatchAction: PlannedAction = {
  kind: 'cancelDispatch',
  enabled: true,
  dryRun: true,
  reason: 'planned',
  config: {
    identifier: 'followup',
    target: 'self',
  },
};

const modNoteAction: PlannedAction = {
  kind: 'modnote',
  enabled: true,
  dryRun: true,
  reason: 'planned',
  config: {
    content: 'Needs follow-up',
    type: 'SPAM_WARNING',
    existingNoteCheck: false,
  },
};

const userNoteAction: PlannedAction = {
  kind: 'usernote',
  enabled: true,
  dryRun: true,
  reason: 'planned',
  config: {
    type: 'spamwatch',
    content: 'Warned {{item.author}} for {{item.permalink}}',
  },
};

const messageAction: PlannedAction = {
  kind: 'message',
  enabled: true,
  dryRun: true,
  reason: 'planned',
  config: {
    content: 'Please review {{item.permalink}}',
    title: 'Regarding your {{item.kind}}',
  },
};

const submissionAction: PlannedAction = {
  kind: 'submission',
  enabled: true,
  dryRun: true,
  reason: 'planned',
  config: {
    title: 'ContextMod alert for {{item.author}}',
    content: 'Review {{item.permalink}}',
    nsfw: true,
    spoiler: true,
    flairText: 'Needs Review',
    flairId: 'flair-template',
  },
};

beforeEach(() => {
  lockTarget.mockClear();
});

describe('executePlannedActions', () => {
  it('does not execute when app enabled setting is false', async () => {
    const client = createClient();

    const summary = await executePlannedActions(
      client,
      target,
      targetId,
      [removeAction],
      {
        appEnabled: false,
        dryRun: false,
      }
    );

    expect(client.remove).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      executed: 0,
      skipped: 1,
    });
    expect(summarizeActionExecution(summary)).toBe(
      'Actions not executed: app is disabled.'
    );
  });

  it('does not execute when dry run is enabled', async () => {
    const client = createClient();

    const summary = await executePlannedActions(
      client,
      target,
      targetId,
      [removeAction],
      {
        appEnabled: true,
        dryRun: true,
      }
    );

    expect(client.remove).not.toHaveBeenCalled();
    expect(summary.results[0]).toMatchObject({
      status: 'skipped',
      reason: 'app setting dryRun is true',
    });
  });

  it('does not execute actions with action-level dryRun enabled', async () => {
    const client = createClient();
    const actionDryRunRemove: PlannedAction = {
      ...removeAction,
      config: {
        ...removeAction.config,
        dryRun: true,
      },
    };

    const summary = await executePlannedActions(
      client,
      target,
      targetId,
      [actionDryRunRemove],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.remove).not.toHaveBeenCalled();
    expect(summary.results[0]).toMatchObject({
      status: 'skipped',
      reason: 'action dryRun is true',
    });
  });

  it('does not execute actions planned from unsupported checks or filters', async () => {
    const client = createClient();
    const unsupportedPlannedRemove: PlannedAction = {
      ...removeAction,
      supported: false,
    };

    const summary = await executePlannedActions(
      client,
      target,
      targetId,
      [unsupportedPlannedRemove],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.remove).not.toHaveBeenCalled();
    expect(summary.results[0]).toMatchObject({
      status: 'skipped',
      reason:
        'planned action is blocked because check/filter evaluation was unsupported',
    });
  });

  it('executes remove and report when both runtime gates allow actions', async () => {
    const client = createClient();

    const summary = await executePlannedActions(
      client,
      target,
      targetId,
      [removeAction, reportAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.remove).toHaveBeenCalledWith(targetId, true);
    expect(client.report).toHaveBeenCalledWith(target, {
      reason: 'discord spam',
    });
    expect(summary).toMatchObject({
      executed: 2,
      skipped: 0,
      failed: 0,
    });
    expect(summarizeActionExecution(summary)).toBe(
      'Action execution: 2 executed, 0 skipped, 0 failed.'
    );
  });

  it('adds configured removal notes after removing an item', async () => {
    const client = createClient();
    const notedRemoveAction: PlannedAction = {
      ...removeAction,
      config: {
        spam: false,
        note: 'Reason for {{item.author}}',
        reasonId: 'rr_123',
      },
    };
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
    } as unknown as ReportableThing;

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [notedRemoveAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.remove).toHaveBeenCalledWith(targetId, false);
    expect(client.addRemovalNote).toHaveBeenCalledWith({
      itemIds: [targetId],
      reasonId: 'rr_123',
      modNote: 'Reason for Spammer42',
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: 'removed; reason rr_123; removal note',
    });
  });

  it('supports note-only removal notes and truncates to Reddit limits', async () => {
    const client = createClient();
    const notedRemoveAction: PlannedAction = {
      ...removeAction,
      config: {
        note: 'x'.repeat(110),
      },
    };

    await executePlannedActions(
      client,
      target,
      targetId,
      [notedRemoveAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.addRemovalNote).toHaveBeenCalledWith({
      itemIds: [targetId],
      reasonId: '',
      modNote: 'x'.repeat(100),
    });
  });

  it('renders basic item placeholders in report content', async () => {
    const client = createClient();
    const templatedReportAction: PlannedAction = {
      ...reportAction,
      config: {
        content: 'review {{item.author}} in r/{{item.subreddit}}',
      },
    };
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
    } as unknown as ReportableThing;

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [templatedReportAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.report).toHaveBeenCalledWith(authoredTarget, {
      reason: 'review Spammer42 in r/testsub',
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: 'reported: review Spammer42 in r/testsub',
    });
  });

  it('renders legacy item statistic and state placeholders in action content', async () => {
    const client = createClient();
    const templatedReportAction: PlannedAction = {
      ...reportAction,
      config: {
        content:
          's={{item.score}} r={{item.reports}} m={{item.modReports}} u={{item.userReports}} t={{item.title}} st={{item.shortTitle}} rm={{item.removed}} ap={{item.approved}}',
      },
    };
    const richTarget = {
      id: 't3_post',
      authorName: 'Poster42',
      subredditName: 'testsub',
      permalink: '/r/testsub/comments/post/title',
      title: 'Tiny',
      score: 7,
      numberOfReports: 3,
      modReportReasons: ['Rule 1'],
      userReportReasons: ['spam', 'misinformation'],
      removed: false,
      approved: true,
    } as unknown as ReportableThing;

    await executePlannedActions(
      client,
      richTarget,
      't3_post' as T3,
      [templatedReportAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.report).toHaveBeenCalledWith(richTarget, {
      reason: 's=7 r=3 m=1 u=2 t=Tiny st=Tiny rm=false ap=true',
    });
  });

  it('renders hydrated legacy author and activity placeholders in action content', async () => {
    const client = createClient();
    const templatedReportAction: PlannedAction = {
      ...reportAction,
      config: {
        content:
          'a={{item.author.age}} lk={{item.author.linkKarma}} tk={{item.author.totalKarma}} v={{item.author.verified}} op={{item.op}} ia={{item.age}} r={{item.reports}}',
      },
    };
    const hydratedActivity: ActivitySnapshot = {
      ...activity,
      createdAt: new Date('2026-05-24T00:00:00Z'),
      authorAccountCreatedAt: new Date('2024-05-25T00:00:00Z'),
      authorLinkKarma: 11,
      authorCommentKarma: 22,
      authorTotalKarma: 33,
      authorHasVerifiedEmail: true,
      commentIsOp: true,
      numReports: 2,
      userReportReasons: ['spam'],
      modReportReasons: ['rule 1'],
    };

    await executePlannedActions(
      client,
      target,
      targetId,
      [templatedReportAction],
      {
        appEnabled: true,
        dryRun: false,
      },
      {
        activity: hydratedActivity,
        now: () => new Date('2026-05-25T00:00:00Z'),
      }
    );

    expect(client.report).toHaveBeenCalledWith(target, {
      reason: 'a=2 years lk=11 tk=33 v=true op=true ia=1 day r=2',
    });
  });

  it('renders rule result placeholders in action content', async () => {
    const client = createClient();
    const templatedReportAction: PlannedAction = {
      ...reportAction,
      config: {
        content: 'posted {{rules.xpost.largestRepeat}} times',
      },
      templateContext: {
        rules: {
          xpost: {
            largestRepeat: 4,
          },
        },
      },
    };

    const summary = await executePlannedActions(
      client,
      target,
      targetId,
      [templatedReportAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.report).toHaveBeenCalledWith(target, {
      reason: 'posted 4 times',
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
    });
  });

  it('executes approve and lock when both runtime gates allow actions', async () => {
    const client = createClient();

    const summary = await executePlannedActions(
      client,
      target,
      targetId,
      [approveAction, lockAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.approve).toHaveBeenCalledWith(targetId);
    expect(lockTarget).toHaveBeenCalledOnce();
    expect(summary).toMatchObject({
      executed: 2,
      skipped: 0,
      failed: 0,
    });
  });

  it('skips approve when the self target is already approved', async () => {
    const client = createClient();
    const approvedTarget = {
      id: 't1_comment',
      approved: true,
    } as unknown as ReportableThing;

    const summary = await executePlannedActions(
      client,
      approvedTarget,
      targetId,
      [approveAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.approve).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      executed: 0,
      skipped: 1,
      failed: 0,
    });
    expect(summary.results[0]).toMatchObject({
      status: 'skipped',
      reason: 'self already approved',
    });
  });

  it('skips lock when the target is already locked', async () => {
    const client = createClient();
    const lock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const lockedTarget = {
      id: 't1_comment',
      locked: true,
      lock,
    } as unknown as ReportableThing;

    const summary = await executePlannedActions(
      client,
      lockedTarget,
      targetId,
      [lockAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(lock).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      executed: 0,
      skipped: 1,
      failed: 0,
    });
    expect(summary.results[0]).toMatchObject({
      status: 'skipped',
      reason: 'target is already locked',
    });
  });

  it('executes approve on self and parent targets for comments', async () => {
    const client = createClient();
    const commentTarget = {
      id: 't1_comment',
      postId: 't3_parent',
    } as unknown as ReportableThing;
    const approveBothAction: PlannedAction = {
      ...approveAction,
      config: {
        targets: ['self', 'parent'],
      },
    };

    const summary = await executePlannedActions(
      client,
      commentTarget,
      targetId,
      [approveBothAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.approve).toHaveBeenCalledWith(targetId);
    expect(client.approve).toHaveBeenCalledWith('t3_parent');
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: 'approved self, parent',
    });
  });

  it('executes comment replies on comment targets', async () => {
    const client = createClient();
    const reply = vi
      .fn<(opts: { text: string }) => Promise<unknown>>()
      .mockResolvedValue({ id: 't1_reply' });
    const commentTarget = {
      id: 't1_comment',
      reply,
    } as unknown as ReportableThing;

    const summary = await executePlannedActions(
      client,
      commentTarget,
      targetId,
      [commentAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(reply).toHaveBeenCalledWith({ text: 'ContextMod test reply' });
    expect(summary).toMatchObject({
      executed: 1,
      skipped: 0,
      failed: 0,
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: 'created comment reply',
    });
  });

  it('exposes created comment IDs to later action templates', async () => {
    const client = createClient();
    const reply = vi.fn<(opts: { text: string }) => Promise<unknown>>()
      .mockResolvedValue({
        id: 't1_reply',
        permalink: 'https://reddit.com/r/testsub/comments/post/comment/t1_reply',
      });
    const commentTarget = {
      id: 't1_comment',
      reply,
    } as unknown as ReportableThing;
    const templatedReportAction: PlannedAction = {
      ...reportAction,
      config: {
        content:
          'reply={{action.0.id}} permalink={{action.0.permalink}} status={{action.0.status}}',
      },
    };

    const summary = await executePlannedActions(
      client,
      commentTarget,
      targetId,
      [commentAction, templatedReportAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      targetId: 't1_reply',
      permalink: 'https://reddit.com/r/testsub/comments/post/comment/t1_reply',
    });
    expect(client.report).toHaveBeenCalledWith(commentTarget, {
      reason:
        'reply=t1_reply permalink=https://reddit.com/r/testsub/comments/post/comment/t1_reply status=executed',
    });
  });

  it('renders basic item placeholders in comment content', async () => {
    const client = createClient();
    const reply = vi
      .fn<(opts: { text: string }) => Promise<unknown>>()
      .mockResolvedValue({ id: 't1_reply' });
    const commentTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
      permalink: '/r/testsub/comments/post/comment',
      reply,
    } as unknown as ReportableThing;
    const templatedCommentAction: PlannedAction = {
      ...commentAction,
      config: {
        content: 'Hi {{item.author}}, see {{item.permalink}}',
      },
    };

    const summary = await executePlannedActions(
      client,
      commentTarget,
      targetId,
      [templatedCommentAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(reply).toHaveBeenCalledWith({
      text: 'Hi Spammer42, see https://reddit.com/r/testsub/comments/post/comment',
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
    });
  });

  it('appends rendered footers to comment actions', async () => {
    const client = createClient();
    const reply = vi
      .fn<(opts: { text: string }) => Promise<unknown>>()
      .mockResolvedValue({ id: 't1_reply' });
    const commentTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
      permalink: '/r/testsub/comments/post/comment',
      reply,
    } as unknown as ReportableThing;
    const action: PlannedAction = {
      ...commentAction,
      config: {
        content: 'Body',
      },
    };

    const summary = await executePlannedActions(
      client,
      commentTarget,
      targetId,
      [action],
      {
        appEnabled: true,
        dryRun: false,
      },
      {
        footer: '\nFooter {{subName}} {{permaLink}}',
      }
    );

    expect(reply).toHaveBeenCalledWith({
      text: 'Body\nFooter testsub https://reddit.com/r/testsub/comments/post/comment',
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
    });
  });

  it('lets action footer false disable a configured default footer', async () => {
    const client = createClient();
    const reply = vi
      .fn<(opts: { text: string }) => Promise<unknown>>()
      .mockResolvedValue({ id: 't1_reply' });
    const commentTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
      permalink: '/r/testsub/comments/post/comment',
      reply,
    } as unknown as ReportableThing;
    const action: PlannedAction = {
      ...commentAction,
      config: {
        content: 'Body',
        footer: false,
      },
    };

    await executePlannedActions(
      client,
      commentTarget,
      targetId,
      [action],
      {
        appEnabled: true,
        dryRun: false,
      },
      {
        footer: '\nDefault footer',
      }
    );

    expect(reply).toHaveBeenCalledWith({
      text: 'Body',
    });
  });

  it('loads same-subreddit wiki content before rendering comment templates', async () => {
    const client = createClient();
    const reply = vi
      .fn<(opts: { text: string }) => Promise<unknown>>()
      .mockResolvedValue({ id: 't1_reply' });
    const commentTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
      permalink: '/r/testsub/comments/post/comment',
      reply,
    } as unknown as ReportableThing;
    const wikiCommentAction: PlannedAction = {
      ...commentAction,
      config: {
        content: 'wiki:replytemplates/discord',
      },
    };
    const wikiContentLoader = {
      getWikiPage: vi
        .fn<(subredditName: string, pageName: string) => Promise<{ content: string }>>()
        .mockResolvedValue({
          content: 'Hi {{item.author}}, review {{item.permalink}}',
        }),
    };

    const summary = await executePlannedActions(
      client,
      commentTarget,
      targetId,
      [wikiCommentAction],
      {
        appEnabled: true,
        dryRun: false,
      },
      {
        subredditName: 'testsub',
        wikiContentLoader,
      }
    );

    expect(wikiContentLoader.getWikiPage).toHaveBeenCalledWith(
      'testsub',
      'replytemplates/discord'
    );
    expect(reply).toHaveBeenCalledWith({
      text:
        'Hi Spammer42, review https://reddit.com/r/testsub/comments/post/comment',
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
    });
  });

  it('loads cross-subreddit wiki content before rendering comment templates', async () => {
    const client = createClient();
    const reply = vi
      .fn<(opts: { text: string }) => Promise<unknown>>()
      .mockResolvedValue({ id: 't1_reply' });
    const commentTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
      permalink: '/r/testsub/comments/post/comment',
      reply,
    } as unknown as ReportableThing;
    const wikiCommentAction: PlannedAction = {
      ...commentAction,
      config: {
        content: 'wiki:replytemplates/shared|SharedConfig',
      },
    };
    const wikiContentLoader = {
      getWikiPage: vi
        .fn<(subredditName: string, pageName: string) => Promise<{ content: string }>>()
        .mockResolvedValue({
          content: 'Shared reply for {{item.author}}',
        }),
    };

    const summary = await executePlannedActions(
      client,
      commentTarget,
      targetId,
      [wikiCommentAction],
      {
        appEnabled: true,
        dryRun: false,
      },
      {
        subredditName: 'testsub',
        wikiContentLoader,
      }
    );

    expect(wikiContentLoader.getWikiPage).toHaveBeenCalledWith(
      'SharedConfig',
      'replytemplates/shared'
    );
    expect(reply).toHaveBeenCalledWith({
      text: 'Shared reply for Spammer42',
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
    });
  });

  it('skips unsupported URL-backed action content', async () => {
    const client = createClient();
    const reply = vi
      .fn<(opts: { text: string }) => Promise<unknown>>()
      .mockResolvedValue({ id: 't1_reply' });
    const commentTarget = {
      id: 't1_comment',
      subredditName: 'testsub',
      reply,
    } as unknown as ReportableThing;
    const urlCommentAction: PlannedAction = {
      ...commentAction,
      config: {
        content: 'url:https://example.com/reply.txt',
      },
    };

    const summary = await executePlannedActions(
      client,
      commentTarget,
      targetId,
      [urlCommentAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(reply).not.toHaveBeenCalled();
    expect(summary.results[0]).toMatchObject({
      status: 'skipped',
      reason:
        'url-backed action content requires fetch-domain approval and is not enabled',
    });
  });

  it('executes top-level comments on post targets', async () => {
    const client = createClient();
    const addComment = vi
      .fn<(opts: { text: string }) => Promise<unknown>>()
      .mockResolvedValue({ id: 't1_reply' });
    const postTarget = {
      id: 't3_post',
      addComment,
    } as unknown as ReportableThing;
    const postId = 't3_post' as T3;

    const summary = await executePlannedActions(
      client,
      postTarget,
      postId,
      [commentAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(addComment).toHaveBeenCalledWith({ text: 'ContextMod test reply' });
    expect(summary).toMatchObject({
      executed: 1,
      skipped: 0,
      failed: 0,
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: 'created top-level comment',
    });
  });

  it('executes parent-target comments on the parent post of a comment', async () => {
    const client = createClient();
    const addComment = vi
      .fn<(opts: { text: string }) => Promise<unknown>>()
      .mockResolvedValue({ id: 't1_reply' });
    const parentPost = {
      id: 't3_parent',
      addComment,
    };
    client.getPostById.mockResolvedValueOnce(parentPost as PostThing);
    const commentTarget = {
      id: 't1_comment',
      postId: 't3_parent',
      reply: vi.fn(),
    } as unknown as ReportableThing;
    const parentCommentAction: PlannedAction = {
      ...commentAction,
      config: {
        content: 'ContextMod parent reply',
        targets: 'parent',
      },
    };

    const summary = await executePlannedActions(
      client,
      commentTarget,
      targetId,
      [parentCommentAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.getPostById).toHaveBeenCalledWith('t3_parent');
    expect(addComment).toHaveBeenCalledWith({ text: 'ContextMod parent reply' });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: 'created parent top-level comment',
    });
  });

  it('executes comment actions against permalink targets', async () => {
    const client = createClient();
    const permalinkReply = vi
      .fn<(opts: { text: string }) => Promise<unknown>>()
      .mockResolvedValue({ id: 't1_reply' });
    const permalinkPostComment = vi
      .fn<(opts: { text: string }) => Promise<unknown>>()
      .mockResolvedValue({ id: 't1_post_reply' });
    client.getCommentById.mockResolvedValueOnce({
      id: 't1_def456',
      reply: permalinkReply,
    } as Awaited<ReturnType<RedditClient['getCommentById']>>);
    client.getPostById.mockResolvedValueOnce({
      id: 't3_abc123',
      addComment: permalinkPostComment,
    } as PostThing);
    const commentTarget = {
      id: 't1_comment',
      reply: vi.fn(),
    } as unknown as ReportableThing;
    const permalinkCommentAction: PlannedAction = {
      ...commentAction,
      config: {
        content: 'ContextMod permalink reply',
        targets: [
          '/r/testsub/comments/abc123/title/def456/',
          'https://reddit.com/r/testsub/comments/abc123/title/',
        ],
      },
    };

    const summary = await executePlannedActions(
      client,
      commentTarget,
      targetId,
      [permalinkCommentAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.getCommentById).toHaveBeenCalledWith('t1_def456');
    expect(client.getPostById).toHaveBeenCalledWith('t3_abc123');
    expect(permalinkReply).toHaveBeenCalledWith({
      text: 'ContextMod permalink reply',
    });
    expect(permalinkPostComment).toHaveBeenCalledWith({
      text: 'ContextMod permalink reply',
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason:
        'created permalink comment t1_def456, permalink submission t3_abc123',
    });
  });

  it('executes comment reply modifiers on the created reply', async () => {
    const client = createClient();
    const lockReply = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const distinguishReply = vi
      .fn<(makeSticky?: boolean) => Promise<void>>()
      .mockResolvedValue(undefined);
    const reply = vi
      .fn<(opts: { text: string }) => Promise<unknown>>()
      .mockResolvedValue({
        id: 't1_reply',
        lock: lockReply,
        distinguish: distinguishReply,
      });
    const commentTarget = {
      id: 't1_comment',
      reply,
    } as unknown as ReportableThing;
    const modifierAction: PlannedAction = {
      ...commentAction,
      config: {
        content: 'ContextMod mod reply',
        lock: true,
        distinguish: true,
        sticky: true,
      },
    };

    const summary = await executePlannedActions(
      client,
      commentTarget,
      targetId,
      [modifierAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(reply).toHaveBeenCalledWith({ text: 'ContextMod mod reply' });
    expect(lockReply).toHaveBeenCalledOnce();
    expect(distinguishReply).toHaveBeenCalledWith(true);
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: 'created comment reply; locked; distinguished and stickied',
    });
  });

  it('skips comment actions with missing content or unsupported options', async () => {
    const client = createClient();
    const reply = vi
      .fn<(opts: { text: string }) => Promise<unknown>>()
      .mockResolvedValue({ id: 't1_reply' });
    const commentTarget = {
      id: 't1_comment',
      reply,
    } as unknown as ReportableThing;
    const missingContentAction: PlannedAction = {
      ...commentAction,
      config: {
        content: '   ',
      },
    };
    const unsupportedTargetAction: PlannedAction = {
      ...commentAction,
      config: {
        content: 'ContextMod test reply',
        targets: 'not a reddit permalink',
      },
    };
    const asModTeamAction: PlannedAction = {
      ...commentAction,
      config: {
        content: 'ContextMod test reply',
        asModTeam: true,
      },
    };

    const summary = await executePlannedActions(
      client,
      commentTarget,
      targetId,
      [missingContentAction, unsupportedTargetAction, asModTeamAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(reply).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      executed: 0,
      skipped: 3,
      failed: 0,
    });
    expect(summary.results.map((result) => result.reason)).toEqual([
      'comment content is required',
      'comment target could not be parsed as self, parent, or reddit permalink: not a reddit permalink',
      'comment options are not ported on Devvit: asModTeam',
    ]);
  });

  it('executes post flair actions on post targets', async () => {
    const client = createClient();
    const postTarget = {
      id: 't3_post',
      subredditName: 'testsub',
      authorName: 'Poster42',
    } as unknown as ReportableThing;
    const postId = 't3_post' as T3;
    const templatedFlairAction: PlannedAction = {
      ...flairAction,
      config: {
        text: 'Needs review: {{item.author}}',
        css: '{{item.subreddit}}-review',
      },
    };

    const summary = await executePlannedActions(
      client,
      postTarget,
      postId,
      [templatedFlairAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.setPostFlair).toHaveBeenCalledWith({
      subredditName: 'testsub',
      postId,
      text: 'Needs review: Poster42',
      cssClass: 'testsub-review',
    });
    expect(summary).toMatchObject({
      executed: 1,
      skipped: 0,
      failed: 0,
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: 'set post flair',
    });
  });

  it('executes ban actions against the activity author', async () => {
    const client = createClient();
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
    } as unknown as ReportableThing;

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [banAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.banUser).toHaveBeenCalledWith({
      username: 'Spammer42',
      subredditName: 'testsub',
      context: targetId,
      duration: 7,
      message: 'Please review the rules.',
      reason: 'repeat spam',
      note: 'ContextMod migration test',
    });
    expect(summary).toMatchObject({
      executed: 1,
      skipped: 0,
      failed: 0,
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: 'banned Spammer42 for 7 day(s)',
    });
  });

  it('appends rendered footers to ban messages only', async () => {
    const client = createClient();
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
      permalink: '/r/testsub/comments/post/comment',
    } as unknown as ReportableThing;

    await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [banAction],
      {
        appEnabled: true,
        dryRun: false,
      },
      {
        footer: '\nFooter {{subName}}',
      }
    );

    expect(client.banUser).toHaveBeenCalledWith({
      username: 'Spammer42',
      subredditName: 'testsub',
      context: targetId,
      duration: 7,
      message: 'Please review the rules.\nFooter testsub',
      reason: 'repeat spam',
      note: 'ContextMod migration test',
    });
  });

  it('executes contributor add and remove actions against the activity author', async () => {
    const client = createClient();
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'HelpfulUser',
      subredditName: 'testsub',
    } as unknown as ReportableThing;
    const contributorRemoveAction: PlannedAction = {
      ...contributorAddAction,
      config: {
        action: 'remove',
      },
    };

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [contributorAddAction, contributorRemoveAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.approveUser).toHaveBeenCalledWith('HelpfulUser', 'testsub');
    expect(client.removeUser).toHaveBeenCalledWith('HelpfulUser', 'testsub');
    expect(summary).toMatchObject({
      executed: 2,
      skipped: 0,
      failed: 0,
    });
    expect(summary.results.map((result) => result.reason)).toEqual([
      'added HelpfulUser as contributor',
      'removed HelpfulUser as contributor',
    ]);
  });

  it('skips contributor actions with invalid config or missing metadata', async () => {
    const client = createClient();
    const invalidContributorAction: PlannedAction = {
      ...contributorAddAction,
      config: {
        action: 'promote',
      },
    };
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'HelpfulUser',
      subredditName: 'testsub',
    } as unknown as ReportableThing;

    const missingMetadataSummary = await executePlannedActions(
      client,
      target,
      targetId,
      [contributorAddAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );
    const invalidConfigSummary = await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [invalidContributorAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.approveUser).not.toHaveBeenCalled();
    expect(client.removeUser).not.toHaveBeenCalled();
    expect(missingMetadataSummary.results[0]?.reason).toBe(
      'target author and subreddit are required for contributor'
    );
    expect(invalidConfigSummary.results[0]?.reason).toBe(
      'contributor action must be add or remove'
    );
  });

  it('executes mod note actions when duplicate checks are disabled', async () => {
    const client = createClient();
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
    } as unknown as ReportableThing;

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [modNoteAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.addModNote).toHaveBeenCalledWith({
      subreddit: 'testsub',
      user: 'Spammer42',
      note: 'Needs follow-up',
      label: 'SPAM_WARNING',
      redditId: targetId,
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: 'added mod note',
    });
  });

  it('executes message actions against the activity author', async () => {
    const client = createClient();
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
      permalink: '/r/testsub/comments/post/comment',
    } as unknown as ReportableThing;

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [messageAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.sendPrivateMessage).toHaveBeenCalledWith({
      to: 'Spammer42',
      subject: 'Regarding your comment',
      text: 'Please review https://reddit.com/r/testsub/comments/post/comment',
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: 'sent message to Spammer42',
    });
  });

  it('appends action-specific footers to message actions', async () => {
    const client = createClient();
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
      permalink: '/r/testsub/comments/post/comment',
    } as unknown as ReportableThing;
    const footerMessageAction: PlannedAction = {
      ...messageAction,
      config: {
        content: 'Please review',
        title: 'ContextMod notice',
        footer: '\nFooter {{subName}}',
      },
    };

    await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [footerMessageAction],
      {
        appEnabled: true,
        dryRun: false,
      },
      {
        footer: '\nDefault footer',
      }
    );

    expect(client.sendPrivateMessage).toHaveBeenCalledWith({
      to: 'Spammer42',
      subject: 'ContextMod notice',
      text: 'Please review\nFooter testsub',
    });
  });

  it('executes message actions to subreddit modmail recipients', async () => {
    const client = createClient();
    const authoredTarget = {
      id: 't3_post',
      authorName: 'Poster42',
      subredditName: 'testsub',
      permalink: '/r/testsub/comments/post/title',
    } as unknown as ReportableThing;
    const subredditMessageAction: PlannedAction = {
      ...messageAction,
      config: {
        content: 'Queue item {{item.id}}',
        title: 'ContextMod notice',
        to: 'r/{{item.subreddit}}',
      },
    };

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      't3_post' as T3,
      [subredditMessageAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.sendPrivateMessage).toHaveBeenCalledWith({
      to: '/r/testsub',
      subject: 'ContextMod notice',
      text: 'Queue item t3_post',
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: 'sent message to /r/testsub',
    });
  });

  it('executes asSubreddit message actions through hidden-author modmail', async () => {
    const client = createClient();
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
      permalink: '/r/testsub/comments/post/comment',
    } as unknown as ReportableThing;
    const subredditMessageAction: PlannedAction = {
      ...messageAction,
      config: {
        content: 'Please review {{item.permalink}}',
        title: 'Regarding your {{item.kind}}',
        asSubreddit: true,
      },
    };

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [subredditMessageAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.modMail.createConversation).toHaveBeenCalledWith({
      subredditName: 'testsub',
      subject: 'Regarding your comment',
      body: 'Please review https://reddit.com/r/testsub/comments/post/comment',
      to: 'Spammer42',
      isAuthorHidden: true,
    });
    expect(client.sendPrivateMessage).not.toHaveBeenCalled();
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: 'sent subreddit message to Spammer42',
    });
  });

  it('creates same-subreddit self posts with submission action modifiers', async () => {
    const client = createClient();
    const lockPost = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const distinguishPost = vi
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    const stickyPost = vi
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    client.submitPost.mockResolvedValueOnce({
      id: 't3_created',
      lock: lockPost,
      distinguish: distinguishPost,
      sticky: stickyPost,
    } as PostThing);
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
      permalink: '/r/testsub/comments/post/comment',
    } as unknown as ReportableThing;
    const modifierSubmissionAction: PlannedAction = {
      ...submissionAction,
      config: {
        ...submissionAction.config,
        lock: true,
        distinguish: true,
        sticky: true,
      },
    };

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [modifierSubmissionAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.submitPost).toHaveBeenCalledWith({
      subredditName: 'testsub',
      title: 'ContextMod alert for Spammer42',
      text: 'Review https://reddit.com/r/testsub/comments/post/comment',
      nsfw: true,
      spoiler: true,
      flairText: 'Needs Review',
      flairId: 'flair-template',
    });
    expect(lockPost).toHaveBeenCalledOnce();
    expect(distinguishPost).toHaveBeenCalledOnce();
    expect(stickyPost).toHaveBeenCalledOnce();
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason:
        'created self post in self (t3_created); locked; distinguished; stickied',
    });
  });

  it('appends rendered footers to same-subreddit self post bodies', async () => {
    const client = createClient();
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
      permalink: '/r/testsub/comments/post/comment',
    } as unknown as ReportableThing;

    await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [submissionAction],
      {
        appEnabled: true,
        dryRun: false,
      },
      {
        footer: '\nFooter {{subName}}',
      }
    );

    expect(client.submitPost).toHaveBeenCalledWith({
      subredditName: 'testsub',
      title: 'ContextMod alert for Spammer42',
      text:
        'Review https://reddit.com/r/testsub/comments/post/comment\nFooter testsub',
      nsfw: true,
      spoiler: true,
      flairText: 'Needs Review',
      flairId: 'flair-template',
    });
  });

  it('creates same-subreddit link posts for submission actions', async () => {
    const client = createClient();
    const authoredTarget = {
      id: 't3_post',
      authorName: 'Poster42',
      subredditName: 'testsub',
      permalink: '/r/testsub/comments/post/title',
    } as unknown as ReportableThing;
    const linkSubmissionAction: PlannedAction = {
      ...submissionAction,
      config: {
        title: 'Link post for {{item.author}}',
        url: '{{item.permalink}}',
        content: 'Devvit does not submit link-post bodies',
      },
    };

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      't3_post' as T3,
      [linkSubmissionAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.submitPost).toHaveBeenCalledWith({
      subredditName: 'testsub',
      title: 'Link post for Poster42',
      url: 'https://reddit.com/r/testsub/comments/post/title',
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason:
        'created link post in self (t3_created); link post body ignored by Devvit submitPost',
    });
  });

  it('skips submission actions targeting another subreddit', async () => {
    const client = createClient();
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
    } as unknown as ReportableThing;
    const crossSubredditSubmissionAction: PlannedAction = {
      ...submissionAction,
      config: {
        ...submissionAction.config,
        targets: 'othersub',
      },
    };

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [crossSubredditSubmissionAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.submitPost).not.toHaveBeenCalled();
    expect(summary.results[0]).toMatchObject({
      status: 'skipped',
      reason:
        'submission targets outside the current subreddit are not ported: othersub',
    });
  });

  it('skips asSubreddit messages to subreddit recipients', async () => {
    const client = createClient();
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
    } as unknown as ReportableThing;
    const asSubredditAction: PlannedAction = {
      ...messageAction,
      config: {
        content: 'Please review',
        asSubreddit: true,
        to: 'r/testsub',
      },
    };

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [asSubredditAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.sendPrivateMessage).not.toHaveBeenCalled();
    expect(client.modMail.createConversation).not.toHaveBeenCalled();
    expect(summary.results[0]?.reason).toBe(
      'message asSubreddit cannot target another subreddit'
    );
  });

  it('skips duplicate mod notes when existingNoteCheck is enabled', async () => {
    const client = createClient();
    client.getModNotes.mockReturnValue({
      all: vi.fn().mockResolvedValue([
        {
          id: 'ModNote_1',
          type: 'NOTE',
          createdAt: new Date('2026-05-25T00:00:00Z'),
          operator: {},
          subreddit: { name: 'testsub' },
          user: { name: 'Spammer42' },
          userNote: {
            label: 'SPAM_WARNING',
            note: 'Needs follow-up',
            redditId: targetId,
          },
        },
      ]),
    } as ReturnType<RedditClient['getModNotes']>);
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
    } as unknown as ReportableThing;
    const duplicateCheckAction: PlannedAction = {
      ...modNoteAction,
      config: {
        content: 'Needs follow-up',
      },
    };
    const summary = await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [duplicateCheckAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.addModNote).not.toHaveBeenCalled();
    expect(client.getModNotes).toHaveBeenCalledWith({
      filter: 'NOTE',
      limit: 25,
      subreddit: 'testsub',
      user: 'Spammer42',
    });
    expect(summary.results[0]?.reason).toBe(
      'matching modnote already exists for this activity'
    );
  });

  it('supports object modnote existingNoteCheck criteria', async () => {
    const client = createClient();
    client.getModNotes.mockReturnValue({
      all: vi.fn().mockResolvedValue([
        {
          id: 'ModNote_1',
          type: 'NOTE',
          createdAt: new Date('2026-05-25T00:00:00Z'),
          operator: {},
          subreddit: { name: 'testsub' },
          user: { name: 'Spammer42' },
          userNote: {
            label: 'SPAM_WARNING',
            note: 'Existing warning',
            redditId: targetId,
          },
        },
      ]),
    } as ReturnType<RedditClient['getModNotes']>);
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
    } as unknown as ReportableThing;
    const objectExistingCheckAction: PlannedAction = {
      ...modNoteAction,
      config: {
        content: 'Needs follow-up',
        type: 'SPAM_WARNING',
        existingNoteCheck: {
          noteType: 'SPAM_WARNING',
          note: 'Existing warning',
          referencesCurrentActivity: true,
          search: 'total',
          count: '< 1',
        },
      },
    };

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [objectExistingCheckAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.addModNote).not.toHaveBeenCalled();
    expect(client.getModNotes).toHaveBeenCalledWith({
      filter: 'NOTE',
      limit: 100,
      subreddit: 'testsub',
      user: 'Spammer42',
    });
    expect(summary.results[0]?.reason).toBe(
      'modnote existingNoteCheck criteria did not pass: 1/1 mod note(s) matched criteria'
    );
  });

  it('skips unsupported mod note options', async () => {
    const client = createClient();
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
    } as unknown as ReportableThing;
    const objectExistingCheckAction: PlannedAction = {
      ...modNoteAction,
      config: {
        content: 'Needs follow-up',
        existingNoteCheck: 'invalid',
      },
    };
    const invalidLabelAction: PlannedAction = {
      ...modNoteAction,
      config: {
        content: 'Needs follow-up',
        type: 'not-a-label',
        existingNoteCheck: false,
      },
    };

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [objectExistingCheckAction, invalidLabelAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.addModNote).not.toHaveBeenCalled();
    expect(summary.results.map((result) => result.reason)).toEqual([
      'modnote existingNoteCheck must be a boolean or object',
      'modnote type is not supported by Reddit mod notes',
    ]);
  });

  it('executes Toolbox usernote actions by updating the usernotes wiki page', async () => {
    const client = createClient();
    client.getWikiPage.mockResolvedValueOnce({
      content: JSON.stringify({
        ver: 6,
        constants: {
          users: ['ExistingMod'],
          warnings: ['spamwatch'],
        },
        blob: deflateToolboxUserNotesBlob({}),
      }),
    } as Awaited<ReturnType<RedditClient['getWikiPage']>>);
    const authoredTarget = {
      id: 't1_comment123',
      authorName: 'Spammer42',
      subredditName: 'testsub',
      permalink: '/r/testsub/comments/post123/title/comment123/',
      postId: 't3_post123',
    } as unknown as ReportableThing;

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      't1_comment123' as T1,
      [userNoteAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.getWikiPage).toHaveBeenCalledWith('testsub', 'usernotes');
    expect(client.getCurrentUsername).toHaveBeenCalledOnce();
    expect(client.updateWikiPage).toHaveBeenCalledWith({
      subredditName: 'testsub',
      page: 'usernotes',
      content: expect.any(String),
      reason: expect.stringContaining('ContextMod added spamwatch for Spammer42'),
    });
    const updateOptions = client.updateWikiPage.mock.calls[0]?.[0];
    expect(updateOptions).toBeDefined();
    const notes = getToolboxUserNotesForAuthor(
      updateOptions?.content ?? '',
      'Spammer42'
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      text:
        'Warned Spammer42 for https://reddit.com/r/testsub/comments/post123/title/comment123/',
      type: 'spamwatch',
      moderator: 'ContextModBot',
      link: 'https://www.reddit.com/comments/post123/_/comment123',
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: 'added Toolbox usernote (spamwatch)',
    });
  });

  it('skips Toolbox usernote actions when default duplicate checks fail', async () => {
    const client = createClient();
    client.getWikiPage.mockResolvedValueOnce({
      content: JSON.stringify({
        ver: 6,
        constants: {
          users: ['ExistingMod'],
          warnings: ['spamwatch'],
        },
        blob: deflateToolboxUserNotesBlob({
          Spammer42: {
            ns: [
              {
                n: 'Warned Spammer42 for https://reddit.com/r/testsub/comments/post123/title/comment123/',
                t: 1_764_028_800,
                m: 0,
                l: 'l,post123,comment123',
                w: 0,
              },
            ],
          },
        }),
      }),
    } as Awaited<ReturnType<RedditClient['getWikiPage']>>);
    const authoredTarget = {
      id: 't1_comment123',
      authorName: 'Spammer42',
      subredditName: 'testsub',
      permalink: '/r/testsub/comments/post123/title/comment123/',
      postId: 't3_post123',
    } as unknown as ReportableThing;

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      't1_comment123' as T1,
      [userNoteAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.updateWikiPage).not.toHaveBeenCalled();
    expect(summary.results[0]).toMatchObject({
      status: 'skipped',
      reason: 'usernote existingNoteCheck criteria did not pass',
    });
  });

  it('skips ban actions without target metadata or valid duration', async () => {
    const client = createClient();
    const invalidDurationAction: PlannedAction = {
      ...banAction,
      config: {
        duration: 0,
      },
    };
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
    } as unknown as ReportableThing;

    const missingMetadataSummary = await executePlannedActions(
      client,
      target,
      targetId,
      [banAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );
    const invalidDurationSummary = await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [invalidDurationAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.banUser).not.toHaveBeenCalled();
    expect(missingMetadataSummary.results[0]?.reason).toBe(
      'target author and subreddit are required for ban'
    );
    expect(invalidDurationSummary.results[0]?.reason).toBe(
      'ban duration must be an integer from 1 to 999 days'
    );
  });

  it('executes user flair actions against the activity author', async () => {
    const client = createClient();
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
      permalink: '/r/testsub/comments/post/comment',
    } as unknown as ReportableThing;
    const templatedUserFlairAction: PlannedAction = {
      ...userFlairAction,
      config: {
        text: 'Watched {{item.author}}',
        css: '{{item.subreddit}}-watched',
      },
    };

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [templatedUserFlairAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.setUserFlair).toHaveBeenCalledWith({
      subredditName: 'testsub',
      username: 'Spammer42',
      text: 'Watched Spammer42',
      cssClass: 'testsub-watched',
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: 'set user flair',
    });
  });

  it('executes user flair template and removal actions', async () => {
    const client = createClient();
    const authoredTarget = {
      id: 't1_comment',
      authorName: 'Spammer42',
      subredditName: 'testsub',
    } as unknown as ReportableThing;
    const templateAction: PlannedAction = {
      ...userFlairAction,
      config: {
        flair_template_id: 'template-id',
        text: 'ignored',
        css: 'ignored',
      },
    };
    const removeFlairAction: PlannedAction = {
      ...userFlairAction,
      config: {},
    };

    const summary = await executePlannedActions(
      client,
      authoredTarget,
      targetId,
      [templateAction, removeFlairAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.setUserFlair).toHaveBeenCalledWith({
      subredditName: 'testsub',
      username: 'Spammer42',
      flairTemplateId: 'template-id',
    });
    expect(client.removeUserFlair).toHaveBeenCalledWith(
      'testsub',
      'Spammer42'
    );
    expect(summary).toMatchObject({
      executed: 2,
      skipped: 0,
      failed: 0,
    });
  });

  it('skips flair actions on comments or when flair config is empty', async () => {
    const client = createClient();
    const emptyFlairAction: PlannedAction = {
      ...flairAction,
      config: {},
    };
    const postTarget = {
      id: 't3_post',
      subredditName: 'testsub',
    } as unknown as ReportableThing;
    const postId = 't3_post' as T3;

    const commentSummary = await executePlannedActions(
      client,
      target,
      targetId,
      [flairAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );
    const emptyConfigSummary = await executePlannedActions(
      client,
      postTarget,
      postId,
      [emptyFlairAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.setPostFlair).not.toHaveBeenCalled();
    expect(commentSummary).toMatchObject({
      executed: 0,
      skipped: 1,
      failed: 0,
    });
    expect(emptyConfigSummary).toMatchObject({
      executed: 0,
      skipped: 1,
      failed: 0,
    });
    expect(commentSummary.results[0]?.reason).toBe('flair can only run on posts');
    expect(emptyConfigSummary.results[0]?.reason).toBe(
      'flair text, css, template, or color is required'
    );
  });

  it('queues dispatch records when dispatch resources are available', async () => {
    const client = createClient();
    const redisClient = new MemoryDispatchRedis();

    const summary = await executePlannedActions(
      client,
      target,
      targetId,
      [dispatchAction],
      {
        appEnabled: true,
        dryRun: false,
      },
      {
        dispatchQueue: {
          activity,
          redisClient,
          now: () => new Date('2026-05-25T00:00:00Z'),
        },
      }
    );

    const records = await listDispatchRecords(redisClient);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      targetId,
      activityKind: 'comment',
      identifier: 'followup',
      goto: 'review later',
      runAt: '2026-05-25T00:10:00.000Z',
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: expect.stringContaining('scheduler execution pending'),
    });
  });

  it('schedules Devvit jobs for queued dispatch records', async () => {
    const client = createClient();
    const redisClient = new MemoryDispatchRedis();
    const schedulerClient = {
      runJob: vi.fn().mockResolvedValue('scheduler-1'),
      cancelJob: vi.fn().mockResolvedValue(undefined),
    };

    const summary = await executePlannedActions(
      client,
      target,
      targetId,
      [dispatchAction],
      {
        appEnabled: true,
        dryRun: false,
      },
      {
        dispatchQueue: {
          activity,
          redisClient,
          now: () => new Date('2026-05-25T00:00:00Z'),
        },
        schedulerClient,
      }
    );

    expect(schedulerClient.runJob).toHaveBeenCalledWith({
      name: 'contextModDispatch',
      data: {
        dispatchId: expect.any(String),
      },
      runAt: new Date('2026-05-25T00:10:00.000Z'),
    });
    const records = await listDispatchRecords(redisClient);
    expect(records[0]).toMatchObject({
      schedulerJobId: 'scheduler-1',
    });
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: expect.stringContaining('scheduled 1 Devvit job(s)'),
    });
  });

  it('cancels matching dispatch records', async () => {
    const client = createClient();
    const redisClient = new MemoryDispatchRedis();
    const schedulerClient = {
      runJob: vi.fn().mockResolvedValue('scheduler-2'),
      cancelJob: vi.fn().mockResolvedValue(undefined),
    };
    await enqueueDispatchRecord(
      redisClient,
      {
        activity,
        delayMs: 10 * 60_000,
        identifier: 'followup',
        schedulerJobId: 'scheduler-1',
      },
      {
        id: 'dispatch-1',
      }
    );

    const summary = await executePlannedActions(
      client,
      target,
      targetId,
      [cancelDispatchAction],
      {
        appEnabled: true,
        dryRun: false,
      },
      {
        dispatchQueue: {
          activity,
          redisClient,
        },
        schedulerClient,
      }
    );

    await expect(listDispatchRecords(redisClient)).resolves.toEqual([]);
    expect(schedulerClient.cancelJob).toHaveBeenCalledWith('scheduler-1');
    expect(summary.results[0]).toMatchObject({
      status: 'executed',
      reason: 'canceled 1 dispatch record(s) and 1 scheduler job(s)',
    });
  });

  it('skips dispatch actions when queue resources are unavailable', async () => {
    const client = createClient();

    const summary = await executePlannedActions(
      client,
      target,
      targetId,
      [dispatchAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(summary.results[0]).toMatchObject({
      status: 'skipped',
      reason: 'dispatch queue resources are unavailable',
    });
  });

  it('skips disabled and unsupported actions', async () => {
    const client = createClient();
    const disabledReport: PlannedAction = {
      ...reportAction,
      enabled: false,
    };
    const unsupportedAction: PlannedAction = {
      kind: 'unknownAction',
      enabled: true,
      dryRun: true,
      reason: 'planned',
    };

    const summary = await executePlannedActions(
      client,
      target,
      targetId,
      [disabledReport, unsupportedAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.report).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      executed: 0,
      skipped: 2,
      failed: 0,
    });
    expect(summary.results.map((result) => result.reason)).toEqual([
      'action is disabled in config',
      'unknownAction execution is not ported in the Devvit migration',
    ]);
  });

  it('records failed action execution and continues', async () => {
    const client = createClient();
    client.remove.mockRejectedValueOnce(new Error('permission denied'));

    const summary = await executePlannedActions(
      client,
      target,
      targetId,
      [removeAction, reportAction],
      {
        appEnabled: true,
        dryRun: false,
      }
    );

    expect(client.report).toHaveBeenCalledOnce();
    expect(summary).toMatchObject({
      executed: 1,
      skipped: 0,
      failed: 1,
    });
    expect(summary.results[0]).toMatchObject({
      status: 'failed',
      reason: 'permission denied',
    });
  });
});

describe('getReportReason', () => {
  it('uses report content and truncates to reddit report length', () => {
    expect(getReportReason(reportAction)).toBe('discord spam');
    expect(
      getReportReason({
        ...reportAction,
        config: {
          content: 'x'.repeat(150),
        },
      })
    ).toHaveLength(100);
  });

  it('falls back when report content is not configured', () => {
    expect(
      getReportReason({
        ...reportAction,
        config: {},
      })
    ).toBe('ContextMod rule matched');
  });
});
