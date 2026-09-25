import {
  SHADOW_DEMO_COMMUNITY_IDS,
  SHADOW_DEMO_CONTENT_RULE_SUPPORT_THRESHOLD,
  SHADOW_DEMO_CONTRACT_VERSION,
  SHADOW_DEMO_GUIDED_EPOCHS,
  SHADOW_DEMO_MAX_EPOCHS_PER_SESSION,
  SHADOW_DEMO_MAX_EXCLUDE_KEYWORDS,
  SHADOW_DEMO_MAX_EXCLUDE_KEYWORD_LENGTH,
  SHADOW_DEMO_SIGNAL_KEYS,
  SHADOW_DEMO_TOTAL_DEMO_VOTERS,
  SHADOW_DEMO_VOTER_BLOC_IDS,
  type ShadowDemoCommunityId,
  type ShadowDemoContentRuleSupport,
  type ShadowDemoContentRulesSummary,
  type ShadowDemoSignalKey,
  type ShadowDemoSuggestedExcludeKeyword,
  type ShadowDemoTopicIntent,
  type ShadowDemoTopicCatalogEntry,
  type ShadowDemoWeights,
  type ShadowDemoVoterBlocId,
} from "./shadow-demo-contract"

export {
  SHADOW_DEMO_COMMUNITY_IDS,
  SHADOW_DEMO_CONTENT_RULE_SUPPORT_THRESHOLD,
  SHADOW_DEMO_CONTRACT_VERSION,
  SHADOW_DEMO_GUIDED_EPOCHS,
  SHADOW_DEMO_MAX_EPOCHS_PER_SESSION,
  SHADOW_DEMO_MAX_EXCLUDE_KEYWORDS,
  SHADOW_DEMO_MAX_EXCLUDE_KEYWORD_LENGTH,
  SHADOW_DEMO_SIGNAL_KEYS,
  SHADOW_DEMO_TOTAL_DEMO_VOTERS,
  SHADOW_DEMO_VOTER_BLOC_IDS,
}
export type {
  ShadowDemoCommunityId,
  ShadowDemoContentRuleSupport,
  ShadowDemoContentRulesSummary,
  ShadowDemoSignalKey,
  ShadowDemoSuggestedExcludeKeyword,
  ShadowDemoTopicIntent,
  ShadowDemoTopicCatalogEntry,
  ShadowDemoWeights,
  ShadowDemoVoterBlocId,
}

export const SHADOW_DEMO_PHASES = [
  "created",
  "corpus_ready",
  "reviewer_vote_cast",
  "agent_votes_cast",
  "epoch_transitioned",
  "reranked",
  "degraded",
] as const

export const SHADOW_DEMO_ACTIONS = [
  "create_session",
  "cast_reviewer_vote",
  "run_agent_votes",
  "advance_epoch",
  "select_post",
] as const

export const SHADOW_DEMO_AGENT_IDS = SHADOW_DEMO_VOTER_BLOC_IDS

export type ShadowDemoPhase = (typeof SHADOW_DEMO_PHASES)[number]
export type ShadowDemoAction = (typeof SHADOW_DEMO_ACTIONS)[number]
export type ShadowDemoAgentId = (typeof SHADOW_DEMO_AGENT_IDS)[number]

export interface ShadowDemoEnvelope<TPayload> {
  readonly contractVersion: typeof SHADOW_DEMO_CONTRACT_VERSION
  readonly requestId: string
  readonly generatedAt: string
  readonly sessionId: string | null
  readonly payload: TPayload
  readonly warnings: readonly ShadowDemoWarning[]
}

export interface ShadowDemoWarning {
  readonly code: string
  readonly message: string
  readonly recoverable: boolean
}

export interface CreateShadowDemoSessionRequest {
  readonly communityId: ShadowDemoCommunityId
  readonly scenarioId: string
  readonly clientNonce: string
  readonly mode: "guided" | "free_play"
}

