import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import {
  SHADOW_DEMO_COMMUNITY_IDS,
  SHADOW_DEMO_CONTRACT_VERSION,
  SHADOW_DEMO_V4_CONTRACT_VERSION,
  SHADOW_DEMO_MAX_EXCLUDE_KEYWORDS,
  SHADOW_DEMO_MAX_EXCLUDE_KEYWORD_LENGTH,
  SHADOW_DEMO_SESSION_TTL_SECONDS,
  SHADOW_DEMO_TOPIC_KEYS,
  type ShadowDemoEnvelope,
} from './types.js';
import {
  DemoConflictError,
  DemoNotFoundError,
  DemoValidationError,
  ShadowDemoService,
  createDefaultShadowDemoService,
} from './service.js';
import { DemoStoreCapacityError, DemoStoreUnavailableError } from './store.js';
import {
  DemoRateLimitError,
  type DemoRateLimitGuard,
  type DemoRateLimitKind,
} from './rate-limit.js';

const IdempotencyKeySchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9:_-]+$/);
const DEMO_MUTATION_BODY_LIMIT_BYTES = 16 * 1024;
const DEMO_CAPACITY_RETRY_AFTER_SECONDS = Math.min(60, SHADOW_DEMO_SESSION_TTL_SECONDS);

const WeightSchema = z.object({
  recency: z.number().min(0).finite(),
  engagement: z.number().min(0).finite(),
  bridging: z.number().min(0).finite(),
  source_diversity: z.number().min(0).finite(),
  relevance: z.number().min(0).finite(),
}).strict();

const TopicIntentSchema = z.object({
  topicWeights: z.record(z.enum(SHADOW_DEMO_TOPIC_KEYS), z.number().min(0).max(1)),
}).strict();
const V4TopicIntentSchema = z.object({
  topicWeights: z.record(z.string().min(1).max(64), z.number().min(0).max(1))
    .refine((weights) => Object.keys(weights).length <= 64, 'Topic policy exceeds 64 entries'),
}).strict();

const CreateSessionBodySchema = z.object({
  communityId: z.enum(SHADOW_DEMO_COMMUNITY_IDS).optional(),
  clientNonce: IdempotencyKeySchema,
}).strict();

const SessionParamsSchema = z.object({
  sessionId: z.string().min(1).max(64),
}).strict();

const VoteBodySchema = z.object({
  baseEpochId: z.string().min(1).max(64),
  weights: WeightSchema,
  topicIntent: TopicIntentSchema,
  // Accepted only when DEMO_CONTENT_RULES_ENABLED; the service rejects it otherwise.
  excludeKeywords: z.array(z.string().min(1).max(SHADOW_DEMO_MAX_EXCLUDE_KEYWORD_LENGTH)).max(SHADOW_DEMO_MAX_EXCLUDE_KEYWORDS).optional(),
  idempotencyKey: IdempotencyKeySchema.optional(),
}).strict();

const SyntheticVotersBodySchema = z.object({
  baseEpochId: z.string().min(1).max(64),
  idempotencyKey: IdempotencyKeySchema.optional(),
}).strict();

const AdvanceBodySchema = z.object({
  fromEpochId: z.string().min(1).max(64),
  idempotencyKey: IdempotencyKeySchema.optional(),
}).strict();

const FeedQuerySchema = z.object({
  epochId: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(12).optional(),
}).strict();

const ReceiptQuerySchema = z.object({
  epochId: z.string().min(1).max(64).optional(),
  postUri: z.string().min(1).max(512),
}).strict();

export function registerShadowDemoRoutes(
  app: FastifyInstance,
  serviceOverride: ShadowDemoService | null | undefined,
  rateLimitGuard: DemoRateLimitGuard | null
): void {
  registerShadowDemoRouteFamily(app, serviceOverride, rateLimitGuard, {
    prefix: '/api/demo',
    contractVersion: SHADOW_DEMO_CONTRACT_VERSION,
    defaultCommunityId: 'open_science_builders',
    topicIntentSchema: TopicIntentSchema,
    installCloseHook: true,
  });
}

export function registerShadowDemoV4Routes(
  app: FastifyInstance,
  serviceOverride: ShadowDemoService | null | undefined,
  rateLimitGuard: DemoRateLimitGuard | null
): void {
  registerShadowDemoRouteFamily(app, serviceOverride, rateLimitGuard, {
    prefix: '/api/demo/v4',
    contractVersion: SHADOW_DEMO_V4_CONTRACT_VERSION,
    defaultCommunityId: 'community_gov',
    topicIntentSchema: V4TopicIntentSchema,
    installCloseHook: false,
  });
}

