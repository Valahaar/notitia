# --- Stage 1: production-only deps -------------------------------------------
FROM node:22-alpine AS deps

WORKDIR /usr/src/app

RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./

# Install ONLY production deps (Yarn 4 workspace-tools plugin).
RUN yarn workspaces focus --production

# --- Stage 2: build (full deps) ----------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /usr/src/app

RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./

RUN yarn install --immutable

COPY . .

RUN yarn nest build

# --- Stage 3: runtime (minimal) ----------------------------------------------
FROM node:22-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production

# Copy pruned production node_modules from the deps stage and the compiled
# bundle from the build stage. Runtime image has no yarn / corepack / source.
COPY --from=deps    /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist          ./dist
COPY package.json ./

EXPOSE ${PORT:-3000}

CMD ["node", "dist/main"]
