---
name: add-gws
description: Add Google Workspace CLI (gws) to NanoClaw. Gives the Butler read-only access to Gmail and Google Calendar via short-lived OAuth tokens injected at container start — no credentials stored in containers.
---

# Add Google Workspace CLI

This skill adds `gws` (Google Workspace CLI) support to NanoClaw. The host fetches a fresh OAuth access token before each container run and injects it as `GOOGLE_WORKSPACE_CLI_TOKEN`. The container agent can then call `gws` directly to read Gmail and Google Calendar.

## Phase 1: Pre-flight

Check if already applied:

```bash
grep -q "getGoogleWorkspaceToken" src/container-runner.ts && echo "already applied"
```

If already applied, skip to Phase 3 (Setup).

## Phase 2: Apply Code Changes

### 1. Update the Dockerfile

In `container/Dockerfile`, add `@googleworkspace/cli` to the global npm install line:

```
# Install agent-browser, claude-code, and gws (Google Workspace CLI)
RUN npm install -g agent-browser @anthropic-ai/claude-code @googleworkspace/cli
```

### 2. Update container-runner.ts

Add `import { request as httpsRequest } from 'https';` and `import os from 'os';` to the imports.

Add the following function before `buildContainerArgs`:

```typescript
/**
 * Get a short-lived Google OAuth access token by decrypting gws credentials
 * and exchanging the refresh token. Returns null if gws is not configured.
 */
async function getGoogleWorkspaceToken(): Promise<string | null> {
  const gwsDir = path.join(os.homedir(), '.config/gws');
  const encFile = path.join(gwsDir, 'credentials.enc');
  const keyFile = path.join(gwsDir, '.encryption_key');
  if (!fs.existsSync(encFile) || !fs.existsSync(keyFile)) return null;

  let creds: { client_id: string; client_secret: string; refresh_token: string };
  try {
    const { createDecipheriv } = await import('crypto');
    const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
    const enc = fs.readFileSync(encFile);
    const iv = enc.subarray(0, 12);
    const authTag = enc.subarray(-16);
    const ciphertext = enc.subarray(12, -16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    creds = JSON.parse(decrypted.toString());
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    const body = JSON.stringify({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    });
    const req = httpsRequest(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve(data.access_token ?? null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}
```

In `buildContainerArgs`, add `googleToken?: string` as a third parameter, and inject it after the existing auth env vars:

```typescript
if (googleToken) {
  args.push('-e', `GOOGLE_WORKSPACE_CLI_TOKEN=${googleToken}`);
}
```

In `runContainerAgent`, fetch the token before building container args:

```typescript
const googleToken = await getGoogleWorkspaceToken() ?? undefined;
const containerArgs = buildContainerArgs(mounts, containerName, googleToken);
```

### 3. Validate

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

Rebuild the container (gws was added to the image):

```bash
cd container && ./build.sh
```

Build and restart:

```bash
npm run build
systemctl --user restart nanoclaw  # Linux
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 5: Verify

Ask the user to send their Butler: `check my recent emails` or `what's on my calendar today?`

## Troubleshooting

**Butler says auth is not set up:**
- Verify `~/.config/gws/credentials.enc` and `~/.config/gws/.encryption_key` both exist
- Test token exchange: `GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file ~/.local/bin/gws gmail +triage`
- Check nanoclaw logs: `tail -20 logs/nanoclaw.log`

**`gws auth export` shows redacted secrets:**
This is expected — `gws auth export` always redacts client_secret and refresh_token for display. The skill decrypts `credentials.enc` directly using `crypto.createDecipheriv('aes-256-gcm')`.

**OAuth token expired:**
Re-authenticate:
```bash
rm ~/.config/gws/credentials.enc ~/.config/gws/.encryption_key
~/.local/bin/gws auth login --readonly -s gmail,calendar
```
