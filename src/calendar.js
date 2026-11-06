import { createHash } from 'node:crypto';
import { google } from 'googleapis';
import { getClient } from './auth.js';

/** Marker written into every copied event so we can find/manage them later. */
export const SYNC_APP_TAG = 'calendarsync';

/** Marker written into every "Busy" block (kept separate from full copies). */
export const BUSY_APP_TAG = 'calendarsync-busy';

/** Build a googleapis calendar client for an account. */
export function calendarFor(account) {
  return google.calendar({ version: 'v3', auth: getClient(account) });
}

/**
 * Stable key identifying a single source event instance across syncs.
 * Includes the account so two calendars named "primary" never collide.
 */
export function syncKeyFor(account, calendarId, eventId) {
  return `${account}::${calendarId}::${eventId}`;
}

/**
 * List every event in [timeMin, timeMax) for a calendar, expanding recurring
 * events into individual instances. Handles pagination.
 */
export async function listEvents(cal, calendarId, timeMin, timeMax, extraParams = {}) {
  const events = [];
  let pageToken;
  do {
    const res = await cal.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      showDeleted: false,
      maxResults: 2500,
      pageToken,
      ...extraParams,
    });
    events.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return events;
}

/**
 * Map a source event to the body we write on the target.
 * Copies full details but deliberately omits attendees, organizer, and
 * reminders so the copy never sends invitations or notifications.
 */
export function buildCopyBody(sourceEvent, { account, calendarId }) {
  return {
    summary: sourceEvent.summary || '(no title)',
    description: sourceEvent.description,
    location: sourceEvent.location,
    start: sourceEvent.start,
    end: sourceEvent.end,
    transparency: sourceEvent.transparency,
    visibility: sourceEvent.visibility,
    colorId: sourceEvent.colorId,
    // Suppress notifications on the copy.
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: {
      private: {
        syncApp: SYNC_APP_TAG,
        syncKey: syncKeyFor(account, calendarId, sourceEvent.id),
        sourceAccount: account,
        sourceCalendarId: calendarId,
        sourceEventId: sourceEvent.id,
        // Used to detect changes on later syncs.
        sourceUpdated: sourceEvent.updated || '',
      },
    },
  };
}

/** Fetch all previously-synced copies on the target within the date range. */
export async function listSyncedCopies(cal, calendarId, timeMin, timeMax) {
  return listEvents(cal, calendarId, timeMin, timeMax, {
    privateExtendedProperty: `syncApp=${SYNC_APP_TAG}`,
  });
}

/**
 * True for events this tool wrote (full copies or Busy blocks). These are
 * never treated as sources, so syncs can't feed back into each other.
 */
export function isSyncCreated(ev) {
  const app = ev.extendedProperties?.private?.syncApp;
  return app === SYNC_APP_TAG || app === BUSY_APP_TAG;
}

/**
 * Whether an event should block time on the user's other calendars. Skips
 * events marked "Free", invitations the user declined, and Google's
 * working-location / birthday entries.
 */
export function blocksTime(ev) {
  if (ev.status === 'cancelled') return false;
  if (ev.transparency === 'transparent') return false;
  if (ev.eventType === 'workingLocation' || ev.eventType === 'birthday') return false;
  const self = ev.attendees?.find((a) => a.self);
  return self?.responseStatus !== 'declined';
}

/**
 * Identifies a meeting occurrence across calendars: the same invite received
 * on two accounts shares an iCalUID, and recurring instances differ by start.
 */
export function occurrenceKey(ev) {
  const start = ev.start?.dateTime ? String(Date.parse(ev.start.dateTime)) : ev.start?.date;
  return `${ev.iCalUID || ev.id}::${start}`;
}

/**
 * Map a source event to a "Busy" block for another calendar: same times, but
 * no title, description, location, or attendees. The source is recorded only
 * as a hash, so people who can read this calendar can't see which other
 * account or event it came from.
 */
export function buildBusyBody(sourceEvent, { account, calendarId }, title) {
  return {
    summary: title,
    start: sourceEvent.start,
    end: sourceEvent.end,
    transparency: 'opaque',
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: {
      private: {
        syncApp: BUSY_APP_TAG,
        syncKey: busyKeyFor(account, calendarId, sourceEvent.id),
        sourceUpdated: sourceEvent.updated || '',
      },
    },
  };
}

export function busyKeyFor(account, calendarId, eventId) {
  return createHash('sha256')
    .update(syncKeyFor(account, calendarId, eventId))
    .digest('hex')
    .slice(0, 32);
}
