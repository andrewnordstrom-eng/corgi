/**
 * Admin Governance Routes
 *
 * Unified governance control endpoints for admin dashboard.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { db } from '../../db/client.js';
import { config } from '../../config.js';
import { getAdminDid } from '../../auth/admin.js';
import { logger } from '../../lib/logger.js';
import { adminSecurity, ErrorResponseSchema } from '../../lib/openapi.js';
import {
  ContentRules,
  GovernanceWeights,
  normalizeKeywords,
  normalizeWeights,
  toContentRules,
} from '../../governance/governance.types.js';
import { invalidateContentRulesCache } from '../../governance/content-filter.js';
import {
  aggregateContentVotes,
  aggregateTopicWeights,
  aggregateVotes,
} from '../../governance/aggregation.js';
import {
  InvalidStoredTopicWeightsError,
  parseStoredProposedTopicWeights,
  parseStoredTopicWeights,
} from '../../governance/topic-weights.js';
import { readGovernanceVoteCounts } from '../../governance/vote-counts.js';
import {
  readEpochWeightsForMultipleEpochs,
  writeEpochWeights,
} from '../../governance/weight-longtable.js';
import { tryTriggerManualScoringRun } from '../../scoring/scheduler.js';
import { requestFullRescore } from '../../scoring/pipeline.js';
import {
  announceResultsApproved,
  announceVoteScheduled,
  announceVotingClosed,
  announceVotingOpen,
} from '../../bot/governance-announcements.js';

const KEYWORD_PATTERN = /^[a-z0-9][a-z0-9\s-]{0,49}$/i;

const ContentRulesPatchSchema = z
  .object({
    includeKeywords: z.array(z.string()).max(20).optional(),
    excludeKeywords: z.array(z.string()).max(20).optional(),
  })
  .refine((value) => value.includeKeywords !== undefined || value.excludeKeywords !== undefined, {
    message: 'At least one keyword list must be provided',
  });

const KeywordActionSchema = z.object({
  type: z.enum(['include', 'exclude']),
  keyword: z.string().min(1).max(50),
  confirm: z.boolean().optional(),
});

const WeightPatchSchema = z
  .object({
    recency: z.number().min(0).max(1).optional(),
    engagement: z.number().min(0).max(1).optional(),
    bridging: z.number().min(0).max(1).optional(),
    sourceDiversity: z.number().min(0).max(1).optional(),
    relevance: z.number().min(0).max(1).optional(),
  })
  .refine(
    (value) =>
      value.recency !== undefined ||
      value.engagement !== undefined ||
      value.bridging !== undefined ||
      value.sourceDiversity !== undefined ||
      value.relevance !== undefined,
    { message: 'At least one weight override is required' }
  );

const ExtendVotingSchema = z.object({
  hours: z.coerce.number().int().min(1).max(168),
});

const RoundIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const StartVotingSchema = z.object({
  durationHours: z.coerce.number().int().min(1).max(168).default(72),
  announce: z.boolean().optional().default(true),
});

const EndVotingSchema = z.object({
  announce: z.boolean().optional().default(true),
});

const ApproveResultsSchema = z.object({
  announce: z.boolean().optional().default(true),
});

const ScheduleVoteSchema = z.object({
  startsAt: z.string().datetime(),
  durationHours: z.coerce.number().int().min(1).max(168).default(72),
});

/** JSON Schema conversions for request validation in OpenAPI docs. */
const KeywordActionJsonSchema = zodToJsonSchema(KeywordActionSchema, { target: 'jsonSchema7' });
const ExtendVotingJsonSchema = zodToJsonSchema(ExtendVotingSchema, { target: 'jsonSchema7' });
const RoundIdParamsJsonSchema = zodToJsonSchema(RoundIdParamsSchema, { target: 'jsonSchema7' });
const StartVotingJsonSchema = zodToJsonSchema(StartVotingSchema, { target: 'jsonSchema7' });
const EndVotingJsonSchema = zodToJsonSchema(EndVotingSchema, { target: 'jsonSchema7' });
const ApproveResultsJsonSchema = zodToJsonSchema(ApproveResultsSchema, { target: 'jsonSchema7' });
const ScheduleVoteJsonSchema = zodToJsonSchema(ScheduleVoteSchema, { target: 'jsonSchema7' });

/** Reusable schema fragment for governance weights. */
const weightsSchema = {
  type: 'object' as const,
  properties: {
    recency: { type: 'number' as const },
    engagement: { type: 'number' as const },
    bridging: { type: 'number' as const },
    sourceDiversity: { type: 'number' as const },
    relevance: { type: 'number' as const },
  },
};

/** Reusable schema fragment for content rules. */
const contentRulesSchema = {
  type: 'object' as const,
  properties: {
    includeKeywords: { type: 'array' as const, items: { type: 'string' as const } },
    excludeKeywords: { type: 'array' as const, items: { type: 'string' as const } },
  },
};

/** Reusable schema fragment for a topic slug to weight map. */
const topicWeightsSchema = {
  type: 'object' as const,
  additionalProperties: { type: 'number' as const, minimum: 0, maximum: 1 },
};

/** Reusable schema fragment for a governance round object. */
const roundSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'integer' as const },
    status: { type: 'string' as const },
    phase: { type: 'string' as const, enum: ['running', 'voting', 'results'] },
    voteCount: { type: 'integer' as const },
    createdAt: { type: 'string' as const, format: 'date-time' },
    closedAt: { type: 'string' as const, format: 'date-time', nullable: true },
    votingEndsAt: { type: 'string' as const, format: 'date-time', nullable: true },
    votingStartedAt: { type: 'string' as const, format: 'date-time', nullable: true },
    votingClosedAt: { type: 'string' as const, format: 'date-time', nullable: true },
    resultsApprovedAt: { type: 'string' as const, format: 'date-time', nullable: true },
    resultsApprovedBy: { type: 'string' as const, nullable: true },
    proposedWeights: { ...weightsSchema, nullable: true },
    proposedTopicWeights: { ...topicWeightsSchema, nullable: true },
    proposedContentRules: { ...contentRulesSchema, nullable: true },
    autoTransition: { type: 'boolean' as const },
    weights: weightsSchema,
    topicWeights: topicWeightsSchema,
    contentRules: contentRulesSchema,
  },
};

interface GovernanceEpochRow {
  id: number;
  status: string;
  phase: string | null;
  voting_ends_at: string | null;
  voting_started_at: string | null;
  voting_closed_at: string | null;
  results_approved_at: string | null;
  results_approved_by: string | null;
  proposed_weights: unknown;
  proposed_topic_weights: unknown;
  proposed_content_rules: unknown;
  auto_transition: boolean;
  recency_weight: number | string;
  engagement_weight: number | string;
  bridging_weight: number | string;
  source_diversity_weight: number | string;
  relevance_weight: number | string;
  content_rules: unknown;
  topic_weights: unknown;
  created_at: string;
  closed_at: string | null;
}

interface ScheduledVoteRow {
  id: number;
  starts_at: string;
  duration_hours: number;
  announced: boolean;
  created_by: string;
  created_at: string;
}

