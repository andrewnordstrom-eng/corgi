/**
 * Bridging Scoring Component
 *
 * Measures cross-cluster appeal - does this post attract engagement
 * from users in different social "bubbles"?
 *
 * MVP Implementation: Jaccard distance of engager follow sets.
 * - Get users who liked/reposted the post
 * - Compare their follow sets pairwise
 * - Low overlap = high bridging (they come from different "worlds")
 *
 * Upgrade path:
 * 1. MVP: Follower overlap of engagers (implemented here)
 * 2. V2: Pre-cluster subscribers, check which clusters engaged
 * 3. V3: Matrix factorization (Community Notes approach)
 *
 * This is designed to be pluggable - swap the implementation later.
 */

import type { PoolClient } from 'pg';
import { db } from '../../db/client.js';
import type { ScoringComponent } from '../component.interface.js';
import type { BridgingScoreEvidence, PostForScoring } from '../score.types.js';

/** Maximum engagers to consider (performance limit) */
const MAX_ENGAGERS = 50;

/** Maximum follows to fetch per engager (performance limit) */
const MAX_FOLLOWS_PER_ENGAGER = 200;

/** Maximum engagers to use for pairwise comparison */
const MAX_PAIRWISE_ENGAGERS = 20;

/** Default score when insufficient data */
const DEFAULT_BRIDGING_SCORE = 0.3;

/** Minimum engagers needed for meaningful bridging calculation */
const MIN_ENGAGERS = 2;

interface EngagerRow {
  post_uri: string;
  author_did: string;
}

interface FollowRow {
  author_did: string;
  subject_did: string;
}

/**
 * Calculate bridging score for a post.
 *
 * @param postUri - The post's AT-URI
 * @param _authorDid - The post author's DID (unused in MVP, kept for future)
 * @returns Score between 0.0 and 1.0 (higher = more cross-cluster appeal)
 */
export async function scoreBridging(
  postUri: string,
  _authorDid: string
): Promise<number> {
  // Get DIDs of users who engaged with this post
  const engagers = await db.query(
    `SELECT DISTINCT author_did FROM (
       SELECT author_did FROM likes WHERE subject_uri = $1 AND deleted = FALSE
       UNION ALL
       SELECT author_did FROM reposts WHERE subject_uri = $1 AND deleted = FALSE
     ) AS engagers
     ORDER BY author_did
     LIMIT $2`,
    [postUri, MAX_ENGAGERS]
  );

  // Not enough engagers for meaningful comparison
  if (engagers.rows.length < MIN_ENGAGERS) {
    return DEFAULT_BRIDGING_SCORE;
  }

  const engagerDids = engagers.rows.map((r: { author_did: string }) => r.author_did);

  // Get who each engager follows (limited for performance)
  const followSets: Map<string, Set<string>> = new Map();

  // Limit to MAX_PAIRWISE_ENGAGERS for O(n²) comparison
  const engagersToCompare = engagerDids.slice(0, MAX_PAIRWISE_ENGAGERS);

  for (const did of engagersToCompare) {
    const follows = await db.query(
      `SELECT subject_did FROM follows
        WHERE author_did = $1 AND deleted = FALSE
        ORDER BY subject_did
        LIMIT $2`,
      [did, MAX_FOLLOWS_PER_ENGAGER]
    );
    followSets.set(
      did,
      new Set(follows.rows.map((r: { subject_did: string }) => r.subject_did))
    );
  }

  // Compute average pairwise Jaccard distance (1 - Jaccard similarity)
  let totalDistance = 0;
  let pairCount = 0;

  const dids = Array.from(followSets.keys());

  for (let i = 0; i < dids.length; i++) {
    for (let j = i + 1; j < dids.length; j++) {
      const setA = followSets.get(dids[i])!;
      const setB = followSets.get(dids[j])!;

      const distance = jaccardDistance(setA, setB);
      totalDistance += distance;
      pairCount++;
    }
  }

  if (pairCount === 0) {
    return DEFAULT_BRIDGING_SCORE;
  }

  const avgDistance = totalDistance / pairCount;

  // Normalize: 0.0 (identical audiences) to 1.0 (completely different audiences)
  return Math.min(1.0, avgDistance);
}

