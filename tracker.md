# ContextMod Devvit Migration Tracker

Last updated: 2026-05-26

## Current Decisions

- Target app lives in `port/context-mod-devvit`.
- Legacy source of truth is `old/context-mod`.
- Devvit app slug in `devvit.json` is `hexadecimal-mod`.
- Event processing is disabled by default and actions default to dry run during the migration.
- Use Devvit Reddit API, Redis, scheduler, settings, triggers, menu items, and native forms first.
- Do not add external fetch domains until a migrated feature proves Devvit cannot support it.
- If relational persistence is required, prefer Supabase with the most granular project hostname.

## Status Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete
- `[?]` Needs feasibility decision

## Foundation

- [x] Scaffold `port/context-mod-devvit` from the current Devvit mod-tool template.
- [x] Replace sample template behavior with ContextMod-specific status/manual-run stubs.
- [x] Add subreddit settings for enablement, dry run, and config wiki path.
- [x] Enable Devvit Reddit API moderator scope and Redis storage.
- [x] Add this migration tracker.
- [x] Add working type-check, lint, build, deploy, launch, and playtest scripts.
- [x] Generate `package-lock.json` with Node 22.
- [x] Verify scaffold with `npm run type-check`, `npm run lint`, and `npm run build`.
- [x] Register or bind the local project to a real Devvit app code with `devvit init --force`.
- [x] Add a unit test harness once the first pure migration module lands.
- [x] Decide package dependency policy for porting old pure utilities versus rewriting. Pure local dependencies are allowed when they do not require fetch, native binaries, or long-lived processes; the sentiment slice reuses `vader-sentiment` under that rule.

## Architecture Slices

- [x] Define Devvit runtime boundaries: request budget, scheduler continuation, Redis storage limits, and no long-lived polling process. README now documents trigger/scheduler-only execution, bounded Redis storage, real-action gates, and fetch-domain constraints for moderator operators.
- [x] Create a pure config domain module for YAML/JSON5 parsing, structural validation, normalization, and migration warnings.
- [x] Create an activity adapter that normalizes Devvit posts/comments into the old ContextMod activity model, including moderation state/report metadata exposed by Devvit.
- [x] Create a Reddit resources adapter for authors, subreddits, wiki pages, mod notes, contributors, flair, and history fetches. Author profile, subreddit NSFW/type/quarantine metadata, moderator, contributor, mod note, bounded author history, submission duplicate/crosspost candidate hydration, and same/cross-subreddit wiki reads are implemented; unavailable external metadata facets are documented as not ported.
- [x] Create action execution adapter with explicit settings gates.
- [x] Create a Redis cache wrapper with TTL namespacing for per-installation cache data.
- [x] Create a processing planner that can split expensive checks into scheduler-safe chunks. Dispatch queue records schedule Devvit jobs and process due records through the shared pipeline; broader chunk continuation is not needed for the bounded Devvit-only milestone.
- [x] Create dry-run logging/audit records with bounded Redis retention.
- [x] Create migration fixtures from old cookbook examples and tests. Legacy cookbook history, repeatActivity, and attribution/usernote examples now parse under local tests and assert required Devvit resource hydration.

## Event Ingestion

- [x] Map old `newSub` polling to Devvit post create/submit triggers. `onPostSubmit` processing is wired behind the event-processing setting with app-authored event skipping; legacy always-on polling is intentionally replaced by Devvit triggers.
- [x] Map old `newComm` polling to Devvit comment create/submit triggers. `onCommentSubmit` processing is wired behind the event-processing setting with app-authored event skipping; legacy always-on polling is intentionally replaced by Devvit triggers.
- [x] Map old `unmoderated` polling to available Devvit triggers or a scheduled moderation queue scan. Scheduler-backed unmoderated scans now process bounded queue listings with `poll:unmoderated` source metadata and app-authored item skipping.
- [x] Map old `modqueue` polling to report, automoderator-filter, and scheduled scan behavior. Scheduler-backed bounded modqueue scans process queue listings with `poll:modqueue` source metadata; report/Automoderator-specific realtime triggers are not exposed as separate Devvit triggers for this port.
- [x] Preserve manual "run bot on permalink/item" behavior through moderator menu actions. Selected post/comment runs and subreddit-menu pasted permalink or `t1_`/`t3_` thing-ID runs share the migrated processor.
- [x] Add installation/upgrade hooks for default settings and migrations. Dispatch and moderation-scan scheduled tasks are configured in `devvit.json`, and app install schedules the first moderation scan; no pre-existing Devvit data migration is needed for this port.