export interface ShadowDemoSessionResponse {
  readonly session: ShadowDemoSession
  readonly community: ShadowDemoCommunity
  readonly currentEpoch: ShadowDemoEpoch
  readonly previousEpoch: ShadowDemoEpoch | null
  readonly feed: ShadowDemoFeed
  readonly nextRecommendedAction: ShadowDemoAction
  readonly agents: readonly ShadowDemoAgent[]
  readonly agentVotes: readonly ShadowDemoVote[]
  readonly pendingAggregate: ShadowDemoAggregate | null
}

export interface ShadowDemoSession {
  readonly id: string
  readonly phase: ShadowDemoPhase
  readonly communityId: ShadowDemoCommunityId
  readonly scenarioId: string
  readonly mode: "guided" | "free_play"
  readonly seed: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly sequence: number
  readonly guidedEpochs: typeof SHADOW_DEMO_GUIDED_EPOCHS
  readonly maxEpochs: typeof SHADOW_DEMO_MAX_EPOCHS_PER_SESSION
  readonly isolation: ShadowDemoIsolation
  readonly capabilities: ShadowDemoCapabilities
  readonly corpusProvenance: ShadowDemoCorpusProvenance
  readonly topicCatalog?: readonly ShadowDemoTopicCatalogEntry[]
  readonly sourceFeedUri?: string | null
  /** Present only when DEMO_CONTENT_RULES_ENABLED. */
  readonly contentRulesEnabled?: boolean
  readonly suggestedExcludeKeywords?: readonly ShadowDemoSuggestedExcludeKeyword[]
}

export interface ShadowDemoIsolation {
  readonly writesProductionGovernance: false
  readonly writesGovernanceVotes: false
  readonly writesGovernanceEpochs: false
  readonly writesResearchExports: false
  readonly writesProductionFeedCache: false
  readonly storageNamespace: "demo"
}

export interface ShadowDemoCapabilities {
  readonly canCastReviewerVote: boolean
  readonly canRunAgents: boolean
  readonly canAdvanceEpoch: boolean
  readonly canOpenNativeBlueskyFeed: boolean
  readonly canMutateNativeBlueskyFeed: false
}

export interface ShadowDemoCommunity {
  readonly id: ShadowDemoCommunityId
  readonly name: string
  readonly tagline: string
  readonly corpusStrategy: "published_feed_snapshot" | "live_appview_search" | "fixture_fallback"
  readonly candidateTerms: readonly string[]
  readonly bridgeTerms: readonly string[]
  readonly publicBlueskyFeedUrl: string | null
}

export interface CastShadowDemoVoteRequest {
  readonly idempotencyKey: string
  readonly baseEpochId: string
  readonly voterLabel: string
  readonly weights: ShadowDemoWeights
  readonly topicIntent: ShadowDemoTopicIntent
  /** Sent only when the reviewer proposed keywords and content rules are enabled. */
  readonly excludeKeywords?: readonly string[]
}

export interface CastShadowDemoVoteResponse {
  readonly session: ShadowDemoSession
  readonly reviewerVote: ShadowDemoViewVote
  readonly currentEpoch: ShadowDemoEpoch
  readonly nextRecommendedAction: "run_agent_votes"
}

export interface RunShadowDemoAgentsRequest {
  readonly idempotencyKey: string
  readonly baseEpochId: string
}

export interface RunShadowDemoAgentsResponse {
  readonly session: ShadowDemoSession
  readonly agents: readonly ShadowDemoAgent[]
  readonly agentVotes: readonly ShadowDemoViewVote[]
  readonly currentEpoch: ShadowDemoEpoch
  readonly pendingAggregate: ShadowDemoAggregate
  readonly nextRecommendedAction: "advance_epoch"
}

export interface AdvanceShadowDemoEpochRequest {
  readonly idempotencyKey: string
  readonly fromEpochId: string
}

export interface AdvanceShadowDemoEpochResponse {
  readonly session: ShadowDemoSession
  readonly previousEpoch: ShadowDemoEpoch
  readonly currentEpoch: ShadowDemoEpoch
  readonly feedBefore: ShadowDemoFeed
  readonly feedAfter: ShadowDemoFeed
  readonly nextRecommendedAction: "select_post"
}

