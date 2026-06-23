FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/log-service/package.json services/log-service/package.json
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/log-service ./services/log-service
RUN npx tsc -b services/log-service

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8500
ENV LOG_SERVICE_DB_PATH=/data/log-service.db
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/services/log-service/dist ./services/log-service/dist
RUN mkdir -p /data
EXPOSE 8500
CMD ["node", "services/log-service/dist/main.js"]