## Config Features

- [x] Wiki config loading from the configured subreddit wiki page.
- [x] Raw settings-based config fallback if wiki loading is not enough.
- [x] Friendly missing-config handling when the configured wiki page does not exist.
- [x] Automatic creation of the default configuration wiki page on app installation and upgrade triggers.
- [x] YAML parsing.
- [x] JSON5 parsing.
- [x] Structural validation and useful config errors.
- [x] Runs and checks.
- [x] Named rules, actions, rule sets, author filters, and item filters. Named rule, action, author filter, and item filter references now hydrate from the loaded config.
- [x] Filter defaults with merge/replace behavior.
- [x] Post-check flow control: `next`, `stop`, `nextRun`, and `goto`.
- [x] Partial configs from same-subreddit wiki pages. Same-subreddit `wiki:` fragments hydrate for runs, checks, rules, and actions before normalization.
- [x] Partial configs from other subreddits with ACLs. `wiki:path|SubredditName` fragments now hydrate through Devvit wiki reads; access is governed by Reddit/Devvit permissions for the installed app.
- [x] Partial configs from external URLs are not ported by default. `url:` fragments remain unsupported unless a future exact fetch-domain request is approved for a specific host.
- [x] Action templating with old placeholders. Basic and moderator-facing `{{item.*}}` placeholders, template-driven hydration for legacy author detail placeholders such as `{{item.author.age}}`/karma/verified/moderator/contributor/flair, activity age/state/report placeholders, footer constants, `{{rules.<name>.<field>}}`, and prior action result placeholders such as `{{action.0.status}}`/`{{action.0.id}}` are rendered for local text, flair, user-flair, submission, and same/cross-subreddit wiki-backed action content fields; URL content is not ported in the Devvit-only milestone.
- [x] Wiki-backed action template content. Same-subreddit and `wiki:path|SubredditName` content is loaded for action text fields during real execution before template rendering.

## Filters

- [x] Author criteria: name, flair CSS/text/template/background, moderator status. Local name and author flair text/CSS/template/background filters are supported; moderator status is hydrated through the Reddit resources adapter.
- [x] Author criteria: user notes. Toolbox wiki `usernotes` blobs are parsed and hydrated from same-subreddit wiki, and filters support type, note text/regex, current/total/consecutive search, count/percent comparisons, and current-activity references.
- [x] Author criteria: mod notes and mod log actions. `authorIs.modActions` supports Reddit mod note criteria over hydrated Devvit mod notes; broader legacy mod log action queries are not exposed by Devvit and are not ported.
- [x] Author criteria: account age, link/comment/total karma, verified email, shadowbanned.
- [x] Author criteria: profile description and contributor status.
- [x] Item criteria: removed, filtered, deleted, locked, spam, stickied, distinguished, approved. Boolean current-item checks include deleted/filtered state, Devvit post/comment moderation flags, removed/approved moderator-name checks where Devvit metadata is hydrated, and `self` moderator-name matching through the current Devvit app username when those filters are present.
- [x] Item criteria: score, reports, age, created-on, source, dispatched state. Local fields support score, total/user/mod report comparisons, literal/regex report reason filters, age duration comparisons, day-of-week `createdOn`, and source matching for `poll:newSub`, `poll:newComm`, `poll:modqueue`, `poll:unmoderated`, `user`, and `dispatch:*`; report time-window history is supported only for reports observed and retained by this Devvit app.
- [x] Submission criteria: pinned, spoiler, NSFW, self post, title, link flair, Reddit media, upvote ratio. Local fields support pinned/stickied, spoiler, NSFW/over_18, is_self, title, link flair text/CSS/template/background, Reddit-hosted media detection, and best-effort upvote ratio when Devvit exposes `upVoteRatio` on the post object.
- [x] Comment criteria: OP, parent submission state, depth. OP is supported when parent post metadata is available, top-level/exact snapshot depth is supported, and comment filters can evaluate local item criteria against the hydrated parent submission.
- [x] Subreddit criteria for history filters: name, NSFW, quarantine, type, profile, own profile. Legacy `SubredditCriteria` objects now work in recent/history/repeat/attribution include/exclude paths; name/profile checks use local snapshots, and NSFW/quarantine/type checks work when those facets are present in hydrated snapshots.

