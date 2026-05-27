# ContextMod Devvit Port

This app is the Devvit migration target for the legacy app in `old/context-mod`.

The first scaffold intentionally performs no moderation actions. Event processing is disabled by default and actions default to dry run so each migration slice can be playtested before it can affect a subreddit.

## Commands

- `npm install` - install dependencies
- `npm run type-check` - verify TypeScript
- `npm run lint` - run ESLint
- `npm run test` - run unit tests
- `npm run build` - build the Devvit server and custom post bundles
- `npm run dev` - run `devvit playtest`
- `npm run migrate:audit -- <legacy-config.yml>` - statically audit a legacy config before migration

## Current Testable Behavior

The app can validate legacy ContextMod config, run dry-runs, execute supported actions behind settings gates, scan moderation queues, and show recent Redis-backed state in the dashboard.

1. Install/playtest the app with `npm run dev`.
2. For quick testing, paste YAML or JSON5 into the **Raw configuration override** subreddit setting.
3. Otherwise, create the configured wiki page, default `botconfig/contextbot`.
4. Use the subreddit menu item **Validate ContextMod config**.
5. On a post or comment, use **Run ContextMod check** to run the current dry-run evaluator.
6. From the subreddit menu, use **Run ContextMod by permalink** to run against a pasted post/comment permalink or `t1_`/`t3_` thing ID.
7. To test automatic processing, set **Enable event processing** to true and create a new matching post or comment.

The validation menu parses YAML/JSON5, normalizes runs/checks/rules/actions, and logs full migration warnings. The toast shows a short count summary.

The dry-run evaluator currently supports current-activity regex rules, basic author-name rules, author/item filters with local snapshot fields, simple item state checks, submission state checks, score comparisons, current app `self` moderator-name checks for removed/approved state, and action planning. Unsupported rules are reported in logs and do not execute. Manual dry-run results are stored in a bounded Redis audit log; use **ContextMod status** to see the latest retained dry run.

Basic `approve`, `lock`, `remove`, `report`, simple `comment`, post `flair`, `userflair`, `ban`, `contributor`, direct `message`, and static `modnote` action execution is implemented but guarded by both settings. Actions execute only when **Enable event processing** is true and **Dry run actions** is false. Keep dry run enabled during normal migration testing.

The current `comment` action support uses `content`, supports `targets: self`, `targets: parent`, and Reddit permalink/thing-ID targets, and can lock/distinguish/sticky the created reply. `asModTeam` remains unsupported because Devvit does not expose the same public-as-subreddit reply flow.

Basic `onPostSubmit` and `onCommentSubmit` triggers are wired to the same processing path as the manual menu action. Trigger processing exits early unless **Enable event processing** is true and skips app-authored submit events when the event author is available.

Moderator-only fixture menu actions can create temporary comment/submission test content and run built-in YAML fixtures directly against the shared processor. Fixture action execution is forced to dry-run mode.

## Devvit Runtime Boundaries

This port does not run a long-lived polling server. Work starts from Devvit triggers, moderator menu actions, scheduled moderation scans, or scheduled dispatch jobs.

Devvit Redis is used as bounded app storage for config/cache/audit/dispatch records. It is not treated as a replacement for the old SQL database or InfluxDB. Retained audit/status records are intentionally small and TTL/bounded.

Expensive work must be split across scheduled jobs or skipped with a clear unsupported reason. Current scans are bounded by settings, and delayed dispatches are persisted as Redis queue records plus Devvit scheduler jobs.

External fetch is feature-gated by config and API keys. URL-backed config fragments and URL-backed action text remain blocked; Discord webhooks, YouTube lookups, Reddit-hosted image fetches, and Gemini toxicity checks require the exact fetch domains documented below.

Real moderator actions are gated by all of these controls: **Enable event processing** must be true, **Dry run actions** must be false, the action must have `enable: true`, action-level `dryRun` must not be true, and the check/filter planning path must be supported.

## Legacy Compatibility Notes

The supported config surface is intentionally expanding slice by slice. YAML/JSON5 parsing, runs/checks, named rules/actions/filters, same-subreddit and cross-subreddit wiki includes, current triggers, bounded queue scans, author metadata hydration, subreddit metadata hydration, author history hydration, legacy SubredditCriteria include/exclude matching, dispatch, Toolbox usernotes, Reddit mod notes, and the main moderation actions are implemented.

Known degraded or deferred legacy behavior:

