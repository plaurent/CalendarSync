import {
  BUSY_APP_TAG,
  calendarFor,
  listEvents,
  listSyncedCopies,
  buildCopyBody,
  buildBusyBody,
  busyKeyFor,
  syncKeyFor,
  isSyncCreated,
  blocksTime,
  occurrenceKey,
} from './calendar.js';

/**
 * Full sync of all configured source calendars into the target calendar,
 * bounded to [timeMin, timeMax).
 *
 * - insert: source instance with no existing copy
 * - update: copy exists but the source's `updated` timestamp changed
 * - delete: copy whose source instance no longer exists in the range
 *
 * @param {object} cfg   loaded config
 * @param {string} timeMin RFC3339
 * @param {string} timeMax RFC3339
 * @param {{dryRun?: boolean}} opts
 */
export async function runSync(cfg, timeMin, timeMax, opts = {}) {
  const { dryRun = false } = opts;
  const stats = { inserted: 0, updated: 0, deleted: 0, unchanged: 0, errors: 0 };

  // 1. Gather every source instance, keyed by syncKey.
  const sourceByKey = new Map();
  for (const src of cfg.sources) {
    const cal = calendarFor(src.account);
    let items;
    try {
      items = await listEvents(cal, src.calendarId, timeMin, timeMax);
    } catch (err) {
      console.error(`  ! failed to read ${src.account}/${src.calendarId}: ${err.message}`);
      stats.errors++;
      continue;
    }
    for (const ev of items) {
      if (ev.status === 'cancelled') continue;
      if (isSyncCreated(ev)) continue; // e.g. a Busy block on a source calendar
      const key = syncKeyFor(src.account, src.calendarId, ev.id);
      sourceByKey.set(key, { ev, src });
    }
    console.log(`  read ${items.length} event(s) from ${src.account}/${src.calendarId}`);
  }

  // 2. Gather existing copies on the target, keyed by syncKey.
  const targetCal = calendarFor(cfg.target.account);
  const copies = await listSyncedCopies(
    targetCal,
    cfg.target.calendarId,
    timeMin,
    timeMax
  );
  const copyByKey = new Map();
  for (const c of copies) {
    const key = c.extendedProperties?.private?.syncKey;
    if (key) copyByKey.set(key, c);
  }
  console.log(
    `  found ${copyByKey.size} existing synced copy(ies) on ${cfg.target.account}/${cfg.target.calendarId}`
  );

  // 3. Insert or update from sources.
  for (const [key, { ev, src }] of sourceByKey) {
    const existing = copyByKey.get(key);
    const body = buildCopyBody(ev, src);

    if (!existing) {
      console.log(`  + insert: ${describe(ev)}`);
      if (!dryRun) {
        try {
          await targetCal.events.insert({
            calendarId: cfg.target.calendarId,
            requestBody: body,
            sendUpdates: 'none',
          });
        } catch (err) {
          console.error(`    ! insert failed: ${err.message}`);
          stats.errors++;
          continue;
        }
      }
      stats.inserted++;
    } else if (existing.extendedProperties?.private?.sourceUpdated !== (ev.updated || '')) {
      console.log(`  ~ update: ${describe(ev)}`);
      if (!dryRun) {
        try {
          await targetCal.events.update({
            calendarId: cfg.target.calendarId,
            eventId: existing.id,
            requestBody: body,
            sendUpdates: 'none',
          });
        } catch (err) {
          console.error(`    ! update failed: ${err.message}`);
          stats.errors++;
          continue;
        }
      }
      stats.updated++;
    } else {
      stats.unchanged++;
    }
  }

  // 4. Delete copies whose source instance is gone.
  for (const [key, copy] of copyByKey) {
    if (sourceByKey.has(key)) continue;
    console.log(`  - delete: ${describe(copy)}`);
    if (!dryRun) {
      try {
        await targetCal.events.delete({
          calendarId: cfg.target.calendarId,
          eventId: copy.id,
          sendUpdates: 'none',
        });
      } catch (err) {
        console.error(`    ! delete failed: ${err.message}`);
        stats.errors++;
        continue;
      }
    }
    stats.deleted++;
  }

  return stats;
}

/**
 * Keep "Busy" blocks in sync across the calendars in cfg.busy.calendars,
 * bounded to [timeMin, timeMax): each calendar gets a block for every busy
 * event on the others.
 *
 * - insert: busy event on another calendar with no block here yet
 * - update: block exists but the source's `updated` timestamp (or the
 *           configured title) changed
 * - delete: block whose source event is gone, declined, or marked Free
 *
 * If any calendar can't be read, deletions are skipped for that run so its
 * blocks elsewhere aren't mistaken for stale ones.
 *
 * @param {object} cfg   loaded config
 * @param {string} timeMin RFC3339
 * @param {string} timeMax RFC3339
 * @param {{dryRun?: boolean}} opts
 */