## Rules

- [x] Author rule.
- [x] Regex rule against current activity.
- [x] Regex rule against activity windows/history. Windowed count/duration history, `lookAt`/`window.fetch`, `matchThreshold`, `activityMatchThreshold`, `totalMatchThreshold`, `repeatThreshold`, `mustMatchCurrent`, submission `testOn`, and same/cross-subreddit wiki-backed regex content tokens are supported; URL-backed regex content is not ported without fetch-domain approval.
- [x] Recent activity rule. Author-history subreddit thresholds, legacy `SubredditCriteria` matching, count/percent comparisons, karma threshold, `lookAt`, same-link submission reference, and Reddit-hosted image hash comparisons are supported from bounded hydrated history; arbitrary external image fetching remains blocked and metadata-backed subreddit criteria are best-effort when history snapshots do not expose every facet.
- [x] Repeat activity rule. Identifier repeat detection supports bounded author-history windows, `useSubmissionAsReference`, `gapAllowance`, `lookAt`/`window.fetch`, `keepRemoved`, legacy `SubredditCriteria` include/exclude, transformations, `matchScore` fuzzy similarity, and threshold comparisons; metadata-backed subreddit criteria are best-effort when history snapshots do not expose every facet.
- [x] History rule. Author-history comment/submission/total count and percent thresholds are supported with count/duration windows, subreddit include/exclude filters, and ratio thresholds; full OP metadata parity is not ported.
- [x] Attribution/self-promotion rule. Local domain aggregation over bounded author history supports thresholds, percent thresholds, `thresholdOn`, `minActivityCount`, `aggregateOn`, `domains`, `domainsCombined`, `AGG:SELF`, and legacy `SubredditCriteria` include/exclude; media channel attribution and full legacy window filter parity are not ported.
- [x] Repost rule: title/url/duplicate/crosspost facets. Submission repost checks evaluate hydrated Devvit duplicate/crosspost candidates, comment repost checks compare candidate comments from duplicate/crosspost parent submissions, and count/time occurrence criteria are supported; global title/url Reddit search and external facets are not ported.
- [x] Repost rule: YouTube repost integration is ported. Allows detecting reposted YouTube videos using the `youtube.googleapis.com` fetch domain and a YouTube API key in settings.
- [x] Image comparison is partially ported for approved Reddit image hosts. Pure-JS perceptual hashing supports Reddit-hosted images from `i.redd.it` and `preview.redd.it`; arbitrary non-Reddit image fetching remains blocked by fetch-domain policy.
- [x] Sentiment rule with local library if bundle/runtime limits allow it. Current-activity and hydrated-history sentiment checks use bundled VADER scoring with numeric/text comparisons plus a Latin-script heuristic to skip likely unsupported non-English text; the legacy multi-analyzer average is not ported.
- [x] Toxicity/MHS rule is ported. The legacy moderatehatespeech.com integration is replaced by a Gemini API (gemini-2.5-flash) toxicity classifier. Requires a Gemini API key in app settings.

## Actions

