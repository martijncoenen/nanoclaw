/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Google Workspace token refresh:
 *   POST /google/token — containers send placeholder credentials here;
 *   proxy substitutes real gws credentials before forwarding to Google.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { decryptGwsCredentials } from './gws-auth.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

let gwsTokenCache: { token: string; expiresAt: number } | null = null;
const GWS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

function fetchGoogleToken(): Promise<string> {
  const creds = decryptGwsCredentials();
  if (!creds) return Promise.resolve('');

  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
  }).toString();

  return new Promise((resolve) => {
    const upstream = httpsRequest(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (upRes) => {
        const chunks: Buffer[] = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            const token: string = data.access_token ?? '';
            const expiresIn: number = data.expires_in ?? 3600;
            if (token) {
              gwsTokenCache = {
                token,
                expiresAt: Date.now() + expiresIn * 1000,
              };
            }
            resolve(token);
          } catch {
            resolve('');
          }
        });
      },
    );
    upstream.on('error', (err) => {
      logger.error({ err }, 'Google token refresh upstream error');
      resolve('');
    });
    upstream.write(body);
    upstream.end();
  });
}

/**
 * GET /google/token — returns a cached Google OAuth access token as plain text,
 * refreshing from Google when the token is missing or within 5 min of expiry.
 * Called by the gws wrapper script inside containers before each gws invocation.
 */
async function handleGoogleToken(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!decryptGwsCredentials()) {
    res.writeHead(503);
    res.end('');
    return;
  }

  const needsRefresh =
    !gwsTokenCache ||
    gwsTokenCache.expiresAt - Date.now() < GWS_TOKEN_REFRESH_MARGIN_MS;

  const token = needsRefresh ? await fetchGoogleToken() : gwsTokenCache!.token;

  res.writeHead(token ? 200 : 502, { 'Content-Type': 'text/plain' });
  res.end(token);
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        // Google token endpoint — gws wrapper fetches a fresh access token here.
        if (req.method === 'GET' && req.url === '/google/token') {
          handleGoogleToken(req, res).catch((err) =>
            logger.error({ err }, 'Google token handler error'),
          );
          return;
        }

        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