export async function runBusySync(cfg, timeMin, timeMax, opts = {}) {
  const { dryRun = false } = opts;
  const title = cfg.busy.title || 'Busy';
  const stats = { inserted: 0, updated: 0, deleted: 0, unchanged: 0, errors: 0 };

  // 1. Read each calendar once, splitting its own busy events from the
  //    blocks we previously put on it.
  const cals = [];
  let readFailed = false;
  for (const src of cfg.busy.calendars) {
    let api, items;
    try {
      api = calendarFor(src.account);
      items = await listEvents(api, src.calendarId, timeMin, timeMax);
    } catch (err) {
      console.error(`  ! failed to read ${src.account}/${src.calendarId}: ${err.message}`);
      stats.errors++;
      readFailed = true;
      continue;
    }
    const busy = [];
    const blocks = new Map();
    const duplicateBlocks = [];
    for (const ev of items) {
      if (ev.extendedProperties?.private?.syncApp === BUSY_APP_TAG) {
        const key = ev.extendedProperties.private.syncKey;
        if (blocks.has(key)) duplicateBlocks.push(ev);
        else blocks.set(key, ev);
      } else if (!isSyncCreated(ev) && blocksTime(ev)) {
        busy.push(ev);
      }
    }
    cals.push({ src, api, busy, blocks, duplicateBlocks });
    console.log(
      `  read ${busy.length} busy event(s), ${blocks.size} existing block(s) from ${src.account}/${src.calendarId}`
    );
  }
  if (readFailed) console.log('  (skipping deletions this run because a calendar could not be read)');

  // 2. Per calendar, diff the blocks it should have against the ones it has.
  for (const cal of cals) {
    const { account, calendarId } = cal.src;
    const where = `${account}/${calendarId}`;

    for (const [key, { ev, src }] of wantedBlocks(cal, cals, cfg)) {
      const existing = cal.blocks.get(key);
      cal.blocks.delete(key); // whatever is left afterwards is stale
      const body = buildBusyBody(ev, src, title);

      if (!existing) {
        console.log(`  + block on ${where}: ${describe(ev)}  [from ${src.account}]`);
        const ok = await write(dryRun, stats, 'insert', () =>
          cal.api.events.insert({ calendarId, requestBody: body, sendUpdates: 'none' })
        );
        if (ok) stats.inserted++;
      } else if (
        existing.summary !== title ||
        existing.extendedProperties.private.sourceUpdated !== (ev.updated || '')
      ) {
        console.log(`  ~ block on ${where}: ${describe(ev)}  [from ${src.account}]`);
        const ok = await write(dryRun, stats, 'update', () =>
          cal.api.events.update({
            calendarId,
            eventId: existing.id,
            requestBody: body,
            sendUpdates: 'none',
          })
        );
        if (ok) stats.updated++;
      } else {
        stats.unchanged++;
      }
    }

    const stale = [...(readFailed ? [] : cal.blocks.values()), ...cal.duplicateBlocks];
    for (const block of stale) {
      console.log(`  - block on ${where}: ${describe(block)}`);
      const ok = await write(dryRun, stats, 'delete', () =>
        cal.api.events.delete({ calendarId, eventId: block.id, sendUpdates: 'none' })
      );
      if (ok) stats.deleted++;
    }
  }

  return stats;
}

/**
 * The blocks a calendar should carry, as syncKey → { ev, src }: one per busy
 * event on every other calendar, except meetings this calendar already has
 * itself, or that an earlier calendar already contributed — so an invite
 * received on several accounts yields one block, not one per copy.
 *
 * If this calendar is the copy target, events from copy sources are skipped
 * too: it already has full copies of them.
 */
function wantedBlocks(target, cals, cfg) {
  const seen = new Set(target.busy.map(occurrenceKey));
  for (const other of cals) {
    if (other !== target && copiedInto(cfg, target.src, other.src)) {
      for (const ev of other.busy) seen.add(occurrenceKey(ev));
    }
  }
  const wanted = new Map();
  for (const other of cals) {
    if (other === target) continue;
    for (const ev of other.busy) {
      const occurrence = occurrenceKey(ev);
      if (seen.has(occurrence)) continue;
      seen.add(occurrence);
      const { account, calendarId } = other.src;
      wanted.set(busyKeyFor(account, calendarId, ev.id), { ev, src: other.src });
    }
  }
  return wanted;
}

/** True when the copy sync puts full copies of `from`'s events onto `to`. */
function copiedInto(cfg, to, from) {
  const same = (a, b) => a.account === b.account && a.calendarId === b.calendarId;
  return !!cfg.target && same(cfg.target, to) && cfg.sources.some((s) => same(s, from));
}

/** Run one API write (skipped on dry run), logging and counting failures. */
async function write(dryRun, stats, what, fn) {
  if (dryRun) return true;
  try {
    await fn();
    return true;
  } catch (err) {
    console.error(`    ! ${what} failed: ${err.message}`);
    stats.errors++;
    return false;
  }
}

function describe(ev) {
  const when = ev.start?.dateTime || ev.start?.date || '?';
  return `${ev.summary || '(no title)'} @ ${when}`;
}