/** Batch the engager and follow reads for all candidates in one ranking run. */
export async function scoreBridgingBatch(
  client: PoolClient,
  posts: readonly PostForScoring[]
): Promise<ReadonlyMap<string, BridgingScoreEvidence>> {
  if (posts.length === 0) {
    return new Map();
  }
  const uris = [...new Set(posts.map((post) => post.uri))];
  const engagerResult = await client.query<EngagerRow>(
    `WITH combined AS (
       SELECT subject_uri AS post_uri, author_did FROM likes
        WHERE subject_uri = ANY($1::text[]) AND deleted = FALSE
       UNION
       SELECT subject_uri AS post_uri, author_did FROM reposts
        WHERE subject_uri = ANY($1::text[]) AND deleted = FALSE
     ), ranked AS (
       SELECT post_uri, author_did,
              ROW_NUMBER() OVER (PARTITION BY post_uri ORDER BY author_did) AS ordinal
         FROM combined
     )
     SELECT post_uri, author_did
       FROM ranked
      WHERE ordinal <= $2
      ORDER BY post_uri, author_did`,
    [uris, MAX_ENGAGERS]
  );
  const engagersByUri = new Map<string, string[]>();
  for (const row of engagerResult.rows) {
    const engagers = engagersByUri.get(row.post_uri) ?? [];
    engagers.push(row.author_did);
    engagersByUri.set(row.post_uri, engagers);
  }

  const comparisonDids = [...new Set(
    [...engagersByUri.values()].flatMap((engagers) => engagers.slice(0, MAX_PAIRWISE_ENGAGERS))
  )];
  const followSets = new Map<string, Set<string>>();
  if (comparisonDids.length > 0) {
    const followResult = await client.query<FollowRow>(
      `WITH ranked AS (
         SELECT author_did, subject_did,
                ROW_NUMBER() OVER (PARTITION BY author_did ORDER BY subject_did) AS ordinal
           FROM follows
          WHERE author_did = ANY($1::text[]) AND deleted = FALSE
       )
       SELECT author_did, subject_did
         FROM ranked
        WHERE ordinal <= $2
        ORDER BY author_did, subject_did`,
      [comparisonDids, MAX_FOLLOWS_PER_ENGAGER]
    );
    for (const did of comparisonDids) {
      followSets.set(did, new Set());
    }
    for (const row of followResult.rows) {
      followSets.get(row.author_did)?.add(row.subject_did);
    }
  }

  const output = new Map<string, BridgingScoreEvidence>();
  for (const post of posts) {
    const engagers = engagersByUri.get(post.uri) ?? [];
    output.set(
      `${post.uri}\u0000${post.createdAt.toISOString()}`,
      calculateBridgingEvidence(engagers, followSets)
    );
  }
  return output;
}

/** Compute bridging evidence from deterministic engager and follow-set inputs. */
export function calculateBridgingEvidence(
  engagers: readonly string[],
  followSets: ReadonlyMap<string, ReadonlySet<string>>
): BridgingScoreEvidence {
  if (engagers.length < MIN_ENGAGERS) {
    return {
      raw: DEFAULT_BRIDGING_SCORE,
      evidenceState: 'insufficient',
      engagerCount: engagers.length,
      pairCount: 0,
    };
  }
  const selected = engagers.slice(0, MAX_PAIRWISE_ENGAGERS);
  let totalDistance = 0;
  let pairCount = 0;
  for (let left = 0; left < selected.length; left += 1) {
    for (let right = left + 1; right < selected.length; right += 1) {
      const leftSet = followSets.get(selected[left]) ?? new Set<string>();
      const rightSet = followSets.get(selected[right]) ?? new Set<string>();
      totalDistance += jaccardDistance(leftSet, rightSet);
      pairCount += 1;
    }
  }
  if (pairCount === 0) {
    return {
      raw: DEFAULT_BRIDGING_SCORE,
      evidenceState: 'insufficient',
      engagerCount: engagers.length,
      pairCount,
    };
  }
  return {
    raw: Math.min(1, totalDistance / pairCount),
    evidenceState: 'observed',
    engagerCount: engagers.length,
    pairCount,
  };
}

/**
 * Calculate Jaccard distance between two sets.
 * Jaccard distance = 1 - (|A ∩ B| / |A ∪ B|)
 *
 * @param setA - First set
 * @param setB - Second set
 * @returns Distance between 0.0 (identical) and 1.0 (completely disjoint)
 */
function jaccardDistance(setA: ReadonlySet<string>, setB: ReadonlySet<string>): number {
  if (setA.size === 0 && setB.size === 0) {
    // Both empty - consider as identical
    return 0;
  }

  // Calculate intersection
  let intersectionSize = 0;
  for (const item of setA) {
    if (setB.has(item)) {
      intersectionSize++;
    }
  }

  // Union size = A + B - intersection
  const unionSize = setA.size + setB.size - intersectionSize;

  if (unionSize === 0) {
    return 0;
  }

  const similarity = intersectionSize / unionSize;
  return 1 - similarity;
}

/** ScoringComponent wrapper for the bridging scorer. */
export const bridgingComponent: ScoringComponent = {
  key: 'bridging',
  name: 'Bridging',
  async score(post, context) {
    if (context.bridgingEvidenceByPost !== undefined) {
      const evidence = context.bridgingEvidenceByPost.get(post);
      if (evidence === undefined) {
        throw new Error(`Bridging batch omitted candidate evidence for ${post.uri}`);
      }
      return evidence.raw;
    }
    return scoreBridging(post.uri, post.authorDid);
  },
};
