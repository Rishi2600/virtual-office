# Single-stage build: the whole monorepo is small and the server needs the
# built client on disk to serve it.
FROM node:24-alpine

WORKDIR /app

# Install deps first so edits to source don't invalidate the dependency layer.
COPY package.json package-lock.json* ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=2567
EXPOSE 2567

# Serves both the API/game server and the built client from one origin.
CMD ["npm", "start"]
