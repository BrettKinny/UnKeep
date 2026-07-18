FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/client/package.json packages/client/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/server/package.json apps/server/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 UNKEEP_DATA_DIR=/data UNKEEP_WEB_DIR=/app/web
COPY --from=build /app/apps/server/src ./server
COPY --from=build /app/apps/web/build ./web
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/v1/status || exit 1
CMD ["node", "server/index.mjs"]