- Cross-subreddit config fragments and wiki-backed action text are enabled when the installed app can read that subreddit wiki. Cross-subreddit moderator action targets are not enabled.
- External URL config/action content is blocked until a fetch domain is approved.
- Old SQL/Influx/Grafana dashboard parity is not ported; the Devvit dashboard and status menu show bounded Redis audit records.
- Report time-window filters only cover report events observed and retained by this Devvit app.
- Upvote ratio is not generally available from the current Devvit post model.
- `asModTeam` public reply parity is not exposed by Devvit; hidden-author modmail is used where supported.
- YouTube repost metadata, Reddit-hosted image comparison, Discord webhooks, and Gemini toxicity replacement require API credentials/fetch-domain approval and should be playtested separately.

Not ported in the Devvit-only milestone:

- Old SQL audit migration, InfluxDB, and Grafana.
- External URL config fragments or URL-backed action templates.
- Legacy SQL/Influx/Grafana dashboard parity.
- Arbitrary non-Reddit image fetching.
- The legacy MHS provider as-is; the Devvit port uses a Gemini replacement.

## Playtest Checklist

Use **Validate ContextMod config** after every YAML change, then create new matching content for realtime trigger tests. Existing content only runs when you use the manual menu action.

Keep **Dry run actions** true for broad config smoke tests. Use visible safe actions such as `comment` with `enable: true` when you need realtime confirmation without removing content.

For real action tests, use a throwaway playtest subreddit and set **Enable event processing** true plus **Dry run actions** false. Start with a single enabled action, confirm it, then add more actions.

Check **ContextMod status** after manual runs, realtime trigger runs, queue scans, and dispatch jobs. It should show the latest retained dry-run or real-action audit record.

### Sample Playtest Config

Paste this into **Raw configuration override** if the default wiki page does not exist yet:

```yaml
checks:
  - name: remove discord spam
    kind: comment
    rules:
      - name: linkOnlySpam
        kind: regex
        criteria:
          - regex: '/discord\.gg\/[\w\d]+/i'
    actions:
      - kind: remove
      - kind: report
        enable: false
        content: discord spam
```

For safe reply testing, keep **Dry run actions** enabled and use a `comment` action:

```yaml
checks:
  - name: reply to discord spam
    kind: comment
    rules:
      - name: linkOnlySpam
        kind: regex
        criteria:
          - regex: '/discord\.gg\/[\w\d]+/i'
    actions:
      - kind: comment
        content: ContextMod test reply
```

For parent-target reply testing, create a matching comment on a post:

```yaml
checks:
  - name: parent target reply test
    kind: comment
    rules:
      - kind: regex
        criteria:
          - regex: '/contextmod parent test/i'
    actions:
      - kind: comment
        targets: parent
        content: ContextMod parent-level test reply
```

For reply modifier testing:

```yaml
checks:
  - name: modified reply test
    kind: comment
    rules:
      - kind: regex
        criteria:
          - regex: '/contextmod modified reply test/i'
    actions:
      - kind: comment
        content: ContextMod locked distinguished sticky test reply
        lock: true
        distinguish: true
        sticky: true
```

For submission filter testing:

```yaml
checks:
  - name: flag matching submission state
    kind: submission
    itemIs:
      over_18: false
      spoiler: false
      is_self: true
      pinned: false
      title: '/contextmod test/i'
    actions:
      - kind: report
        content: submission state matched
```

For post flair testing, use a submission with `contextmod flair test` in the title:

```yaml
checks:
  - name: flair matching submission
    kind: submission
    rules:
      - kind: regex
        criteria:
          - regex: '/contextmod flair test/i'
    actions:
      - kind: flair
        text: Needs Review
        css: review
```

## Migration Shape

The migration should land in small, testable pieces:

1. Preserve the old YAML/JSON5 config contract where Devvit can support it.
2. Build a pure TypeScript config parser and planner with unit tests before wiring Reddit APIs.
3. Port read-only rule evaluation before moderator actions.
4. Add one action family at a time behind dry-run logging.
5. Add Redis-backed queues/caches only where Devvit request limits require continuation.
6. Introduce Supabase only if Redis cannot support the required query or audit capability.

`tracker.md` is the source of truth for migration status and should be updated with every completed slice.

## Migration Guide

See [docs/MIGRATION.md](docs/MIGRATION.md) for the moderator migration runbook and static audit workflow.

## Fetch Domains

The following domains are requested for this app:

- `discord.com` - Used only when a legacy config enables Discord webhook notification providers.
- `youtube.googleapis.com` - Used only when repost rules retain YouTube external comment checks.
- `i.redd.it` - Used for Reddit-hosted image comparison when image matching rules are enabled.
- `preview.redd.it` - Used for Reddit image preview comparison when image matching rules are enabled.
- `generativelanguage.googleapis.com` - Used only when legacy `mhs`/toxicity checks are replaced by Gemini classification.

Supabase is not requested. Add a granular `<project-ref>.supabase.co` domain only if a future migration slice proves Devvit Redis cannot support a required relational storage capability.
