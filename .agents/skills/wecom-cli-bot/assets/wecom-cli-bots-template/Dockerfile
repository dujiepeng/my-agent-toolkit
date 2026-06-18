FROM node:22-bookworm-slim

WORKDIR /app

ENV PATH="/root/.local/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    else npm install; fi

# Install Kiro CLI only. Authentication is supplied at runtime by a read-only
# host auth/config mount; do not bake credentials into the image.
# Set to "curl -fsSL https://cli.kiro.dev/install | bash" when building a runnable image.
# Installs to /root/.local/bin/kiro-cli by default.
ARG KIRO_CLI_ZIP=""
ARG INSTALL_KIRO_CLI=""
COPY .docker/kiro-cache/ /tmp/kiro-cache/
RUN if [ -n "$KIRO_CLI_ZIP" ]; then \
      unzip -q "/tmp/kiro-cache/$KIRO_CLI_ZIP" -d /tmp/kiro-cli-install \
      && /tmp/kiro-cli-install/kirocli/install.sh --force --no-confirm \
      && rm -rf /tmp/kiro-cache /tmp/kiro-cli-install; \
    elif [ -n "$INSTALL_KIRO_CLI" ]; then \
      sh -lc "$INSTALL_KIRO_CLI"; \
    fi

COPY . .
RUN rm -rf .docker/kiro-cache
RUN rm -rf /root/.local/share/kiro-cli && ln -s /host/kiro-auth /root/.local/share/kiro-cli
RUN npm run build

ENTRYPOINT ["node", "dist/main.js"]
