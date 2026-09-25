export const SHADOW_DEMO_CONTRACT_VERSION = '2026-07-11.shadow-demo.v4' as const;

export const SHADOW_DEMO_SIGNAL_KEYS = [
  'recency',
  'engagement',
  'bridging',
  'source_diversity',
  'relevance',
] as const;

export type ShadowDemoSignalKey = (typeof SHADOW_DEMO_SIGNAL_KEYS)[number];

export type ShadowDemoWeights = Record<ShadowDemoSignalKey, number>;

export interface ShadowDemoTopicIntent {
  topicWeights: Record<string, number>;
}

export type ShadowDemoTopicKey = string;

export type ShadowDemoRawScores = Record<ShadowDemoSignalKey, number>;

export const SHADOW_DEMO_COMMUNITY_IDS = [
  'community_gov',
  'open_science_builders',
  'birders_who_code',
  'crit_fumble_pickup',
  'osint_garden_club',
] as const;

export type ShadowDemoCommunityId = (typeof SHADOW_DEMO_COMMUNITY_IDS)[number];

export const SHADOW_DEMO_VOTER_BLOC_IDS = [
  'research_practitioner',
  'dataset_steward',
  'current_awareness',
  'community_discussant',
  'interdisciplinary_connector',
  'freshness_watcher',
  'conversation_follower',
  'bridge_builder',
  'source_diversifier',
  'relevance_steward',
] as const;

export type ShadowDemoVoterBlocId = (typeof SHADOW_DEMO_VOTER_BLOC_IDS)[number];
export type ShadowDemoSyntheticVoterId = `synthetic-${ShadowDemoVoterBlocId}-${number}`;

export const SHADOW_DEMO_ENDPOINTS = {
  createSession: '/api/demo/v4/sessions',
  readSession: '/api/demo/v4/sessions/:sessionId',
  castVote: '/api/demo/v4/sessions/:sessionId/votes',
  runSyntheticVoters: '/api/demo/v4/sessions/:sessionId/agents/run',
  advanceEpoch: '/api/demo/v4/sessions/:sessionId/epochs/advance',
  readFeed: '/api/demo/v4/sessions/:sessionId/feed?epochId=&limit=',
  readReceipt: '/api/demo/v4/sessions/:sessionId/receipts?epochId=&postUri=',
} as const;

export const SHADOW_DEMO_AGGREGATION_METHOD = 'trimmed_mean_no_trim_under_10' as const;

export const SHADOW_DEMO_MAX_EPOCHS_PER_SESSION = 10;

export const SHADOW_DEMO_GUIDED_EPOCHS = 5;

export const SHADOW_DEMO_SYNTHETIC_VOTER_COUNT = 24;

export const SHADOW_DEMO_TOTAL_DEMO_VOTERS = 25;

export const SHADOW_DEMO_CORPUS_PROVENANCE = {
  mode: 'production_feed_snapshot_session_frozen',
  label: 'Reviewer-safe snapshot of the live Community Governed Feed',
  description:
    'Published Community Governed Feed snapshot, frozen for this demo run so rank movement is attributable to policy changes.',
  windowHours: 72,
  topicScoreThreshold: 0.5,
} as const;

export const SHADOW_DEMO_MAX_EXCLUDE_KEYWORDS = 10;

export const SHADOW_DEMO_MAX_EXCLUDE_KEYWORD_LENGTH = 50;

/** Mirrors production KEYWORD_THRESHOLD in src/governance/aggregation.ts. */
export const SHADOW_DEMO_CONTENT_RULE_SUPPORT_THRESHOLD = 0.3;

export interface ShadowDemoContentRuleSupport {
  keyword: string;
  supportCount: number;
  adopted: boolean;
}

export interface ShadowDemoContentRulesSummary {
  enabled: true;
  /** Votes needed to adopt a keyword: ceil(threshold share x electorate), min 1. */
  threshold: number;
  /** Every demo ballot is complete, so the denominator is the full electorate. */
  electorate: number;
  adoptedExcludeKeywords: string[];
  support: ShadowDemoContentRuleSupport[];
}

export interface ShadowDemoSuggestedExcludeKeyword {
  keyword: string;
  matchCount: number;
}

export interface ShadowDemoWithheldPost {
  keyword: string;
  supportCount: number;
  previousRank: number | null;
  post: ShadowDemoDisplayPost;
}