- [x] Approve. Self and comment parent targets execute behind settings gates and already-approved self/loaded-parent targets are skipped.
- [x] Remove. Item removal and spam marking execute behind settings gates, and configured New Reddit removal `reasonId`/templated `note` values are sent through Devvit removal notes; removal reason ID discovery/validation is not exposed by the current adapter.
- [x] Report.
- [x] Lock. Lock executes behind settings gates and already-locked targets are skipped.
- [x] Comment/reply. Self-target replies/top-level post comments, parent-target comments, permalink/thing-ID targets, action footers, and lock/distinguish/sticky reply modifiers execute behind settings gates; `asModTeam` is not ported because Devvit does not expose the same public-as-subreddit reply flow.
- [x] Submission actions: flair and legacy post creation. Post `flair` action execution is implemented; legacy `kind: submission` creates same-subreddit self/link posts with templated title/body/url/flair, action footers for self-post bodies, NSFW/spoiler submit options, and lock/distinguish/sticky modifiers. Cross-subreddit submission targets are not ported.
- [x] User flair. Text/CSS/template assignment and flair removal execute behind settings gates, with action placeholder rendering for configured flair values.
- [x] Ban. Templated message/reason/note/duration bans with message footers execute behind settings gates.
- [x] Message/modmail. Direct app-user messages, `/r/subreddit` moderator messages, message footers, and `asSubreddit` user messages through hidden-author Devvit modmail execute behind settings gates; richer legacy modmail workflows are not ported.
- [x] Contributor add/remove. Static add/remove contributor actions execute behind settings gates, and same-subreddit hydrated contributor state prechecks skip already-final add/remove attempts.
- [x] Reddit Mod Note. Static mod note creation executes behind settings gates, default/boolean duplicate checks use Devvit mod notes to skip matching notes for the same activity, and object-shaped `existingNoteCheck` supports mod note criteria/count checks; broader mod log criteria are not ported.
- [x] Toolbox User Note read/write via wiki page. Same-subreddit Toolbox `usernotes` read/hydrate/evaluate support is implemented, and `kind: usernote` writes back to the wiki page with templated content, moderator constants, warning constants, activity links, and boolean/object duplicate checks.
- [x] Dispatch/delay with Devvit scheduler. Dispatch actions enqueue bounded Redis dispatch records, schedule Devvit jobs, and scheduled/manual task processing rehydrates the target with `dispatch:*` source metadata and optional `goto` start position; scheduled dispatch failures retry with bounded backoff and then move to a Redis dead-letter set.
- [x] Cancel dispatch. Pending Redis dispatch records can be cancelled by target and identifier, and stored Devvit scheduler jobs are cancelled when available.
- [x] Dry-run mode for every planned action.
- [x] Real action execution is blocked unless app processing is enabled, global dry run is false, action `enable` is true, action-level `dryRun` is false, and the check/action filter planning path is fully supported.
- [x] Per-action author/item filters.

## Storage And Persistence

- [x] Redis key design for config cache, wiki cache, author cache, activity cache, rule result cache, and delayed dispatches. Shared namespaced cache keys cover bounded TTL caches, author profile/subreddit relationship/mod-note hydration, delayed dispatch queue keys, dispatch target/identifier lookup, and scheduler job IDs.
- [x] Bounded dry-run audit records in Redis.
- [x] Bounded real action/event records in Redis.
- [x] Retention policy cleanup.
- [x] Supabase schema for relational audit history is not adopted for the Devvit-only port. Bounded Redis audit/status records are the first milestone.
- [x] Supabase fetch-domain request and README entry are not needed because relational storage was not adopted.
- [x] Migration strategy for old SQL audit data is out of scope for the Devvit-only port; old audit history is not migrated into Redis.
- [x] Remove or replace InfluxDB/Grafana statistics. The external statistics stack is replaced by bounded Redis audit/status records and console logging.

## Notifications And Cross-Subreddit Coordination

- [x] Discord webhook notifications are ported. Uses the `discord.com` fetch domain to send notifications for complete runs, errors, and actions.
- [x] Devvit-native moderator notifications are covered by the migrated `message`/modmail action family where configs explicitly request them; no global notification bus is ported.
- [x] Notification event mapping for run state, polling/config errors, and actioned events is replaced by menu toasts, bounded audit records, and console logs in the Devvit port.

## Web And Moderator UX

- [x] Subreddit settings for enablement, dry run, config source/path, moderation scan limit/interval, and safe defaults.
- [x] Config validation menu action.
- [x] Manual run menu action for posts/comments, pasted permalinks/thing IDs, and moderation queues. Selected-item runs, subreddit-menu pasted target runs, and bounded modqueue/unmoderated scans all use the shared migrated processor.
- [x] Built-in moderator fixture menu action for comment migration smoke tests.
- [x] Built-in moderator fixture menu action for submission migration smoke tests.
- [x] Missing config setup guidance in validation/manual-run menu responses.
- [x] Lightweight status view or menu response for current config/cache/last-run state.
- [x] Status menu reports the latest retained dry-run and real-action audit records.
- [x] Replacement for the old external dashboard is a native Devvit Custom Post webview UI. It loads active config, recent dry-run/action audit records, and dispatch queue state from `/api/dashboard`.
- [x] Moderator-facing docs for unsupported/degraded legacy features. README and `docs/MIGRATION.md` document current Devvit runtime boundaries, degraded legacy behavior, fetch-domain constraints, and playtest steps.
- [x] Static migration audit script for legacy configs. `npm run migrate:audit -- <config>` reports feature inventory, blockers, required fetch domains, and manual action items.

