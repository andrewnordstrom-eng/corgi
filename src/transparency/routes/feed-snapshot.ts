import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from '../../config.js';
import { ErrorResponseSchema, RateLimitResponseSchema } from '../../lib/openapi.js';
import { logger } from '../../lib/logger.js';
import {
  isPublishedSnapshotIntegrityFailure,
  readTransparencyFeedSnapshot,
} from '../feed-snapshot-store.js';
import { readPublicPostEligibility } from '../public-post-eligibility.js';
import type { PublicTransparencyFeedSnapshot, TransparencyFeedSnapshot } from '../transparency.types.js';

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
}).strict();
const DEFAULT_LIMIT = 50;
const SNAPSHOT_CACHE_CONTROL = 'no-store';
const ELIGIBILITY_SUCCESS_TTL_MS = 5_000;
const MAX_ELIGIBILITY_SUCCESSES = 128;
const WITHHELD_REASON = 'Post withheld from the public view' as const;

interface EligibilitySuccess {
  readonly expiresAt: number;
  readonly eligibleByUri: ReadonlyMap<string, boolean>;
}

function etagMatches(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
  const rawValues = Array.isArray(ifNoneMatch) ? ifNoneMatch : [ifNoneMatch];
  return rawValues.some((value) => value?.split(',').some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, '');
    return normalized === '*' || normalized === etag;
  }) ?? false);
}

export function registerFeedSnapshotRoute(app: FastifyInstance): void {
  const pendingEligibility = new Map<string, Promise<ReadonlyMap<string, boolean>>>();
  const eligibilitySuccesses = new Map<string, EligibilitySuccess>();

  async function readSnapshotPublicEligibility(snapshot: TransparencyFeedSnapshot, limit: number): Promise<ReadonlyMap<string, boolean>> {
    const targets = snapshot.items.map((item) => ({
      postUri: item.post_uri,
      requiresLocalPost: item.ranked_position !== null,
    }));
    // Include the exact disclosure set: different limits and unscored pins must not
    // borrow approval from a smaller or otherwise different presentation.
    const key = JSON.stringify([snapshot.presentation_snapshot_id, limit, targets]);
    const startedAt = performance.now();
    const cached = eligibilitySuccesses.get(key);
    if (cached !== undefined && startedAt < cached.expiresAt) return cached.eligibleByUri;
    for (const [cachedKey, value] of eligibilitySuccesses) {
      if (startedAt >= value.expiresAt) eligibilitySuccesses.delete(cachedKey);
    }
    const pending = pendingEligibility.get(key);
    if (pending !== undefined) return pending;
    const check = readPublicPostEligibility(targets);
    pendingEligibility.set(key, check);
    try {
      const eligibleByUri = await check;
      // Only fully eligible snapshots reuse the owner-approved five-second window.
      // A mixed or withheld mask is always refreshed; denied results never enter cache.
      if (targets.every((target) => eligibleByUri.get(target.postUri) === true)) {
        const expiresAt = startedAt + ELIGIBILITY_SUCCESS_TTL_MS;
        if (performance.now() < expiresAt) {
          if (eligibilitySuccesses.size >= MAX_ELIGIBILITY_SUCCESSES) {
            const oldestKey = eligibilitySuccesses.keys().next().value;
            if (oldestKey !== undefined) eligibilitySuccesses.delete(oldestKey);
          }
          eligibilitySuccesses.set(key, { expiresAt, eligibleByUri: new Map(eligibleByUri) });
        }
      }
      return eligibleByUri;
    } finally {
      if (pendingEligibility.get(key) === check) pendingEligibility.delete(key);
    }
  }

  app.get(
    '/api/transparency/feed-snapshot',
    {
      onSend: async (_request, reply, payload) => {
        reply.header('Cache-Control', SNAPSHOT_CACHE_CONTROL);
        return payload;
      },
      config: {
        rateLimit: {
          max: 60,
          timeWindow: 60_000,
        },
      },
      schema: {
        tags: ['Transparency'],
        summary: 'Read the current published feed snapshot and ranking explanations',
        description: 'Returns one publication-bound, anonymous snapshot of the live Corgi feed. Published order and math are immutable; public visibility is checked in bounded AppView batches and one local lifecycle query. Ineligible posts become generic withheld slots at their original positions. Fully eligible checks may be reused for the identical publication and disclosure set for at most five seconds; withheld or failed results are never cached. This policy applies before both 200 and 304 responses. It never reconstructs per-post score receipts from PostgreSQL.',
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 50 } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            properties: {
              schema_version: { type: 'integer', enum: [1] },
              feed_uri: { type: 'string' },
              presentation_snapshot_id: { type: 'string' },
              publication_run_id: { type: 'string' },
              epoch_id: { type: 'integer' },
              published_at: { type: 'string', format: 'date-time' },
              status: { type: 'string', enum: ['current', 'last_known_good'] },
              total_published_items: { type: 'integer' },
              expected_refresh_seconds: { type: 'integer' },
              active_weights: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  recency: { type: 'number' }, engagement: { type: 'number' },
                  bridging: { type: 'number' }, source_diversity: { type: 'number' },
                  relevance: { type: 'number' },
                },
                required: ['recency', 'engagement', 'bridging', 'source_diversity', 'relevance'],
              },
              items: {
                type: 'array',
                items: {
                  oneOf: [
                    scoredItemResponseSchema('ranked'),
                    scoredItemResponseSchema('pinned_announcement'),
                    scorelessPinnedItemResponseSchema(),
                    withheldItemResponseSchema(),
                  ],
                },
              },
            },
            required: ['schema_version', 'feed_uri', 'presentation_snapshot_id', 'publication_run_id', 'epoch_id', 'published_at', 'status', 'total_published_items', 'expected_refresh_seconds', 'active_weights', 'items'],
          },
          304: { type: 'null', description: 'The presentation snapshot has not changed and public eligibility satisfies the bounded five-second success policy.' },
          400: ErrorResponseSchema,
          429: RateLimitResponseSchema,
          503: {
            ...ErrorResponseSchema,
            description:
              'TransparencySnapshotUnavailable when no complete publication exists or current public eligibility cannot be established, or TransparencySnapshotIntegrityFailure when a published artifact fails validation.',
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: { limit?: string | number } }>, reply: FastifyReply) => {
      const parsedQuery = QuerySchema.safeParse(request.query);
      if (!parsedQuery.success) {
        return reply.code(400).send({
          error: 'ValidationError',
          message: 'limit must be an integer from 1 to 50',
        });
      }

      try {
        if (config.FEED_PRIVATE_MODE) {
          return reply.code(503).send({
            error: 'TransparencySnapshotUnavailable',
            message: 'The public feed snapshot is unavailable while private feed mode is active.',
          });
        }
        const effectiveLimit = parsedQuery.data.limit ?? DEFAULT_LIMIT;
        const snapshot = await readTransparencyFeedSnapshot(effectiveLimit);
        if (snapshot === null) {
          return reply.code(503).send({
            error: 'TransparencySnapshotUnavailable',
            message: 'A complete feed explanation snapshot is not currently available.',
          });
        }

        const eligibleByUri = await readSnapshotPublicEligibility(snapshot, effectiveLimit);
        const publicSnapshot: PublicTransparencyFeedSnapshot = {
          ...snapshot,
          items: snapshot.items.map((item) => {
            if (eligibleByUri.get(item.post_uri) === true) return item;
            if (eligibleByUri.has(item.post_uri)) {
              return { position: item.position, placement: 'withheld', reason: WITHHELD_REASON };
            }
            throw new Error('Public eligibility did not return a decision for every published slot');
          }),
        };
        const representationHash = createHash('sha256').update(JSON.stringify(publicSnapshot)).digest('hex');
        const etag = `"${representationHash}"`;
        reply.header('ETag', etag);
        if (etagMatches(request.headers['if-none-match'], etag)) {
          return reply.code(304).send();
        }
        return reply.send(publicSnapshot);
      } catch (error) {
        const isIntegrityFailure = isPublishedSnapshotIntegrityFailure(error);
        logger.error(
          { err: error },
          isIntegrityFailure
            ? 'Published transparency feed snapshot failed integrity validation'
            : 'Failed to read the materialized transparency feed snapshot'
        );
        return reply.code(503).send({
          error: isIntegrityFailure
            ? 'TransparencySnapshotIntegrityFailure'
            : 'TransparencySnapshotUnavailable',
          message: isIntegrityFailure
            ? 'The published feed snapshot failed integrity validation.'
            : 'A complete feed explanation snapshot is not currently available.',
        });
      }
    }
  );
}

function withheldItemResponseSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      position: { type: 'integer' },
      placement: { type: 'string', enum: ['withheld'] },
      reason: { type: 'string', enum: [WITHHELD_REASON] },
    },
    required: ['position', 'placement', 'reason'],
  };
}

function componentResponseSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      raw_score: { type: 'number' },
      weight: { type: 'number' },
      weighted: { type: 'number' },
    },
    required: ['raw_score', 'weight', 'weighted'],
  };
}

function scoredItemResponseSchema(
  placement: 'ranked' | 'pinned_announcement'
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      position: { type: 'integer' },
      epoch_id: { type: 'integer' },
      ranked_position: { type: 'integer' },
      placement: { type: 'string', enum: [placement] },
      post_uri: { type: 'string' },
      base_score: { type: 'number' },
      publication_adjustment: { type: 'number' },
      final_score: { type: 'number' },
      components: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recency: componentResponseSchema(),
          engagement: componentResponseSchema(),
          bridging: componentResponseSchema(),
          source_diversity: componentResponseSchema(),
          relevance: componentResponseSchema(),
        },
        required: ['recency', 'engagement', 'bridging', 'source_diversity', 'relevance'],
      },
      source_score_run_id: { type: 'string' },
      scored_at: { type: 'string', format: 'date-time' },
      classification_method: { type: 'string', enum: ['keyword', 'embedding'] },
      engagement_only_position: { type: 'integer' },
    },
    required: ['position', 'epoch_id', 'ranked_position', 'placement', 'post_uri', 'base_score', 'publication_adjustment', 'final_score', 'components', 'source_score_run_id', 'scored_at', 'classification_method', 'engagement_only_position'],
  };
}

function scorelessPinnedItemResponseSchema(): Record<string, unknown> {
  const nullProperty = { type: 'string', nullable: true, enum: [null] };
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      position: { type: 'integer' },
      epoch_id: nullProperty,
      ranked_position: nullProperty,
      placement: { type: 'string', enum: ['pinned_announcement'] },
      post_uri: { type: 'string' },
      base_score: nullProperty,
      publication_adjustment: nullProperty,
      final_score: nullProperty,
      components: nullProperty,
      source_score_run_id: nullProperty,
      scored_at: nullProperty,
      classification_method: nullProperty,
      engagement_only_position: nullProperty,
    },
    required: ['position', 'epoch_id', 'ranked_position', 'placement', 'post_uri', 'base_score', 'publication_adjustment', 'final_score', 'components', 'source_score_run_id', 'scored_at', 'classification_method', 'engagement_only_position'],
  };
}