export const SHADOW_DEMO_ISOLATION_CONTRACT = {
  productionGovernanceMutates: false,
  productionFeedMutates: false,
  productionAuditLogMutates: false,
  researchExportsMutate: false,
  stateBackend: 'redis_only_demo_namespace',
  redisPrefixes: [
    'demo:session:',
    'demo:session-nonce:',
    'demo:sessions:',
    'demo:corpus:',
    'demo:corpus:current:v4:',
    'demo:idempotency:',
    'demo:lock:',
    'demo:staging:',
    'demo:rate-limit:',
  ],
  liveShadowCommunities: ['community_gov'],
} as const;

export interface ShadowDemoWarning {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'degraded';
}

export interface ShadowDemoEnvelope<TPayload> {
  contractVersion: typeof SHADOW_DEMO_CONTRACT_VERSION;
  requestId: string;
  generatedAt: string;
  sessionId: string | null;
  payload: TPayload;
  warnings: ShadowDemoWarning[];
}

export interface ShadowDemoTopicCatalogEntry {
  readonly slug: string
  readonly name: string
  readonly description: string | null
  readonly baselineWeight: number
}

export interface ShadowDemoCommunity {
  id: ShadowDemoCommunityId;
  name: string;
  status: 'live_shadow' | 'degraded';
  description: string;
  liveFeedReady: boolean;
}

export interface ShadowDemoCorpusHealth {
  status: 'live' | 'degraded';
  source: 'production_scores_appview' | 'production_feed_snapshot' | 'fixture_fallback';
  candidatePosts72h: number;
  publicScoredPosts: number;
  uniqueAuthors72h: number;
  bridgePostShare: number;
  topAuthorConcentration: number;
  sampledAt: string;
  sourcePostCount?: number;
  eligiblePostCount?: number;
  englishTaggedShare?: number;
  richMediaShare?: number;
}

interface ShadowDemoCorpusProvenanceBase {
  description: string;
  corpusId: string;
  productionEpochId: number;
  sampledAt: string;
  windowHours: number;
  topicScoreThreshold: number;
  eligiblePostCount: number;
}

export type ShadowDemoCorpusProvenance =
  | ShadowDemoCorpusProvenanceBase & {
      mode: 'production_feed_snapshot_session_frozen';
      label: 'Reviewer-safe snapshot of the live Community Governed Feed';
      sourceFeedUri: string;
      sourceFeedName: string;
      sourceSnapshotDigest: string;
      sourceRunId: string;
      sourceUpdatedAt: string;
      sourceReviewedAt?: string;
      sourcePostCount: number;
      selectionPolicyVersion: string;
      baselineOrderDigest: string;
    }
  | ShadowDemoCorpusProvenanceBase & {
      mode: 'production_sourced_session_frozen';
      label: 'Live-scored snapshot';
    }
  | ShadowDemoCorpusProvenanceBase & {
      mode: 'illustrative_fixture_session_frozen';
      label: 'Illustrative mechanics fixture';
    };

export interface ShadowDemoCorpusInclusionReason {
  matchedTopics: Array<{ topic: ShadowDemoTopicKey; score: number }>;
  matchedTerms: string[];
}

export interface ShadowDemoVoteSummary {
  aggregateMethod: typeof SHADOW_DEMO_AGGREGATION_METHOD;
  voteCount: number;
  trimCount: number;
  weights: ShadowDemoWeights;
  topicIntent: ShadowDemoTopicIntent;
  /** Present only when DEMO_CONTENT_RULES_ENABLED. Threshold rule, not trimmed mean. */
  contentRules?: ShadowDemoContentRulesSummary;
}

export interface ShadowDemoEpoch {
  id: string;
  sequence: number;
  label: string;
  status: 'open' | 'advanced';
  createdAt: string;
  advancedAt: string | null;
  decidedByEpochId: string | null;
  aggregate: ShadowDemoVoteSummary;
}

interface ShadowDemoVoteBase {
  id: string;
  epochId: string;
  label: string;
  weights: ShadowDemoWeights;
  topicIntent: ShadowDemoTopicIntent;
  /** Present only when DEMO_CONTENT_RULES_ENABLED; normalized exclude keywords. */
  excludeKeywords?: string[];
  createdAt: string;
}

export interface ShadowDemoReviewerVote extends ShadowDemoVoteBase {
  actorType: 'reviewer';
  actorId: 'reviewer';
  blocId?: never;
}

export interface ShadowDemoSyntheticVote extends ShadowDemoVoteBase {
  actorType: 'synthetic_voter';
  actorId: ShadowDemoSyntheticVoterId;
  blocId: ShadowDemoVoterBlocId;
}

export type ShadowDemoVote = ShadowDemoReviewerVote | ShadowDemoSyntheticVote;

