# Claude Code agent for a hosted agent VM, governed by Guardian.
# The Agent SDK ships the Claude Code CLI as a platform-specific package,
# so npm install runs inside this Linux build.
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./

ENV NODE_ENV=production \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Exec form: some micro-VM inits do not run shell-form commands.
CMD ["node", "server.mjs"]
