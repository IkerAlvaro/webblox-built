FROM oven/bun:1.4.4

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Fetch Roblox's engine in its own cached layer so source edits don't redownload it.
COPY scripts/fetch-webblox.mjs ./scripts/fetch-webblox.mjs
RUN bun scripts/fetch-webblox.mjs

COPY . .
RUN bun run build:proxy

ENV HOST=0.0.0.0
EXPOSE 10000
CMD ["bun", "run", "start"]
