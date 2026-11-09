# PodoCRM – Produktions-Image (Next.js standalone)
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
# Eingespielter Commit (vom Update-Skript gesetzt) – /api/health meldet ihn, damit ein Deploy ohne Login prüfbar ist
ARG GIT_SHA=unknown
ENV APP_COMMIT=$GIT_SHA
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd -r podo && useradd -r -g podo podo && mkdir -p /data/storage && chown podo:podo /data/storage
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Migrationen laufen über einen separaten Container (siehe docker-compose: migrate)
COPY --from=build /app/drizzle ./drizzle
USER podo
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
