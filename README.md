# CalendarSync

Copy events from a set of **source** Google calendars — possibly spread across
several Google accounts — into a single **target** calendar, for a day or a
range of days.

It performs a **full sync** for the chosen date window:

- **insert** events that don't have a copy yet (checks before copying),
- **update** copies whose source event changed since the last run,
- **delete** copies whose source event was cancelled or removed.

Each copy carries full details (title, description, location, times) but **not
attendees** — so copying never sends invitations or notifications to anyone.
Every copy is tagged in its `extendedProperties.private` with the source
account / calendar / event id, which is how existing copies are found and how
changes and deletions are detected.

It can also keep **"Busy" blocks** across a group of calendars: whenever you
have an event on one of them, each of the others gets a matching event titled
"Busy" (no details), so people looking at any one calendar see you're taken.
See [Busy blocks](#busy-blocks).

## Requirements

- Node.js 18+
- A Google Cloud project with the Google Calendar API enabled
- One OAuth "Desktop app" client (shared by all accounts you authorize)

## 1. Install

```bash
cd CalendarSync
npm install
```

## 2. Create Google OAuth credentials (one time)

If Patryk provided you with his CalendarSync Google Cloud Project's credentials.json, just use that.

Otherwise, or if you want to create your own Google Cloud Project CalenderSync project:

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library →** enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen:**
   - User type **External** is fine for personal use.
   - Add each Google account you'll sync (source and target) under
     **Test users**. (While the app is in "testing", only listed test users can
     authorize, and refresh tokens last ~7 days — see note below.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type: **Desktop app**.
   - Download the JSON and save it in this folder as **`credentials.json`**.

> This project uses a loopback redirect (`http://127.0.0.1:<random-port>`),
> which Desktop-app clients allow automatically — no redirect URIs to configure.

## 3. Configure your calendars

```bash
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "target":  { "account": "patryk@pakl.net", "calendarId": "primary" },
  "sources": [
    { "account": "patryk@pakl.net",   "calendarId": "primary" },
    { "account": "work@example.com",  "calendarId": "primary" },
    { "account": "work@example.com",  "calendarId": "team-abc123@group.calendar.google.com" }
  ]
}
```

- `account` — the Google login that has access to that calendar.
- `calendarId` — `"primary"` for the account's main calendar, or a specific
  calendar id. Find ids with `list-calendars` (below), or in Google Calendar
  under **Settings → <calendar> → Integrate calendar → Calendar ID**.

To also keep Busy blocks, add a `busy` section (see [Busy blocks](#busy-blocks)).
`target`/`sources` and `busy` are each optional, but you need at least one.

```json
{
  "busy": {
    "title": "Busy",
    "calendars": [
      { "account": "patryk@pakl.net",  "calendarId": "primary" },
      { "account": "work@example.com", "calendarId": "primary" }
    ]
  }
}
```

## 4. Authorize each account (one time per account)

```bash
node src/cli.js auth --all          # authorize every account in config.json
# or one at a time:
node src/cli.js auth patryk@pakl.net
```

A browser window opens for each account; approve access. Tokens are cached in
`tokens/` and refreshed automatically afterward. `auth --all` skips accounts
that already have a token; add `--force` to re-authorize them all.

Handy for filling in `config.json`:

```bash
node src/cli.js list-calendars work@example.com
```

## 5. Run a sync

```bash
# A single day
node src/cli.js run --date 2026-09-15

# An inclusive range
node src/cli.js run --from 2026-09-15 --to 2026-09-20

# Preview without writing anything
node src/cli.js run --from 2026-09-15 --to 2026-09-20 --dry-run
```

Dates are interpreted in your computer's local time zone. `run` does the copy
sync and then the Busy-block sync (each only if configured), and ends with a
summary line per sync like `copy: inserted=3 updated=1 deleted=0 unchanged=42 errors=0`.

## Busy blocks

With a `busy` section, every calendar listed in `busy.calendars` gets a block
for each event on the *other* listed calendars, kept in sync by `run` (insert /
update / delete, same as copies).

- A block has the source's start and end, the title from `busy.title`
  (default `"Busy"`), and nothing else: no description, location, attendees,
  or reminders. It's marked Busy (opaque), so it also shows in free/busy lookups.
- Events don't produce blocks if they're marked **Free**, you **declined**
  them, or they're Google **working-location** / **birthday** entries.
- If the same meeting is already on a calendar (for example you were invited
  on two of your accounts), that calendar gets no extra block for it, and a
  meeting on several of your other calendars produces one block, not several.
- Blocks and full copies are never used as sources, so the two syncs can't
  feed back into each other.
- Blocks don't record which account or event they came from (only a hash),
  so people who can see that calendar learn nothing beyond "busy".
- If any calendar in the group can't be read, that run skips deletions so it
  doesn't remove blocks that are still valid.

Your copy `target` can be in `busy.calendars` too. Events you put directly
on it then block the other calendars, and it only receives blocks for events
from calendars that aren't copy `sources` (it already has full copies of the
rest).

The first run in a window creates (events × other calendars) blocks, so try
`--dry-run` first, and consider starting with a short date range.

## 6. Schedule it (optional)

Because tokens are cached, `run` needs no interaction and is easy to schedule.

**cron** — sync a rolling 14-day window every morning at 06:00. Create a small
wrapper so cron has an absolute Node path and working directory:

```bash
# run-sync.sh
#!/bin/bash
cd /Users/patryk/Desktop/Core/Lighthill/CalendarSync
TODAY=$(date +%F)
END=$(date -v+14d +%F)          # macOS date syntax
/usr/local/bin/node src/cli.js run --from "$TODAY" --to "$END" >> sync.log 2>&1
```

```bash
chmod +x run-sync.sh
crontab -e
# add:
0 6 * * * /Users/patryk/Desktop/Core/Lighthill/CalendarSync/run-sync.sh
```

(Use `which node` to confirm the Node path.) On macOS you can alternatively use
a `launchd` LaunchAgent if you prefer.

## Notes & limits

- **Refresh-token expiry:** while the OAuth consent screen is in *Testing*,
  refresh tokens expire after ~7 days and you'll need to re-run `auth`. Move the
  app to *In production* (**Audience → Publish app**) to get long-lived tokens.
  No Google review is needed, but Branding must first have a homepage and a
  privacy policy URL on an authorized domain (see `site/calendarsync/` for
  example pages). Unverified apps show a "Google hasn't verified this app"
  screen (**Advanced → Go to CalendarSync**) and are capped at 100 users.
  Tokens issued while in Testing keep their 7-day limit, so run
  `auth --all --force` once after publishing.
- **Recurring events** are expanded to individual instances, so each occurrence
  in the window is synced independently and correctly.
- **Attendees/organizer/reminders are intentionally dropped** on copies to avoid
  notifying other people. Adjust `buildCopyBody` in `src/calendar.js` to change
  what's copied.
- Deletion only affects events this tool created (they carry the sync tag);
  it never touches events you made by hand on the target or busy calendars.
- Secrets (`credentials.json`, `tokens/`, `config.json`) are git-ignored.

## Project layout

```
src/
  cli.js        # command-line interface (auth / list-calendars / run)
  config.js     # loads & validates config.json
  auth.js       # per-account OAuth loopback flow + token cache
  calendar.js   # Calendar API helpers + event mapping / sync tagging
  sync.js       # the insert / update / delete diff engines (copies + Busy blocks)
```
