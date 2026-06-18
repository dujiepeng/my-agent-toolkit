FROM node:22-bookworm-slim

WORKDIR /app

ENV PATH="/root/.local/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    else npm install; fi

# Install Kiro CLI only. Authentication is supplied at runtime by a read-only
# host auth/config mount; do not bake credentials into the image.
# Set to "curl -fsSL https://cli.kiro.dev/install | bash" when building a runnable image.
# Installs to /root/.local/bin/kiro-cli by default.
ARG INSTALL_KIRO_CLI=""
RUN if [ -n "$INSTALL_KIRO_CLI" ]; then sh -lc "$INSTALL_KIRO_CLI"; fi

COPY . .
RUN npm run build

ENTRYPOINT ["node", "dist/main.js"]
