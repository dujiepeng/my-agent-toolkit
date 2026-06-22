FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY services/llm-runner/package.json services/llm-runner/package.json
COPY services/data-service/package.json services/data-service/package.json
COPY services/bot-host/package.json services/bot-host/package.json
COPY services/log-service/package.json services/log-service/package.json
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/bot-host ./services/bot-host
RUN npx tsc -b services/bot-host

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8400
ENV DATA_SERVICE_URL=http://data-service:8300
ENV LLM_RUNNER_URL=http://llm-runner:8200
ENV LOG_SERVICE_URL=http://log-service:8500
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/services/bot-host/dist ./services/bot-host/dist
EXPOSE 8400
CMD ["node", "services/bot-host/dist/main.js"]
