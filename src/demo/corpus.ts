import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { db as defaultDb } from '../db/client.js';
import { logger } from '../lib/logger.js';
import {
  createDefaultPublishedFeedSnapshotReader,
  readApprovedCommunityGovPolicy,
  readApprovedCommunityGovSnapshot,
  COMMUNITY_GOV_FEED_URI,
  DEMO_SOURCE_SNAPSHOT_LIMIT,
  type PublishedFeedSnapshot,
} from '../feed/demo-snapshot-source.js';
import { readPostScore, type PostScoreRecord, type ReadPostScoreOptions } from '../scoring/score-reader.js';
import { hydrateCorpusItemsWithAppView, type DemoFetchFunction } from './appview.js';
import { hiddenDisplayPost } from './public-view.js';
import {
  SHADOW_DEMO_SESSION_TTL_SECONDS,
  SHADOW_DEMO_CORPUS_PROVENANCE,
  SHADOW_DEMO_TOPIC_KEYS,
  type ShadowDemoCommunity,
  type ShadowDemoCommunityId,
  type ShadowDemoCorpus,
  type ShadowDemoCorpusHealth,
  type ShadowDemoCorpusItem,
  type ShadowDemoDisplayPost,
  type ShadowDemoRawScores,
  type ShadowDemoWarning,
  type ShadowDemoTopicIntent,
  type ShadowDemoTopicKey,
  type ShadowDemoTopicCatalogEntry,
  type ShadowDemoPublicationPolicy,
  type ShadowDemoWeights,
} from './types.js';
import { equalShadowWeights, internalRawScoresToShadow, internalWeightsToShadow } from './weights.js';
import { emptyShadowTopicIntent } from './topic-intent.js';
import { COMMUNITY_GOV_SNAPSHOT_GATE } from './snapshot-capture.js';

export { COMMUNITY_GOV_SNAPSHOT_GATE } from './snapshot-capture.js';

export const DEMO_COMMUNITIES: Record<ShadowDemoCommunityId, ShadowDemoCommunity> = {
  community_gov: {
    id: 'community_gov',
    name: 'Corgi Commons',
    status: 'live_shadow',
    description:
      'The real public Corgi feed, frozen into an isolated comparison corpus for a replayable governance walkthrough.',
    liveFeedReady: true,
  },
  open_science_builders: {
    id: 'open_science_builders',
    name: 'Open Science Builders',
    status: 'live_shadow',
    description:
      'Research, reusable datasets, open-source methods, and software that moves knowledge across disciplines.',
    liveFeedReady: true,
  },
  birders_who_code: {
    id: 'birders_who_code',
    name: 'Birders Who Code',
    status: 'degraded',
    description:
      'Warbler sightings, messy CSVs, camera traps, bug reports, and deploy jokes ranked by community policy.',
    liveFeedReady: false,
  },
  crit_fumble_pickup: {
    id: 'crit_fumble_pickup',
    name: 'Crit Fumble Pickup',
    status: 'degraded',
    description:
      'A tabletop community concept for rules debates, painted minis, session logs, and dramatic dice stories.',
    liveFeedReady: false,
  },
  osint_garden_club: {
    id: 'osint_garden_club',
    name: 'OSINT Garden Club',
    status: 'degraded',
    description:
      'A community concept for satellite sleuthing, botany threads, public records, and surprisingly intense plant IDs.',
    liveFeedReady: false,
  },
};

const CANDIDATE_LIMIT = 80;
const SCORE_READ_BATCH_SIZE = 10;
const APPVIEW_TIMEOUT_MS = 8000;
const MIN_PUBLIC_SCORED_POSTS = 10;
const OPEN_SCIENCE_TOPIC_SLUGS = SHADOW_DEMO_TOPIC_KEYS;
const OPEN_SCIENCE_TERM_RULES = [
  { label: 'research', pattern: '\\mresearch\\M' },
  { label: 'preprint', pattern: '\\mpreprints?\\M' },
  { label: 'dataset', pattern: '\\mdatasets?\\M' },
  { label: 'open source', pattern: '\\mopen[- ]source\\M' },
  { label: 'replication', pattern: '\\mreplicat(e|ed|ion|ing)\\M' },
  { label: 'reproducibility', pattern: '\\mreproduc(e|ed|ible|ibility|tion)\\M' },
  { label: 'method', pattern: '\\mmethods?\\M' },
  { label: 'study', pattern: '\\mstud(y|ies)\\M' },
  { label: 'science', pattern: '\\msci(ence|entific)\\M' },
  { label: 'paper', pattern: '\\mpapers?\\M' },
  { label: 'software', pattern: '\\msoftware\\M' },
  { label: 'code', pattern: '\\mcode\\M' },
  { label: 'GitHub', pattern: '\\mgithub\\M' },
  { label: 'repository', pattern: '\\mrepositor(y|ies)\\M' },
  { label: 'notebook', pattern: '\\mnotebooks?\\M' },
  { label: 'Python', pattern: '\\mpython\\M' },
  { label: 'RStats', pattern: '\\mrstats\\M' },
  { label: 'Julia', pattern: '\\mjulia\\M' },
  { label: 'analysis', pattern: '\\manalys(is|es)\\M' },
  { label: 'benchmark', pattern: '\\mbenchmarks?\\M' },
  { label: 'model', pattern: '\\mmodels?\\M' },
  { label: 'CSV', pattern: '\\mcsv\\M' },
  { label: 'API', pattern: '\\mapi\\M' },
] as const;
const COMPILED_OPEN_SCIENCE_TERM_RULES = OPEN_SCIENCE_TERM_RULES.map((rule) => ({
  label: rule.label,
  regex: new RegExp(rule.pattern.replaceAll('\\m', '\\b').replaceAll('\\M', '\\b'), 'i'),
}));

