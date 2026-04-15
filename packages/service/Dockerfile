FROM node:20-alpine AS builder

WORKDIR /usr/src/app

RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./

RUN yarn install --immutable

COPY . .

RUN yarn nest build

# --- Production image ---
FROM node:20-alpine

WORKDIR /usr/src/app

RUN corepack enable

ENV NODE_ENV=production

COPY package.json yarn.lock .yarnrc.yml ./

RUN yarn install --immutable

COPY --from=builder /usr/src/app/dist ./dist

EXPOSE ${PORT:-3000}

CMD ["node", "dist/main"]
