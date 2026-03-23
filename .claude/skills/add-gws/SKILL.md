---
name: add-gws
description: Add Google Workspace CLI (gws) to NanoClaw. Gives the Butler read-only access to Gmail and Google Calendar. Tokens are refreshed on every gws call via the credential proxy — no credentials stored in containers.
---

# Add Google Workspace CLI

This skill adds `gws` (Google Workspace CLI) support to NanoClaw.

**How it works:** The container runs a `gws` wrapper script that fetches a fresh OAuth access token from the credential proxy before each `gws` call. The proxy decrypts credentials on the host and exchanges the refresh token with Google. The container never sees the refresh token or client secret.

## Phase 1: Pre-flight

Check if already applied:

```bash
grep -q "isGwsConfigured" src/container-runner.ts && echo "already applied"
```

If already applied, skip to Phase 3 (Setup).

## Phase 2: Apply Code Changes

### 1. Create `src/gws-auth.ts`

```typescript
import { createDecipheriv } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface GwsCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

/**
 * Decrypt gws credentials from ~/.config/gws/credentials.enc using the
 * AES-256-GCM key stored in ~/.config/gws/.encryption_key.
 * Returns null if gws is not configured.
 */
export function decryptGwsCredentials(): GwsCredentials | null {
  const gwsDir = path.join(os.homedir(), '.config/gws');
  const encFile = path.join(gwsDir, 'credentials.enc');
  const keyFile = path.join(gwsDir, '.encryption_key');
  if (!fs.existsSync(encFile) || !fs.existsSync(keyFile)) return null;

  try {
    const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
    const enc = fs.readFileSync(encFile);
    const iv = enc.subarray(0, 12);
    const authTag = enc.subarray(-16);
    const ciphertext = enc.subarray(12, -16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString());
  } catch {
    return null;
  }
}
```

### 2. Update `src/credential-proxy.ts`

Add to the imports:
```typescript
import { IncomingMessage, ServerResponse } from 'http';  // add to existing http import
import { decryptGwsCredentials } from './gws-auth.js';
```

Add this function before `startCredentialProxy`:

```typescript
/**
 * GET /google/token — returns a fresh Google OAuth access token as plain text.
 * Called by the gws wrapper script inside containers before each gws invocation.
 */
function handleGoogleToken(_req: IncomingMessage, res: ServerResponse): void {
  const creds = decryptGwsCredentials();
  if (!creds) { res.writeHead(503); res.end(''); return; }

  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
  }).toString();

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
          const token = data.access_token ?? '';
          res.writeHead(token ? 200 : 502, { 'Content-Type': 'text/plain' });
          res.end(token);
        } catch {
          res.writeHead(502); res.end('');
        }
      });
    },
  );
  upstream.on('error', (err) => {
    logger.error({ err }, 'Google token refresh upstream error');
    if (!res.headersSent) { res.writeHead(502); res.end(''); }
  });
  upstream.write(body);
  upstream.end();
}
```

Inside the `createServer` handler, add the route before the Anthropic proxy logic:

```typescript
if (req.method === 'GET' && req.url === '/google/token') {
  handleGoogleToken(req, res);
  return;
}
```

### 3. Update `src/container-runner.ts`

Add to imports:
```typescript
import { decryptGwsCredentials } from './gws-auth.js';
```

Add before `buildContainerArgs`:
```typescript
/** Returns true if gws credentials are present on this host. */
function isGwsConfigured(): boolean {
  return decryptGwsCredentials() !== null;
}
```

Add `gwsConfigured?: boolean` as a third parameter to `buildContainerArgs`, and inject the token URL after the existing auth env vars:

```typescript
if (gwsConfigured) {
  args.push(
    '-e',
    `GWS_TOKEN_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}/google/token`,
  );
}
```

In `runContainerAgent`, pass the flag:

```typescript
const containerArgs = buildContainerArgs(mounts, containerName, isGwsConfigured());
```

### 4. Update `container/Dockerfile`