interface ActiveEpochRow {
  id: number;
  recency_weight: number;
  engagement_weight: number;
  bridging_weight: number;
  source_diversity_weight: number;
  relevance_weight: number;
  topic_weights: Record<string, number> | null;
}

interface CandidatePostRow {
  uri: string;
  reviewed_cid?: string | null;
  author_did: string;
  created_at: Date | string;
  text: string;
  topic_vector: Record<string, number> | null;
  candidate_count_72h: string | number;
  unique_authors_72h: string | number;
  embed_url?: string | null;
  text_length?: string | number;
}

export interface LoadShadowDemoCorpusOptions {
  communityId: ShadowDemoCommunityId;
  now: Date;
  fetchFn: DemoFetchFunction;
  dbPool: Pick<Pool, 'query'>;
  readScore: (options: ReadPostScoreOptions) => Promise<PostScoreRecord | null>;
  readPublishedSnapshot?: (limit: number) => Promise<PublishedFeedSnapshot>;
}

export interface CommunityGovCapturePolicy {
  signalWeights: ShadowDemoWeights;
  topicCatalog: ShadowDemoTopicCatalogEntry[];
  publicationPolicy: ShadowDemoPublicationPolicy;
}

interface CommunityGovCorpusBehavior {
  policy: CommunityGovCapturePolicy;
  gateFailureMode: 'fixture_fallback' | 'return_degraded_live';
  loadFailureMode: 'fixture_fallback' | 'throw';
}

export async function loadShadowDemoCorpus(options: LoadShadowDemoCorpusOptions): Promise<ShadowDemoCorpus> {
  if (options.communityId === 'community_gov') {
    return loadCommunityGovCorpus(options, {
      policy: readApprovedCommunityGovPolicy(),
      gateFailureMode: 'fixture_fallback',
      loadFailureMode: 'fixture_fallback',
    });
  }
  if (options.communityId !== 'open_science_builders') {
    return fallbackCorpus({
      communityId: options.communityId,
      now: options.now,
      reason: `Community ${options.communityId} is not wired to a live shadow corpus in v1`,
    });
  }

  try {
    const epoch = await readLatestActiveEpoch(options.dbPool);
    if (!epoch) {
      return fallbackCorpus({
        communityId: options.communityId,
        now: options.now,
        reason: 'No active production epoch was available for the shadow demo corpus',
      });
    }

    const candidates = await readOpenScienceCandidates({
      dbPool: options.dbPool,
      epochId: epoch.id,
    });
    const scoredItems = await buildScoredCorpusItems({
      rows: candidates,
      epochId: epoch.id,
      readScore: options.readScore,
    });
    const hydratedItems = await hydrateCorpusItemsWithAppView({
      items: scoredItems,
      fetchFn: options.fetchFn,
      timeoutMs: APPVIEW_TIMEOUT_MS,
    });
    const publicCount = hydratedItems.filter((item) => item.displayPost.kind === 'public_post').length;
    const health = buildHealth({
      now: options.now,
      rows: candidates,
      items: hydratedItems,
      source: publicCount >= MIN_PUBLIC_SCORED_POSTS ? 'production_scores_appview' : 'fixture_fallback',
    });

    if (publicCount < MIN_PUBLIC_SCORED_POSTS) {
      return fallbackCorpus({
        communityId: options.communityId,
        now: options.now,
        reason: `Only ${publicCount} public scored Open Science Builders candidates passed the scout threshold`,
        activeEpochId: epoch.id,
        baseWeights: epochWeights(epoch),
        baseTopicIntent: epochTopicIntent(epoch),
        health,
      });
    }

    return {
      corpusId: `corpus-${randomUUID()}`,
      communityId: options.communityId,
      baseProductionEpochId: epoch.id,
      baseWeights: epochWeights(epoch),
      baseTopicIntent: epochTopicIntent(epoch),
      createdAt: options.now.toISOString(),
      expiresAt: expiresAt(options.now).toISOString(),
      items: hydratedItems,
      health,
      warnings: [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, communityId: options.communityId }, 'Shadow demo live corpus load failed');
    return fallbackCorpus({
      communityId: options.communityId,
      now: options.now,
      reason: `Live Open Science Builders corpus could not be loaded: ${message}`,
    });
  }
}

export async function loadCommunityGovCaptureCorpus(
  options: Omit<LoadShadowDemoCorpusOptions, 'communityId'> & { policy: CommunityGovCapturePolicy }
): Promise<ShadowDemoCorpus> {
  return loadCommunityGovCorpus({
    communityId: 'community_gov',
    now: options.now,
    fetchFn: options.fetchFn,
    dbPool: options.dbPool,
    readScore: options.readScore,
    readPublishedSnapshot: options.readPublishedSnapshot,
  }, {
    policy: options.policy,
    gateFailureMode: 'return_degraded_live',
    loadFailureMode: 'throw',
  });
}

