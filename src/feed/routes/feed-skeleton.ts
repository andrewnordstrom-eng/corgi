/**
 * Feed Skeleton Route
 *
 * This is the core feed endpoint that Bluesky calls to get post URIs.
 * CRITICAL: Response time target is <50ms. Only read from Redis/PostgreSQL.
 * NEVER call external APIs from this endpoint.
 *
 * Phase 3: Reads from Redis sorted set with real ranked posts.
 * Uses snapshot-based cursors for stable pagination.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ErrorResponseSchema } from '../../lib/openapi.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { redis } from '../../db/redis.js';
import { upsertSubscriberAsync } from '../../db/queries/subscribers.js';
import { encodeCursor, decodeCursor } from '../cursor.js';
import { verifyFeedRequesterDid } from '../jwt-verifier.js';
import { isParticipantApproved } from '../access-control.js';
import {
  feedUriForCommunity,
  getFeedCommunities,
  isFeedCommunityServable,
  resolveFeedCommunityByUri,
  type FeedCommunity,
} from '../community-registry.js';
import {
  enqueueFeedRequestTracking,
  noteFeedRequestTrackingAbandonedBackendOperation,
} from '../request-tracker.js';
import { getCommunityFeedSnapshot, getCommunityFeedSnapshotById } from '../snapshot-cache.js';
import { composeFeedItems, parsePinnedAnnouncementUri } from '../pinned-composition.js';

const MIN_CURSOR_OFFSET = 0;
const MAX_CURSOR_OFFSET = 10000;
const SnapshotIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/);

interface FeedRequestTrackingContext {
  authHeader: string | undefined;
  community: FeedCommunity;
  precomputedViewerDid: string | undefined;
  signal: AbortSignal;
  snapshotId: string;
  pageOffset: number;
  postsServed: number;
  postUris: string[];
  responseTimeMs: number;
}

function readAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new Error('feed request tracking aborted');
}

async function waitForTrackingOperation<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
  operationName: string
): Promise<T> {
  if (signal.aborted) {
    throw readAbortReason(signal);
  }

  return new Promise<T>((resolve, reject) => {
    let operationSettled = false;
    let releaseAbandonedBackendOperation: (() => void) | null = null;

    const releaseIfAbandoned = (): void => {
      if (releaseAbandonedBackendOperation === null) {
        return;
      }
      releaseAbandonedBackendOperation();
      releaseAbandonedBackendOperation = null;
    };

    const abort = (): void => {
      if (!operationSettled && releaseAbandonedBackendOperation === null) {
        releaseAbandonedBackendOperation = noteFeedRequestTrackingAbandonedBackendOperation(operationName);
      }
      reject(readAbortReason(signal));
    };

    signal.addEventListener('abort', abort, { once: true });
    let operationPromise: Promise<T>;
    try {
      operationPromise = operation();
    } catch (err) {
      signal.removeEventListener('abort', abort);
      reject(err);
      return;
    }
    operationPromise
      .then(resolve, reject)
      .finally(() => {
        operationSettled = true;
        releaseIfAbandoned();
        signal.removeEventListener('abort', abort);
      });
  }).catch((err: unknown) => {
    if (signal.aborted) {
      throw readAbortReason(signal);
    }
    if (err instanceof Error) {
      throw err;
    }
    throw new Error(`${operationName} failed with non-Error rejection: ${String(err)}`);
  });
}

async function trackFeedRequest(context: FeedRequestTrackingContext): Promise<void> {
  try {
    const viewerDid =
      context.precomputedViewerDid ??
      (await waitForTrackingOperation(
        context.signal,
        () => verifyFeedRequesterDid(context.authHeader),
        'verifyFeedRequesterDid'
      ));

    const epochIdStr = await waitForTrackingOperation(
      context.signal,
      () => redis.get(context.community.redis.epoch),
      `redis.get(${context.community.redis.epoch})`
    );

    const logEntry = JSON.stringify({
      viewer_did: viewerDid,
      community_id: context.community.communityId,
      epoch_id: epochIdStr ? parseInt(epochIdStr, 10) : 0,
      snapshot_id: context.snapshotId,
      page_offset: context.pageOffset,
      posts_served: context.postsServed,
      post_uris: context.postUris,
      position_start: context.pageOffset,
      response_time_ms: context.responseTimeMs,
      requested_at: new Date().toISOString(),
    });

    const pipeline = redis.pipeline();
    pipeline.rpush('feed:request_log', logEntry);
    pipeline.ltrim('feed:request_log', -100000, -1);
    if (context.signal.aborted) {
      throw readAbortReason(context.signal);
    }
    const trackingWrites: Array<Promise<unknown>> = [
      waitForTrackingOperation(
        context.signal,
        () => pipeline.exec(),
        'redis.pipeline.exec(feed:request_log)'
      ),
    ];
    if (viewerDid) {
      trackingWrites.push(
        waitForTrackingOperation(
          context.signal,
          () => upsertSubscriberAsync(viewerDid),
          'upsertSubscriberAsync'
        )
      );
    }
    await Promise.all(trackingWrites);
  } catch (err) {
    if (context.signal.aborted) {
      throw err;
    }
    logger.debug({ err }, 'Feed request tracking failed; tracker will emit rate-limited warning');
    if (err instanceof Error) {
      throw err;
    }
    throw new Error(`feed request tracking failed with non-Error rejection: ${String(err)}`);
  }
}

interface FeedSkeletonQuery {
  feed: string;
  cursor?: string;
  limit?: string;
}

export interface RegisterFeedSkeletonOptions {
  communities: readonly FeedCommunity[];
}

/** Route-level schema for OpenAPI docs (no superRefine — Ajv can't compile Zod effects). */
const FeedSkeletonRouteSchema = z.object({
  feed: z.string(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** JSON Schema for Fastify route definition (consumed by @fastify/swagger for OpenAPI). */
const FeedSkeletonQueryJsonSchema = zodToJsonSchema(FeedSkeletonRouteSchema, {
  target: 'jsonSchema7',
});

/** Full validation schema including cursor structure check (used by safeParse in handler). */
const FeedSkeletonQuerySchema = FeedSkeletonRouteSchema.superRefine((query, ctx) => {
  if (query.cursor && decodeCursor(query.cursor) === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cursor'],
      message: 'Cursor must be a valid feed pagination cursor',
    });
  }
});

/**
 * Register the getFeedSkeleton endpoint.
 *
 * Spec: §9.1-9.3 - GET /xrpc/app.bsky.feed.getFeedSkeleton
 */
export function registerFeedSkeleton(app: FastifyInstance, options?: RegisterFeedSkeletonOptions): void {
  const communities = options?.communities ?? getFeedCommunities();

  app.get(
    '/xrpc/app.bsky.feed.getFeedSkeleton',
    {
      schema: {
        tags: ['Feed'],
        summary: 'Get feed skeleton',
        description:
          'Returns a list of post URIs for the community-governed feed. Called by the Bluesky app. ' +
          'Uses snapshot-based cursors for stable pagination (5-minute TTL).',
        querystring: FeedSkeletonQueryJsonSchema,
        response: {
          200: {
            type: 'object',
            properties: {
              feed: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    post: { type: 'string', description: 'AT-URI of the post', example: 'at://did:plc:example/app.bsky.feed.post/abc123' },
                  },
                  required: ['post'],
                },
                description: 'Ordered list of post references',
              },
              cursor: { type: 'string', description: 'Pagination cursor for the next page (absent on last page)' },
            },
            required: ['feed'],
          },
          400: ErrorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: FeedSkeletonQuery }>, reply) => {
      const startTime = performance.now();

      const parseResult = FeedSkeletonQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'ValidationError',
          message: 'Invalid query parameters',
          details: parseResult.error.issues,
        });
      }

      const { feed, cursor, limit } = parseResult.data;
      const authHeader = request.headers.authorization;
      const isFirstPage = !cursor;
      let precomputedViewerDid: string | undefined;

      const community = resolveFeedCommunityByUri(feed, config.FEEDGEN_PUBLISHER_DID, communities);
      if (community === null) {
        logger.warn(
          {
            feed,
            supportedFeeds: communities.map((candidate) =>
              feedUriForCommunity(candidate, config.FEEDGEN_PUBLISHER_DID)
            ),
          },
          'Unknown feed requested'
        );
        return reply.code(400).send({
          error: 'UnsupportedAlgorithm',
          message: 'Unknown feed',
        });
      }
      if (!isFeedCommunityServable(community)) {
        logger.warn({ feed, communityId: community.communityId }, 'Disabled feed requested');
        return reply.code(400).send({
          error: 'UnsupportedAlgorithm',
          message: 'Feed is disabled',
        });
      }

      // Private communities and global private mode require an approved participant.
      if (!community.public || config.FEED_PRIVATE_MODE) {
        const viewerDid = await verifyFeedRequesterDid(authHeader);
        if (!viewerDid) return reply.send({ feed: [] });
        const approved = await isParticipantApproved(viewerDid);
        if (!approved) return reply.send({ feed: [] });
        precomputedViewerDid = viewerDid;
      }

      let postUris: string[];
      let offset: number;
      let snapshotId: string;

      if (cursor) {
        // Subsequent page: read from existing snapshot
        const parsed = decodeCursor(cursor);
        if (!parsed) {
          logger.warn({ cursor }, 'Invalid cursor');
          return reply.code(400).send({
            error: 'ValidationError',
            message: 'Invalid query parameters',
            details: [
              {
                path: ['cursor'],
                message: 'Cursor must be a valid feed pagination cursor',
              },
            ],
          });
        }

        snapshotId = parsed.snapshotId;
        offset = parsed.offset;

        if (!SnapshotIdSchema.safeParse(snapshotId).success) {
          logger.warn({ snapshotIdLength: snapshotId.length }, 'Cursor snapshot id failed validation');
          return reply.code(400).send({
            error: 'ValidationError',
            message: 'Invalid query parameters',
            details: [
              {
                path: ['cursor'],
                message: 'Cursor must contain a valid snapshot id',
              },
            ],
          });
        }

        if (offset < MIN_CURSOR_OFFSET || offset > MAX_CURSOR_OFFSET) {
          logger.warn({ snapshotId, offset }, 'Cursor offset out of supported bounds');
          return reply.send({ feed: [] });
        }

        // Try to get snapshot from the shared in-memory/Redis snapshot cache.
        let snapshot;
        try {
          snapshot = await getCommunityFeedSnapshotById(community, snapshotId);
        } catch (err) {
          logger.warn({ err, communityId: community.communityId, snapshotId }, 'Failed to read feed snapshot by id');
          return reply.send({ feed: [] });
        }
        if (snapshot === null) {
          // Snapshot expired, return empty to signal client to refresh
          logger.debug({ snapshotId }, 'Snapshot expired');
          return reply.send({ feed: [] });
        }

        postUris = snapshot.uris.slice(offset, offset + limit);
      } else {
        // First page: use the current scoring snapshot. It is shared for the scoring TTL.
        offset = 0;
        let snapshot;
        try {
          snapshot = await getCommunityFeedSnapshot(community);
        } catch (err) {
          logger.warn({ err, communityId: community.communityId }, 'Failed to read current feed snapshot');
          return reply.send({ feed: [] });
        }
        if (snapshot === null) {
          logger.debug('No posts in feed');
          return reply.send({ feed: [] });
        }

        snapshotId = snapshot.snapshotId;
        postUris = snapshot.uris.slice(0, limit);
      }

      // Check for pinned announcement (first page only)
      let pinnedUri: string | null = null;
      if (isFirstPage && community.includePinnedAnnouncements) {
        const pinnedData = await redis.get('bot:latest_announcement');
        pinnedUri = parsePinnedAnnouncementUri(pinnedData);
      }

      // Build response with pinned post first
      const composedItems = composeFeedItems(postUris, limit, pinnedUri);
      const feedItems = composedItems.map((item) => ({ post: item.postUri }));
      const servedPostUris = feedItems.map((item) => item.post);
      const pinWasInserted = composedItems.some((item) => item.rankedPosition === null);
      const rankedItemsServed = composedItems.filter(
        (item) => item.rankedPosition !== null
      ).length;

      const nextOffset = offset + rankedItemsServed;
      const hasMore = pinWasInserted
        ? postUris.length >= limit
        : postUris.length === limit;
      const responseTimeMs = Math.round(performance.now() - startTime);

      logger.debug(
        {
          feedItems: feedItems.length,
          communityId: community.communityId,
          hasMore,
          snapshotId,
          authHeaderPresent: Boolean(authHeader),
          responseTimeMs,
        },
        'Returning feed skeleton'
      );

      const response = {
        feed: feedItems,
        cursor: hasMore ? encodeCursor(snapshotId, nextOffset) : undefined,
      };

      // Keep getFeedSkeleton hot path non-blocking: verification + tracking happens async.
      const trackingAccepted = enqueueFeedRequestTracking((signal) =>
        trackFeedRequest({
          authHeader,
          community,
          precomputedViewerDid,
          signal,
          snapshotId,
          pageOffset: offset,
          postsServed: feedItems.length,
          postUris: servedPostUris,
          responseTimeMs,
        })
      );
      if (!trackingAccepted) {
        logger.warn({ snapshotId, pageOffset: offset }, 'Feed request tracking queue is full');
      }

      return reply.send(response);
    }
  );
}
