# Two stages: build everything with dev dependencies, then copy only the built
# output and production dependencies into a clean image that runs as a
# non-root user. What gets sent to the build at all is limited by .dockerignore.

# ------------------------------------------------------------------ build
FROM node:24-alpine AS build
WORKDIR /app

# Install deps first so edits to source don't invalidate the dependency layer.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci

COPY tsconfig.base.json ./
COPY shared ./shared
COPY server ./server
COPY client ./client
# Client sourcemaps are for local debugging only; never ship them.
RUN npm run build && find client/dist -name "*.map" -delete

# ---------------------------------------------------------------- runtime
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=2567
WORKDIR /app

# Production dependencies of the server (and the shared package it links to)
# only. No build tools, no client libraries: the client ships prebuilt.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci --omit=dev --workspace=@vo/server && npm cache clean --force

COPY --from=build /app/shared/dist ./shared/dist
# The map JSON is read at runtime by both server and client (see shared/package.json exports).
COPY --from=build /app/shared/src/maps ./shared/src/maps
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist

# The JSON store (used only when DATABASE_URL is unset) writes here.
RUN mkdir -p .data && chown node:node .data
USER node

EXPOSE 2567
# /ready, not /health: unhealthy also when the database is unreachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 2567) + '/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Serves both the API/game server and the built client from one origin.
# node directly (not npm) so it receives SIGTERM itself.
CMD ["node", "server/dist/main.js"]