export function createDefaultCorpusLoader(): (options: {
  communityId: ShadowDemoCommunityId;
  now: Date;
}) => Promise<ShadowDemoCorpus> {
  return async (options) => loadShadowDemoCorpus({
    communityId: options.communityId,
    now: options.now,
    fetchFn: defaultFetch,
    dbPool: defaultDb,
    readScore: readPostScore,
    readPublishedSnapshot: createDefaultPublishedFeedSnapshotReader(),
  });
}

async function loadCommunityGovCorpus(
  options: LoadShadowDemoCorpusOptions,
  behavior: CommunityGovCorpusBehavior
): Promise<ShadowDemoCorpus> {
  try {
    const approvedPolicy = behavior.policy;
    const readPublishedSnapshot = options.readPublishedSnapshot ?? createDefaultPublishedFeedSnapshotReader();
    const snapshot = await readPublishedSnapshot(DEMO_SOURCE_SNAPSHOT_LIMIT);
    // Retention absence is not deletion. Frozen ranking inputs remain valid,
    // but explicit current local deletion evidence must still deny hydration.
    const deletedUris = await readDeletedPublishedUris(options.dbPool, snapshot);
    const topicCatalog = approvedPolicy.topicCatalog;
    const baseTopicIntent = topicIntentFromCatalog(null, topicCatalog);
    const orderedRows = snapshot.entries.flatMap((entry) => {
      const frozen = entry.frozen;
      if (deletedUris.has(entry.uri) || !frozen) return [];
      return [{
        uri: entry.uri,
        reviewed_cid: frozen.reviewedCid,
        author_did: frozen.authorDid,
        created_at: frozen.createdAt,
        text: '', // Bodies are obtained only from current public AppView.
        topic_vector: { ...frozen.topicVector },
        embed_url: frozen.embedUrl,
        text_length: frozen.textLength,
        candidate_count_72h: snapshot.entries.length,
        unique_authors_72h: 0,
        published: entry,
      }];
    });
    const scoredItems = await buildScoredCorpusItems({
      rows: orderedRows,
      epochId: snapshot.productionEpochId,
      readScore: options.readScore,
    });
    const hydrated = await hydrateCorpusItemsWithAppView({
      items: scoredItems,
      fetchFn: options.fetchFn,
      timeoutMs: APPVIEW_TIMEOUT_MS,
    });
    const eligibleItems = hydrated.filter((item) => item.displayPost.kind === 'public_post');
    const health = buildCommunityGovHealth(
      new Date(snapshot.capturedAt),
      snapshot,
      eligibleItems,
      eligibleItems.length
    );
    const gateFailures = communityGovSnapshotGateFailures(health);
    const reviewedHealth = applyCommunityGovSnapshotGateStatus(health);
    if (gateFailures.length > 0 && behavior.gateFailureMode === 'fixture_fallback') {
      return fallbackCorpus({
        communityId: options.communityId,
        now: options.now,
        reason: `Corgi Commons snapshot failed reviewer-safe gates: ${gateFailures.join('; ')}`,
        activeEpochId: snapshot.productionEpochId,
        baseWeights: approvedPolicy.signalWeights,
        baseTopicIntent,
        topicCatalog,
        sourceFeedUri: snapshot.feedUri,
      });
    }
    const warning = gateFailures.length > 0
      ? [{
          code: 'shadow_demo_snapshot_not_approvable',
          message: `Corgi Commons snapshot failed reviewer-safe gates: ${gateFailures.join('; ')}`,
          severity: 'degraded' as const,
        }]
      : [];
    return {
      corpusId: `corpus-${randomUUID()}`,
      communityId: options.communityId,
      baseProductionEpochId: snapshot.productionEpochId,
      baseWeights: approvedPolicy.signalWeights,
      baseTopicIntent,
      createdAt: options.now.toISOString(),
      expiresAt: expiresAt(options.now).toISOString(),
      items: eligibleItems,
      health: reviewedHealth,
      warnings: warning,
      topicCatalog,
      sourceFeedUri: snapshot.feedUri,
      sourceSnapshot: {
        feedName: snapshot.feedName,
        digest: snapshot.snapshotDigest,
        runId: snapshot.sourceRunId,
        updatedAt: snapshot.sourceUpdatedAt,
        capturedAt: snapshot.capturedAt,
        reviewedAt: snapshot.reviewedAt,
        sourcePostCount: snapshot.entries.length,
        selectionPolicyVersion: snapshot.selectionPolicyVersion,
        baselineOrderDigest: snapshot.baselineOrderDigest,
        publicationPolicy: {
          ...approvedPolicy.publicationPolicy,
          decay: [...approvedPolicy.publicationPolicy.decay],
        },
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'Corgi Commons demo snapshot load failed');
    if (behavior.loadFailureMode === 'throw') {
      throw new Error(`Corgi Commons live snapshot capture could not be loaded: ${message}`, { cause: err });
    }
    // The v4 API requires the complete approved 26-topic policy. Snapshot-entry
    // failures may degrade to the fixture; policy corruption fails closed.
    const approvedPolicy = readApprovedCommunityGovPolicy();
    return fallbackCorpus({
      communityId: options.communityId,
      now: options.now,
      reason: `Corgi Commons snapshot could not be loaded: ${message}`,
      activeEpochId: 0,
      baseWeights: approvedPolicy.signalWeights,
      baseTopicIntent: {
        topicWeights: Object.fromEntries(approvedPolicy.topicCatalog.map((topic) => [topic.slug, topic.baselineWeight])),
      },
      topicCatalog: approvedPolicy.topicCatalog,
      sourceFeedUri: COMMUNITY_GOV_FEED_URI,
    });
  }
}

export function communityGovSnapshotGateFailures(health: ShadowDemoCorpusHealth): string[] {
  const failures: string[] = [];
  const eligible = health.eligiblePostCount ?? health.publicScoredPosts;
  if (eligible < COMMUNITY_GOV_SNAPSHOT_GATE.minimumEligiblePosts) {
    failures.push(`eligible posts ${eligible} < ${COMMUNITY_GOV_SNAPSHOT_GATE.minimumEligiblePosts}`);
  }
  if (health.publicScoredPosts < COMMUNITY_GOV_SNAPSHOT_GATE.minimumDisplayablePosts) {
    failures.push(`displayable posts ${health.publicScoredPosts} < ${COMMUNITY_GOV_SNAPSHOT_GATE.minimumDisplayablePosts}`);
  }
  const englishShare = health.englishTaggedShare ?? 0;
  if (englishShare < COMMUNITY_GOV_SNAPSHOT_GATE.minimumEnglishTaggedShare) {
    failures.push(`English-tagged share ${englishShare} < ${COMMUNITY_GOV_SNAPSHOT_GATE.minimumEnglishTaggedShare}`);
  }
  if (health.topAuthorConcentration > COMMUNITY_GOV_SNAPSHOT_GATE.maximumTopAuthorConcentration) {
    failures.push(`top-author concentration ${health.topAuthorConcentration} > ${COMMUNITY_GOV_SNAPSHOT_GATE.maximumTopAuthorConcentration}`);
  }
  const richMediaShare = health.richMediaShare ?? 0;
  if (richMediaShare < COMMUNITY_GOV_SNAPSHOT_GATE.minimumRichMediaShare) {
    failures.push(`rich-media share ${richMediaShare} < ${COMMUNITY_GOV_SNAPSHOT_GATE.minimumRichMediaShare}`);
  }
  return failures;
}

export function applyCommunityGovSnapshotGateStatus(
  health: ShadowDemoCorpusHealth
): ShadowDemoCorpusHealth {
  if (communityGovSnapshotGateFailures(health).length === 0) return health;
  return { ...health, status: 'degraded' };
}

async function readDeletedPublishedUris(
  dbPool: Pick<Pool, 'query'>,
  snapshot: PublishedFeedSnapshot
): Promise<Set<string>> {
  const result = await dbPool.query<{ uri: string }>(
    `SELECT DISTINCT uri FROM posts
     WHERE uri = ANY($1::text[]) AND deleted = TRUE`,
    [snapshot.entries.map((entry) => entry.uri)]
  );
  return new Set(result.rows.map((row) => row.uri));
}

function topicIntentFromCatalog(
  epochWeights: Record<string, number> | null,
  catalog: ShadowDemoTopicCatalogEntry[]
): ShadowDemoTopicIntent {
  return {
    topicWeights: Object.fromEntries(catalog.map((topic) => [
      topic.slug,
      finiteTopicWeight(epochWeights?.[topic.slug] ?? topic.baselineWeight),
    ])),
  };
}

function finiteTopicWeight(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

function buildCommunityGovHealth(
  now: Date,
  snapshot: PublishedFeedSnapshot,
  items: ShadowDemoCorpusItem[],
  eligiblePostCount: number
): ShadowDemoCorpusHealth {
  const englishTagged = items.filter((item) =>
    item.displayPost.kind === 'public_post'
    && item.displayPost.languages?.some(isEnglishLanguageTag)
  ).length;
  const richMedia = items.filter((item) =>
    item.displayPost.kind === 'public_post' && item.displayPost.media !== null && item.displayPost.media !== undefined
  ).length;
  return {
    status:
      eligiblePostCount >= COMMUNITY_GOV_SNAPSHOT_GATE.minimumEligiblePosts
      && items.length >= COMMUNITY_GOV_SNAPSHOT_GATE.minimumDisplayablePosts
        ? 'live'
        : 'degraded',
    source: 'production_feed_snapshot',
    candidatePosts72h: snapshot.entries.length,
    publicScoredPosts: items.length,
    uniqueAuthors72h: uniqueAuthorCount(items),
    bridgePostShare: bridgePostShare(items),
    topAuthorConcentration: topAuthorConcentration(items),
    sampledAt: now.toISOString(),
    sourcePostCount: snapshot.entries.length,
    eligiblePostCount,
    englishTaggedShare: items.length === 0 ? 0 : Number((englishTagged / items.length).toFixed(3)),
    richMediaShare: items.length === 0 ? 0 : Number((richMedia / items.length).toFixed(3)),
  };
}

export function isEnglishLanguageTag(language: string): boolean {
  const normalized = language.toLowerCase();
  return normalized === 'en' || normalized.startsWith('en-');
}

async function readLatestActiveEpoch(dbPool: Pick<Pool, 'query'>): Promise<ActiveEpochRow | null> {
  const result = await dbPool.query<ActiveEpochRow>(
    `SELECT id, recency_weight, engagement_weight, bridging_weight, source_diversity_weight, relevance_weight,
            topic_weights
     FROM governance_epochs
     WHERE status = 'active'
     ORDER BY id DESC
     LIMIT 1`
  );
  return result.rows[0] ?? null;
}

async function readOpenScienceCandidates(options: {
  dbPool: Pick<Pool, 'query'>;
  epochId: number;
}): Promise<CandidatePostRow[]> {
  const result = await options.dbPool.query<CandidatePostRow>(
    `WITH scored_candidates AS (
       SELECT DISTINCT ON (p.uri)
              p.uri, p.author_did, p.created_at, p.text, p.topic_vector, ps.total_score
       FROM posts p
       JOIN post_scores ps ON ps.post_uri = p.uri
       WHERE ps.epoch_id = $1
         AND p.deleted = FALSE
         AND p.created_at >= NOW() - INTERVAL '72 hours'
         AND EXISTS (
           SELECT 1
           FROM jsonb_each_text(COALESCE(p.topic_vector, '{}'::jsonb)) topic
           WHERE topic.key = ANY($2::text[])
             AND topic.value::double precision >= $3
         )
         AND p.text ~* ANY($4::text[])
       ORDER BY p.uri, ps.total_score DESC, p.created_at DESC
     ),
     candidates AS (
       SELECT uri, author_did, created_at, text, topic_vector
       FROM scored_candidates
       ORDER BY total_score DESC, created_at DESC
       LIMIT ${CANDIDATE_LIMIT}
     ),
     metrics AS (
       SELECT COUNT(*) AS candidate_count_72h,
              COUNT(DISTINCT author_did) AS unique_authors_72h
       FROM scored_candidates
     )
     SELECT c.uri, c.author_did, c.created_at, c.text, c.topic_vector,
            m.candidate_count_72h, m.unique_authors_72h
     FROM candidates c
     CROSS JOIN metrics m`,
    [
      options.epochId,
      [...OPEN_SCIENCE_TOPIC_SLUGS],
      SHADOW_DEMO_CORPUS_PROVENANCE.topicScoreThreshold,
      OPEN_SCIENCE_TERM_RULES.map((rule) => rule.pattern),
    ]
  );
  return result.rows;
}

async function buildScoredCorpusItems(options: {
  rows: Array<CandidatePostRow & { published?: PublishedFeedSnapshot['entries'][number] }>;
  epochId: number;
  readScore: (options: ReadPostScoreOptions) => Promise<PostScoreRecord | null>;
}): Promise<ShadowDemoCorpusItem[]> {
  const items: ShadowDemoCorpusItem[] = [];
  for (let start = 0; start < options.rows.length; start += SCORE_READ_BATCH_SIZE) {
    const batch = options.rows.slice(start, start + SCORE_READ_BATCH_SIZE);
    const scoredBatch = await Promise.all(batch.map(async (row) => {
      const frozen = row.published?.frozen;
      const score = frozen
        ? {
            postUri: row.uri,
            epochId: frozen.scoreEpochId,
            totalScore: frozen.componentScore,
            scoredAt: new Date(frozen.scoredAt),
            classificationMethod: 'keyword' as const,
            componentDetails: { run_id: frozen.scoreRunId, source: 'approved_demo_snapshot' },
            components: {
              recency: { raw: frozen.rawScores.recency, weight: 0, weighted: 0 },
              engagement: { raw: frozen.rawScores.engagement, weight: 0, weighted: 0 },
              bridging: { raw: frozen.rawScores.bridging, weight: 0, weighted: 0 },
              sourceDiversity: { raw: frozen.rawScores.source_diversity, weight: 0, weighted: 0 },
              relevance: { raw: frozen.rawScores.relevance, weight: 0, weighted: 0 },
            },
          } satisfies PostScoreRecord
        : await options.readScore({
            postUri: row.uri,
            epochId: options.epochId,
          });
      if (!score) {
        return null;
      }
      const rawScores = internalRawScoresToShadow(score.components);
      if (!hasAllFiniteRawScores(rawScores)) {
        return null;
      }
      return {
        postUri: row.uri,
        reviewedCid: row.reviewed_cid,
        authorDid: row.author_did,
        createdAt: dateToIso(row.created_at),
        topicVector: row.topic_vector ?? {},
        rawScores,
        productionScore: score.totalScore,
        productionEpochId: score.epochId,
        scoredAt: score.scoredAt.toISOString(),
        componentDetails: score.componentDetails,
        inclusionReasons: row.published
          ? { matchedTopics: [], matchedTerms: [], sourceRank: row.published.publishedRank, reason: 'published_feed_snapshot' as const }
          : openScienceInclusionReasons(row.text, row.topic_vector ?? {}),
        displayPost: hiddenDisplayPost('Post has not been hydrated from Bluesky public AppView yet'),
        publishedRank: row.published?.publishedRank,
        publishedScore: row.published?.publishedScore,
        publicationAdjustment: row.published && score.totalScore !== 0
          ? row.published.publishedScore / score.totalScore
          : undefined,
        embedUrl: row.embed_url,
        textLength: row.text_length === undefined ? undefined : Number(row.text_length),
      } satisfies ShadowDemoCorpusItem;
    }));
    items.push(...scoredBatch.filter((item): item is NonNullable<typeof item> => item !== null));
  }
  return items;
}

function buildHealth(options: {
  now: Date;
  rows: CandidatePostRow[];
  items: ShadowDemoCorpusItem[];
  source: ShadowDemoCorpusHealth['source'];
}): ShadowDemoCorpusHealth {
  const first = options.rows[0];
  const candidateCount = first ? Number(first.candidate_count_72h) : options.rows.length;
  const uniqueAuthors = first ? Number(first.unique_authors_72h) : uniqueAuthorCount(options.items);
  return {
    status: options.source === 'production_scores_appview' ? 'live' : 'degraded',
    source: options.source,
    candidatePosts72h: finiteNumber(candidateCount),
    publicScoredPosts: options.items.filter((item) => item.displayPost.kind === 'public_post').length,
    uniqueAuthors72h: finiteNumber(uniqueAuthors),
    bridgePostShare: bridgePostShare(options.items),
    topAuthorConcentration: topAuthorConcentration(options.items),
    sampledAt: options.now.toISOString(),
  };
}

function fallbackCorpus(options: {
  communityId: ShadowDemoCommunityId;
  now: Date;
  reason: string;
  activeEpochId?: number;
  baseWeights?: ShadowDemoWeights;
  baseTopicIntent?: ShadowDemoTopicIntent;
  health?: ShadowDemoCorpusHealth;
  topicCatalog?: ShadowDemoTopicCatalogEntry[];
  sourceFeedUri?: string;
}): ShadowDemoCorpus {
  const warning: ShadowDemoWarning = {
    code: 'shadow_demo_corpus_degraded',
    message: options.reason,
    severity: 'degraded',
  };
  const items = fixtureCorpusItems(options.now, options.activeEpochId ?? 0);
  const baseWeights = options.baseWeights ?? equalShadowWeights();
  const baseTopicIntent = options.baseTopicIntent ?? emptyShadowTopicIntent();
  const rankedItems = items;
  return {
    corpusId: `corpus-${randomUUID()}`,
    communityId: options.communityId,
    baseProductionEpochId: options.activeEpochId ?? 0,
    baseWeights,
    baseTopicIntent,
    createdAt: options.now.toISOString(),
    expiresAt: expiresAt(options.now).toISOString(),
    items: rankedItems,
    health: {
      status: 'degraded',
      source: 'fixture_fallback',
      candidatePosts72h: rankedItems.length,
      sourcePostCount: rankedItems.length,
      eligiblePostCount: rankedItems.length,
      publicScoredPosts: rankedItems.length,
      uniqueAuthors72h: uniqueAuthorCount(rankedItems),
      bridgePostShare: bridgePostShare(rankedItems),
      topAuthorConcentration: topAuthorConcentration(rankedItems),
      sampledAt: options.now.toISOString(),
    },
    warnings: [warning],
    topicCatalog: options.topicCatalog,
    sourceFeedUri: options.sourceFeedUri,
  };
}

function fixtureCorpusItems(now: Date, epochId: number): ShadowDemoCorpusItem[] {
  const scoredAt = now.toISOString();
  return [
    fixtureItem({
      index: 1,
      epochId,
      scoredAt,
      authorHandle: 'maya-keene.bsky.social',
      authorDisplayName: 'Maya Keene',
      text: 'Published a notebook that reproduces our urban heat analysis from raw sensor data.',
      rawScores: { recency: 0.74, engagement: 0.32, bridging: 0.81, source_diversity: 0.66, relevance: 0.91 },
      topicVector: { 'science-research': 0.92, 'software-development': 0.76 },
    }),
    fixtureItem({
      index: 2,
      epochId,
      scoredAt,
      authorHandle: 'benadler.bsky.social',
      authorDisplayName: 'Ben Adler',
      text: 'New preprint maps how wildfire smoke changes neighborhood-scale air quality.',
      rawScores: { recency: 0.95, engagement: 0.5, bridging: 0.28, source_diversity: 0.42, relevance: 0.87 },
      topicVector: { 'science-research': 0.95 },
    }),
    fixtureItem({
      index: 3,
      epochId,
      scoredAt,
      authorHandle: 'eli-overthinking.bsky.social',
      authorDisplayName: 'Eli Moreno',
      text: 'Researchers will do anything except document the environment that produced the result.',
      rawScores: { recency: 0.67, engagement: 0.96, bridging: 0.35, source_diversity: 0.26, relevance: 0.43 },
      topicVector: { 'software-development': 0.78 },
    }),
    fixtureItem({
      index: 4,
      epochId,
      scoredAt,
      authorHandle: 'arjunmehta.dev',
      authorDisplayName: 'Arjun Mehta',
      text: 'Open-source image classifier benchmark and training dataset just dropped.',
      rawScores: { recency: 0.82, engagement: 0.58, bridging: 0.88, source_diversity: 0.74, relevance: 0.93 },
      topicVector: { 'science-research': 0.86, 'ai-machine-learning': 0.8, 'open-source': 0.72 },
    }),
    fixtureItem({
      index: 5,
      epochId,
      scoredAt,
      authorHandle: 'toastwindow.bsky.social',
      authorDisplayName: 'Claire Rowan',
      text: 'Field notes from a rainy biodiversity survey, plus the messy CSV and cleaning script.',
      rawScores: { recency: 0.7, engagement: 0.44, bridging: 0.77, source_diversity: 0.82, relevance: 0.89 },
      topicVector: { 'science-research': 0.88, 'data-science': 0.71 },
    }),
    fixtureItem({
      index: 6,
      epochId,
      scoredAt,
      authorHandle: 'thocknotes.bsky.social',
      authorDisplayName: 'Theo Kim',
      text: 'Half my lab notebook is error messages, but the replication package finally runs end to end.',
      rawScores: { recency: 0.6, engagement: 0.84, bridging: 0.65, source_diversity: 0.48, relevance: 0.64 },
      topicVector: { 'science-research': 0.7, 'software-development': 0.66 },
    }),
    fixtureItem({
      index: 7,
      epochId,
      scoredAt,
      authorHandle: 'danielweiss.net',
      authorDisplayName: 'Daniel Weiss',
      text: 'Peer review notes, analysis code, and the exact environment file are now in the open repository.',
      rawScores: { recency: 0.78, engagement: 0.51, bridging: 0.72, source_diversity: 0.69, relevance: 0.86 },
      topicVector: { 'science-research': 0.84, 'open-source': 0.79, 'software-development': 0.7 },
    }),
    fixtureItem({
      index: 8,
      epochId,
      scoredAt,
      authorHandle: 'kmillerwrites.bsky.social',
      authorDisplayName: 'Karen Miller',
      text: 'A small API change broke three public datasets, so we wrote up the migration and reproducibility impact.',
      rawScores: { recency: 0.88, engagement: 0.61, bridging: 0.83, source_diversity: 0.75, relevance: 0.9 },
      topicVector: { 'data-science': 0.83, 'software-development': 0.77, 'open-source': 0.62 },
    }),
  ];
}

function fixtureItem(options: {
  index: number;
  epochId: number;
  scoredAt: string;
  authorHandle: string;
  authorDisplayName: string;
  text: string;
  rawScores: ShadowDemoRawScores;
  topicVector: Record<string, number>;
}): ShadowDemoCorpusItem {
  const uri = `at://did:plc:shadowdemo${options.index}/app.bsky.feed.post/bird${options.index}`;
  return {
    postUri: uri,
    authorDid: `did:plc:shadowdemo${options.index}`,
    createdAt: options.scoredAt,
    topicVector: options.topicVector,
    rawScores: options.rawScores,
    productionScore: 0,
    productionEpochId: options.epochId,
    scoredAt: options.scoredAt,
    componentDetails: null,
    inclusionReasons: openScienceInclusionReasons(options.text, options.topicVector),
    displayPost: {
      kind: 'public_post',
      uri,
      cid: `bafyshadowdemo${options.index}`,
      authorDid: `did:plc:shadowdemo${options.index}`,
      authorHandle: options.authorHandle,
      authorDisplayName: options.authorDisplayName,
      authorAvatar: null,
      text: options.text,
      likeCount: 12 * options.index,
      repostCount: 4 * options.index,
      replyCount: 3 * options.index,
      quoteCount: options.index,
      indexedAt: options.scoredAt,
      createdAt: options.scoredAt,
      bskyUrl: `https://bsky.app/profile/${options.authorHandle}/post/bird${options.index}`,
    },
  };
}

export function openScienceInclusionReasons(
  text: string,
  topicVector: Record<string, number>
): ShadowDemoCorpusItem['inclusionReasons'] {
  const matchedTopics = Object.entries(topicVector)
    .filter(([topic, score]) =>
      OPEN_SCIENCE_TOPIC_SLUGS.includes(topic as ShadowDemoTopicKey) &&
      Number.isFinite(score) &&
      score >= SHADOW_DEMO_CORPUS_PROVENANCE.topicScoreThreshold
    )
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([topic, score]) => ({ topic: topic as ShadowDemoTopicKey, score }));
  return {
    matchedTopics,
    matchedTerms: matchingOpenScienceTerms(text),
  };
}

export function isStrictOpenScienceCandidate(
  text: string,
  topicVector: Record<string, number>
): boolean {
  const reasons = openScienceInclusionReasons(text, topicVector);
  return reasons.matchedTopics.length > 0 && reasons.matchedTerms.length > 0;
}

function matchingOpenScienceTerms(text: string): string[] {
  return COMPILED_OPEN_SCIENCE_TERM_RULES
    .filter((rule) => rule.regex.test(text))
    .map((rule) => rule.label);
}

function epochWeights(row: ActiveEpochRow): ShadowDemoWeights {
  return internalWeightsToShadow({
    recency: Number(row.recency_weight),
    engagement: Number(row.engagement_weight),
    bridging: Number(row.bridging_weight),
    sourceDiversity: Number(row.source_diversity_weight),
    relevance: Number(row.relevance_weight),
  });
}

function epochTopicIntent(row: ActiveEpochRow): ShadowDemoTopicIntent {
  return { topicWeights: { ...(row.topic_weights ?? {}) } };
}

function hasAllFiniteRawScores(rawScores: ShadowDemoRawScores): boolean {
  return Object.values(rawScores).every((value) => Number.isFinite(value));
}

function expiresAt(now: Date): Date {
  return new Date(now.getTime() + SHADOW_DEMO_SESSION_TTL_SECONDS * 1000);
}

function bridgePostShare(items: ShadowDemoCorpusItem[]): number {
  if (items.length === 0) {
    return 0;
  }
  const bridgeCount = items.filter((item) => item.rawScores.bridging >= 0.5).length;
  return Number((bridgeCount / items.length).toFixed(3));
}

function topAuthorConcentration(items: ShadowDemoCorpusItem[]): number {
  if (items.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = item.authorDid ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const max = Math.max(...counts.values());
  return Number((max / items.length).toFixed(3));
}

function uniqueAuthorCount(items: ShadowDemoCorpusItem[]): number {
  return new Set(items.map((item) => item.authorDid ?? item.postUri)).size;
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function dateToIso(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid corpus date value: ${value}`);
  }
  return parsed.toISOString();
}

async function defaultFetch(input: string, init: { method: 'GET'; signal: AbortSignal }): Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}> {
  return globalThis.fetch(input, init);
}

/** Current disclosure only; returned metadata never replaces the frozen scoring corpus. */
export function createDisplayProjector(options: {
  dbPool: Pick<Pool, 'query'>;
  fetchFn: DemoFetchFunction;
}): (corpus: ShadowDemoCorpus, items: readonly ShadowDemoCorpusItem[]) => Promise<ReadonlyMap<string, ShadowDemoDisplayPost>> {
  return async (corpus, items) => {
    if (corpus.health.source === 'fixture_fallback') {
      return new Map(items.map((item) => [item.postUri, item.displayPost]));
    }
    const hidden = (reason: string): ReadonlyMap<string, ShadowDemoDisplayPost> =>
      new Map(items.map((item) => [item.postUri, hiddenDisplayPost(reason)]));
    if (items.length === 0) return new Map();
    const approved = corpus.communityId === 'community_gov'
      ? readApprovedCommunityGovSnapshot(DEMO_SOURCE_SNAPSHOT_LIMIT) : null;
    const matchesApproved = approved !== null
      && corpus.sourceSnapshot?.digest === approved.snapshotDigest
      && corpus.sourceSnapshot.runId === approved.sourceRunId
      && corpus.sourceSnapshot.baselineOrderDigest === approved.baselineOrderDigest
      && corpus.sourceFeedUri === approved.feedUri
      && corpus.baseProductionEpochId === approved.productionEpochId;
    const inputs = items.map((item) => ({
      ...item,
      reviewedCid: item.reviewedCid !== undefined ? item.reviewedCid
        : matchesApproved ? approved.entries.find((entry) => entry.uri === item.postUri)?.frozen?.reviewedCid ?? null
          : null,
    }));
    const hydrated = await hydrateCorpusItemsWithAppView({ items: inputs, fetchFn: options.fetchFn, timeoutMs: 2000 });
    try {
      // Route B uses the retained legacy posts table, not the Route A lifecycle-version table.
      // Current AppView must already match the reviewed CID. Retention absence is not deletion;
      // any retained ambiguity, deletion or different CID denies disclosure. Query last.
      const query = {
        text: `WITH requested AS (
            SELECT * FROM unnest($1::text[], $2::text[]) AS target(uri, reviewed_cid)
          )
          SELECT requested.uri,
            (local.row_count > 0 AND NOT (local.row_count = 1 AND local.matching_live_count = 1)) AS denied
          FROM requested
          CROSS JOIN LATERAL (
            SELECT COUNT(*) AS row_count,
              COUNT(*) FILTER (WHERE p.deleted = FALSE AND p.cid = requested.reviewed_cid)
                AS matching_live_count
            FROM posts p WHERE p.uri = requested.uri
          ) local`,
        values: [inputs.map((item) => item.postUri), inputs.map((item) => item.reviewedCid)],
        query_timeout: 1000,
      };
      const result = await options.dbPool.query<{ uri: string; denied: boolean }>(query);
      if (result.rows.length !== items.length || new Set(result.rows.map((row) => row.uri)).size !== items.length
        || result.rows.some((row) => typeof row.denied !== 'boolean' || !items.some((item) => item.postUri === row.uri))) {
        return hidden('Current local display eligibility could not be established');
      }
      const denied = new Set(result.rows.filter((row) => row.denied).map((row) => row.uri));
      return new Map(hydrated.map((item) => [item.postUri, denied.has(item.postUri)
        ? hiddenDisplayPost('Post withheld by current local deletion or denial') : item.displayPost]));
    } catch (error) {
      logger.warn({ errorKind: error instanceof Error ? error.name : 'unknown', postCount: items.length }, 'Demo current local display eligibility failed closed');
      return hidden('Current local display eligibility could not be established');
    }
  };
}

export function createDefaultDisplayProjector(): ReturnType<typeof createDisplayProjector> {
  return createDisplayProjector({ dbPool: defaultDb, fetchFn: defaultFetch });
}
