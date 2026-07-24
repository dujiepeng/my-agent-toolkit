FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/pr-feedback-runner/package.json services/pr-feedback-runner/package.json
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/pr-feedback-runner ./services/pr-feedback-runner
RUN npx tsc -b services/pr-feedback-runner

FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache git
RUN printf '%s\n' '#!/bin/sh' 'case "$1" in *Username*) printf "%s\\n" "x-access-token" ;; *) printf "%s\\n" "$GITHUB_TOKEN" ;; esac' > /usr/local/bin/git-askpass && chmod 700 /usr/local/bin/git-askpass
COPY --from=build /app/services/pr-feedback-runner/dist ./services/pr-feedback-runner/dist
COPY --from=deps /app/node_modules/undici ./node_modules/undici
ENV PORT=8920
EXPOSE 8920
CMD ["node", "services/pr-feedback-runner/dist/main.js"]
