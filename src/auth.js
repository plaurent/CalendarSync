import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { OAuth2Client } from 'google-auth-library';
import { CREDENTIALS_PATH, TOKENS_DIR } from './config.js';

// Read + write access to calendar events, and read access to the calendar list.
export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];

function tokenPath(account) {
  // Sanitize the account email into a safe filename.
  const safe = account.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(TOKENS_DIR, `${safe}.json`);
}

/** Load the OAuth client id/secret downloaded from Google Cloud. */
function loadClientSecret() {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Missing ${CREDENTIALS_PATH}. Download an OAuth "Desktop app" client secret from ` +
        `Google Cloud Console and save it there. See README.md.`
    );
  }
  const parsed = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
  const key = parsed.installed || parsed.web;
  if (!key?.client_id || !key?.client_secret) {
    throw new Error('credentials.json does not look like an OAuth client secret file.');
  }
  return { clientId: key.client_id, clientSecret: key.client_secret };
}

/** Best-effort open of a URL in the user's default browser. */
function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {
    /* fall back to printing the URL */
  }
}

/**
 * Run the interactive loopback OAuth flow for one account and persist its
 * refresh token to tokens/<account>.json.
 */
export async function authorizeAccount(account) {
  const { clientId, clientSecret } = loadClientSecret();

  // Bind a throwaway loopback server on a random free port to catch the redirect.
  const { server, port } = await new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
  const redirectUri = `http://127.0.0.1:${port}`;

  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const authUrl = client.generateAuthUrl({
    access_type: 'offline', // request a refresh token
    prompt: 'consent', // force refresh_token even on re-auth
    scope: SCOPES,
    login_hint: account, // pre-fill the account chooser
  });

  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for authorization (5 min).'));
    }, 5 * 60 * 1000);

    server.on('request', (req, res) => {
      const url = new URL(req.url, redirectUri);
      const err = url.searchParams.get('error');
      const authCode = url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<html><body style="font-family:sans-serif;padding:2rem">` +
          `<h2>${err ? 'Authorization failed' : 'Authorized ✓'}</h2>` +
          `<p>You can close this tab and return to the terminal.</p></body></html>`
      );
      clearTimeout(timeout);
      server.close();
      if (err) reject(new Error(`Authorization error: ${err}`));
      else if (authCode) resolve(authCode);
      else reject(new Error('No authorization code returned.'));
    });

    console.log(`\nAuthorizing account: ${account}`);
    console.log('Opening browser. If it does not open, visit this URL:\n');
    console.log(authUrl + '\n');
    openBrowser(authUrl);
  });

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Revoke prior access at ' +
        'https://myaccount.google.com/permissions and retry.'
    );
  }

  mkdirSync(TOKENS_DIR, { recursive: true });
  writeFileSync(tokenPath(account), JSON.stringify(tokens, null, 2));
  console.log(`Saved token for ${account}.`);
}

/**
 * Return an authenticated OAuth2Client for an account, refreshing and
 * re-persisting the access token as needed.
 */
export function getClient(account) {
  const p = tokenPath(account);
  if (!existsSync(p)) {
    throw new Error(`No stored token for "${account}". Run: calendarsync auth ${account}`);
  }
  const { clientId, clientSecret } = loadClientSecret();
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials(JSON.parse(readFileSync(p, 'utf8')));

  // Persist rotated/refreshed tokens so the refresh token survives.
  client.on('tokens', (t) => {
    const current = JSON.parse(readFileSync(p, 'utf8'));
    writeFileSync(p, JSON.stringify({ ...current, ...t }, null, 2));
  });

  return client;
}

export function hasToken(account) {
  return existsSync(tokenPath(account));
}
