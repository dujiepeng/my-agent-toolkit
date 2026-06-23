FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/control-api/package.json services/control-api/package.json
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/control-api ./services/control-api
RUN npx tsc -b services/control-api

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8600
ENV DATA_SERVICE_URL=http://data-service:8300
ENV LOG_SERVICE_URL=http://log-service:8500
COPY --from=build /app/services/control-api/dist ./services/control-api/dist
EXPOSE 8600
CMD ["node", "services/control-api/dist/main.js"]
