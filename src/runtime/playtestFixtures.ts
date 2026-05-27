export type ContextModPlaytestFixture = {
  sourceName: string;
  configText: string;
  triggerText: string;
};

export const commentParentModifierFixture: ContextModPlaytestFixture = {
  sourceName: 'built-in fixture: comment parent target and modifiers',
  triggerText: 'contextmod fixture comment parent modifiers',
  configText: `
checks:
  - name: fixture comment parent modifiers
    kind: comment
    rules:
      - kind: regex
        criteria:
          - regex: '/contextmod fixture comment parent modifiers/i'
    actions:
      - kind: comment
        targets: parent
        content: ContextMod fixture parent-level reply
        lock: true
        distinguish: true
        sticky: true
`,
};

export const submissionFilterFlairFixture: ContextModPlaytestFixture = {
  sourceName: 'built-in fixture: submission filters and flair',
  triggerText: 'contextmod fixture submission filters flair',
  configText: `
checks:
  - name: fixture submission filters flair
    kind: submission
    itemIs:
      over_18: false
      spoiler: false
      is_self: true
      pinned: false
      title: '/contextmod fixture submission filters flair/i'
    actions:
      - kind: flair
        text: Needs Review
        css: review
`,
};
