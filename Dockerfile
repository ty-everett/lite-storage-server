FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run test:security
RUN npm prune --omit=dev

FROM node:24.21.0-bookworm-slim
ENV NODE_ENV=production HTTP_PORT=9002
WORKDIR /app
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/out ./out
COPY --chown=10001:10001 public ./public
USER 10001:10001
EXPOSE 9002
CMD ["node", "out/index.js"]
