#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig, accountsInConfig } from './config.js';
import { authorizeAccount, hasToken } from './auth.js';
import { calendarFor } from './calendar.js';
import { runSync, runBusySync } from './sync.js';

const USAGE = `
CalendarSync — copy events from multiple source calendars into one target calendar,
and/or keep "Busy" blocks on each calendar for events on the others.

Usage:
  calendarsync auth <account-email>     Authorize a single Google account
  calendarsync auth --all               Authorize every account referenced in config.json
      [--force]                         Re-authorize accounts that already have a token
  calendarsync list-calendars <account> List calendar IDs visible to an account
  calendarsync run --date YYYY-MM-DD    Sync a single day
  calendarsync run --from YYYY-MM-DD --to YYYY-MM-DD   Sync an inclusive date range
      [--dry-run]                       Show what would change without writing

"run" does the copy sync (if "target"/"sources" are configured) and then the
Busy-block sync (if "busy" is configured).

Examples:
  calendarsync auth patryk@pakl.net
  calendarsync run --date 2026-09-15
  calendarsync run --from 2026-09-15 --to 2026-09-20 --dry-run
`;

/** Convert an inclusive [from, to] date range (YYYY-MM-DD, local tz) to RFC3339 bounds. */
function dateRangeToBounds(from, to) {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(from) || !dateRe.test(to)) {
    throw new Error('Dates must be in YYYY-MM-DD format.');
  }
  const start = new Date(`${from}T00:00:00`); // parsed in local timezone
  const endExclusive = new Date(`${to}T00:00:00`);
  endExclusive.setDate(endExclusive.getDate() + 1); // make the range inclusive of `to`
  if (isNaN(start) || isNaN(endExclusive)) throw new Error('Invalid date.');
  if (endExclusive <= start) throw new Error('--to must not be before --from.');
  return { timeMin: start.toISOString(), timeMax: endExclusive.toISOString() };
}

async function cmdAuth(rest) {
  if (rest[0] === '--all') {
    const force = rest.includes('--force');
    const cfg = loadConfig();
    for (const account of accountsInConfig(cfg)) {
      if (hasToken(account) && !force) {
        console.log(`${account}: already authorized (skip). Use --all --force to re-auth.`);
        continue;
      }
      await authorizeAccount(account);
    }
    return;
  }
  const account = rest[0];
  if (!account) throw new Error('Usage: calendarsync auth <account-email> | --all [--force]');
  await authorizeAccount(account);
}

async function cmdListCalendars(rest) {
  const account = rest[0];
  if (!account) throw new Error('Usage: calendarsync list-calendars <account-email>');
  const cal = calendarFor(account);
  const res = await cal.calendarList.list({ maxResults: 250 });
  const items = res.data.items || [];
  console.log(`Calendars visible to ${account}:\n`);
  for (const c of items) {
    console.log(`  ${c.id}`);
    console.log(`      ${c.summary}${c.primary ? '  [primary]' : ''}  (${c.accessRole})`);
  }
}

async function cmdRun(rest) {
  const { values } = parseArgs({
    args: rest,
    options: {
      date: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  let from, to;
  if (values.date) {
    from = to = values.date;
  } else if (values.from && values.to) {
    from = values.from;
    to = values.to;
  } else {
    throw new Error('Provide --date YYYY-MM-DD, or both --from and --to.');
  }

  const { timeMin, timeMax } = dateRangeToBounds(from, to);
  const cfg = loadConfig();

  console.log(
    `Syncing ${from}${from === to ? '' : ` → ${to}`}` +
      `${values['dry-run'] ? '  (dry run)' : ''}`
  );
  console.log(`  window: ${timeMin} .. ${timeMax}`);

  const opts = { dryRun: values['dry-run'] };
  const results = [];
  if (cfg.target) {
    console.log(`\nCopy → ${cfg.target.account}/${cfg.target.calendarId}`);
    results.push(['copy', await runSync(cfg, timeMin, timeMax, opts)]);
  }
  if (cfg.busy) {
    console.log(`\nBusy blocks across ${cfg.busy.calendars.length} calendars`);
    results.push(['busy', await runBusySync(cfg, timeMin, timeMax, opts)]);
  }

  console.log('\nDone.');
  for (const [name, stats] of results) {
    console.log(
      `  ${name}: inserted=${stats.inserted} updated=${stats.updated} ` +
        `deleted=${stats.deleted} unchanged=${stats.unchanged} errors=${stats.errors}`
    );
    if (stats.errors > 0) process.exitCode = 1;
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'auth':
      return cmdAuth(rest);
    case 'list-calendars':
      return cmdListCalendars(rest);
    case 'run':
      return cmdRun(rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.log(USAGE);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exitCode = 1;
});
