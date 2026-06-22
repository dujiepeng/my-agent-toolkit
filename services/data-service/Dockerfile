FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY services/llm-runner/package.json services/llm-runner/package.json
COPY services/data-service/package.json services/data-service/package.json
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY services/data-service ./services/data-service
RUN npx tsc -b services/data-service

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8300
ENV DATA_SERVICE_DB_PATH=/data/data-service.db
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/services/data-service/dist ./services/data-service/dist
RUN mkdir -p /data
EXPOSE 8300
CMD ["node", "services/data-service/dist/main.js"]
