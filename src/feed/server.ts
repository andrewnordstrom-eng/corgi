import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { registerDescribeGenerator } from './routes/describe-generator.js';
import { registerWellKnown } from './routes/well-known.js';
import { registerFeedSkeleton } from './routes/feed-skeleton.js';
import { isPayloadTooLargeError } from './error-classification.js';
import { registerSendInteractions } from './routes/send-interactions.js';
import { registerGovernanceRoutes } from '../governance/server.js';
import { registerTransparencyRoutes } from '../transparency/server.js';
import { registerShadowDemoRoutes, registerShadowDemoV4Routes } from '../demo/routes.js';
import { createDefaultShadowDemoService } from '../demo/service.js';
import { registerDebugRoutes } from './routes/debug.js';
import { registerAdminRoutes } from '../admin/routes/index.js';
import { registerLegalRoutes } from '../legal/server.js';
import { registerMcpRoutes } from '../mcp/transport.js';
import { getPublicHealthStatus, isLive, isPromotionReady, isReady } from '../lib/health.js';
import { generateCorrelationId } from '../lib/correlation.js';
import { AppError, isAppError } from '../lib/errors.js';
import { redis } from '../db/redis.js';
import { getAuthenticatedDid } from '../governance/auth.js';
import { requireAdmin } from '../auth/admin.js';
import type { ShadowDemoService } from '../demo/service.js';
import {
  createRedisDemoRateLimitGuard,
  type DemoRateLimitGuard,
} from '../demo/rate-limit.js';
import { buildRouteRateLimitConfig } from './rate-limit-config.js';
import { applyStaticExportResponseHeaders, discoverStaticExportHtmlPaths } from './static-export-headers.js';
import packageMetadata from '../../package.json' with { type: 'json' };

// Extend FastifyRequest to include correlationId
declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

/**
 * Create and configure the Fastify server instance.
 * Registers all feed-related routes.
 */
export interface CreateServerOptions {
  shadowDemoService?: ShadowDemoService | null;
}