export interface ShadowDemoAgent {
  readonly id: ShadowDemoAgentId
  readonly name: string
  readonly role: string
  readonly deterministicSeed: string
  readonly voteRationale: string
  readonly voterCount: number
  readonly baseWeights: ShadowDemoWeights
  readonly reviewerBlend: number
  readonly policyInertia: number
}

export interface ShadowDemoViewVote {
  readonly id: string
  readonly epochId: string
  readonly voterKind: "reviewer" | "agent"
  readonly voterId: string
  readonly voterLabel: string
  readonly weights: ShadowDemoWeights
  readonly topicIntent: ShadowDemoTopicIntent
  readonly rationale: string
  readonly castAt: string
}

export type ShadowDemoVote = ShadowDemoViewVote

export interface ShadowDemoEpoch {
  readonly id: string
  readonly sequence: number
  readonly status: "open" | "agent_voting" | "closing" | "closed" | "published"
  readonly label: string
  readonly weights: ShadowDemoWeights
  readonly topicIntent: ShadowDemoTopicIntent
  readonly voteSummary: ShadowDemoVoteSummary
  readonly startedAt: string
  readonly closedAt: string | null
}

export interface ShadowDemoVoteSummary {
  readonly reviewerVotes: number
  readonly agentVotes: number
  readonly totalVotes: number
  readonly aggregateMethod: "trimmed_mean_no_trim_under_10"
  readonly trimCount: number
  readonly reviewerBallotShare: number
  /** Present only when DEMO_CONTENT_RULES_ENABLED. Threshold rule, not trimmed mean. */
  readonly contentRules?: ShadowDemoContentRulesSummary
}

export interface ShadowDemoAggregate {
  readonly weights: ShadowDemoWeights
  readonly topicIntent: ShadowDemoTopicIntent
  readonly voteSummary: ShadowDemoVoteSummary
}

export interface ShadowDemoFeedRequest {
  readonly epochId: string
  readonly limit: number
}

export interface ShadowDemoFeed {
  readonly epochId: string
  readonly corpusId: string
  readonly rankingSource: "live_public_posts_shadow_weights" | "fixture_posts_shadow_weights"
  readonly generatedAt: string
  readonly items: readonly ShadowDemoFeedItem[]
  readonly corpusHealth: ShadowDemoCorpusHealth
  readonly corpusProvenance: ShadowDemoCorpusProvenance
  readonly aggregate: ShadowDemoAggregate
  /** Present when content rules are enabled for the epoch; may be an empty array. */
  readonly withheldPosts?: readonly ShadowDemoWithheldFeedItem[]
}

/** A post removed from the ranking by an adopted community content rule. */
export interface ShadowDemoWithheldFeedItem {
  readonly keyword: string
  readonly supportCount: number
  readonly previousRank: number | null
  readonly post: ShadowDemoPublicPost | null
  readonly hiddenReason: string | null
}

export type ShadowDemoFeedItem = ShadowDemoPublicFeedItem | ShadowDemoHiddenFeedItem

export interface ShadowDemoPublicFeedItem {
  readonly visibility: "public"
  readonly rank: number
  readonly publishedRank?: number | null
  readonly publishedScore?: number | null
  readonly previousRank: number | null
  readonly movement: ShadowDemoRankMovement
  readonly post: ShadowDemoPublicPost
  readonly score: ShadowDemoScore
}

export interface ShadowDemoHiddenFeedItem {
  readonly visibility: "hidden"
  readonly rank: number
  readonly publishedRank?: number | null
  readonly publishedScore?: number | null
  readonly previousRank: number | null
  readonly movement: ShadowDemoRankMovement
  readonly post: null
  readonly score: null
  readonly hiddenReason: "no_unauthenticated" | "hide_label" | "adult_label" | "deleted_or_unavailable" | "missing_text"
  readonly labels: readonly string[]
}

export interface ShadowDemoImageMedia {
  readonly thumb: string
  readonly fullsize: string
  readonly alt: string
  readonly width: number | null
  readonly height: number | null
}