function registerShadowDemoRouteFamily(
  app: FastifyInstance,
  serviceOverride: ShadowDemoService | null | undefined,
  rateLimitGuard: DemoRateLimitGuard | null,
  options: {
    prefix: '/api/demo' | '/api/demo/v4';
    contractVersion: typeof SHADOW_DEMO_CONTRACT_VERSION | typeof SHADOW_DEMO_V4_CONTRACT_VERSION;
    defaultCommunityId: 'open_science_builders' | 'community_gov';
    topicIntentSchema: typeof TopicIntentSchema | typeof V4TopicIntentSchema;
    installCloseHook: boolean;
  }
): void {
  if (serviceOverride === null) {
    return;
  }
  const service = serviceOverride ?? createDefaultShadowDemoService();
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0].startsWith(`${options.prefix}/`)) reply.header('cache-control', 'no-store');
  });

  if (rateLimitGuard && options.installCloseHook) {
    app.addHook('onClose', async () => {
      await rateLimitGuard.close();
    });
  }

  app.post(`${options.prefix}/sessions`, {
    bodyLimit: DEMO_MUTATION_BODY_LIMIT_BYTES,
    schema: { tags: ['Demo'] },
  }, async (request, reply) => {
    return handleShadowDemoRequest(request, reply, async () => {
      await applyRateLimit(rateLimitGuard, 'session_create', request.ip);
      const body = parseOrThrow(CreateSessionBodySchema, request.body ?? {});
      if (options.defaultCommunityId === 'community_gov' && body.communityId && body.communityId !== 'community_gov') {
        throw new DemoValidationError('Shadow demo v4 supports only community_gov');
      }
      if (options.defaultCommunityId !== 'community_gov' && body.communityId === 'community_gov') {
        throw new DemoValidationError('community_gov is available only on the v4 shadow demo API');
      }
      return service.createSession({
        communityId: body.communityId ?? options.defaultCommunityId,
        clientNonce: body.clientNonce,
      });
    }, options.contractVersion);
  });

  app.get(`${options.prefix}/sessions/:sessionId`, { schema: { tags: ['Demo'] } }, async (request, reply) => {
    return handleShadowDemoRequest(request, reply, async () => {
      await applyRateLimit(rateLimitGuard, 'read', request.ip);
      const params = parseOrThrow(SessionParamsSchema, request.params);
      return service.getSession(params.sessionId);
    }, options.contractVersion);
  });

  app.post(`${options.prefix}/sessions/:sessionId/votes`, {
    bodyLimit: DEMO_MUTATION_BODY_LIMIT_BYTES,
    schema: { tags: ['Demo'] },
  }, async (request, reply) => {
    return handleShadowDemoRequest(request, reply, async () => {
      await applyRateLimit(rateLimitGuard, 'mutation', request.ip);
      const params = parseOrThrow(SessionParamsSchema, request.params);
      const body = parseOrThrow(VoteBodySchema.extend({ topicIntent: options.topicIntentSchema }), request.body ?? {});
      return service.castVote({
        sessionId: params.sessionId,
        baseEpochId: body.baseEpochId,
        weights: body.weights,
        topicIntent: body.topicIntent,
        excludeKeywords: body.excludeKeywords,
        idempotencyKey: idempotencyKeyFrom(request, body.idempotencyKey ?? null),
      });
    }, options.contractVersion);
  });

  app.post(`${options.prefix}/sessions/:sessionId/agents/run`, {
    bodyLimit: DEMO_MUTATION_BODY_LIMIT_BYTES,
    schema: { tags: ['Demo'] },
  }, async (request, reply) => {
    return handleShadowDemoRequest(request, reply, async () => {
      await applyRateLimit(rateLimitGuard, 'mutation', request.ip);
      const params = parseOrThrow(SessionParamsSchema, request.params);
      const body = parseOrThrow(SyntheticVotersBodySchema, request.body ?? {});
      return service.runSyntheticVoters({
        sessionId: params.sessionId,
        baseEpochId: body.baseEpochId,
        idempotencyKey: idempotencyKeyFrom(request, body.idempotencyKey ?? null),
      });
    }, options.contractVersion);
  });

  app.post(`${options.prefix}/sessions/:sessionId/epochs/advance`, {
    bodyLimit: DEMO_MUTATION_BODY_LIMIT_BYTES,
    schema: { tags: ['Demo'] },
  }, async (request, reply) => {
    return handleShadowDemoRequest(request, reply, async () => {
      await applyRateLimit(rateLimitGuard, 'mutation', request.ip);
      const params = parseOrThrow(SessionParamsSchema, request.params);
      const body = parseOrThrow(AdvanceBodySchema, request.body ?? {});
      return service.advanceEpoch({
        sessionId: params.sessionId,
        fromEpochId: body.fromEpochId,
        idempotencyKey: idempotencyKeyFrom(request, body.idempotencyKey ?? null),
      });
    }, options.contractVersion);
  });

  app.get(`${options.prefix}/sessions/:sessionId/feed`, { schema: { tags: ['Demo'] } }, async (request, reply) => {
    return handleShadowDemoRequest(request, reply, async () => {
      await applyRateLimit(rateLimitGuard, 'read', request.ip);
      const params = parseOrThrow(SessionParamsSchema, request.params);
      const query = parseOrThrow(FeedQuerySchema, request.query);
      const limit = query.limit ?? 12;
      return service.getFeed({
        sessionId: params.sessionId,
        epochId: query.epochId ?? null,
        limit,
      });
    }, options.contractVersion);
  });

  app.get(`${options.prefix}/sessions/:sessionId/receipts`, { schema: { tags: ['Demo'] } }, async (request, reply) => {
    return handleShadowDemoRequest(request, reply, async () => {
      await applyRateLimit(rateLimitGuard, 'read', request.ip);
      const params = parseOrThrow(SessionParamsSchema, request.params);
      const query = parseOrThrow(ReceiptQuerySchema, request.query);
      return service.getReceipt({
        sessionId: params.sessionId,
        epochId: query.epochId ?? null,
        postUri: query.postUri,
      });
    }, options.contractVersion);
  });
}

