FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 make g++ ca-certificates tini && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/knowledge/package.json packages/knowledge/package.json
COPY packages/knowledge-db/package.json packages/knowledge-db/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/knowledge-worker/package.json apps/knowledge-worker/package.json
COPY apps/discord-context/package.json apps/discord-context/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm check && pnpm build
RUN mkdir -p /data/audio && chown -R node:node /data
USER node
ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
