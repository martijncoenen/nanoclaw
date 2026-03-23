---
name: gws
description: Read Gmail and Google Calendar using the gws CLI. Use when the user asks about emails, inbox, messages, calendar events, schedule, or agenda.
allowed-tools: Bash(gws:*)
---

# Google Workspace with gws

You have read-only access to Gmail and Google Calendar via the `gws` CLI. Auth is handled automatically — no setup needed.

## Gmail

```bash
gws gmail +triage                          # Unread inbox summary (sender, subject, date)
gws gmail +read --id <message-id>          # Read a specific email
gws gmail users messages list \
  --q "from:someone@example.com" \
  --max-results 10                         # Search emails
```

## Calendar

```bash
gws calendar +agenda                       # Today's agenda
gws calendar users events list \
  --calendar-id primary \
  --time-min $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --max-results 10 \
  --order-by startTime \
  --single-events true                     # Upcoming events
```

## Notes

- Access is **read-only** — you cannot send email or modify calendar events
- Output is JSON by default; add `--format table` for readable output
- If `gws` returns an auth error, tell the user to re-run `/add-gws` to re-authenticate