async function applyRateLimit(
  guard: DemoRateLimitGuard | null,
  kind: DemoRateLimitKind,
  identifier: string
): Promise<void> {
  if (guard) {
    await guard.check(kind, identifier);
  }
}

function parseOrThrow<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown
): z.infer<TSchema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DemoValidationError(parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'request';
      return `${path}: ${issue.message}`;
    }).join('; '));
  }
  return parsed.data;
}

function idempotencyKeyFrom(request: FastifyRequest, bodyKey: string | null): string | null {
  if (bodyKey) {
    return bodyKey;
  }
  const header = request.headers['idempotency-key'];
  if (typeof header !== 'string' || header.length === 0) {
    return null;
  }
  const parsed = IdempotencyKeySchema.safeParse(header);
  if (!parsed.success) {
    throw new DemoValidationError('idempotency-key header is malformed');
  }
  return parsed.data;
}

function sendEnvelope<TPayload>(
  request: FastifyRequest,
  reply: FastifyReply,
  result: {
    sessionId: string | null;
    payload: TPayload;
    warnings: ShadowDemoEnvelope<TPayload>['warnings'];
  },
  contractVersion: typeof SHADOW_DEMO_CONTRACT_VERSION | typeof SHADOW_DEMO_V4_CONTRACT_VERSION
): FastifyReply {
  const envelope: ShadowDemoEnvelope<TPayload> = {
    contractVersion,
    requestId: request.correlationId ?? randomUUID(),
    generatedAt: new Date().toISOString(),
    sessionId: result.sessionId,
    payload: result.payload,
    warnings: result.warnings,
  };
  return reply.send(envelope);
}

async function handleShadowDemoRequest<TPayload>(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: () => Promise<{
    sessionId: string | null;
    payload: TPayload;
    warnings: ShadowDemoEnvelope<TPayload>['warnings'];
  }>,
  contractVersion: typeof SHADOW_DEMO_CONTRACT_VERSION | typeof SHADOW_DEMO_V4_CONTRACT_VERSION = SHADOW_DEMO_CONTRACT_VERSION
): Promise<FastifyReply> {
  reply.header('cache-control', 'no-store');
  try {
    const result = await operation();
    return sendEnvelope(request, reply, result, contractVersion);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const correlationId = request.correlationId ?? randomUUID();
    const status = shadowDemoErrorStatus(error);
    if (error instanceof DemoRateLimitError) {
      reply.header('retry-after', String(error.retryAfterSeconds));
    } else if (error instanceof DemoStoreCapacityError) {
      reply.header('retry-after', String(DEMO_CAPACITY_RETRY_AFTER_SECONDS));
    }
    if (status >= 500) {
      logger.error({ err: error, correlationId }, 'Unexpected shadow demo request failure');
    }
    return reply.code(status).send(shadowDemoErrorBody(error, correlationId));
  }
}

export function shadowDemoErrorStatus(error: Error): number {
  if (error instanceof DemoValidationError) {
    return 400;
  }
  if (error instanceof DemoNotFoundError) {
    return 404;
  }
  if (error instanceof DemoConflictError) {
    return 409;
  }
  if (error instanceof DemoRateLimitError) {
    return 429;
  }
  if (error instanceof DemoStoreCapacityError || error instanceof DemoStoreUnavailableError) {
    return 503;
  }
  return 500;
}

export function shadowDemoErrorBody(error: Error, correlationId: string): {
  error: string;
  message: string;
  correlationId: string;
  retryAfterSeconds?: number;
} {
  if (error instanceof DemoRateLimitError) {
    return {
      error: error.name,
      message: error.message,
      correlationId,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  if (
    error instanceof DemoValidationError ||
    error instanceof DemoNotFoundError ||
    error instanceof DemoConflictError ||
    error instanceof DemoStoreCapacityError
  ) {
    return {
      error: error.name,
      message: error.message,
      correlationId,
      ...(error instanceof DemoStoreCapacityError
        ? { retryAfterSeconds: DEMO_CAPACITY_RETRY_AFTER_SECONDS }
        : {}),
    };
  }
  if (error instanceof DemoStoreUnavailableError) {
    return {
      error: error.name,
      message: 'The isolated shadow demo is temporarily unavailable. The production Corgi feed is unaffected.',
      correlationId,
    };
  }
  return {
    error: 'DemoInternalError',
    message: 'Shadow demo request failed. Please retry the guided demo.',
    correlationId,
  };
}
