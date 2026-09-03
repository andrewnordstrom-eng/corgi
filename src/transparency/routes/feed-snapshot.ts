import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { ErrorResponseSchema, RateLimitResponseSchema } from '../../lib/openapi.js';
import { logger } from '../../lib/logger.js';
import {
  isPublishedSnapshotIntegrityFailure,
  readTransparencyFeedSnapshot,
} from '../feed-snapshot-store.js';

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
}).strict();
const DEFAULT_LIMIT = 50;
const PUBLIC_CACHE_CONTROL = 'public, max-age=30, stale-while-revalidate=60';

function etagMatches(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
  const rawValues = Array.isArray(ifNoneMatch) ? ifNoneMatch : [ifNoneMatch];
  return rawValues.some((value) => value?.split(',').some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, '');
    return normalized === '*' || normalized === etag;
  }) ?? false);
}

export function registerFeedSnapshotRoute(app: FastifyInstance): void {
  app.get(
    '/api/transparency/feed-snapshot',
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: 60_000,
        },
      },
      schema: {
        tags: ['Transparency'],
        summary: 'Read the current published feed snapshot and ranking explanations',
        description: 'Returns one publication-bound, anonymous snapshot of the live Corgi feed. It never reconstructs per-post receipts from PostgreSQL.',
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
                  ],
                },
              },
            },
            required: ['schema_version', 'feed_uri', 'presentation_snapshot_id', 'publication_run_id', 'epoch_id', 'published_at', 'status', 'total_published_items', 'expected_refresh_seconds', 'active_weights', 'items'],
          },
          304: { type: 'null', description: 'The presentation snapshot has not changed.' },
          400: ErrorResponseSchema,
          429: RateLimitResponseSchema,
          503: {
            ...ErrorResponseSchema,
            description:
              'TransparencySnapshotUnavailable when no complete publication exists, or TransparencySnapshotIntegrityFailure when a published artifact fails validation.',
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

        const etag = `"${snapshot.presentation_snapshot_id}-${effectiveLimit}"`;
        reply.header('ETag', etag);
        reply.header('Cache-Control', PUBLIC_CACHE_CONTROL);
        if (etagMatches(request.headers['if-none-match'], etag)) {
          return reply.code(304).send();
        }
        return reply.send(snapshot);
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
  const nullProperty = { type: 'null' };
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