## Fetch Domains

- [x] Scaffold requests no external domains.
- [x] Add README "Fetch Domains" entry before any external domain is added to `devvit.json`.
- [x] `discord.com` is requested for webhook notifications.
- [x] `youtube.googleapis.com` is requested for YouTube repost metadata.
- [x] `generativelanguage.googleapis.com` is requested for the Gemini Toxicity classifier.
- [x] `<project-ref>.supabase.co` is not requested because relational storage is not adopted.

## Test Plan

- [x] Unit tests for config parsing and normalization.
- [x] Unit tests for duration/comparison parsing.
- [x] Unit tests for author and item filters using fixtures, including Devvit report type/reason metadata and additional moderation state fields.
- [x] Unit tests for each pure rule implementation that is ported; non-ported MHS/image/external facets are covered by parser warnings and unsupported-path tests.
- [x] Unit tests for action planning/dry-run output.
- [x] Unit tests for shared manual/trigger processing pipeline.
- [x] Unit tests for trigger thing-id normalization.
- [x] Unit tests for local submission item filters.
- [x] Unit tests for resource-backed author metadata filters and the Reddit resources adapter.
- [x] Unit tests for bounded author history hydration and basic history/recentActivity rule evaluation.
- [x] Unit tests for regex history windows, regex repeat thresholds, and repeatActivity exact/fuzzy repeat evaluation.
- [x] Unit tests for attribution aggregation, submission repost duplicate/crosspost candidate evaluation, comment repost candidate evaluation, and repost occurrence time criteria.
- [x] Unit tests for rule-result action templates, modnote duplicate checks, object `existingNoteCheck`, and author mod note filters.
- [x] Unit tests for built-in playtest fixture configs.
- [x] Unit tests for gated approve/lock/remove/report action execution, including removal notes/reason IDs.
- [x] Unit tests for action-level dry-run gating and unsupported-planned-action execution blocking.
- [x] Unit tests for approve self/parent targets, already-final approve/lock skips, and deleted/filtered item criteria.
- [x] Unit tests for gated simple comment action execution.
- [x] Unit tests for comment parent/permalink targets and reply modifiers.
- [x] Unit tests for gated post flair and same-subreddit submission action execution.
- [x] Unit tests for Reddit-hosted media submission filters and snapshot detection.
- [x] Unit tests for action footer rendering on comment, ban, message, and submission actions.
- [x] Unit tests for templated flair/user-flair execution and `asSubreddit` modmail message execution.
- [x] Unit tests for comment parent submission-state filters.
- [x] Unit tests for gated user flair and ban action execution.
- [x] Unit tests for gated contributor and mod note action execution.
- [x] Unit tests for direct message action execution and basic/statistic/state action placeholders.
- [x] Unit tests for same-subreddit wiki config fragments, wiki-backed regex content tokens, and wiki-backed action template content.
- [x] Unit tests for Toolbox usernote blob parsing, author resource hydration, author filter evaluation, and gated usernote wiki write-back.
- [x] Unit tests for dispatch queue action execution, cancel dispatch matching, and item source filters.
- [x] Unit tests for Devvit dispatch scheduler IDs, scheduled dispatch processing, and dispatch `goto` start behavior.
- [x] Unit tests for scheduled modqueue/unmoderated scan source tagging, app-authored item skipping, and scan job scheduling.
- [x] Unit tests for current and historical sentiment rule evaluation.
- [x] Unit tests for Redis-backed dry-run audit helper.
- [x] Integration tests for Redis-backed cache and dispatch queue abstractions.
- [x] Playtest checklist for triggers, menu actions, wiki config loading, and dry-run actions.

## Known Constraints

- Devvit does not provide the same always-on process model as the legacy polling server.
- Redis should be treated as small bounded storage, not a SQL/Influx replacement.
- External URL config fragments remain blocked; arbitrary non-Reddit image fetching is not ported.
- Discord webhooks, YouTube lookups, Reddit image fetches, and Gemini toxicity checks need fetch-domain approval plus feature-specific playtesting before production use.
- Personal domains should not be used for required app functionality.
- Full parity with the old SQL/Influx/Grafana dashboard is not a first milestone.
