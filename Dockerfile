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
# Bundle the CLI (runtime deps are workspace-only, so a hand-laid node_modules suffices)
COPY --from=build /app/apps/cli/package.json ./cli/package.json
COPY --from=build /app/apps/cli/dist ./cli/dist
COPY --from=build /app/packages/core/package.json ./cli/node_modules/@unkeep/core/package.json
COPY --from=build /app/packages/core/dist ./cli/node_modules/@unkeep/core/dist
COPY --from=build /app/packages/client/package.json ./cli/node_modules/@unkeep/client/package.json
COPY --from=build /app/packages/client/dist ./cli/node_modules/@unkeep/client/dist
RUN printf '#!/bin/sh\nexec node /app/cli/dist/bin.js "$@"\n' > /usr/local/bin/unkeep && chmod +x /usr/local/bin/unkeep
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/v1/status || exit 1
CMD ["node", "server/index.mjs"]
