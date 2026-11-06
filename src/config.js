import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the project root (one level above src/). */
export const ROOT = join(__dirname, '..');

/** Path to the OAuth client secret downloaded from Google Cloud. */
export const CREDENTIALS_PATH = join(ROOT, 'credentials.json');

/** Directory where per-account refresh tokens are cached. */
export const TOKENS_DIR = join(ROOT, 'tokens');

const CONFIG_PATH = join(ROOT, 'config.json');

/**
 * Load and validate config.json. Either section may be omitted, but not both.
 * @returns {{target?: {account: string, calendarId: string},
 *            sources?: Array<{account: string, calendarId: string}>,
 *            busy?: {calendars: Array<{account: string, calendarId: string}>,
 *                    title?: string}}}
 */
export function loadConfig() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    throw new Error(
      `Could not read ${CONFIG_PATH}. Copy config.example.json to config.json and edit it.`
    );
  }

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }

  if (!cfg.target && !cfg.sources && !cfg.busy) {
    throw new Error('config.json: configure "target" + "sources", "busy", or both.');
  }

  if (cfg.target || cfg.sources) {
    if (!cfg.target?.account || !cfg.target?.calendarId) {
      throw new Error('config.json: "target" must have "account" and "calendarId".');
    }
    if (!Array.isArray(cfg.sources) || cfg.sources.length === 0) {
      throw new Error('config.json: "sources" must be a non-empty array.');
    }
    cfg.sources.forEach((s, i) => {
      if (!s.account || !s.calendarId) {
        throw new Error(`config.json: sources[${i}] must have "account" and "calendarId".`);
      }
    });
  }

  if (cfg.busy) {
    const cals = cfg.busy.calendars;
    if (!Array.isArray(cals) || cals.length < 2) {
      throw new Error('config.json: "busy.calendars" must list at least two calendars.');
    }
    const seen = new Set();
    cals.forEach((c, i) => {
      if (!c.account || !c.calendarId) {
        throw new Error(`config.json: busy.calendars[${i}] must have "account" and "calendarId".`);
      }
      const id = `${c.account}/${c.calendarId}`;
      if (seen.has(id)) throw new Error(`config.json: busy.calendars lists ${id} twice.`);
      seen.add(id);
    });
    if (cfg.busy.title !== undefined && (typeof cfg.busy.title !== 'string' || !cfg.busy.title)) {
      throw new Error('config.json: "busy.title" must be a non-empty string.');
    }
  }

  return cfg;
}

/** Every distinct account referenced by the config (sources, target, busy). */
export function accountsInConfig(cfg) {
  const set = new Set([
    ...(cfg.sources || []).map((s) => s.account),
    ...(cfg.busy?.calendars || []).map((c) => c.account),
  ]);
  if (cfg.target) set.add(cfg.target.account);
  return [...set];
}
