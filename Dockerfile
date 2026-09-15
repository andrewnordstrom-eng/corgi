# Community Feed Generator - Production Dockerfile
# Multi-stage build for minimal image size

# =============================================================================
# Stage 1: Build
# =============================================================================
FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS builder

ARG SOURCE_REVISION
RUN test "${#SOURCE_REVISION}" -eq 40 && printf '%s\n' "$SOURCE_REVISION" | grep -Eq '^[0-9a-f]{40}$'

WORKDIR /app

RUN npm install --global --ignore-scripts npm@11.19.1 && test "$(npm --version)" = "11.19.1"

# Install build dependencies
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

# Copy package files first (better caching)
COPY package*.json ./
COPY .npmrc ./
COPY packages/feed-sdk/package.json ./packages/feed-sdk/package.json
COPY examples/civility-component/package.json ./examples/civility-component/package.json

# Install all dependencies (including devDependencies for build)
RUN npm ci --ignore-scripts

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build
RUN printf '%s\n' "$SOURCE_REVISION" > dist/.release-sha

# =============================================================================
# Stage 2: Production
# =============================================================================
FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS production

ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision="$SOURCE_REVISION"

WORKDIR /app

RUN npm install --global --ignore-scripts npm@11.19.1 && test "$(npm --version)" = "11.19.1"

# Set production environment
ENV NODE_ENV=production

# Install only production dependencies.
# Ignore lifecycle scripts in runtime image so dev-only `prepare` hooks (Husky)
# do not run when devDependencies are intentionally omitted.
COPY package*.json ./
COPY .npmrc ./
COPY packages/feed-sdk/package.json ./packages/feed-sdk/package.json
COPY examples/civility-component/package.json ./examples/civility-component/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy database migrations (needed at runtime)
COPY src/db/migrations ./src/db/migrations

# Copy legal documents (needed by /api/legal/* at runtime)
COPY scripts/check-legal-docs.sh ./scripts/check-legal-docs.sh
COPY legal/TERMS_OF_SERVICE.md legal/PRIVACY_POLICY.md ./legal/
RUN sh /app/scripts/check-legal-docs.sh /app/legal

# Create non-root user for security
RUN groupadd --system --gid 1001 appgroup && \
    useradd --system --uid 1001 --gid appgroup --no-create-home --shell /usr/sbin/nologin appuser

# Change ownership of app directory
RUN chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Expose the application port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('node:http').get('http://localhost:3000/health/ready', response => process.exit(response.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Start the application
CMD ["sh", "-c", "sh /app/scripts/check-legal-docs.sh /app/legal && exec node dist/index.js"]