function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : parseFloat(value);
}

/**
 * Project a governance-epoch row to a Record<>-shaped weights object.
 *
 * The `override` parameter is the storage-agnostic path: callers fetch
 * weights via readEpochWeightsForMultipleEpochs (or readEpochWeights for a
 * single epoch) and pass them here. The wide-column fallback is the legacy
 * path used by callers that still SELECT recency_weight..relevance_weight
 * inline. After PROJ-819 (P5) drops the wide columns, the fallback path
 * becomes a runtime error indicator; every caller is migrated to the
 * override path before then.
 */
function toWeights(row: GovernanceEpochRow, override?: Record<string, number>): GovernanceWeights {
  if (override) {
    return override as GovernanceWeights;
  }
  return {
    recency: toNumber(row.recency_weight),
    engagement: toNumber(row.engagement_weight),
    bridging: toNumber(row.bridging_weight),
    sourceDiversity: toNumber(row.source_diversity_weight),
    relevance: toNumber(row.relevance_weight),
  };
}

function toDbContentRules(rules: ContentRules): { include_keywords: string[]; exclude_keywords: string[] } {
  return {
    include_keywords: rules.includeKeywords,
    exclude_keywords: rules.excludeKeywords,
  };
}

function toPhase(row: GovernanceEpochRow): 'running' | 'voting' | 'results' {
  if (row.phase === 'voting' || row.phase === 'results' || row.phase === 'running') {
    return row.phase;
  }

  if (row.status === 'voting') {
    return 'voting';
  }

  return 'running';
}

function toProposedWeights(raw: unknown): GovernanceWeights | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const value = raw as Record<string, unknown>;
  const recency = typeof value.recency === 'number' ? value.recency : null;
  const engagement = typeof value.engagement === 'number' ? value.engagement : null;
  const bridging = typeof value.bridging === 'number' ? value.bridging : null;
  const sourceDiversity =
    typeof value.sourceDiversity === 'number' ? value.sourceDiversity : null;
  const relevance = typeof value.relevance === 'number' ? value.relevance : null;

  if (
    recency === null ||
    engagement === null ||
    bridging === null ||
    sourceDiversity === null ||
    relevance === null
  ) {
    return null;
  }

  return {
    recency,
    engagement,
    bridging,
    sourceDiversity,
    relevance,
  };
}

function toProposedContentRules(raw: unknown): ContentRules | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  return toContentRules(raw as any);
}

function toContentRulesPayload(rules: ContentRules): { include_keywords: string[]; exclude_keywords: string[] } {
  return {
    include_keywords: rules.includeKeywords,
    exclude_keywords: rules.excludeKeywords,
  };
}

function sanitizeKeywordList(keywords: string[]): string[] {
  const normalized = normalizeKeywords(keywords);

  if (normalized.length !== keywords.filter((keyword) => keyword.trim().length > 0).length) {
    throw new Error('Keywords must be non-empty and <= 50 characters');
  }

  for (const keyword of normalized) {
    if (!KEYWORD_PATTERN.test(keyword)) {
      throw new Error('Keywords may only include letters, numbers, spaces, and hyphens');
    }
  }

  return normalized;
}

function sanitizeSingleKeyword(rawKeyword: string): string {
  const normalized = sanitizeKeywordList([rawKeyword]);
  if (normalized.length !== 1) {
    throw new Error('Keyword is invalid');
  }
  return normalized[0];
}

function mapRound(
  row: GovernanceEpochRow,
  voteCount: number,
  weightsOverride?: Record<string, number>
) {
  const contentRules = toContentRules((row.content_rules ?? null) as any);

  return {
    id: row.id,
    status: row.status,
    phase: toPhase(row),
    voteCount,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    votingEndsAt: row.voting_ends_at,
    votingStartedAt: row.voting_started_at,
    votingClosedAt: row.voting_closed_at,
    resultsApprovedAt: row.results_approved_at,
    resultsApprovedBy: row.results_approved_by,
    proposedWeights: toProposedWeights(row.proposed_weights),
    proposedTopicWeights: parseStoredProposedTopicWeights(
      row.proposed_topic_weights,
      `governance epoch ${row.id} proposed policy`
    ),
    proposedContentRules: toProposedContentRules(row.proposed_content_rules),
    autoTransition: row.auto_transition,
    weights: toWeights(row, weightsOverride),
    topicWeights: parseStoredTopicWeights(
      row.topic_weights,
      `governance epoch ${row.id} active policy`
    ),
    contentRules: {
      includeKeywords: contentRules.includeKeywords,
      excludeKeywords: contentRules.excludeKeywords,
    },
  };
}

async function getCurrentEpochForUpdate(client: PoolClient): Promise<GovernanceEpochRow | null> {
  const result = await client.query<GovernanceEpochRow>(
    `SELECT *
     FROM governance_epochs
     WHERE status IN ('active', 'voting')
     ORDER BY id DESC
     LIMIT 1
     FOR UPDATE`
  );

  return result.rows[0] ?? null;
}

async function triggerManualRescore(reason: string): Promise<boolean> {
  requestFullRescore();
  try {
    const triggered = await tryTriggerManualScoringRun();

    if (!triggered) {
      logger.warn({ reason }, 'Manual rescore skipped because scoring pipeline is already running');
    }

    return triggered;
  } catch (error) {
    logger.error(
      { error, reason },
      'Manual rescore trigger failed; durable policy rescore remains pending'
    );
    return false;
  }
}

async function enqueuePolicyRescore(client: PoolClient, epochId: number): Promise<number> {
  const result = await client.query<{ requested_generation: number | string }>(
    `INSERT INTO governance_rescore_requests (
       epoch_id,
       requested_generation,
       completed_generation,
       requested_at,
       completed_at
     )
     VALUES ($1, 1, 0, NOW(), NULL)
     ON CONFLICT (epoch_id) DO UPDATE
     SET requested_generation = governance_rescore_requests.requested_generation + 1,
         requested_at = NOW(),
         completed_at = NULL
     RETURNING requested_generation`,
    [epochId]
  );
  const generation = Number.parseInt(String(result.rows[0]?.requested_generation ?? ''), 10);
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error(
      `Failed to enqueue policy rescore for governance epoch ${epochId}: invalid generation`
    );
  }

  return generation;
}

