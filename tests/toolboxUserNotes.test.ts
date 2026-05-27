import { describe, expect, it } from 'vitest';
import {
  deflateToolboxUserNotesBlob,
  evaluateToolboxUserNoteCriteria,
  getToolboxUserNotesForAuthor,
  inflateToolboxUserNotesBlob,
} from '../src/runtime/toolboxUserNotes';

const blob = {
  Spammer42: {
    ns: [
      {
        n: 'First spam warning',
        t: 1_764_028_800,
        m: 0,
        l: 'l,post123,comment123',
        w: 0,
      },
      {
        n: 'Recent helper note',
        t: 1_764_115_200,
        m: 1,
        l: '',
        w: 1,
      },
      {
        n: 'Second spam warning',
        t: 1_764_201_600,
        m: 0,
        l: 'https://reddit.com/r/testsub/comments/post123/title/comment123/',
        w: 0,
      },
    ],
  },
};

const content = JSON.stringify({
  ver: 6,
  constants: {
    users: ['ModOne', 'ModTwo'],
    warnings: ['spamwatch', 'gooduser'],
  },
  blob: deflateToolboxUserNotesBlob(blob),
});

describe('toolbox usernotes helpers', () => {
  it('inflates toolbox usernote blobs and extracts normalized notes for an author', () => {
    expect(inflateToolboxUserNotesBlob(deflateToolboxUserNotesBlob(blob))).toEqual(
      blob
    );

    const notes = getToolboxUserNotesForAuthor(content, 'spammer42');

    expect(notes).toEqual([
      {
        text: 'First spam warning',
        type: 'spamwatch',
        moderator: 'ModOne',
        createdAt: new Date('2025-11-25T00:00:00.000Z'),
        link: 'https://www.reddit.com/comments/post123/_/comment123',
      },
      {
        text: 'Recent helper note',
        type: 'gooduser',
        moderator: 'ModTwo',
        createdAt: new Date('2025-11-26T00:00:00.000Z'),
      },
      {
        text: 'Second spam warning',
        type: 'spamwatch',
        moderator: 'ModOne',
        createdAt: new Date('2025-11-27T00:00:00.000Z'),
        link: 'https://reddit.com/r/testsub/comments/post123/title/comment123/',
      },
    ]);
  });

  it('evaluates usernote type, text, reference, search, and count criteria', () => {
    const notes = getToolboxUserNotesForAuthor(content, 'Spammer42');

    expect(
      evaluateToolboxUserNoteCriteria(
        notes,
        {
          type: 'spamwatch',
          note: '/spam warning/i',
          referencesCurrentActivity: true,
          search: 'total',
          count: '>= 2',
        },
        't1_comment123'
      )
    ).toBe(true);
    expect(
      evaluateToolboxUserNoteCriteria(
        notes,
        {
          type: 'spamwatch',
          search: 'current',
        },
        't1_comment123'
      )
    ).toBe(true);
    expect(
      evaluateToolboxUserNoteCriteria(
        notes,
        {
          type: 'gooduser',
          search: 'consecutive',
          count: '>= 2',
        },
        't1_comment123'
      )
    ).toBe(false);
  });
});