export async function createServer(options?: CreateServerOptions) {
  const app = Fastify({
    logger: false, // We use our own pino logger
    trustProxy: parseTrustProxyConfig(config.TRUST_PROXY),
    bodyLimit: 256 * 1024, // 256 KB — tighter than Fastify's 1 MB default
  });

  const allowedOrigins = parseAllowedOrigins();

  // Register CORS for cross-origin requests
  // NOTE: @fastify/cors v11 requires origin functions to be async or callback-style.
  // Sync functions that return a boolean are silently ignored, causing requests to hang.
  await app.register(cors, {
    credentials: true,
    origin: async (origin: string | undefined) => {
      if (!origin) return true;
      return allowedOrigins.has(origin);
    },
  });

  // Security headers for browser-facing endpoints
  await app.register(helmet, {
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        frameSrc: ["'self'", 'https://www.youtube-nocookie.com'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        fontSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https:', 'wss:'],
        formAction: ["'self'"],
      },
    },
    referrerPolicy: {
      policy: 'strict-origin-when-cross-origin',
    },
  });

  // No-op validator: route schemas are for OpenAPI documentation only.
  // Actual request validation is handled by Zod safeParse() in each handler.
  app.setValidatorCompiler(() => () => true);

  // OpenAPI documentation via Swagger — gate behind admin auth in production
  // to prevent reconnaissance of internal API routes and schemas.
  const isProduction = config.NODE_ENV === 'production';

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Community Feed API',
        description:
          'Corgi Commons is a Bluesky feed with inspectable, community-shaped ranking. Approved pilot participants can vote on ranking signals, topic priorities, and content rules; reviewed policy changes are applied before rescoring. ' +
          'Built on AT Protocol.\n\n' +
          '## Authentication\n' +
          '- **Governance endpoints** require a session cookie or bearer token from `POST /api/governance/auth/login`.\n' +
          '- **Admin endpoints** additionally require the caller\'s DID to be in the `BOT_ADMIN_DIDS` allowlist.\n' +
          '- **Feed endpoints** are public (called by the Bluesky app). Viewing the feed and using the shadow demo do not require governance access.\n' +
          '- **Transparency endpoints** are public and unauthenticated.',
        version: '1.2.0',
        contact: {
          name: 'Community Feed',
          url: 'https://github.com/andrewnordstrom-eng/bluesky-community-feed',
        },
        license: { name: packageMetadata.license },
      },
      servers: [
        { url: `https://${config.FEEDGEN_HOSTNAME}`, description: 'Production' },
      ],
      tags: [
        { name: 'Feed', description: 'AT Protocol feed endpoints (called by Bluesky app)' },
        { name: 'Governance', description: 'Voting, epochs, weights, and community governance' },
        { name: 'Auth', description: 'Bluesky authentication for governance actions' },
        { name: 'Topics', description: 'Topic catalog and topic weight voting' },
        { name: 'Transparency', description: 'Score explanations, feed stats, and audit logs' },
        { name: 'Demo', description: 'Public, isolated shadow-governance sessions for the reviewer walkthrough' },
        { name: 'Admin', description: 'Admin-only endpoints (requires BOT_ADMIN_DIDS)' },
        { name: 'Export', description: 'Research data export (anonymized, admin-only)' },
        { name: 'Health', description: 'Server health checks and liveness probes' },
        { name: 'Bot', description: 'Announcement bot management' },
        { name: 'Legal', description: 'Legal documents (terms of service, privacy policy)' },
      ],
      components: {
        securitySchemes: {
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: config.GOVERNANCE_SESSION_COOKIE_NAME,
            description: 'Session cookie from POST /api/governance/auth/login',
          },
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'Bearer token from POST /api/governance/auth/login (for CLI/MCP)',
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    // `/docs` belongs to the public Next product documentation. Keep the
    // admin-gated API explorer under the API namespace so a static export can
    // register its own `/docs/` route without Fastify startup collisions.
    routePrefix: '/api/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      defaultModelsExpandDepth: 3,
      displayRequestDuration: true,
      filter: true,
      tryItOutEnabled: false,
    },
    uiHooks: {
      onRequest: isProduction ? requireAdmin : undefined,
    },
  });

  if (config.RATE_LIMIT_ENABLED) {
    const governanceMutationKeyGenerator = async (request: FastifyRequest) => {
      try {
        const did = await getAuthenticatedDid(request);
        return did ?? request.ip;
      } catch {
        return request.ip;
      }
    };

    app.addHook('onRoute', (routeOptions) => {
      if (routeOptions.url.startsWith('/api/demo/')) {
        routeOptions.config = { ...routeOptions.config, rateLimit: false };
        return;
      }
      if (routeOptions.config?.rateLimit !== undefined) {
        return;
      }
      const rateLimitConfig = buildRouteRateLimitConfig(
        routeOptions.url,
        routeOptions.method,
        governanceMutationKeyGenerator
      );

      if (!rateLimitConfig) {
        return;
      }

      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: rateLimitConfig,
      };
    });

    await app.register(fastifyRateLimit, {
      global: true,
      redis,
      max: config.RATE_LIMIT_GLOBAL_MAX,
      timeWindow: config.RATE_LIMIT_GLOBAL_WINDOW_MS,
      keyGenerator: (request) => request.ip,
      errorResponseBuilder: (_request, context) => ({
        statusCode: 429,
        error: 'TooManyRequests',
        message: 'Rate limit exceeded. Please retry later.',
        retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)),
      }),
    });
  }

  // Add correlation ID to every request
  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    const incomingId = request.headers['x-correlation-id'];
    const correlationId = typeof incomingId === 'string' ? incomingId : generateCorrelationId();
    request.correlationId = correlationId;
    reply.header('x-correlation-id', correlationId);
    done();
  });

  // Log all requests with correlation ID
  app.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, done) => {
    logger.info({
      correlationId: request.correlationId,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime,
    }, 'Request completed');
    done();
  });

  // Register feed generator routes (required by Bluesky)
  registerDescribeGenerator(app);
  registerWellKnown(app);
  registerFeedSkeleton(app);
  registerSendInteractions(app);

  // Register governance routes
  registerGovernanceRoutes(app);

  // Register transparency routes
  registerTransparencyRoutes(app);

  // Register public shadow demo routes
  const shadowDemoRateLimitGuard: DemoRateLimitGuard | null = config.RATE_LIMIT_ENABLED
    ? createRedisDemoRateLimitGuard({
      redisUrl: config.DEMO_REDIS_URL,
      commandTimeoutMs: config.REDIS_COMMAND_TIMEOUT_MS,
      identifierHashSecret: config.DEMO_RATE_LIMIT_HASH_SECRET,
      policies: {
        session_create: {
          max: config.RATE_LIMIT_LOGIN_MAX,
          windowMs: config.RATE_LIMIT_LOGIN_WINDOW_MS,
        },
        mutation: {
          max: config.RATE_LIMIT_VOTE_MAX,
          windowMs: config.RATE_LIMIT_VOTE_WINDOW_MS,
        },
        read: {
          max: config.RATE_LIMIT_INTERACTIONS_MAX,
          windowMs: config.RATE_LIMIT_INTERACTIONS_WINDOW_MS,
        },
      },
    })
    : null;
  const shadowDemoService = options?.shadowDemoService === undefined
    ? createDefaultShadowDemoService()
    : options.shadowDemoService;
  registerShadowDemoRoutes(app, shadowDemoService, shadowDemoRateLimitGuard);
  registerShadowDemoV4Routes(app, shadowDemoService, shadowDemoRateLimitGuard);

  // Register debug routes
  registerDebugRoutes(app);

  // Register admin routes
  registerAdminRoutes(app);

  // Register legal document routes
  registerLegalRoutes(app);

  // Register MCP (Model Context Protocol) routes
  registerMcpRoutes(app);

  // Public health check endpoint - redacted status and immutable release revision only
  app.get('/health', {
    schema: {
      tags: ['Health'],
      summary: 'Public health check',
      description: 'Returns redacted health status and the running release revision. Does not expose component details.',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok', 'degraded'], description: 'Overall system health' },
            revision: {
              type: 'string',
              pattern: '^[0-9a-f]{40}$',
              nullable: true,
              description: 'Commit SHA captured by the running process at startup',
            },
          },
          required: ['status', 'revision'],
        },
      },
    },
  }, async () => {
    return getPublicHealthStatus();
  });

  // Liveness probe - just checks if process is running (k8s liveness)
  app.get('/health/live', {
    schema: {
      tags: ['Health'],
      summary: 'Liveness probe',
      description: 'Returns 200 if the process is running. Used by Kubernetes liveness probes.',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['live'], description: 'Process is running' },
          },
          required: ['status'],
        },
        503: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['not live'] },
          },
          required: ['status'],
        },
      },
    },
  }, async (_request, reply) => {
    if (isLive()) {
      return reply.status(200).send({ status: 'live' });
    }
    return reply.status(503).send({ status: 'not live' });
  });

  // Dependency readiness probe used by restart-oriented watchdogs.
  app.get('/health/ready', {
    schema: {
      tags: ['Health'],
      summary: 'Readiness probe',
      description: 'Returns 200 if database and Redis are healthy. Used by restart-oriented readiness probes; release promotion uses /health/promotion-ready.',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ready'], description: 'All critical dependencies healthy' },
          },
          required: ['status'],
        },
        503: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['not ready'] },
          },
          required: ['status'],
        },
      },
    },
  }, async (_request, reply) => {
    const ready = await isReady();
    if (ready) {
      return reply.status(200).send({ status: 'ready' });
    }
    return reply.status(503).send({ status: 'not ready' });
  });

  // Promotion readiness is intentionally stricter than restart readiness.
  app.get('/health/promotion-ready', {
    config: {
      rateLimit: {
        max: config.RATE_LIMIT_PROMOTION_READY_MAX,
        timeWindow: config.RATE_LIMIT_PROMOTION_READY_WINDOW_MS,
      },
    },
    schema: {
      hide: true,
      tags: ['Health'],
      summary: 'Production promotion readiness probe',
      description: 'Returns 200 if database, Redis, and emergency disk health are clear, persisted cursor and newest-post freshness are within 120 seconds, and the production release artifact is valid. Used only by the protected production promotion workflow.',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ready'], description: 'All promotion gates healthy' },
          },
          required: ['status'],
        },
        503: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['not ready'] },
          },
          required: ['status'],
        },
        403: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['not ready'] },
          },
          required: ['status'],
        },
      },
    },
  }, async (request, reply) => {
    if (!isDirectLoopbackRequest(request)) {
      return reply.status(403).send({ status: 'not ready' });
    }

    try {
      const ready = await isPromotionReady();
      if (ready) {
        return reply.status(200).send({ status: 'ready' });
      }
    } catch (error) {
      logger.warn({ err: error }, 'Promotion readiness check failed');
    }
    return reply.status(503).send({ status: 'not ready' });
  });

  // OpenAPI JSON endpoint — gated behind admin auth in production
  app.get(
    '/api/openapi.json',
    { schema: { hide: true }, preHandler: isProduction ? requireAdmin : undefined },
    async () => {
      return app.swagger();
    }
  );

  // Standardized error handler with correlation ID
  app.setErrorHandler((error: Error, request: FastifyRequest, reply: FastifyReply) => {
    const correlationId = request.correlationId || 'unknown';
    const rateLimitError = error as Partial<{
      statusCode: number;
      code: number | string;
      error: string;
      message: string;
      retryAfterSeconds: number;
    }>;

    if (isPayloadTooLargeError(error)) {
      logger.warn({ correlationId }, 'Request body exceeded the configured limit');
      return reply.status(413).send({
        error: 'PayloadTooLarge',
        message: 'Request body exceeds the configured limit.',
        correlationId,
      });
    }

    if (
      rateLimitError.statusCode === 429 ||
      rateLimitError.code === 429 ||
      rateLimitError.error === 'TooManyRequests'
    ) {
      const response: Record<string, unknown> = {
        error: 'TooManyRequests',
        message: rateLimitError.message ?? 'Rate limit exceeded. Please retry later.',
        correlationId,
      };
      if (typeof rateLimitError.retryAfterSeconds === 'number') {
        response.retryAfterSeconds = rateLimitError.retryAfterSeconds;
      }

      logger.warn({
        correlationId,
        retryAfterSeconds: rateLimitError.retryAfterSeconds,
      }, 'Rate limit exceeded');

      return reply.status(429).send(response);
    }

    // Handle AppError (our custom error type)
    if (isAppError(error)) {
      logger.warn({
        err: error,
        correlationId,
        errorCode: error.errorCode,
      }, error.message);

      return reply.status(error.statusCode).send(error.toResponse(correlationId));
    }

    // Handle Fastify validation errors
    const fastifyError = error as Error & { validation?: unknown };
    if (fastifyError.validation) {
      logger.warn({
        err: error,
        correlationId,
        validation: fastifyError.validation,
      }, 'Validation error');

      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: error.message,
        correlationId,
        details: fastifyError.validation,
      });
    }

    // Handle unexpected errors
    logger.error({
      err: error,
      correlationId,
      stack: error.stack,
    }, 'Unexpected error');

    return reply.status(500).send({
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      correlationId,
    });
  });

  // Serve frontend static files (must be AFTER all API routes).
  //
  // Two env-gated knobs support the web-next migration (PROJ-1497) with
  // defaults that preserve the existing behavior exactly:
  //   WEB_DIST_DIR    — build dir served, relative to the repo root
  //                     (default 'web/dist', the Vite SPA build)
  //   WEB_ROUTING_MODE — 'spa' (default): single index.html fallback, as today
  //                      'export': multi-page Next.js static export
  //                      (out/<route>/index.html per route + real 404.html)
  // Cutover to web-next is a deploy-env flip, not a code change; rollback is
  // reverting the two env vars.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDistDir = process.env.WEB_DIST_DIR ?? 'web/dist';
  const webRoutingMode = process.env.WEB_ROUTING_MODE === 'export' ? 'export' : 'spa';
  const webDistPath = path.isAbsolute(webDistDir)
    ? webDistDir
    : path.join(__dirname, '../..', webDistDir);

  // Only register static serving if the build dir exists (production with built frontend)
  if (fs.existsSync(webDistPath)) {
    logger.info({ webDistPath, webRoutingMode }, 'Registering static file serving for frontend');

    await app.register(fastifyStatic, {
      root: webDistPath,
      prefix: '/',
      wildcard: false, // Don't match all routes, let API routes take precedence
    });

    if (webRoutingMode === 'export') {
      const staticExportHtmlPaths = discoverStaticExportHtmlPaths(webDistPath);
      // Next.js static-export HTML hydrates via inline bootstrap scripts
      // (self.__next_f.push(...)), which the strict global CSP
      // (script-src 'self') blocks — the page would render but never become
      // interactive. Static export cannot use per-request nonces, and
      // per-build hashes would add a fail-closed startup dependency on
      // scanning the build output; the app renders exclusively through React
      // (no dangerouslySetInnerHTML), so scoped 'unsafe-inline' on HTML
      // documents only is the deliberate trade-off. API/JSON responses keep
      // the strict helmet policy above (kept in sync manually — mirror any
      // helmet directive change here).
      app.addHook('onSend', async (request, reply) => {
        // Cache-Control split (set here rather than via @fastify/static's
        // setHeaders, whose result the plugin's own cacheControl default
        // overwrites): content-hashed Next assets are immutable; HTML must
        // revalidate so a deploy is picked up immediately (stale HTML
        // referencing purged chunks is the classic white-screen failure).
        applyStaticExportResponseHeaders(request, reply, staticExportHtmlPaths);
      });
    }

    // Frontend fallback for GET requests to non-API routes
    app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
      if (
        request.method === 'GET' &&
        !request.url.startsWith('/api/') &&
        !request.url.startsWith('/xrpc/') &&
        !request.url.startsWith('/.well-known/') &&
        !request.url.startsWith('/health')
      ) {
        if (webRoutingMode === 'export') {
          // Multi-page export: map /vote or /vote/ -> vote/index.html.
          // Unknown routes get the real 404 page with a real 404 status
          // (never the home shell — that hides broken deep links).
          const routeKey = request.url.split('?')[0].replace(/^\/+|\/+$/g, '');
          const candidate = routeKey === '' ? 'index.html' : `${routeKey}/index.html`;
          if (!routeKey.includes('..') && fs.existsSync(path.join(webDistPath, candidate))) {
            return reply.type('text/html').sendFile(candidate);
          }
          if (fs.existsSync(path.join(webDistPath, '404.html'))) {
            return reply.status(404).type('text/html').sendFile('404.html');
          }
          return reply.status(404).type('text/plain').send('Not Found');
        }
        // SPA fallback (default) — serve index.html for frontend routes, as today
        return reply.sendFile('index.html');
      }
      // For API 404s, return JSON error
      return reply.status(404).send({
        error: 'Not Found',
        message: `Route ${request.method}:${request.url} not found`,
        statusCode: 404,
      });
    });
  }

  return app;
}