export interface ShadowDemoSessionPayload {
  session: {
    sessionId: string;
    community: ShadowDemoCommunity;
    phase: 'created' | 'reviewer_voted' | 'synthetic_voters_ran' | 'epoch_advanced';
    currentEpochId: string;
    expiresAt: string;
    corpusHealth: ShadowDemoCorpusHealth;
    epochs: ShadowDemoEpoch[];
    pendingAggregate: ShadowDemoVoteSummary | null;
    voteCount: number;
    guidedEpochs: typeof SHADOW_DEMO_GUIDED_EPOCHS;
    maxEpochs: typeof SHADOW_DEMO_MAX_EPOCHS_PER_SESSION;
    syntheticVoterCount: typeof SHADOW_DEMO_SYNTHETIC_VOTER_COUNT;
    totalDemoVoters: typeof SHADOW_DEMO_TOTAL_DEMO_VOTERS;
    corpusProvenance: ShadowDemoCorpusProvenance;
    voterProfiles: Array<{
      id: ShadowDemoVoterBlocId;
      label: string;
      voterCount: number;
      baseWeights: ShadowDemoWeights;
      baseTopicWeights: Record<string, number>;
      reviewerBlend: number;
      policyInertia: number;
    }>;
    votes: ShadowDemoVote[];
    /** Present only when DEMO_CONTENT_RULES_ENABLED. */
    contentRulesEnabled?: boolean;
    suggestedExcludeKeywords?: ShadowDemoSuggestedExcludeKeyword[];
  };
}

export interface ShadowDemoPublicPost {
  kind: 'public_post';
  uri: string;
  cid: string;
  authorDid: string;
  authorHandle: string;
  authorDisplayName: string;
  authorAvatar: string | null;
  text: string;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  quoteCount: number;
  indexedAt: string;
  createdAt: string;
  bskyUrl: string;
}

export interface ShadowDemoHiddenPost {
  kind: 'hidden_post';
  reason: string;
}

export type ShadowDemoDisplayPost = ShadowDemoPublicPost | ShadowDemoHiddenPost;

export interface ShadowDemoRankedPost {
  rank: number;
  previousRank: number | null;
  movement: number | null;
  score: number | null;
  weightedComponents: Record<ShadowDemoSignalKey, number> | null;
  rawScores: ShadowDemoRawScores | null;
  post: ShadowDemoDisplayPost;
}

export interface ShadowDemoFeedPayload {
  epochId: string;
  corpusId: string;
  communityId: ShadowDemoCommunityId;
  corpusHealth: ShadowDemoCorpusHealth;
  corpusProvenance: ShadowDemoCorpusProvenance;
  aggregate: ShadowDemoVoteSummary;
  posts: ShadowDemoRankedPost[];
  /** Present only when content rules are enabled for the epoch; may be an empty array. */
  withheldPosts?: ShadowDemoWithheldPost[];
}

export interface ShadowDemoReceiptPayload {
  receipt: {
    type: 'shadow_demo_receipt';
    epochId: string;
    postUri: string;
    visibleRank: number;
    previousRank: number | null;
    score: number;
    scoredAt: string;
    aggregate: ShadowDemoVoteSummary;
    reviewerBallotShare: number;
    components: Array<{
      signal: ShadowDemoSignalKey;
      rawScore: number;
      weight: number;
      contribution: number;
    }>;
    topicRelevanceFormula: {
      formulaApplied: boolean;
      defaultTopicWeight: number;
      confidenceThreshold: number;
      weightedSum: number | null;
      signalSum: number | null;
      baseRelevance: number;
      confidenceMultiplier: number;
      effectiveRelevance: number;
      usedDefaultWeight: boolean;
      terms: Array<{
        topic: string;
        postScore: number;
        communityWeight: number;
        weightedTerm: number;
        usedDefaultWeight: boolean;
      }>;
    };
    provenance: ShadowDemoCorpusProvenance & {
      shadowEpochId: string;
      postInclusionReasons: ShadowDemoCorpusInclusionReason;
    };
    counterfactuals: Array<{
      label: 'previous_epoch' | 'engagement_only' | 'direct_reviewer_ballot_removed';
      description: string;
      rank: number | null;
      deltaFromVisible: number | null;
    }>;
    /** Present only when DEMO_CONTENT_RULES_ENABLED. */
    contentRules?: {
      adoptedExcludeKeywords: string[];
      threshold: number;
      electorate: number;
      /** Always null on a rank receipt; withheld posts have no rank receipt. */
      matchedKeyword: null;
    };
  };
}
