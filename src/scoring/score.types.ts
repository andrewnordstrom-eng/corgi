/**
 * Score Types
 *
 * Type definitions for the scoring pipeline.
 * These types enforce the GOLDEN RULE: always store raw, weight, AND weighted values.
 */

import type { GovernanceWeights } from '../shared/api-types.js';

export const CLASSIFICATION_METHODS = ['keyword', 'embedding'] as const;

export type ClassificationMethod = typeof CLASSIFICATION_METHODS[number];

/**
 * Per-component score map: `Record<componentKey, value 0..1>`. Was a 5-field
 * interface before PROJ-816; now reuses the registry-driven shape from
 * GovernanceWeights so the type contract no longer fossilizes a 5-component
 * assumption. The 5 production keys (recency, engagement, bridging,
 * sourceDiversity, relevance) are validated at runtime via
 * `REGISTERED_COMPONENT_KEYS` in src/scoring/registry.ts.
 */
export type ScoreComponents = GovernanceWeights;

/** Bridging calculation retained for one candidate after each bounded DB batch. */
export interface BridgingScoreEvidence {
  raw: number;
  evidenceState: 'observed' | 'insufficient';
  engagerCount: number;
  pairCount: number;
}

/**
 * Complete score decomposition for a post.
 * This is what gets stored in the database - all the data needed for transparency.
 */
export interface WeightedScore {
  /** Raw component scores (0.0-1.0) */
  raw: ScoreComponents;
  /** Weights from governance epoch (must sum to 1.0) */
  weights: ScoreComponents;
  /** Weighted values (raw × weight) */
  weighted: ScoreComponents;
  /** Final combined score (sum of weighted values) */
  total: number;
}

/**
 * A post with its computed score.
 * Used during pipeline processing.
 */
export interface ScoredPost {
  uri: string;
  authorDid: string;
  /** The scored post's own posts.created_at — carried through so score writes
   *  bind the partition key directly instead of re-looking it up by uri
   *  (which is no longer unique on its own after the PROJ-917 rebuild). */
  createdAt: Date;
  score: WeightedScore;
}

/**
 * Governance epoch with weights.
 * Represents the current algorithm configuration.
 *
 * PROJ-816: the 5 named `*Weight: number` fields were replaced with a single
 * `weights: GovernanceWeights` map keyed by registered component_key. Today
 * the live registry still produces 5 keys (recency, engagement, bridging,
 * sourceDiversity, relevance); the shape change is what unblocks future
 * additions. PROJ-817 (P4) flips `toGovernanceEpoch` to read from the
 * `governance_epoch_weights` long table when the flag is on.
 */
export interface GovernanceEpoch {
  id: number;
  status: 'active' | 'voting' | 'closed';
  weights: GovernanceWeights;
  voteCount: number;
  createdAt: Date;
  closedAt: Date | null;
  description: string | null;
  /** Community-voted topic weights from governance. Slug → weight (0.0-1.0). */
  topicWeights?: Record<string, number>;
}

/**
 * Post data from database with engagement counts.
 * This is what gets fetched for scoring.
 */
export interface PostForScoring {
  uri: string;
  cid: string;
  authorDid: string;
  text: string | null;
  replyRoot: string | null;
  replyParent: string | null;
  langs: string[];
  hasMedia: boolean;
  createdAt: Date;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  /** Topic classification vector from ingestion. Slug → confidence (0.0-1.0). */
  topicVector?: Record<string, number>;
  /** Which classifier produced the topic_vector: winkNLP keywords or Transformers.js embeddings. */
  classificationMethod?: ClassificationMethod;
}

function weightFromRow(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (value === null || value === undefined) {
    return 0;
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

/**
 * Convert snake_case DB row to camelCase GovernanceEpoch.
 *
 * PROJ-816: projects the 5 wide weight columns into `weights` as a Record map.
 * PROJ-817 (P4) is responsible for the flag-gated long-table source switch
 * (which requires async DB access and is therefore done at the query layer,
 * not in this synchronous row-to-object helper).
 */
export function toGovernanceEpoch(row: Record<string, unknown>): GovernanceEpoch {
  return {
    id: row.id as number,
    status: row.status as 'active' | 'voting' | 'closed',
    weights: {
      recency: weightFromRow(row, 'recency_weight'),
      engagement: weightFromRow(row, 'engagement_weight'),
      bridging: weightFromRow(row, 'bridging_weight'),
      sourceDiversity: weightFromRow(row, 'source_diversity_weight'),
      relevance: weightFromRow(row, 'relevance_weight'),
    },
    voteCount: row.vote_count as number,
    createdAt: new Date(row.created_at as string),
    closedAt: row.closed_at ? new Date(row.closed_at as string) : null,
    description: row.description as string | null,
    topicWeights: (row.topic_weights as Record<string, number>) ?? {},
  };
}

/**
 * Convert snake_case DB row to camelCase PostForScoring.
 */
export function toPostForScoring(row: Record<string, unknown>): PostForScoring {
  return {
    uri: row.uri as string,
    cid: row.cid as string,
    authorDid: row.author_did as string,
    text: row.text as string | null,
    replyRoot: row.reply_root as string | null,
    replyParent: row.reply_parent as string | null,
    langs: (row.langs as string[]) ?? [],
    hasMedia: row.has_media as boolean,
    createdAt: new Date(row.created_at as string),
    likeCount: (row.like_count as number) ?? 0,
    repostCount: (row.repost_count as number) ?? 0,
    replyCount: (row.reply_count as number) ?? 0,
    topicVector: (row.topic_vector as Record<string, number>) ?? {},
    classificationMethod: (row.classification_method as string) === 'embedding' ? 'embedding' : 'keyword',
  };
}