function parseAllowedOrigins(): Set<string> {
  const configured = config.CORS_ALLOWED_ORIGINS
    .split(',')
    .map((origin: string) => origin.trim())
    .filter(Boolean);

  if (configured.length > 0) {
    return new Set(configured);
  }

  const defaults =
    config.NODE_ENV === 'production'
      ? [`https://${config.FEEDGEN_HOSTNAME}`]
      : [
          `https://${config.FEEDGEN_HOSTNAME}`,
          'http://localhost:5173',
          'http://127.0.0.1:5173',
          'http://localhost:3000',
          'http://127.0.0.1:3000',
        ];

  return new Set(defaults);
}

export function parseTrustProxyConfig(value: string): boolean | string | string[] {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  const lower = normalized.toLowerCase();
  if (lower === 'true' || lower === 'on') {
    return true;
  }

  if (lower === 'false' || lower === 'off') {
    return false;
  }

  if (/^\d+$/.test(normalized)) {
    throw new TypeError(
      'TRUST_PROXY numeric hop counts are unsupported because they cannot validate the connecting proxy. ' +
      'Use an explicit trusted proxy IP/CIDR or "loopback" instead.',
    );
  }

  if (normalized.includes(',')) {
    return normalized
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }

  return normalized;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) {
    return false;
  }
  const normalized = address.toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1'
  );
}

// A denylist of forwarding/client-IP headers can never be exhaustive, so the
// TCP socket address is the primary signal below and is checked first, on
// its own: a request whose socket peer isn't the loopback interface is
// rejected outright regardless of headers. The header denylist is additional
// defense against a reverse proxy that terminates on loopback (so the socket
// address looks local) without stripping or rewriting client-supplied
// IP/forwarding headers.
const FORWARDING_HEADER_DENYLIST = [
  'forwarded',
  'x-forwarded-for',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'x-cluster-client-ip',
] as const;

export function isDirectLoopbackRequest(request: FastifyRequest): boolean {
  if (!isLoopbackAddress(request.raw.socket.remoteAddress)) {
    return false;
  }
  return FORWARDING_HEADER_DENYLIST.every(
    (header) => request.headers[header] === undefined
  );
}