Add `@googleworkspace/cli` to the global npm install, then add a wrapper step:

```dockerfile
# Install agent-browser, claude-code, and gws (Google Workspace CLI)
RUN npm install -g agent-browser @anthropic-ai/claude-code @googleworkspace/cli

# Wrap gws so it fetches a fresh token from the credential proxy before each call.
# GWS_TOKEN_URL is injected at container start when gws is configured on the host.
RUN gws_target=$(node -e "console.log(require('fs').realpathSync('/usr/local/bin/gws'))") \
 && mv "$gws_target" "$(dirname "$gws_target")/gws-bin" \
 && rm /usr/local/bin/gws \
 && ln -s "$(dirname "$gws_target")/gws-bin" /usr/local/bin/gws-bin \
 && printf '#!/bin/sh\nif [ -n "$GWS_TOKEN_URL" ]; then\n  TOKEN=$(curl -sf "$GWS_TOKEN_URL")\n  [ -n "$TOKEN" ] && exec env GOOGLE_WORKSPACE_CLI_TOKEN="$TOKEN" /usr/local/bin/gws-bin "$@"\nfi\nexec /usr/local/bin/gws-bin "$@"\n' > /usr/local/bin/gws \
 && chmod +x /usr/local/bin/gws
```

### 5. Validate

```bash
npm run build
```

## Phase 3: Setup

### Install gws

```bash
npm install -g @googleworkspace/cli --prefix ~/.local
```

Verify:

```bash
~/.local/bin/gws --version
```

### GCP OAuth credentials

Tell the user:

> I need you to set up Google Cloud OAuth credentials:
>
> 1. Open https://console.cloud.google.com — create a new project or select existing
> 2. Go to **APIs & Services > Library** — enable **Gmail API** and **Google Calendar API**
> 3. Go to **APIs & Services > OAuth consent screen** — choose External, fill in app name + email, add yourself as a test user
> 4. Go to **APIs & Services > Credentials > + CREATE CREDENTIALS > OAuth client ID**
>    - Application type: **Desktop app**, name anything (e.g. "NanoClaw gws")
> 5. Click **DOWNLOAD JSON** and paste the contents here

Save the JSON to `~/.config/gws/client_secret.json`:

```bash
mkdir -p ~/.config/gws
# write the JSON the user provided to ~/.config/gws/client_secret.json
```

### Authenticate

Run the auth flow with readonly scopes:

```bash
~/.local/bin/gws auth login --readonly -s gmail,calendar
```

This opens a browser. On a remote machine the browser redirect will fail — the user should copy the resulting `http://localhost:PORT/?...` URL and tell you. Then complete the flow with:

```bash
curl -s "<the localhost URL the user pasted>"
```

Verify:

```bash
GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file ~/.local/bin/gws auth status 2>/dev/null | grep -E "(user|scopes|token_valid)"
```

## Phase 4: Rebuild and Restart

```bash
cd container && ./build.sh
npm run build
systemctl --user restart nanoclaw  # Linux
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 5: Verify

Ask the user to send their Butler: `check my recent emails` or `what's on my calendar today?`

## Troubleshooting

**Butler says auth is not set up / invalid_client:**
- Verify `~/.config/gws/credentials.enc` and `~/.config/gws/.encryption_key` both exist
- Test the proxy endpoint from the host: `curl -s http://127.0.0.1:<CREDENTIAL_PROXY_PORT>/google/token`
- Check nanoclaw logs: `tail -20 logs/nanoclaw.log`

**`gws auth export` shows redacted secrets:**
This is expected — `gws auth export` always redacts `client_secret` and `refresh_token`. The skill decrypts `credentials.enc` directly using `crypto.createDecipheriv('aes-256-gcm')`.

**OAuth token expired / re-authenticate:**
```bash
rm ~/.config/gws/credentials.enc ~/.config/gws/.encryption_key
~/.local/bin/gws auth login --readonly -s gmail,calendar
```
