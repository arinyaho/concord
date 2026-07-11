# Minimal role-execution image. node (SDK runtime) + git (coder commits) + ca-certs (TLS).
# No author state baked in; the pipeline code arrives via a RO mount at runtime (entrypoint).
FROM node:24-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
