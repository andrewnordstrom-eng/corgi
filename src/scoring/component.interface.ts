/**
 * Scoring Component Interface
 *
 * Defines the contract for pluggable scoring components.
 * Each component returns a 0.0-1.0 score for a given post.
 *
 * To add a new scoring component:
 * 1. Implement the ScoringComponent interface
 * 2. Add to the registry in registry.ts
 * 3. Add a votable weight param in src/config/votable-params.ts
 * 4. Add corresponding DB columns (raw, weight, weighted) to post_scores
 * 5. Update the frontend — sliders are auto-generated from votable-params
 */

import type { PostForScoring, GovernanceEpoch, BridgingScoreEvidence } from './score.types.js';
import type { GovernanceWeightKey } from '../config/votable-params.js';

/**
 * Shared context passed to all components during a single scoring run.
 */
export interface ScoringContext {
  readonly epoch: GovernanceEpoch;
  readonly scoringWindowHours: number;
  /** Immutable ranking clock. V2 always supplies this; optional for legacy adapters. */
  readonly asOf?: Date;
  /** Mutable map shared across components in a single run. */
  readonly authorCounts: Map<string, number>;
  /**
   * Per-post source-diversity scores precomputed in `posts`-array order BEFORE
   * the concurrent scoring loop, so parallelism cannot change them (PROJ-917).
   * Keyed by `PostForScoring` object identity (robust even if two candidate
   * rows share a uri, possible now the posts PK is `(uri, created_at)`).
   * Absent for non-pipeline callers, which fall back to `authorCounts`.
   */
  readonly sourceDiversityByPost?: ReadonlyMap<PostForScoring, number>;
  /** Run-scoped bounded batch evidence keyed by post identity; absent for legacy callers. */
  readonly bridgingEvidenceByPost?: ReadonlyMap<PostForScoring, BridgingScoreEvidence>;
}

/**
 * A pluggable scoring component that contributes to the total post score.
 */
export interface ScoringComponent {
  /** Must match a GovernanceWeightKey from votable-params. */
  readonly key: GovernanceWeightKey;
  /** Human-readable name for logs and diagnostics. */
  readonly name: string;
  /** Score a post. Must return a value between 0.0 and 1.0. */
  score(post: PostForScoring, context: ScoringContext): Promise<number>;
  /** Optional efficient path keyed by `${uri}\0${createdAt.toISOString()}`. */
  scoreBatch?(
    posts: readonly PostForScoring[],
    context: ScoringContext
  ): Promise<ReadonlyMap<string, number>>;
}

export interface SlateReranker<TInput, TOutput> {
  readonly key: string;
  rerank(items: readonly TInput[], limit: number): readonly TOutput[];
}
