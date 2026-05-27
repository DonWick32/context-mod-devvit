# Migrating A Subreddit From ContextMod To ContextMod Devvit

Use this runbook to move an existing subreddit from the legacy externally hosted ContextMod service to the Devvit port.

Do the migration in stages. Keep event processing disabled first, validate the config, run manual dry-runs, then enable automatic dry-runs. Only enable real actions after the dashboard and status output match moderator expectations.

## What Changes

Legacy ContextMod used an external server, durable database, and broad network access. The Devvit port runs inside Reddit:

- Post/comment events come from Devvit triggers.
- Existing content can be checked from moderator menu actions.
- Modqueue and unmoderated checks run through bounded scheduled scans.
- Delayed dispatches use Redis queue records plus Devvit scheduler jobs.
- Audit, cache, and dispatch data are bounded Redis records, not a SQL/Influx replacement.
- The dashboard is a Devvit custom post that shows recent Redis-backed audit/config/dispatch data.

## Static Audit

From `port/context-mod-devvit`:

```sh
npm install
npm run migrate:audit -- /path/to/legacy-contextmod.yml > migration-audit.md
```

For JSON:

```sh
npm run migrate:audit -- --json /path/to/legacy-contextmod.yml > migration-audit.json
```

The audit script does not call Reddit. It reports inventory and flags:

- `url:` config fragments or URL-backed content that must move to wiki.
- `comment.asModTeam`, which Devvit does not expose as the same public reply mode.
- Discord webhook notifications requiring `discord.com`.
- YouTube external repost checks requiring `youtube.googleapis.com` and an API key.
- Gemini toxicity/MHS replacement requiring `generativelanguage.googleapis.com` and an API key.
- Image comparison paths that need Reddit image fetch domains and playtest timing review.
- Subreddit criteria that depend on historical NSFW/quarantine/type metadata should be manually spot-checked because Devvit history entries do not always expose every subreddit facet.

Fix every `BLOCKER` before real actions. `ACTION` findings usually mean credentials, fetch-domain approval, or manual feature testing.

## Config Storage

Preferred production source:

```text
r/<subreddit>/wiki/botconfig/contextbot
```

Devvit app setting:

```text
Configuration wiki page = botconfig/contextbot
Raw configuration override = empty
```

For playtests, paste config into **Raw configuration override**. That setting wins over the wiki page, so clear it before production.

Supported wiki references:

```yaml
rules:
  - wiki:botconfig/rules/spam
actions:
  - wiki:botconfig/actions/report
```

Cross-subreddit wiki fragments can be read only when the installed app has permission:

```yaml
rules:
  - wiki:botconfig/rules/shared|SharedConfigSubreddit
```

Move URL fragments to wiki:

```yaml
# old, not ported
- url:https://example.com/contextmod/rules.yml

# new
- wiki:botconfig/rules/imported
```

## Safe Install Settings

Start with:

```text
Enable event processing = false
Dry run actions = true
Configuration wiki page = botconfig/contextbot
Moderation scan item limit = 25
Moderation scan interval minutes = 10
```

Optional settings:

```text
YouTube Data API Key = required only for YouTube external repost checks
Gemini API Key = required only for mhs/toxicity checks
```

## Validation Flow

1. Install/playtest the Devvit app.
2. Open subreddit app settings and set the config source.
3. Run **Validate ContextMod config** from the subreddit menu.
4. Run **Run ContextMod check** on representative posts/comments.
5. Run **Run ContextMod by permalink** for existing content.
6. Run **Run ContextMod moderation scan** if modqueue/unmoderated coverage matters.
7. Open **ContextMod Dashboard** and confirm recent audit/config/dispatch data.

Expected dry-run output includes:

```text
Actions not executed: dry run is enabled.
```

## Automatic Dry-Run Test

Set:

```text
Enable event processing = true
Dry run actions = true
```

Create new matching test posts/comments. Existing content does not trigger automatically; use manual menu runs for existing content.

Confirm **ContextMod status** and **ContextMod Dashboard** show the new dry-run record.

## Real Action Cutover

Use a throwaway/playtest subreddit first.

For each action family:

1. Enable only one action in the YAML.
2. Set **Enable event processing = true**.
3. Set **Dry run actions = false**.
4. Create a new matching test item.
5. Confirm the action happened.
6. Confirm the dashboard action audit shows executed/skipped/failed counts.
7. Re-enable dry run before testing the next action.

Recommended order:

1. `report`
2. `comment`
3. `flair` / `userflair`
4. `lock`
5. `remove`
6. `approve`
7. `modnote` / `usernote`
8. `ban`
9. `dispatch` / `cancelDispatch`

## Fetch Domains

The current app requests these exact hostnames:

- `discord.com` - Discord webhook notification providers in legacy configs.
- `youtube.googleapis.com` - YouTube Data API lookups for external repost comment checks.
- `i.redd.it` - Reddit-hosted image fetches for image comparison.
- `preview.redd.it` - Reddit image preview fetches for image comparison.
- `generativelanguage.googleapis.com` - Gemini toxicity/MHS replacement.

If a subreddit does not use a feature, leave its config and API key empty. The domain may still be present in app config, so README must document why it can be requested.

## Not Migrated From Legacy Storage

The Devvit app does not import:

- SQL audit history.
- InfluxDB metrics.
- Grafana dashboards.
- Arbitrary external URL fragments.

Keep the legacy data export separately if moderators need historical audit retention.

## Rollback

Rollback is configuration-based:

1. Set **Enable event processing = false**.
2. Set **Dry run actions = true**.
3. Clear **Raw configuration override** if it contains test config.
4. Re-enable the old ContextMod service if needed.

No Devvit Redis restore is required because Redis is only used for bounded current-state data.

## Production Checklist

- Static audit has no blockers.
- Config validates in the Devvit menu.
- Raw override is empty.
- Wiki config and fragments are backed up.
- Required API keys are set.
- Dry-run records match expected checks/actions.
- Real action tests passed in playtest.
- Dashboard opens and shows recent records.
- Old ContextMod service is paused before enabling real Devvit actions.
