# Bellows gateway. Runs TypeScript directly on Node's built-in type stripping (no build step).
#
# Hardened for a sealed deployment (tinfoil-config.yml):
#  - the base image is pinned by digest, so a rebuild starts from the same bytes;
#  - it runs as an unprivileged user (1000:1000) and owns nothing but /data;
#  - it needs no writable root file system: run it read-only with /data on the encrypted volume and a
#    small tmpfs on /tmp;
#  - the running image carries no package manager.
# test/unit/deploy.test.ts checks these rules.
ARG NODE_IMAGE=node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM ${NODE_IMAGE}
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && mkdir -p /data \
 && chown 1000:1000 /data \
 && chmod 0700 /data
ENV NODE_ENV=production \
    BELLOWS_DB_PATH=/data/bellows.db \
    PORT=8787
WORKDIR /app
# Application files stay owned by root: the process can read them and cannot change them.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY client ./client
COPY config ./config
USER 1000:1000
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "src/index.ts"]
