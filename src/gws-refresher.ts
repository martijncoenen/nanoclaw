/**
 * GWS token refresher for OneCLI integration.
 * Periodically fetches a fresh Google OAuth access token and pushes it
 * to the OneCLI secret store so the gateway can inject it into containers.
 */
import { request as httpsRequest } from 'https';

import { GWS_ONECLI_SECRET_ID, ONECLI_URL } from './config.js';
import { decryptGwsCredentials } from './gws-auth.js';
import { logger } from './logger.js';

const REFRESH_INTERVAL_MS = 50 * 60 * 1000; // 50 minutes

function fetchGwsAccessToken(): Promise<string | null> {
  const creds = decryptGwsCredentials();
  if (!creds) return Promise.resolve(null);

  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
  }).toString();

  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString();
            const data = JSON.parse(raw);
            if (!data.access_token) {
              logger.warn(
                { googleError: raw },
                'GWS token refresh: Google returned no access_token',
              );
            }
            resolve(data.access_token ?? null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', (err) => {
      logger.error({ err }, 'GWS token refresh: Google request failed');
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

async function pushTokenToOneCLI(token: string): Promise<void> {
  const url = new URL(`/api/secrets/${GWS_ONECLI_SECRET_ID}`, ONECLI_URL);
  const body = JSON.stringify({ value: token });

  const makeRequest =
    url.protocol === 'https:' ? httpsRequest : (await import('http')).request;

  return new Promise((resolve) => {
    const req = makeRequest(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode !== 200) {
          logger.warn(
            { status: res.statusCode },
            'GWS token refresh: OneCLI PATCH returned non-200',
          );
        }
        resolve();
      },
    );
    req.on('error', (err) => {
      logger.error({ err }, 'GWS token refresh: OneCLI request failed');
      resolve();
    });
    req.write(body);
    req.end();
  });
}

async function refresh(): Promise<void> {
  const token = await fetchGwsAccessToken();
  if (!token) {
    logger.warn('GWS token refresh: failed to fetch access token from Google');
    return;
  }
  await pushTokenToOneCLI(token);
  logger.debug('GWS token refreshed and pushed to OneCLI');
}

export function startGwsTokenRefresher(): void {
  if (!decryptGwsCredentials()) return; // GWS not configured on this host

  if (!GWS_ONECLI_SECRET_ID) {
    logger.warn(
      'GWS is configured but GWS_ONECLI_SECRET_ID is missing — token refresh disabled',
    );
    return;
  }

  // Refresh immediately so the token is ready before the first container starts
  refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);
  logger.info('GWS token refresher started');
}
