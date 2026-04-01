---
name: add-gws
description: Add Google Workspace CLI (gws) to NanoClaw. Gives the Butler read-only access to Gmail and Google Calendar. Tokens are refreshed every 50 minutes via a background job that pushes fresh access tokens to OneCLI — no credentials stored in containers.
---

# Add Google Workspace CLI

This skill adds `gws` (Google Workspace CLI) support to NanoClaw.

**How it works:** NanoClaw runs a background token refresher that fetches a fresh Google OAuth access token every 50 minutes and pushes it to OneCLI via `PATCH /api/secrets/{id}`. The OneCLI gateway intercepts outbound requests to `*.googleapis.com` and injects the current Bearer token. Containers receive `GOOGLE_WORKSPACE_CLI_TOKEN=placeholder` — they never see the real token.

**Prerequisites:** OneCLI must be installed and running (`/init-onecli`).

## Phase 1: Pre-flight

Check if gws is already configured:

```bash
grep -q "GWS_ONECLI_SECRET_ID" .env && echo "already configured"
```

If already configured, check if re-authentication is needed:

```bash
gws auth status 2>/dev/null | grep token_valid
```

If `token_valid: true`, GWS is working — nothing to do. If `token_valid: false`, skip to Phase 4 (re-authenticate).

Check OneCLI is running:

```bash
curl -sf http://127.0.0.1:10254/api/health
```

If not healthy, run `/init-onecli` first.

## Phase 2: Install gws

Check if gws is already installed on the host:

```bash
gws --version 2>/dev/null || ~/.local/bin/gws --version 2>/dev/null
```

If not installed:

```bash
npm install -g @googleworkspace/cli --prefix ~/.local
export PATH="$HOME/.local/bin:$PATH"
```

Add to shell profile if needed:
```bash
grep -q '.local/bin' ~/.bashrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

## Phase 3: GCP OAuth credentials

Check if credentials already exist:

```bash
ls ~/.config/gws/client_secret.json 2>/dev/null && echo "exists"
```

If missing, tell the user:

> I need you to set up Google Cloud OAuth credentials:
>
> 1. Open https://console.cloud.google.com — create a new project or select existing
> 2. Go to **APIs & Services > Library** — enable **Gmail API** and **Google Calendar API**
> 3. Go to **APIs & Services > OAuth consent screen** — choose External, fill in app name + email, add yourself as a test user
> 4. Go to **APIs & Services > Credentials > + CREATE CREDENTIALS > OAuth client ID**
>    - Application type: **Desktop app**, name anything (e.g. "NanoClaw gws")
> 5. Click **DOWNLOAD JSON** and paste the contents here

Save the JSON:
```bash
mkdir -p ~/.config/gws
# write the JSON to ~/.config/gws/client_secret.json
```

## Phase 4: Authenticate

Run the auth flow:

```bash
gws auth login --readonly -s gmail,calendar
```

This prints a URL. On a remote machine the browser redirect will fail — tell the user to open the URL, authorize, then copy the resulting `http://localhost:PORT/?code=...` URL and paste it here. Then complete the flow:

```bash
curl -s "<the localhost URL the user pasted>"
```

Verify:

```bash
gws auth status 2>/dev/null | grep -E "(user|token_valid)"
```

## Phase 5: Create OneCLI secret

Get a fresh access token using the stored credentials:

```bash
node -e "
import('./dist/gws-auth.js').then(async ({ decryptGwsCredentials }) => {
  const creds = decryptGwsCredentials();
  const body = new URLSearchParams({
    client_id: creds.client_id, client_secret: creds.client_secret,
    refresh_token: creds.refresh_token, grant_type: 'refresh_token',
  }).toString();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const data = await res.json();
  console.log(data.access_token);
})" --input-type=module
```

Create the OneCLI secret (local OneCLI requires no API key):

```bash
onecli secrets create \
  --name "Google Workspace" \
  --type generic \
  --value "<access_token>" \
  --host-pattern "*.googleapis.com" \
  --header-name "Authorization" \
  --value-format "Bearer {value}"
```

Note the `id` from the output.

## Phase 6: Configure .env

Add the secret ID to `.env` using the Edit tool:

```
GWS_ONECLI_SECRET_ID=<secret-id-from-above>
```

`GWS_ONECLI_SECRET_ID` tells the refresher which OneCLI secret to PATCH with fresh tokens. No `ONECLI_API_KEY` needed — local OneCLI is unauthenticated.

## Phase 7: Restart

```bash
npm run build
systemctl --user restart nanoclaw  # Linux
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Check that the refresher started:

```bash
sleep 3 && grep "GWS token refresher" logs/nanoclaw.log | tail -2
```

Expected: `GWS token refresher started`

## Phase 8: Verify

Ask the user to send their Butler: `check my recent emails` or `what's on my calendar today?`

The token refreshes every 50 minutes automatically. No container rebuild needed — the gws binary is already in the image and OneCLI handles token injection at the network layer.

## Troubleshooting

**"auth expired" / token_valid: false:**
Re-run Phase 4 (re-authenticate). This happens when the OAuth refresh token has expired from disuse.

**Butler says gws auth not set up / invalid_client:**
- Verify `~/.config/gws/credentials.enc` exists: `ls ~/.config/gws/`
- Check refresher is running: `grep "GWS token" logs/nanoclaw.log | tail -3`
- Verify OneCLI secret exists: `onecli secrets list`

**GLIBC version error in container:**
The `@googleworkspace/cli` binary requires glibc ≥ 2.39. Switch the container base image to `node:22-trixie-slim` (Debian 13, glibc 2.41) in `container/Dockerfile` and rebuild.

**Token not refreshing:**
Check `GWS_ONECLI_SECRET_ID` is set in `.env` and matches the secret ID from `onecli secrets list`.
