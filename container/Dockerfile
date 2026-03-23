# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

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

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