function mapScheduledVote(row: ScheduledVoteRow) {
  return {
    id: row.id,
    startsAt: row.starts_at,
    durationHours: row.duration_hours,
    announced: row.announced,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function registerGovernanceRoutes(app: FastifyInstance): void {
  app.get('/governance', {
    schema: {
      tags: ['Admin'],
      summary: 'Governance overview',
      description: 'Returns a full governance overview: the current round, all recent rounds (up to 30), current weights, content keywords, and voting schedule.',
      security: adminSecurity,
      response: {
        200: {
          type: 'object',
          properties: {
            currentRound: { ...roundSchema, nullable: true },
            rounds: { type: 'array', items: roundSchema },
            weights: { ...weightsSchema, nullable: true },
            includeKeywords: { type: 'array', items: { type: 'string' } },
            excludeKeywords: { type: 'array', items: { type: 'string' } },
            votingEndsAt: { type: 'string', format: 'date-time', nullable: true },
            autoTransition: { type: 'boolean' },
          },
        },
        500: ErrorResponseSchema,
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    // List N rounds without the 5 weight columns; per-component weights come
    // from the storage-agnostic batch reader so this route works the same
    // under both wide-column and long-table storage.
    const roundsResult = await db.query<GovernanceEpochRow & { vote_count: string }>(
      `SELECT
        e.id,
        e.status,
        e.phase,
        e.voting_ends_at,
        e.voting_started_at,
        e.voting_closed_at,
        e.results_approved_at,
        e.results_approved_by,
        e.proposed_weights,
        e.proposed_topic_weights,
        e.proposed_content_rules,
        e.auto_transition,
        e.topic_weights,
        e.content_rules,
        e.created_at,
        e.closed_at,
        COUNT(v.id)::int AS vote_count
       FROM governance_epochs e
       LEFT JOIN governance_votes v ON v.epoch_id = e.id
       GROUP BY e.id
       ORDER BY e.id DESC
       LIMIT 30`
    );

    const roundEpochIds = roundsResult.rows.map((row) => row.id);
    const weightsByEpoch = await readEpochWeightsForMultipleEpochs({ epochIds: roundEpochIds });
    let rounds: ReturnType<typeof mapRound>[];
    try {
      rounds = roundsResult.rows.map((row) =>
        mapRound(row, Number.parseInt(row.vote_count, 10), weightsByEpoch[row.id])
      );
    } catch (error) {
      if (!(error instanceof InvalidStoredTopicWeightsError)) {
        throw error;
      }
      logger.error({ error }, 'Stored governance policy is invalid in overview');
      return reply.code(500).send({
        error: 'InvalidGovernancePolicy',
        message: 'Stored governance policy is invalid',
      });
    }
    const currentRound = rounds.find((round) => round.status === 'active' || round.status === 'voting') ?? null;

    return reply.send({
      currentRound,
      rounds,
      weights: currentRound?.weights ?? null,
      includeKeywords: currentRound?.contentRules.includeKeywords ?? [],
      excludeKeywords: currentRound?.contentRules.excludeKeywords ?? [],
      votingEndsAt: currentRound?.votingEndsAt ?? null,
      autoTransition: currentRound?.autoTransition ?? false,
    });
  });

  app.post('/governance/start-voting', {
    schema: {
      tags: ['Admin'],
      summary: 'Start voting period',
      description: 'Opens a voting period on the current round. Optionally announces to Bluesky.',
      security: adminSecurity,
      body: StartVotingJsonSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            round: roundSchema,
          },
          required: ['success'],
        },
        400: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const adminDid = getAdminDid(request);
    const parseResult = StartVotingSchema.safeParse(request.body ?? {});

    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: 'Invalid start-voting request',
        details: parseResult.error.issues,
      });
    }

    const { durationHours, announce } = parseResult.data;
    const client = await db.connect();

    try {
      await client.query('BEGIN');

      const epoch = await getCurrentEpochForUpdate(client);
      if (!epoch) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'NoActiveRound', message: 'No active round found' });
      }

      const phase = toPhase(epoch);
      if (phase === 'voting') {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'AlreadyVoting',
          message: 'A voting period is already open for the current round',
        });
      }

      if (phase === 'results') {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'ResultsPending',
          message: 'Current round is awaiting results approval/rejection',
        });
      }

      const updatedResult = await client.query<GovernanceEpochRow>(
        `UPDATE governance_epochs
         SET phase = 'voting',
             status = 'active',
             voting_started_at = NOW(),
             voting_closed_at = NULL,
             voting_ends_at = NOW() + make_interval(hours => $1),
             auto_transition = TRUE,
             results_approved_at = NULL,
             results_approved_by = NULL,
             proposed_weights = NULL,
             proposed_topic_weights = NULL,
             proposed_content_rules = NULL
         WHERE id = $2
         RETURNING *`,
        [durationHours, epoch.id]
      );

      const voteCounts = await readGovernanceVoteCounts(client, epoch.id);

      await client.query(
        `INSERT INTO governance_audit_log (action, actor_did, epoch_id, details)
         VALUES ('admin_start_voting', $1, $2, $3)`,
        [
          adminDid,
          epoch.id,
          JSON.stringify({
            duration_hours: durationHours,
            announce,
          }),
        ]
      );

      await client.query('COMMIT');

      if (announce) {
        await announceVotingOpen({ id: epoch.id }, `${durationHours} hour(s)`);
      }

      return reply.send({
        success: true,
        round: mapRound(updatedResult.rows[0], voteCounts.total),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error, adminDid }, 'Failed to start voting period');
      return reply.code(500).send({
        error: 'StartVotingFailed',
        message: 'Failed to start voting period',
      });
    } finally {
      client.release();
    }
  });

  app.post('/governance/end-voting', {
    schema: {
      tags: ['Admin'],
      summary: 'End voting period',
      description: 'Closes the current voting period, aggregates votes, and moves the round to results phase. Optionally announces to Bluesky.',
      security: adminSecurity,
      body: EndVotingJsonSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            voteCount: { type: 'integer' },
            proposedWeights: weightsSchema,
            proposedTopicWeights: topicWeightsSchema,
            proposedContentRules: contentRulesSchema,
            round: roundSchema,
          },
          required: ['success'],
        },
        400: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const adminDid = getAdminDid(request);
    const parseResult = EndVotingSchema.safeParse(request.body ?? {});

    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: 'Invalid end-voting request',
        details: parseResult.error.issues,
      });
    }

    const { announce } = parseResult.data;
    const client = await db.connect();

    try {
      await client.query('BEGIN');

      const epoch = await getCurrentEpochForUpdate(client);
      if (!epoch) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'NoActiveRound', message: 'No active round found' });
      }

      const phase = toPhase(epoch);
      if (phase !== 'voting') {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'VotingNotOpen',
          message: 'Voting is not currently open for this round',
        });
      }

      const voteCounts = await readGovernanceVoteCounts(client, epoch.id);
      const previousWeights = toWeights(epoch);
      const previousTopicWeights = parseStoredTopicWeights(
        epoch.topic_weights,
        `governance epoch ${epoch.id} active policy`
      );
      const previousRules = toContentRules((epoch.content_rules ?? null) as any);

      let proposedWeights = previousWeights;
      let proposedTopicWeights = previousTopicWeights;
      let proposedRules = previousRules;

      if (voteCounts.total > 0) {
        const aggregatedWeights = await aggregateVotes(epoch.id);
        if (aggregatedWeights) {
          proposedWeights = aggregatedWeights;
        }
      }

      if (voteCounts.content > 0) {
        proposedRules = await aggregateContentVotes(epoch.id);
      }

      if (voteCounts.topic > 0) {
        proposedTopicWeights = await aggregateTopicWeights(epoch.id);
      }

      const updatedResult = await client.query<GovernanceEpochRow>(
        `UPDATE governance_epochs
         SET phase = 'results',
             voting_closed_at = NOW(),
             auto_transition = FALSE,
             proposed_weights = $1,
             proposed_content_rules = $2,
             proposed_topic_weights = $3
         WHERE id = $4
         RETURNING *`,
        [
          JSON.stringify(proposedWeights),
          JSON.stringify(toDbContentRules(proposedRules)),
          JSON.stringify(proposedTopicWeights),
          epoch.id,
        ]
      );

      await client.query(
        `INSERT INTO governance_audit_log (action, actor_did, epoch_id, details)
         VALUES ('admin_end_voting', $1, $2, $3)`,
        [
          adminDid,
          epoch.id,
          JSON.stringify({
            vote_count: voteCounts.total,
            content_vote_count: voteCounts.content,
            topic_vote_count: voteCounts.topic,
            proposed_weights: proposedWeights,
            proposed_topic_weights: proposedTopicWeights,
            proposed_content_rules: toDbContentRules(proposedRules),
            announce,
          }),
        ]
      );

      await client.query('COMMIT');

      if (announce) {
        await announceVotingClosed({ id: epoch.id }, voteCounts.total);
      }

      return reply.send({
        success: true,
        voteCount: voteCounts.total,
        proposedWeights,
        proposedTopicWeights,
        proposedContentRules: proposedRules,
        round: mapRound(updatedResult.rows[0], voteCounts.total),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error, adminDid }, 'Failed to end voting period');
      return reply.code(500).send({
        error: 'EndVotingFailed',
        message: 'Failed to end voting period',
      });
    } finally {
      client.release();
    }
  });

  app.post('/governance/approve-results', {
    schema: {
      tags: ['Admin'],
      summary: 'Approve voting results',
      description: 'Approves aggregated voting results, applying the proposed signal weights, topic weights, and content rules to the active epoch before triggering a rescore.',
      security: adminSecurity,
      body: ApproveResultsJsonSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            weights: weightsSchema,
            topicWeights: topicWeightsSchema,
            contentRules: contentRulesSchema,
            rescoreTriggered: { type: 'boolean' },
            round: roundSchema,
          },
          required: ['success'],
        },
        400: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const adminDid = getAdminDid(request);
    const parseResult = ApproveResultsSchema.safeParse(request.body ?? {});

    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: 'Invalid approve-results request',
        details: parseResult.error.issues,
      });
    }

    const { announce } = parseResult.data;
    const client = await db.connect();

    try {
      await client.query('BEGIN');

      const epoch = await getCurrentEpochForUpdate(client);
      if (!epoch) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'NoActiveRound', message: 'No active round found' });
      }

      if (toPhase(epoch) !== 'results') {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'ResultsNotPending',
          message: 'No pending results to approve',
        });
      }

      const voteCounts = await readGovernanceVoteCounts(client, epoch.id);
      if (voteCounts.total === 0) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'NoBallots',
          message: 'Results cannot be approved because this voting window received no ballots.',
        });
      }

      const oldWeights = toWeights(epoch);
      const oldTopicWeights = parseStoredTopicWeights(
        epoch.topic_weights,
        `governance epoch ${epoch.id} active policy`
      );
      const oldContentRules = toContentRules((epoch.content_rules ?? null) as any);
      const newWeights = toProposedWeights(epoch.proposed_weights) ?? oldWeights;
      const newTopicWeights = parseStoredProposedTopicWeights(
        epoch.proposed_topic_weights,
        `governance epoch ${epoch.id} proposed policy`
      ) ?? oldTopicWeights;
      const newContentRules = toProposedContentRules(epoch.proposed_content_rules) ?? oldContentRules;

      const updatedResult = await client.query<GovernanceEpochRow>(
        `UPDATE governance_epochs
         SET recency_weight = $1,
             engagement_weight = $2,
             bridging_weight = $3,
             source_diversity_weight = $4,
             relevance_weight = $5,
             topic_weights = $6,
             content_rules = $7,
             phase = 'running',
             voting_ends_at = NULL,
             auto_transition = FALSE,
             proposed_weights = NULL,
             proposed_topic_weights = NULL,
             proposed_content_rules = NULL,
             results_approved_at = NOW(),
             results_approved_by = $8
         WHERE id = $9
         RETURNING *`,
        [
          newWeights.recency,
          newWeights.engagement,
          newWeights.bridging,
          newWeights.sourceDiversity,
          newWeights.relevance,
          JSON.stringify(newTopicWeights),
          JSON.stringify(toDbContentRules(newContentRules)),
          adminDid,
          epoch.id,
        ]
      );

      if (config.GOVERNANCE_LONGTABLE_DUALWRITE_ENABLED) {
        await writeEpochWeights(client, epoch.id, newWeights);
      }

      const rescoreGeneration = await enqueuePolicyRescore(client, epoch.id);

      await client.query(
        `INSERT INTO governance_audit_log (action, actor_did, epoch_id, details)
         VALUES ('admin_approve_results', $1, $2, $3)`,
        [
          adminDid,
          epoch.id,
          JSON.stringify({
            old_weights: oldWeights,
            new_weights: newWeights,
            old_topic_weights: oldTopicWeights,
            new_topic_weights: newTopicWeights,
            old_content_rules: toDbContentRules(oldContentRules),
            new_content_rules: toDbContentRules(newContentRules),
            rescore_generation: rescoreGeneration,
            announce,
          }),
        ]
      );

      await client.query('COMMIT');

      // The durable rescore worker invalidates both policy caches before it
      // reads this generation. Keeping invalidation there makes post-commit
      // failures retryable instead of masking an already-approved policy.
      const rescoreTriggered = await triggerManualRescore('admin_approve_results');

      if (announce) {
        await announceResultsApproved(
          { id: epoch.id },
          {
            oldWeights,
            newWeights,
            oldContentRules,
            newContentRules,
          }
        );
      }

      return reply.send({
        success: true,
        weights: newWeights,
        topicWeights: newTopicWeights,
        contentRules: newContentRules,
        rescoreTriggered,
        round: mapRound(updatedResult.rows[0], voteCounts.total),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error, adminDid }, 'Failed to approve voting results');
      return reply.code(500).send({
        error: 'ApproveResultsFailed',
        message: 'Failed to approve voting results',
      });
    } finally {
      client.release();
    }
  });

  app.post('/governance/reject-results', {
    schema: {
      tags: ['Admin'],
      summary: 'Reject voting results',
      description: 'Rejects the proposed voting results and returns the round to running phase. Weights remain unchanged.',
      security: adminSecurity,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            round: roundSchema,
          },
          required: ['success'],
        },
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const adminDid = getAdminDid(request);
    const client = await db.connect();

    try {
      await client.query('BEGIN');

      const epoch = await getCurrentEpochForUpdate(client);
      if (!epoch) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'NoActiveRound', message: 'No active round found' });
      }

      if (toPhase(epoch) !== 'results') {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'ResultsNotPending',
          message: 'No pending results to reject',
        });
      }

      const updatedResult = await client.query<GovernanceEpochRow>(
        `UPDATE governance_epochs
         SET phase = 'running',
             voting_ends_at = NULL,
             auto_transition = FALSE,
             proposed_weights = NULL,
             proposed_topic_weights = NULL,
             proposed_content_rules = NULL
         WHERE id = $1
         RETURNING *`,
        [epoch.id]
      );

      const voteCounts = await readGovernanceVoteCounts(client, epoch.id);

      await client.query(
        `INSERT INTO governance_audit_log (action, actor_did, epoch_id, details)
         VALUES ('admin_reject_results', $1, $2, $3)`,
        [
          adminDid,
          epoch.id,
          JSON.stringify({
            rejected_at: new Date().toISOString(),
          }),
        ]
      );

      await client.query('COMMIT');

      return reply.send({
        success: true,
        round: mapRound(updatedResult.rows[0], voteCounts.total),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error, adminDid }, 'Failed to reject voting results');
      return reply.code(500).send({
        error: 'RejectResultsFailed',
        message: 'Failed to reject voting results',
      });
    } finally {
      client.release();
    }
  });

  app.post('/governance/schedule-vote', {
    schema: {
      tags: ['Admin'],
      summary: 'Schedule a future vote',
      description: 'Schedules a voting period to start automatically at a future time. Announces the schedule to Bluesky.',
      security: adminSecurity,
      body: ScheduleVoteJsonSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            scheduledVote: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                startsAt: { type: 'string', format: 'date-time' },
                durationHours: { type: 'integer' },
                announced: { type: 'boolean' },
                createdBy: { type: 'string' },
                createdAt: { type: 'string', format: 'date-time' },
              },
            },
          },
          required: ['success'],
        },
        400: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const adminDid = getAdminDid(request);
    const parseResult = ScheduleVoteSchema.safeParse(request.body ?? {});

    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: 'Invalid schedule-vote request',
        details: parseResult.error.issues,
      });
    }

    const startsAt = new Date(parseResult.data.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: 'startsAt must be a valid ISO datetime string',
      });
    }

    if (startsAt.getTime() <= Date.now()) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: 'startsAt must be in the future',
      });
    }

    const result = await db.query<ScheduledVoteRow>(
      `INSERT INTO scheduled_votes (starts_at, duration_hours, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, starts_at, duration_hours, announced, created_by, created_at`,
      [startsAt.toISOString(), parseResult.data.durationHours, adminDid]
    );

    const scheduledVote = mapScheduledVote(result.rows[0]);

    await db.query(
      `INSERT INTO governance_audit_log (action, actor_did, details)
       VALUES ('admin_schedule_vote', $1, $2)`,
      [
        adminDid,
        JSON.stringify({
          scheduled_vote_id: scheduledVote.id,
          starts_at: scheduledVote.startsAt,
          duration_hours: scheduledVote.durationHours,
        }),
      ]
    );

    await announceVoteScheduled({
      id: scheduledVote.id,
      startsAt: scheduledVote.startsAt,
      durationHours: scheduledVote.durationHours,
    });

    return reply.send({
      success: true,
      scheduledVote,
    });
  });

  app.get('/governance/schedule', {
    schema: {
      tags: ['Admin'],
      summary: 'List scheduled votes',
      description: 'Returns upcoming and recently past scheduled voting periods.',
      security: adminSecurity,
      response: {
        200: {
          type: 'object',
          properties: {
            scheduledVotes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer' },
                  startsAt: { type: 'string', format: 'date-time' },
                  durationHours: { type: 'integer' },
                  announced: { type: 'boolean' },
                  createdBy: { type: 'string' },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const result = await db.query<ScheduledVoteRow>(
      `SELECT id, starts_at, duration_hours, announced, created_by, created_at
       FROM scheduled_votes
       WHERE starts_at >= NOW() - INTERVAL '1 hour'
       ORDER BY starts_at ASC`
    );

    return reply.send({
      scheduledVotes: result.rows.map(mapScheduledVote),
    });
  });

  app.patch('/governance/content-rules', {
    schema: {
      tags: ['Admin'],
      summary: 'Override content rules',
      description: 'Admin override of include/exclude keyword lists on the current epoch. Triggers a rescore.',
      security: adminSecurity,
      body: {
        type: 'object',
        properties: {
          includeKeywords: { type: 'array', items: { type: 'string' } },
          excludeKeywords: { type: 'array', items: { type: 'string' } },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            rules: contentRulesSchema,
            rescoreTriggered: { type: 'boolean' },
          },
          required: ['success'],
        },
        400: ErrorResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const adminDid = getAdminDid(request);
    const parseResult = ContentRulesPatchSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: 'Invalid content rules payload',
        details: parseResult.error.issues,
      });
    }

    const client = await db.connect();

    try {
      await client.query('BEGIN');

      const epoch = await getCurrentEpochForUpdate(client);
      if (!epoch) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'NoActiveRound', message: 'No active round found' });
      }

      const previousRules = toContentRules((epoch.content_rules ?? null) as any);
      const includeKeywords =
        parseResult.data.includeKeywords !== undefined
          ? sanitizeKeywordList(parseResult.data.includeKeywords)
          : previousRules.includeKeywords;
      const excludeKeywords =
        parseResult.data.excludeKeywords !== undefined
          ? sanitizeKeywordList(parseResult.data.excludeKeywords)
          : previousRules.excludeKeywords;

      const updatedRules: ContentRules = { includeKeywords, excludeKeywords };

      await client.query(
        `UPDATE governance_epochs
         SET content_rules = $1
         WHERE id = $2`,
        [JSON.stringify(toContentRulesPayload(updatedRules)), epoch.id]
      );

      const rescoreGeneration = await enqueuePolicyRescore(client, epoch.id);

      await client.query(
        `INSERT INTO governance_audit_log (action, actor_did, epoch_id, details)
         VALUES ('admin_rules_override', $1, $2, $3)`,
        [
          adminDid,
          epoch.id,
          JSON.stringify({
            rescore_generation: rescoreGeneration,
            old_content_rules: toContentRulesPayload(previousRules),
            new_content_rules: toContentRulesPayload(updatedRules),
          }),
        ]
      );

      await client.query('COMMIT');

      await invalidateContentRulesCache();
      const rescoreTriggered = await triggerManualRescore('admin_rules_override');

      return reply.send({
        success: true,
        rules: updatedRules,
        rescoreTriggered,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error, adminDid }, 'Failed to update content rules');

      const message = error instanceof Error ? error.message : 'Failed to update content rules';
      return reply.code(500).send({ error: 'UpdateFailed', message });
    } finally {
      client.release();
    }
  });

  app.post('/governance/content-rules/keyword', {
    schema: {
      tags: ['Admin'],
      summary: 'Add a keyword',
      description: 'Adds a single keyword to either the include or exclude list. Triggers a rescore.',
      security: adminSecurity,
      body: KeywordActionJsonSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            rules: contentRulesSchema,
            rescoreTriggered: { type: 'boolean' },
          },
          required: ['success'],
        },
        400: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const adminDid = getAdminDid(request);
    const parseResult = KeywordActionSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: 'Invalid keyword request',
        details: parseResult.error.issues,
      });
    }

    const { type } = parseResult.data;
    let keyword: string;

    try {
      keyword = sanitizeSingleKeyword(parseResult.data.keyword);
    } catch (error) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: error instanceof Error ? error.message : 'Invalid keyword',
      });
    }

    const client = await db.connect();

    try {
      await client.query('BEGIN');

      const epoch = await getCurrentEpochForUpdate(client);
      if (!epoch) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'NoActiveRound', message: 'No active round found' });
      }

      const previousRules = toContentRules((epoch.content_rules ?? null) as any);
      const nextRules: ContentRules = {
        includeKeywords: [...previousRules.includeKeywords],
        excludeKeywords: [...previousRules.excludeKeywords],
      };

      const target = type === 'include' ? nextRules.includeKeywords : nextRules.excludeKeywords;

      if (target.includes(keyword)) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'Conflict',
          message: 'Keyword already exists in this rule set',
        });
      }

      if (target.length >= 20) {
        await client.query('ROLLBACK');
        return reply.code(400).send({
          error: 'ValidationError',
          message: 'Maximum 20 keywords allowed per rule set',
        });
      }

      target.push(keyword);

      await client.query(
        `UPDATE governance_epochs
         SET content_rules = $1
         WHERE id = $2`,
        [JSON.stringify(toContentRulesPayload(nextRules)), epoch.id]
      );

      const rescoreGeneration = await enqueuePolicyRescore(client, epoch.id);

      await client.query(
        `INSERT INTO governance_audit_log (action, actor_did, epoch_id, details)
         VALUES ('admin_keyword_added', $1, $2, $3)`,
        [
          adminDid,
          epoch.id,
          JSON.stringify({
            rescore_generation: rescoreGeneration,
            type,
            keyword,
            old_content_rules: toContentRulesPayload(previousRules),
            new_content_rules: toContentRulesPayload(nextRules),
          }),
        ]
      );

      await client.query('COMMIT');

      await invalidateContentRulesCache();
      const rescoreTriggered = await triggerManualRescore('admin_keyword_added');

      return reply.send({
        success: true,
        rules: nextRules,
        rescoreTriggered,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error, adminDid, type }, 'Failed to add keyword');

      return reply.code(500).send({
        error: 'KeywordAddFailed',
        message: 'Failed to add keyword',
      });
    } finally {
      client.release();
    }
  });

  app.delete('/governance/content-rules/keyword', {
    schema: {
      tags: ['Admin'],
      summary: 'Remove a keyword',
      description: 'Removes a keyword from the include or exclude list. Removing the last include keyword requires confirm=true. Triggers a rescore.',
      security: adminSecurity,
      body: KeywordActionJsonSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            rules: contentRulesSchema,
            rescoreTriggered: { type: 'boolean' },
          },
          required: ['success'],
        },
        400: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const adminDid = getAdminDid(request);
    const parseResult = KeywordActionSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: 'Invalid keyword request',
        details: parseResult.error.issues,
      });
    }

    const { type, confirm } = parseResult.data;
    let keyword: string;

    try {
      keyword = sanitizeSingleKeyword(parseResult.data.keyword);
    } catch (error) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: error instanceof Error ? error.message : 'Invalid keyword',
      });
    }

    const client = await db.connect();

    try {
      await client.query('BEGIN');

      const epoch = await getCurrentEpochForUpdate(client);
      if (!epoch) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'NoActiveRound', message: 'No active round found' });
      }

      const previousRules = toContentRules((epoch.content_rules ?? null) as any);
      const nextRules: ContentRules = {
        includeKeywords: [...previousRules.includeKeywords],
        excludeKeywords: [...previousRules.excludeKeywords],
      };

      const target = type === 'include' ? nextRules.includeKeywords : nextRules.excludeKeywords;
      const index = target.indexOf(keyword);

      if (index === -1) {
        await client.query('ROLLBACK');
        return reply.code(404).send({
          error: 'NotFound',
          message: 'Keyword not found in this rule set',
        });
      }

      if (type === 'include' && target.length === 1 && confirm !== true) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'ConfirmationRequired',
          message: 'Removing the last include keyword requires confirm=true',
        });
      }

      target.splice(index, 1);

      await client.query(
        `UPDATE governance_epochs
         SET content_rules = $1
         WHERE id = $2`,
        [JSON.stringify(toContentRulesPayload(nextRules)), epoch.id]
      );

      const rescoreGeneration = await enqueuePolicyRescore(client, epoch.id);

      await client.query(
        `INSERT INTO governance_audit_log (action, actor_did, epoch_id, details)
         VALUES ('admin_keyword_removed', $1, $2, $3)`,
        [
          adminDid,
          epoch.id,
          JSON.stringify({
            rescore_generation: rescoreGeneration,
            type,
            keyword,
            old_content_rules: toContentRulesPayload(previousRules),
            new_content_rules: toContentRulesPayload(nextRules),
          }),
        ]
      );

      await client.query('COMMIT');

      await invalidateContentRulesCache();
      const rescoreTriggered = await triggerManualRescore('admin_keyword_removed');

      return reply.send({
        success: true,
        rules: nextRules,
        rescoreTriggered,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error, adminDid, type }, 'Failed to remove keyword');

      return reply.code(500).send({
        error: 'KeywordRemoveFailed',
        message: 'Failed to remove keyword',
      });
    } finally {
      client.release();
    }
  });

  app.patch('/governance/weights', {
    schema: {
      tags: ['Admin'],
      summary: 'Override weights',
      description: 'Admin override of governance weights on the current epoch. Partial updates supported — omitted weights keep their current value. Result is normalized to sum to 1.0. Triggers a rescore.',
      security: adminSecurity,
      body: {
        type: 'object',
        properties: {
          recency: { type: 'number', minimum: 0, maximum: 1 },
          engagement: { type: 'number', minimum: 0, maximum: 1 },
          bridging: { type: 'number', minimum: 0, maximum: 1 },
          sourceDiversity: { type: 'number', minimum: 0, maximum: 1 },
          relevance: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            weights: weightsSchema,
            rescoreTriggered: { type: 'boolean' },
          },
          required: ['success'],
        },
        400: ErrorResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const adminDid = getAdminDid(request);
    const parseResult = WeightPatchSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: 'Invalid weight override payload',
        details: parseResult.error.issues,
      });
    }

    const client = await db.connect();

    try {
      await client.query('BEGIN');

      const epoch = await getCurrentEpochForUpdate(client);
      if (!epoch) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'NoActiveRound', message: 'No active round found' });
      }

      const previousWeights = toWeights(epoch);
      const mergedWeights: GovernanceWeights = {
        recency: parseResult.data.recency ?? previousWeights.recency,
        engagement: parseResult.data.engagement ?? previousWeights.engagement,
        bridging: parseResult.data.bridging ?? previousWeights.bridging,
        sourceDiversity: parseResult.data.sourceDiversity ?? previousWeights.sourceDiversity,
        relevance: parseResult.data.relevance ?? previousWeights.relevance,
      };

      const normalizedWeights = normalizeWeights(mergedWeights);

      await client.query(
        `UPDATE governance_epochs
         SET recency_weight = $1,
             engagement_weight = $2,
             bridging_weight = $3,
             source_diversity_weight = $4,
             relevance_weight = $5
         WHERE id = $6`,
        [
          normalizedWeights.recency,
          normalizedWeights.engagement,
          normalizedWeights.bridging,
          normalizedWeights.sourceDiversity,
          normalizedWeights.relevance,
          epoch.id,
        ]
      );

      const rescoreGeneration = await enqueuePolicyRescore(client, epoch.id);

      await client.query(
        `INSERT INTO governance_audit_log (action, actor_did, epoch_id, details)
         VALUES ('admin_weights_override', $1, $2, $3)`,
        [
          adminDid,
          epoch.id,
          JSON.stringify({
            rescore_generation: rescoreGeneration,
            old_weights: previousWeights,
            new_weights: normalizedWeights,
            override: parseResult.data,
          }),
        ]
      );

      await client.query('COMMIT');

      const rescoreTriggered = await triggerManualRescore('admin_weights_override');

      return reply.send({
        success: true,
        weights: normalizedWeights,
        rescoreTriggered,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error, adminDid }, 'Failed to update governance weights');

      const message = error instanceof Error ? error.message : 'Failed to update weights';
      return reply.code(500).send({
        error: 'WeightUpdateFailed',
        message,
      });
    } finally {
      client.release();
    }
  });

  app.post('/governance/extend-voting', {
    schema: {
      tags: ['Admin'],
      summary: 'Extend voting period',
      description: 'Extends the current voting period by the specified number of hours. Only works while voting is open.',
      security: adminSecurity,
      body: ExtendVotingJsonSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            round: roundSchema,
          },
          required: ['success'],
        },
        400: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const adminDid = getAdminDid(request);
    const parseResult = ExtendVotingSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: 'Invalid extend-voting request',
        details: parseResult.error.issues,
      });
    }

    const { hours } = parseResult.data;
    const client = await db.connect();

    try {
      await client.query('BEGIN');

      const epoch = await getCurrentEpochForUpdate(client);
      if (!epoch) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'NoActiveRound', message: 'No active round found' });
      }

      if (toPhase(epoch) !== 'voting') {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'VotingClosed',
          message: 'Voting can only be extended while the round is in voting phase.',
        });
      }

      const updatedResult = await client.query<GovernanceEpochRow>(
        `UPDATE governance_epochs
         SET voting_ends_at = COALESCE(voting_ends_at, NOW()) + make_interval(hours => $1)
         WHERE id = $2
         RETURNING *`,
        [hours, epoch.id]
      );

      const voteCounts = await readGovernanceVoteCounts(client, epoch.id);
      const voteCount = voteCounts.total;

      await client.query(
        `INSERT INTO governance_audit_log (action, actor_did, epoch_id, details)
         VALUES ('admin_extend_voting', $1, $2, $3)`,
        [
          adminDid,
          epoch.id,
          JSON.stringify({
            hours,
            previous_voting_ends_at: epoch.voting_ends_at,
            new_voting_ends_at: updatedResult.rows[0].voting_ends_at,
          }),
        ]
      );

      await client.query('COMMIT');

      return reply.send({
        success: true,
        round: mapRound(updatedResult.rows[0], voteCount),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error, adminDid }, 'Failed to extend voting');

      return reply.code(500).send({
        error: 'ExtendVotingFailed',
        message: 'Failed to extend voting',
      });
    } finally {
      client.release();
    }
  });

  app.post('/governance/apply-results', {
    schema: {
      tags: ['Admin'],
      summary: 'Approve pending results (legacy alias)',
      description: 'Deprecated compatibility alias for approving an already-reviewed results phase. It cannot bypass voting closure or results review.',
      security: adminSecurity,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            voteCount: { type: 'integer' },
            appliedWeights: { type: 'boolean', description: 'Whether aggregated weights were applied (false if no votes)' },
            weights: weightsSchema,
            topicWeights: topicWeightsSchema,
            contentRules: contentRulesSchema,
            round: roundSchema,
            rescoreTriggered: { type: 'boolean' },
          },
          required: ['success'],
        },
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const adminDid = getAdminDid(request);
    const client = await db.connect();

    try {
      await client.query('BEGIN');

      const epoch = await getCurrentEpochForUpdate(client);
      if (!epoch) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'NoActiveRound', message: 'No active round found' });
      }

      if (toPhase(epoch) !== 'results') {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'ResultsNotPending',
          message: 'Close voting and review the proposed policy before approving results',
        });
      }

      const voteCounts = await readGovernanceVoteCounts(client, epoch.id);
      if (voteCounts.total === 0) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'NoBallots',
          message: 'Results cannot be approved because this voting window received no ballots.',
        });
      }
      const voteCount = voteCounts.total;

      const previousWeights = toWeights(epoch);
      const previousTopicWeights = parseStoredTopicWeights(
        epoch.topic_weights,
        `governance epoch ${epoch.id} active policy`
      );
      const previousRules = toContentRules((epoch.content_rules ?? null) as any);
      const nextWeights = toProposedWeights(epoch.proposed_weights) ?? previousWeights;
      const nextTopicWeights = parseStoredProposedTopicWeights(
        epoch.proposed_topic_weights,
        `governance epoch ${epoch.id} proposed policy`
      ) ?? previousTopicWeights;
      const nextRules = toProposedContentRules(epoch.proposed_content_rules) ?? previousRules;

      const updatedResult = await client.query<GovernanceEpochRow>(
        `UPDATE governance_epochs
         SET recency_weight = $1,
             engagement_weight = $2,
             bridging_weight = $3,
             source_diversity_weight = $4,
             relevance_weight = $5,
             topic_weights = $6,
             content_rules = $7,
             vote_count = $8,
             phase = 'running',
             voting_closed_at = NOW(),
             voting_ends_at = NULL,
             auto_transition = FALSE,
             proposed_weights = NULL,
             proposed_topic_weights = NULL,
             proposed_content_rules = NULL,
             results_approved_at = NOW(),
             results_approved_by = $9
         WHERE id = $10
         RETURNING *`,
        [
          nextWeights.recency,
          nextWeights.engagement,
          nextWeights.bridging,
          nextWeights.sourceDiversity,
          nextWeights.relevance,
          JSON.stringify(nextTopicWeights),
          JSON.stringify(toContentRulesPayload(nextRules)),
          voteCount,
          adminDid,
          epoch.id,
        ]
      );

      if (config.GOVERNANCE_LONGTABLE_DUALWRITE_ENABLED) {
        await writeEpochWeights(client, epoch.id, nextWeights);
      }

      const rescoreGeneration = await enqueuePolicyRescore(client, epoch.id);

      await client.query(
        `INSERT INTO governance_audit_log (action, actor_did, epoch_id, details)
         VALUES ('admin_apply_results', $1, $2, $3)`,
        [
          adminDid,
          epoch.id,
          JSON.stringify({
            vote_count: voteCount,
            old_weights: previousWeights,
            new_weights: nextWeights,
            old_topic_weights: previousTopicWeights,
            new_topic_weights: nextTopicWeights,
            old_content_rules: toContentRulesPayload(previousRules),
            new_content_rules: toContentRulesPayload(nextRules),
            rescore_generation: rescoreGeneration,
          }),
        ]
      );

      await client.query('COMMIT');

      // Cache invalidation belongs to the durable worker for the same
      // post-commit retry guarantee as the canonical approval route.
      const rescoreTriggered = await triggerManualRescore('admin_apply_results');

      return reply.send({
        success: true,
        voteCount,
        appliedWeights: voteCount > 0,
        weights: nextWeights,
        topicWeights: nextTopicWeights,
        contentRules: nextRules,
        round: mapRound(updatedResult.rows[0], voteCount),
        rescoreTriggered,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error, adminDid }, 'Failed to apply round results');

      return reply.code(500).send({
        error: 'ApplyResultsFailed',
        message: 'Failed to apply results',
      });
    } finally {
      client.release();
    }
  });

  app.get('/governance/rounds/:id', {
    schema: {
      tags: ['Admin'],
      summary: 'Get round detail',
      description: 'Returns full detail for a specific governance round including starting/ending weights, vote configurations, duration, and audit trail.',
      security: adminSecurity,
      params: RoundIdParamsJsonSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            round: roundSchema,
            startingWeights: weightsSchema,
            endingWeights: weightsSchema,
            startingRules: contentRulesSchema,
            endingRules: contentRulesSchema,
            voteCount: { type: 'integer' },
            weightConfigurations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  count: { type: 'integer' },
                  weights: { ...weightsSchema, nullable: true },
                },
              },
            },
            duration: {
              type: 'object',
              properties: {
                startedAt: { type: 'string', format: 'date-time' },
                endedAt: { type: 'string', format: 'date-time', nullable: true },
                durationMs: { type: 'integer' },
              },
            },
            auditTrail: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  action: { type: 'string' },
                  details: { type: 'object', additionalProperties: true },
                  created_at: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        400: ErrorResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = RoundIdParamsSchema.safeParse(request.params);

    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: 'Round id must be a positive integer',
        details: parseResult.error.issues,
      });
    }

    const roundId = parseResult.data.id;

    const roundResult = await db.query<GovernanceEpochRow>(
      `SELECT * FROM governance_epochs WHERE id = $1`,
      [roundId]
    );

    if (roundResult.rows.length === 0) {
      return reply.code(404).send({
        error: 'RoundNotFound',
        message: `Round ${roundId} not found`,
      });
    }

    const round = roundResult.rows[0];
    const endingWeights = toWeights(round);
    const endingRules = toContentRules((round.content_rules ?? null) as any);

    const auditResult = await db.query<{ action: string; details: unknown; created_at: string }>(
      `SELECT action, details, created_at
       FROM governance_audit_log
       WHERE epoch_id = $1
       ORDER BY created_at ASC`,
      [roundId]
    );

    let startingWeights = endingWeights;
    let startingRules = endingRules;
    let foundStartingWeights = false;
    let foundStartingRules = false;

    for (const entry of auditResult.rows) {
      const details = (entry.details ?? null) as Record<string, unknown> | null;
      if (!details || typeof details !== 'object') {
        continue;
      }

      if (!foundStartingWeights && details.old_weights && typeof details.old_weights === 'object') {
        const oldWeights = details.old_weights as Record<string, number>;
        if (
          oldWeights.recency !== undefined &&
          oldWeights.engagement !== undefined &&
          oldWeights.bridging !== undefined &&
          oldWeights.sourceDiversity !== undefined &&
          oldWeights.relevance !== undefined
        ) {
          startingWeights = {
            recency: oldWeights.recency,
            engagement: oldWeights.engagement,
            bridging: oldWeights.bridging,
            sourceDiversity: oldWeights.sourceDiversity,
            relevance: oldWeights.relevance,
          };
          foundStartingWeights = true;
        }
      }

      if (!foundStartingRules && details.old_content_rules && typeof details.old_content_rules === 'object') {
        startingRules = toContentRules(details.old_content_rules as any);
        foundStartingRules = true;
      }
    }

    const voteCountResult = await db.query<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM governance_votes WHERE epoch_id = $1`,
      [roundId]
    );
    const voteCount = parseInt(voteCountResult.rows[0]?.count ?? '0', 10);

    const groupedVotesResult = await db.query<{
      recency_weight: number | null;
      engagement_weight: number | null;
      bridging_weight: number | null;
      source_diversity_weight: number | null;
      relevance_weight: number | null;
      count: string;
    }>(
      `SELECT
        recency_weight,
        engagement_weight,
        bridging_weight,
        source_diversity_weight,
        relevance_weight,
        COUNT(*)::int AS count
       FROM governance_votes
       WHERE epoch_id = $1
       GROUP BY recency_weight, engagement_weight, bridging_weight, source_diversity_weight, relevance_weight
       ORDER BY count DESC`,
      [roundId]
    );

    const nowMs = Date.now();
    const startMs = new Date(round.created_at).getTime();
    const endMs = round.closed_at ? new Date(round.closed_at).getTime() : nowMs;
    const durationMs = Math.max(0, endMs - startMs);

    let mappedRound: ReturnType<typeof mapRound>;
    try {
      mappedRound = mapRound(round, voteCount);
    } catch (error) {
      if (!(error instanceof InvalidStoredTopicWeightsError)) {
        throw error;
      }
      logger.error({ error, roundId }, 'Stored governance policy is invalid in round detail');
      return reply.code(500).send({
        error: 'InvalidGovernancePolicy',
        message: 'Stored governance policy is invalid',
      });
    }

    return reply.send({
      round: mappedRound,
      startingWeights,
      endingWeights,
      startingRules,
      endingRules,
      voteCount,
      weightConfigurations: groupedVotesResult.rows.map((row) => ({
        count: parseInt(row.count, 10),
        weights:
          row.recency_weight === null ||
          row.engagement_weight === null ||
          row.bridging_weight === null ||
          row.source_diversity_weight === null ||
          row.relevance_weight === null
            ? null
            : {
                recency: row.recency_weight,
                engagement: row.engagement_weight,
                bridging: row.bridging_weight,
                sourceDiversity: row.source_diversity_weight,
                relevance: row.relevance_weight,
              },
      })),
      duration: {
        startedAt: round.created_at,
        endedAt: round.closed_at,
        durationMs,
      },
      auditTrail: auditResult.rows,
    });
  });

  app.post('/governance/end-round', {
    schema: {
      tags: ['Admin'],
      summary: 'Direct transition disabled',
      description: 'Direct round transitions are disabled. Use start voting, end voting, results review, and approval so the complete policy is applied before rescoring.',
      security: adminSecurity,
      response: {
        409: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    getAdminDid(request);
    return reply.code(409).send({
      error: 'DirectTransitionDisabled',
      message: 'Direct round transitions are disabled. Start voting, close voting, review the proposed policy, and approve results.',
    });
  });
}