export interface ShadowDemoExternalMedia {
  readonly uri: string
  readonly title: string
  readonly description: string
  readonly thumb: string | null
}

export interface ShadowDemoQuoteMedia {
  readonly uri: string
  readonly authorHandle: string
  readonly authorDisplayName: string
  readonly text: string
}

export interface ShadowDemoVideoMedia {
  readonly thumbnail: string | null
  readonly width: number | null
  readonly height: number | null
}

export interface ShadowDemoPostMedia {
  readonly images: readonly ShadowDemoImageMedia[]
  readonly external: ShadowDemoExternalMedia | null
  readonly quote: ShadowDemoQuoteMedia | null
  readonly video: ShadowDemoVideoMedia | null
}

export interface ShadowDemoPublicPost {
  readonly uri: string
  readonly cid: string
  readonly bskyUrl: string
  readonly authorDid: string
  readonly authorHandle: string
  readonly authorDisplayName: string
  readonly authorAvatar: string | null
  readonly text: string
  readonly indexedAt: string
  readonly createdAt: string
  readonly likeCount: number
  readonly repostCount: number
  readonly replyCount: number
  readonly quoteCount: number
  readonly labels: readonly string[]
  readonly languages?: readonly string[]
  readonly media?: ShadowDemoPostMedia | null
}

export interface ShadowDemoRankMovement {
  readonly delta: number
  readonly label: "new" | "same" | "up" | "down"
}

export interface ShadowDemoScore {
  readonly total: number
  readonly components: readonly ShadowDemoScoreComponent[]
  readonly componentTotal?: number | null
  readonly publicationAdjustment?: number | null
}

export interface ShadowDemoScoreComponent {
  readonly key: ShadowDemoSignalKey
  readonly label: string
  readonly rawScore: number
  readonly weight: number
  readonly contribution: number
}

export interface ShadowDemoCorpusHealth {
  readonly status: "live" | "fallback"
  readonly candidatePostCount: number
  readonly publicScoredPostCount: number
  readonly displayedPublicPostCount: number
  readonly displayedHiddenPostCount: number
  readonly uniqueAuthorCount: number
  readonly collectedAt: string
  readonly frozenForSession: true
  readonly sourcePostCount?: number | null
  readonly eligiblePostCount?: number | null
  readonly englishTaggedShare?: number | null
  readonly richMediaShare?: number | null
}

interface ShadowDemoCorpusProvenanceBase {
  readonly description: string
  readonly corpusId: string
  readonly productionEpochId: number
  readonly sampledAt: string
  readonly windowHours: number
  readonly topicScoreThreshold: number
  readonly eligiblePostCount: number
}

export type ShadowDemoCorpusProvenance =
  | ShadowDemoCorpusProvenanceBase & {
      readonly mode: "production_feed_snapshot_session_frozen"
      readonly label: "Reviewer-safe snapshot of the live Community Governed Feed"
      readonly sourceFeedUri: string
      readonly sourceFeedName: string
      readonly sourceSnapshotDigest: string
      readonly sourceRunId: string
      readonly sourceUpdatedAt: string
      readonly sourceReviewedAt?: string
      readonly sourcePostCount: number
      readonly selectionPolicyVersion: string
      readonly baselineOrderDigest: string
    }
  | ShadowDemoCorpusProvenanceBase & {
      readonly mode: "production_sourced_session_frozen"
      readonly label: "Live-scored snapshot"
    }
  | ShadowDemoCorpusProvenanceBase & {
      readonly mode: "illustrative_fixture_session_frozen"
      readonly label: "Illustrative mechanics fixture"
    }

export interface ShadowDemoReceiptRequest {
  readonly epochId: string
  readonly postUri: string
}

export interface ShadowDemoReceiptResponse {
  readonly session: ShadowDemoSession
  readonly receipt: ShadowDemoReceipt
}

