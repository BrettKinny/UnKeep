ARG NODE_LICENSE_PLATFORM=linux/amd64
FROM --platform=${NODE_LICENSE_PLATFORM} node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS node-license

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
ARG UNKEEP_VERSION=dev
ARG UNKEEP_REVISION=unknown
ENV UNKEEP_BUILD_VERSION=${UNKEEP_VERSION} \
  UNKEEP_BUILD_REVISION=${UNKEEP_REVISION}
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

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
ARG UNKEEP_VERSION=dev
ARG UNKEEP_REVISION=unknown
WORKDIR /app
LABEL org.opencontainers.image.title="UnKeep" \
  org.opencontainers.image.source="https://github.com/BrettKinny/UnKeep" \
  org.opencontainers.image.version="${UNKEEP_VERSION}" \
  org.opencontainers.image.revision="${UNKEEP_REVISION}"
ENV NODE_ENV=production \
  PORT=3000 \
  UNKEEP_HOST=0.0.0.0 \
  UNKEEP_DATA_DIR=/data \
  UNKEEP_WEB_DIR=/app/web \
  UNKEEP_VERSION=${UNKEEP_VERSION} \
  UNKEEP_REVISION=${UNKEEP_REVISION}
COPY --from=build /app/apps/server/src ./server
COPY --from=build /app/apps/web/build ./web
COPY --from=build /app/LICENSE ./LICENSE
COPY --from=build /app/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
# The upstream arm64 source build omits this file, while its amd64 archive
# contains the exact Node license text already verified by the source bundle.
COPY --from=node-license /usr/local/LICENSE /usr/local/LICENSE
# Bundle the CLI (runtime deps are workspace-only, so a hand-laid node_modules suffices)
COPY --from=build /app/apps/cli/package.json ./cli/package.json
COPY --from=build /app/apps/cli/dist ./cli/dist
COPY --from=build /app/packages/core/package.json ./cli/node_modules/@unkeep/core/package.json
COPY --from=build /app/packages/core/dist ./cli/node_modules/@unkeep/core/dist
COPY --from=build /app/packages/client/package.json ./cli/node_modules/@unkeep/client/package.json
COPY --from=build /app/packages/client/dist ./cli/node_modules/@unkeep/client/dist
RUN printf '#!/bin/sh\nexec node /app/cli/dist/bin.js "$@"\n' > /usr/local/bin/unkeep \
  && chmod +x /usr/local/bin/unkeep \
  && mkdir -p /data /home/node/.config/unkeep \
  && chown -R node:node /data /home/node/.config \
  && chmod 0700 /data /home/node/.config /home/node/.config/unkeep \
  && rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /opt/yarn-v1.22.22 \
  && rm -f /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/v1/status || exit 1
USER node
CMD ["node", "server/index.mjs"]
