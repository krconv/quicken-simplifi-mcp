FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=true

COPY --from=build /app/dist ./dist
COPY .env.example ./

RUN mkdir -p /app/data

EXPOSE 8787
CMD ["node", "dist/index.js"]