export interface ShadowDemoReceipt {
  readonly postUri: string
  readonly epochId: string
  readonly visibleRank: number
  readonly previousRank: number | null
  readonly totalScore: number
  readonly componentScore?: number | null
  readonly publicationAdjustment?: number | null
  readonly publishedRank?: number | null
  readonly publishedScore?: number | null
  readonly scoredAt: string
  readonly aggregate: ShadowDemoAggregate
  readonly reviewerBallotShare: number
  readonly components: readonly ShadowDemoScoreComponent[]
  readonly topicBreakdown: readonly ShadowDemoTopicContribution[]
  readonly topicRelevanceFormula: ShadowDemoTopicRelevanceFormula
  readonly provenance: ShadowDemoReceiptProvenance
  readonly counterfactuals: readonly ShadowDemoCounterfactual[]
  readonly generatedAt: string
  readonly explanationKind: "shadow_demo_receipt"
  /** Present only when DEMO_CONTENT_RULES_ENABLED. */
  readonly contentRules?: {
    readonly adoptedExcludeKeywords: readonly string[]
    readonly threshold: number
    readonly electorate: number
    /** Always null on a rank receipt; withheld posts have no rank receipt. */
    readonly matchedKeyword: null
  }
}

export interface ShadowDemoTopicRelevanceFormula {
  readonly formulaApplied: boolean
  readonly defaultTopicWeight: number
  readonly confidenceThreshold: number
  readonly weightedSum: number | null
  readonly signalSum: number | null
  readonly baseRelevance: number
  readonly confidenceMultiplier: number
  readonly effectiveRelevance: number
  readonly usedDefaultWeight: boolean
  readonly terms: readonly ShadowDemoTopicTerm[]
}

export interface ShadowDemoTopicTerm {
  readonly topic: string
  readonly postScore: number
  readonly communityWeight: number
  readonly weightedTerm: number
  readonly usedDefaultWeight: boolean
}

export interface ShadowDemoTopicContribution {
  readonly slug: string
  readonly label: string
  readonly postScore: number
  readonly communityWeight: number
  readonly contribution: number
}

export type ShadowDemoReceiptProvenance = ShadowDemoCorpusProvenance & {
  readonly shadowEpochId: string
  readonly postInclusionReasons: {
    readonly matchedTopics: readonly { readonly topic: string; readonly score: number }[]
    readonly matchedTerms: readonly string[]
    readonly sourceRank?: number
    readonly reason?: "published_feed_snapshot"
  }
}

export interface ShadowDemoCounterfactual {
  readonly id: "prior_epoch" | "engagement_only" | "direct_reviewer_ballot_removed"
  readonly label: string
  readonly description: string
  readonly rank: number | null
  readonly deltaFromVisibleRank: number | null
}

export interface ShadowDemoClient {
  readonly createSession: (
    request: CreateShadowDemoSessionRequest,
    signal: AbortSignal,
  ) => Promise<ShadowDemoEnvelope<ShadowDemoSessionResponse>>
  readonly getSession: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<ShadowDemoEnvelope<ShadowDemoSessionResponse>>
  readonly castVote: (
    sessionId: string,
    request: CastShadowDemoVoteRequest,
    signal: AbortSignal,
  ) => Promise<ShadowDemoEnvelope<CastShadowDemoVoteResponse>>
  readonly runAgents: (
    sessionId: string,
    request: RunShadowDemoAgentsRequest,
    signal: AbortSignal,
  ) => Promise<ShadowDemoEnvelope<RunShadowDemoAgentsResponse>>
  readonly advanceEpoch: (
    sessionId: string,
    request: AdvanceShadowDemoEpochRequest,
    signal: AbortSignal,
  ) => Promise<ShadowDemoEnvelope<AdvanceShadowDemoEpochResponse>>
  readonly getFeed: (
    sessionId: string,
    request: ShadowDemoFeedRequest,
    signal: AbortSignal,
  ) => Promise<ShadowDemoEnvelope<ShadowDemoFeed>>
  readonly getReceipt: (
    sessionId: string,
    request: ShadowDemoReceiptRequest,
    signal: AbortSignal,
  ) => Promise<ShadowDemoEnvelope<ShadowDemoReceiptResponse>>
}
