/**
 * Post Explain Route
 *
 * GET /api/transparency/post/:uri
 *
 * Returns full explanation of why a post is ranked where it is:
 * - All 5 component scores (raw, weight, weighted)
 * - Current rank in feed
 * - Counterfactual: what rank would be with pure engagement
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { ErrorResponseSchema } from '../../lib/openapi.js';
import {
  countPostsWithComponentAbove,
  readPostScore,
} from '../../scoring/score-reader.js';
import {
  isPublishedSnapshotIntegrityFailure,
  PUBLIC_SNAPSHOT_DEPTH,
  readPublishedPostSnapshotReceipt,
} from '../feed-snapshot-store.js';
import type { PublishedPostSnapshotReceipt } from '../feed-snapshot-store.js';
import type { PostExplanation, TopicBreakdownEntry } from '../transparency.types.js';

export function registerPostExplainRoute(app: FastifyInstance): void {
  app.get(
    '/api/transparency/post/:uri',
    {
      schema: {
        tags: ['Transparency'],
        summary: 'Explain post ranking',
        description:
          'Returns a full breakdown of why a post is ranked where it is: all 5 component scores (raw, weight, weighted), ' +
          'an exact published position when the post is in the current materialized snapshot, or a legacy score-run rank otherwise, ' +
          'and a counterfactual showing what rank it would have with pure engagement sorting.',
        params: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: 'AT-URI of the post (URL-encoded)' },
          },
          required: ['uri'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              post_uri: { type: 'string' },
              epoch_id: { type: 'integer' },
              epoch_description: { type: 'string', nullable: true },
              total_score: { type: 'number' },
              rank: { type: 'integer' },
              rank_scope: { type: 'string', enum: ['published_snapshot', 'score_run'] },
              published_position: {
                type: 'integer',
                nullable: true,
                description: 'Position in the published top-50 transparency presentation snapshot.',
              },
              publication_snapshot_id: { type: 'string', nullable: true },
              components: {
                type: 'object',
                description: 'All 5 scoring components with raw, weight, and weighted values',
                additionalProperties: {
                  type: 'object',
                  properties: {
                    raw_score: { type: 'number' },
                    weight: { type: 'number' },
                    weighted: { type: 'number' },
                    topicBreakdown: {
                      type: 'object',
                      additionalProperties: {
                        type: 'object',
                        properties: {
                          postScore: { type: 'number' },
                          communityWeight: { type: 'number' },
                          contribution: { type: 'number' },
                        },
                        required: ['postScore', 'communityWeight', 'contribution'],
                      },
                    },
                  },
                },
              },
              governance_weights: {
                type: 'object',
                description: 'Per-component weight vector from the current governance epoch.',
                additionalProperties: { type: 'number' },
              },
              counterfactual: {
                type: 'object',
                properties: {
                  pure_engagement_rank: { type: 'integer' },
                  community_governed_rank: { type: 'integer' },
                  difference: { type: 'integer', description: 'Positive = governance boosted this post' },
                },
              },
              scored_at: { type: 'string', format: 'date-time' },
              classification_method: { type: 'string', enum: ['keyword', 'embedding'] },
            },
            required: ['post_uri', 'epoch_id', 'total_score', 'rank', 'rank_scope', 'published_position', 'publication_snapshot_id', 'components'],
          },
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          503: {
            ...ErrorResponseSchema,
            description:
              'TransparencySnapshotIntegrityFailure when a published receipt artifact fails validation.',
          },
          500: ErrorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Params: { uri: string } }>, reply: FastifyReply) => {
      const { uri } = request.params;
      let decodedUri: string;
      try {
        // Decode the URI (may be URL-encoded)
        decodedUri = decodeURIComponent(uri);
      } catch {
        return reply.code(400).send({
          error: 'ValidationError',
          message: 'Invalid post URI encoding',
        });
      }

      try {
        let publishedReceipt: PublishedPostSnapshotReceipt | null = null;
        try {
          publishedReceipt = await readPublishedPostSnapshotReceipt(
            decodedUri,
            PUBLIC_SNAPSHOT_DEPTH
          );
        } catch (snapshotError) {
          const isIntegrityFailure = isPublishedSnapshotIntegrityFailure(snapshotError);
          if (isIntegrityFailure) {
            logger.error(
              { err: snapshotError, uri: decodedUri },
              'Published snapshot receipt failed integrity validation'
            );
            return reply.code(503).send({
              error: 'TransparencySnapshotIntegrityFailure',
              message: 'The published explanation snapshot failed integrity validation.',
            });
          }
          logger.warn(
            { err: snapshotError, uri: decodedUri },
            'Published snapshot receipt lookup failed; using score-run explanation path'
          );
        }
        if (publishedReceipt !== null) {
          const { explanation: item } = publishedReceipt;
          const explanation: PostExplanation = {
            post_uri: item.post_uri,
            epoch_id: item.epoch_id,
            epoch_description: null,
            total_score: item.final_score,
            rank: publishedReceipt.publishedPosition,
            rank_scope: 'published_snapshot',
            published_position: publishedReceipt.publishedPosition,
            publication_snapshot_id: publishedReceipt.presentationSnapshotId,
            components: item.components,
            governance_weights: publishedReceipt.activeWeights,
            counterfactual: {
              pure_engagement_rank: item.engagement_only_position,
              community_governed_rank: item.ranked_position,
              difference: item.engagement_only_position - item.ranked_position,
            },
            scored_at: item.scored_at,
            component_details: null,
            classification_method: item.classification_method,
          };
          return reply.send(explanation);
        }

        const epochResult = await db.query<{ id: number; description: string | null }>(
          `SELECT id, description
           FROM governance_epochs
           WHERE status = 'active'
           ORDER BY id DESC
           LIMIT 1`
        );

        if (epochResult.rows.length === 0) {
          return reply.code(404).send({
            error: 'NoActiveEpoch',
            message: 'No active governance epoch found.',
          });
        }

        const epochId = epochResult.rows[0].id;
        const epochDescription = epochResult.rows[0].description;

        // Decomposed score via the storage-agnostic reader. Behind
        // SCORE_LONGTABLE_READ_ENABLED it reads from post_score_components;
        // off, it reads the wide columns. Same shape either way.
        const record = await readPostScore({
          postUri: decodedUri,
          epochId,
        });

        if (!record) {
          return reply.code(404).send({
            error: 'NotFound',
            message: 'Score not found for this post. The post may not have been scored yet.',
          });
        }

        const scopedRunId =
          record.componentDetails &&
          typeof (record.componentDetails as { run_id?: unknown }).run_id === 'string'
            ? (record.componentDetails as { run_id: string }).run_id
            : null;

        // Get rank position. total_score lives on post_scores in both storage
        // shapes (denormalized for the hot path), so this query is unchanged.
        const rankParams: unknown[] = [record.epochId, record.totalScore];
        let rankRunClause = '';
        if (scopedRunId) {
          rankParams.push(scopedRunId);
          rankRunClause = `AND component_details->>'run_id' = $${rankParams.length}`;
        }

        const rankResult = await db.query<{ rank: string }>(
          `SELECT COUNT(*) + 1 as rank
           FROM post_scores
           WHERE epoch_id = $1 AND total_score > $2
             ${rankRunClause}`,
          rankParams
        );

        // Counterfactual: rank under pure engagement scoring.
        const engagementComponent = record.components.engagement;
        const pureEngagementRank = engagementComponent
          ? await countPostsWithComponentAbove({
              epochId: record.epochId,
              componentKey: 'engagement',
              threshold: engagementComponent.raw,
              runId: scopedRunId ?? undefined,
            }) + 1
          : 0;

        const rank = parseInt(rankResult.rows[0].rank, 10);

        // Build the response components in the wire-format shape (snake_case
        // outer key, raw_score/weight/weighted inner). Map sourceDiversity →
        // source_diversity for backward-compat with existing API consumers.
        const componentsResponse: PostExplanation['components'] = {} as PostExplanation['components'];
        const governanceWeightsResponse: Record<string, number> = {};
        for (const [key, triple] of Object.entries(record.components)) {
          const wireKey = key === 'sourceDiversity' ? 'source_diversity' : key;
          componentsResponse[wireKey as keyof typeof componentsResponse] = {
            raw_score: triple.raw,
            weight: triple.weight,
            weighted: triple.weighted,
          };
          governanceWeightsResponse[wireKey] = triple.weight;
        }

        if (Number.isNaN(record.scoredAt.getTime())) {
          return reply.code(503).send({
            error: 'ScoreTimestampInvalid',
            message: 'Stored score timestamp is invalid for this post',
          });
        }

        const explanation: PostExplanation = {
          post_uri: record.postUri,
          epoch_id: record.epochId,
          epoch_description: epochDescription,
          total_score: record.totalScore,
          rank,
          rank_scope: 'score_run',
          published_position: null,
          publication_snapshot_id: null,
          components: componentsResponse,
          governance_weights: governanceWeightsResponse as PostExplanation['governance_weights'],
          counterfactual: {
            pure_engagement_rank: pureEngagementRank,
            community_governed_rank: rank,
            difference: pureEngagementRank - rank,
          },
          // Response schema declares string/date-time; readPostScore returns a Date.
          // Coerce to ISO string so Fastify validation accepts the payload.
          scored_at: record.scoredAt.toISOString(),
          component_details: record.componentDetails,
          classification_method: record.classificationMethod,
        };

        // Enrich relevance component with per-topic breakdown
        try {
          const topicResult = await db.query<{ topic_vector: Record<string, number> | null }>(
            'SELECT topic_vector FROM posts WHERE uri = $1',
            [decodedUri]
          );
          const epochWeightsResult = await db.query<{ topic_weights: Record<string, number> | null }>(
            'SELECT topic_weights FROM governance_epochs WHERE id = $1',
            [epochId]
          );

          const topicVector = (topicResult.rows[0]?.topic_vector as Record<string, number>) ?? {};
          const topicWeights = (epochWeightsResult.rows[0]?.topic_weights as Record<string, number>) ?? {};

          if (Object.keys(topicVector).length > 0 && Object.keys(topicWeights).length > 0) {
            const breakdown: Record<string, TopicBreakdownEntry> = {};
            for (const [topic, postScore] of Object.entries(topicVector)) {
              const communityWeight = topicWeights[topic] ?? 0.5;
              breakdown[topic] = {
                postScore: postScore as number,
                communityWeight,
                contribution: (postScore as number) * communityWeight,
              };
            }
            explanation.components.relevance.topicBreakdown = breakdown;
          }
        } catch (topicErr) {
          // Non-fatal: topic breakdown is supplementary
          logger.warn({ err: topicErr, uri: decodedUri }, 'Failed to fetch topic breakdown');
        }

        return reply.send(explanation);
      } catch (err) {
        logger.error({ err, uri: decodedUri }, 'Error fetching post explanation');
        return reply.code(500).send({
          error: 'InternalError',
          message: 'An error occurred while fetching the post explanation',
        });
      }
    }
  );
}
