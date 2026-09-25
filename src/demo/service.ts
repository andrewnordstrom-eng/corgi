import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { applyFeedUrlDedup, FEED_URL_DEDUP_DECAY } from '../scoring/feed-publication.js';
import { DEMO_COMMUNITIES, createDefaultCorpusLoader, createDefaultDisplayProjector } from './corpus.js';
import { hiddenDisplayPost } from './public-view.js';
import {
  SHADOW_DEMO_SUGGESTED_KEYWORD_COUNT,
  aggregateShadowContentRules,
  applyShadowContentRules,
  emptyShadowContentRules,
  suggestedExcludeKeywords,
  validateShadowExcludeKeywords,
} from './content-rules.js';
import { createSyntheticVoterVotes, getShadowDemoVoterProfiles } from './synthetic-voters.js';
import {
  DEMO_MAX_ACTIVE_SESSIONS,
  DemoStoreCapacityError,
  createRedisDemoStore,
  type DemoStore,
  type IdempotencyRecord,
} from './store.js';
import {
  SHADOW_DEMO_CORPUS_PROVENANCE,
  SHADOW_DEMO_GUIDED_EPOCHS,
  SHADOW_DEMO_SESSION_TTL_SECONDS,
  SHADOW_DEMO_MAX_EPOCHS_PER_SESSION,
  SHADOW_DEMO_SHARED_CORPUS_TTL_SECONDS,
  SHADOW_DEMO_SYNTHETIC_VOTER_COUNT,
  SHADOW_DEMO_TOTAL_DEMO_VOTERS,
  type ShadowDemoCommunityId,
  type ShadowDemoCorpus,
  type ShadowDemoCorpusItem,
  type ShadowDemoDisplayPost,
  type ShadowDemoPublicationPolicy,
  type ShadowDemoCounterfactual,
  type ShadowDemoEpoch,
  type ShadowDemoFeedPayload,
  type ShadowDemoRankedPost,
  type ShadowDemoReceiptContribution,
  type ShadowDemoReceiptPayload,
  type ShadowDemoSessionPayload,
  type ShadowDemoSessionState,
  type ShadowDemoTopicIntent,
  type ShadowDemoVote,
  type ShadowDemoWarning,
  type ShadowDemoWeights,
  type ShadowDemoWithheldPost,
} from './types.js';
import {
  aggregateShadowVotes,
  engagementOnlyWeights,
  explainTopicRelevance,
  scoreFromRawWeights,
  validateShadowWeights,
} from './weights.js';
import {
  cloneShadowTopicIntent,
  validateShadowTopicIntent,
  validateShadowTopicIntentForCatalog,
} from './topic-intent.js';

const LOCK_TTL_MS = 15000;
const CORPUS_BUILD_LOCK_TTL_MS = 15000;
const CORPUS_BUILD_LOCK_RENEW_INTERVAL_MS = 5000;
const CORPUS_BUILD_WAIT_INTERVAL_MS = 100;
const CORPUS_BUILD_WAIT_MARGIN_MS = 500;

export class DemoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoValidationError';
  }
}

export class DemoConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoConflictError';
  }
}

export class DemoNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoNotFoundError';
  }
}

export interface ShadowDemoServiceResult<TPayload> {
  sessionId: string | null;
  payload: TPayload;
  warnings: ShadowDemoWarning[];
}

export interface ShadowDemoServiceDependencies {
  store: DemoStore;
  loadCorpus: (options: {
    communityId: ShadowDemoCommunityId;
    now: Date;
  }) => Promise<ShadowDemoCorpus>;
  now: () => Date;
  projectDisplay?: (corpus: ShadowDemoCorpus, items: readonly ShadowDemoCorpusItem[]) => Promise<ReadonlyMap<string, ShadowDemoDisplayPost>>;
  /** Defaults to false; the default factory reads DEMO_CONTENT_RULES_ENABLED. */
  contentRulesEnabled?: boolean;
  /** Session seed source; defaults to randomUUID. Injectable for deterministic tests. */
  seed?: () => string;
}

export interface CreateSessionRequest {
  communityId: ShadowDemoCommunityId;
  clientNonce: string;
}

export interface CastVoteRequest {
  sessionId: string;
  baseEpochId: string;
  weights: unknown;
  topicIntent: unknown;
  excludeKeywords?: unknown;
  idempotencyKey: string | null;
}

export interface RunSyntheticVotersRequest {
  sessionId: string;
  baseEpochId: string;
  idempotencyKey: string | null;
}

export interface AdvanceEpochRequest {
  sessionId: string;
  fromEpochId: string;
  idempotencyKey: string | null;
}

export interface GetFeedRequest {
  sessionId: string;
  epochId: string | null;
  limit: number;
}

export interface GetReceiptRequest {
  sessionId: string;
  epochId: string | null;
  postUri: string;
}

interface PendingSessionMutation<TPayload> {
  state: ShadowDemoSessionState;
  response: TPayload;
}

export class ShadowDemoService {
  private readonly store: DemoStore;
  private readonly loadCorpus: ShadowDemoServiceDependencies['loadCorpus'];
  private readonly projectDisplay: NonNullable<ShadowDemoServiceDependencies['projectDisplay']>;
  private readonly now: () => Date;
  private readonly contentRulesEnabled: boolean;
  private readonly seed: () => string;

  constructor(dependencies: ShadowDemoServiceDependencies) {
    this.store = dependencies.store;
    this.projectDisplay = dependencies.projectDisplay ?? createDefaultDisplayProjector();
    this.loadCorpus = dependencies.loadCorpus;
    this.now = dependencies.now;
    this.contentRulesEnabled = dependencies.contentRulesEnabled ?? false;
    this.seed = dependencies.seed ?? randomUUID;
  }

  private async rejectReusedCreationNonce(clientNonce: string): Promise<void> {
    const existingSessionId = await this.store.readSessionIdByClientNonce(clientNonce);
    if (!existingSessionId) {
      return;
    }
    throw new DemoConflictError('Session creation nonce has already been used');
  }

  async createSession(request: CreateSessionRequest): Promise<ShadowDemoServiceResult<ShadowDemoSessionPayload>> {
    await this.rejectReusedCreationNonce(request.clientNonce);
    const now = this.now();
    const corpus = await this.loadCorpusForSession({
      communityId: request.communityId,
      now,
    });
    const sessionId = `demo-${randomUUID()}`;
    const firstEpoch = createEpoch({
      sequence: 1,
      createdAt: now.toISOString(),
      label: 'Baseline policy',
      decidedByEpochId: null,
      aggregate: {
        aggregateMethod: 'trimmed_mean_no_trim_under_10',
        voteCount: 0,
        trimCount: 0,
        weights: corpus.baseWeights,
        topicIntent: cloneShadowTopicIntent(corpus.baseTopicIntent),
        ...(this.contentRulesEnabled
          ? { contentRules: emptyShadowContentRules(SHADOW_DEMO_TOTAL_DEMO_VOTERS) }
          : {}),
      },
    });
    const state: ShadowDemoSessionState = {
      sessionId,
      communityId: request.communityId,
      seed: this.seed(),
      phase: 'created',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SHADOW_DEMO_SESSION_TTL_SECONDS * 1000).toISOString(),
      corpusId: corpus.corpusId,
      currentEpochId: firstEpoch.id,
      epochs: [firstEpoch],
      votes: [],
      corpus,
      warnings: corpus.warnings,
    };

    const created = await this.store.createSession(
      state,
      ttlSecondsForState(state, now),
      DEMO_MAX_ACTIVE_SESSIONS,
      request.clientNonce
    );
    if (!created) {
      await this.rejectReusedCreationNonce(request.clientNonce);
      throw new DemoStoreCapacityError(
        `Shadow demo is at its ${DEMO_MAX_ACTIVE_SESSIONS}-session capacity; retry after an active session expires`
      );
    }
    return this.projectSessionResult({
      sessionId,
      payload: sessionPayload(state, this.contentRulesEnabled),
      warnings: state.warnings,
    });
  }

  async getSession(sessionId: string): Promise<ShadowDemoServiceResult<ShadowDemoSessionPayload>> {
    const state = await this.readRequiredSession(sessionId);
    return this.projectSessionResult({
      sessionId,
      payload: sessionPayload(state, this.contentRulesEnabled),
      warnings: state.warnings,
    });
  }

  async castVote(request: CastVoteRequest): Promise<ShadowDemoServiceResult<ShadowDemoSessionPayload>> {
    if (!this.contentRulesEnabled) {
      this.validateExcludeKeywordsForApi(request.excludeKeywords);
    }
    const operation = async (): Promise<PendingSessionMutation<ShadowDemoServiceResult<ShadowDemoSessionPayload>>> => {
      const state = await this.readRequiredSession(request.sessionId);
      assertCurrentEpoch(state, request.baseEpochId);
      assertPhaseForReviewerVote(state);
      const weights = validateWeightsForApi(request.weights);
      const topicIntent = validateTopicIntentForSession(state, request.topicIntent);
      const excludeKeywords = this.validateExcludeKeywordsForApi(request.excludeKeywords);
      const now = this.now().toISOString();
      const reviewerVote: ShadowDemoVote = {
        id: `vote-reviewer-${request.baseEpochId}`,
        epochId: request.baseEpochId,
        actorType: 'reviewer',
        actorId: 'reviewer',
        label: 'Reviewer',
        weights,
        topicIntent,
        ...(excludeKeywords.length > 0 ? { excludeKeywords } : {}),
        createdAt: now,
      };

      const nextVotes = state.votes
        .filter((vote) => !(vote.epochId === request.baseEpochId && vote.actorType === 'reviewer'))
        .concat(reviewerVote);
      const nextState: ShadowDemoSessionState = {
        ...state,
        phase: 'reviewer_voted',
        votes: nextVotes,
      };
      return {
        state: nextState,
        response: {
          sessionId: nextState.sessionId,
          payload: sessionPayload(nextState, this.contentRulesEnabled),
          warnings: nextState.warnings,
        },
      };
    };

    const result = await this.runIdempotent({
      sessionId: request.sessionId,
      idempotencyKey: request.idempotencyKey,
      requestPayload: request,
      operation,
      mapReplay: (response) => publicSessionMutationResult(response, this.contentRulesEnabled),
    });
    // runIdempotent has awaited its finally/release before any remote display checks begin.
    return this.projectSessionResult(result);
  }

  async runSyntheticVoters(
    request: RunSyntheticVotersRequest
  ): Promise<ShadowDemoServiceResult<ShadowDemoSessionPayload>> {
    const operation = async (): Promise<PendingSessionMutation<ShadowDemoServiceResult<ShadowDemoSessionPayload>>> => {
      const state = await this.readRequiredSession(request.sessionId);
      assertCurrentEpoch(state, request.baseEpochId);
      if (state.phase !== 'reviewer_voted') {
        throw new DemoConflictError('Cast the reviewer vote before running synthetic voters');
      }
      const currentEpoch = currentEpochOf(state);
      const reviewerVote = latestReviewerVoteForEpoch(state, request.baseEpochId);
      if (!reviewerVote) {
        throw new DemoConflictError(`Reviewer vote is missing for ${request.baseEpochId}`);
      }
      const now = this.now().toISOString();
      const syntheticVoterVotes = createSyntheticVoterVotes({
        seed: state.seed,
        epochId: request.baseEpochId,
        communityId: state.communityId,
        reviewerWeights: reviewerVote.weights,
        reviewerTopicIntent: reviewerVote.topicIntent,
        priorCommunityWeights: currentEpoch.aggregate.weights,
        priorTopicIntent: currentEpoch.aggregate.topicIntent,
        createdAt: now,
        ...(this.contentRulesEnabled
          ? {
              contentRules: {
                reviewerExcludeKeywords: reviewerVote.excludeKeywords ?? [],
                priorAdoptedExcludeKeywords:
                  currentEpoch.aggregate.contentRules?.adoptedExcludeKeywords ?? [],
              },
            }
          : {}),
      });
      const nextVotes = state.votes
        .filter((vote) => !(vote.epochId === request.baseEpochId && vote.actorType === 'synthetic_voter'))
        .concat(syntheticVoterVotes);
      const nextState: ShadowDemoSessionState = {
        ...state,
        phase: 'synthetic_voters_ran',
        votes: nextVotes,
      };
      return {
        state: nextState,
        response: {
          sessionId: nextState.sessionId,
          payload: sessionPayload(nextState, this.contentRulesEnabled),
          warnings: nextState.warnings,
        },
      };
    };

    const result = await this.runIdempotent({
      sessionId: request.sessionId,
      idempotencyKey: request.idempotencyKey,
      requestPayload: request,
      operation,
      mapReplay: (response) => publicSessionMutationResult(response, this.contentRulesEnabled),
    });
    // runIdempotent has awaited its finally/release before any remote display checks begin.
    return this.projectSessionResult(result);
  }

  async advanceEpoch(request: AdvanceEpochRequest): Promise<ShadowDemoServiceResult<ShadowDemoSessionPayload>> {
    const operation = async (): Promise<PendingSessionMutation<ShadowDemoServiceResult<ShadowDemoSessionPayload>>> => {
      const state = await this.readRequiredSession(request.sessionId);
      assertCurrentEpoch(state, request.fromEpochId);
      const currentEpoch = currentEpochOf(state);
      if (currentEpoch.sequence >= SHADOW_DEMO_MAX_EPOCHS_PER_SESSION) {
        throw new DemoConflictError(
          `Shadow demo session reached the ${SHADOW_DEMO_MAX_EPOCHS_PER_SESSION} epoch limit`
        );
      }
      if (state.phase !== 'synthetic_voters_ran') {
        throw new DemoConflictError('Run the synthetic community voters before advancing the epoch');
      }
      const now = this.now().toISOString();
      const decisionVotes = votesForEpoch(state, currentEpoch.id);
      assertCompleteDemoElectorate(decisionVotes, currentEpoch.id);
      const nextAggregate = {
        ...aggregateShadowVotes(decisionVotes),
        ...(this.contentRulesEnabled
          ? { contentRules: aggregateShadowContentRules(decisionVotes, decisionVotes.length) }
          : {}),
      };
      const advancedEpoch: ShadowDemoEpoch = {
        ...currentEpoch,
        status: 'advanced',
        advancedAt: now,
      };
      const nextEpoch = createEpoch({
        sequence: currentEpoch.sequence + 1,
        createdAt: now,
        label: `Shadow epoch ${currentEpoch.sequence + 1}`,
        decidedByEpochId: currentEpoch.id,
        aggregate: nextAggregate,
      });
      const nextState: ShadowDemoSessionState = {
        ...state,
        phase: 'epoch_advanced',
        currentEpochId: nextEpoch.id,
        epochs: state.epochs.map((epoch) => (epoch.id === currentEpoch.id ? advancedEpoch : epoch)).concat(nextEpoch),
      };
      return {
        state: nextState,
        response: {
          sessionId: nextState.sessionId,
          payload: sessionPayload(nextState, this.contentRulesEnabled),
          warnings: nextState.warnings,
        },
      };
    };

    const result = await this.runIdempotent({
      sessionId: request.sessionId,
      idempotencyKey: request.idempotencyKey,
      requestPayload: request,
      operation,
      mapReplay: (response) => publicSessionMutationResult(response, this.contentRulesEnabled),
    });
    // runIdempotent has awaited its finally/release before any remote display checks begin.
    return this.projectSessionResult(result);
  }

  async getFeed(request: GetFeedRequest): Promise<ShadowDemoServiceResult<ShadowDemoFeedPayload>> {
    const state = await this.readRequiredSession(request.sessionId);
    const epoch = epochByIdOrCurrent(state, request.epochId);
    const previousEpoch = previousEpochFor(state, epoch);
    const ranked = rankedPosts({
      corpus: state.corpus,
      epoch,
      previousEpoch,
      limit: request.limit,
      contentRulesEnabled: this.contentRulesEnabled,
    });
    const displayRows = [
      ...ranked.posts,
      ...(this.contentRulesEnabled && epoch.aggregate.contentRules ? ranked.withheld : []),
    ];
    const displayUris = new Set(displayRows.flatMap((row) => row.post.kind === 'public_post' ? [row.post.uri] : []));
    const display = await this.projectDisplay(state.corpus, state.corpus.items.filter((item) => displayUris.has(item.postUri)));
    return {
      sessionId: state.sessionId,
      payload: {
        epochId: epoch.id,
        corpusId: state.corpusId,
        communityId: state.communityId,
        corpusHealth: state.corpus.health,
        corpusProvenance: corpusProvenanceFor(state),
        aggregate: publicAggregate(epoch.aggregate, this.contentRulesEnabled),
        posts: ranked.posts.map((post) => projectRankedPost(post, display)),
        ...(this.contentRulesEnabled && epoch.aggregate.contentRules
          ? { withheldPosts: ranked.withheld.map((post) => ({ ...post, post: projectedPost(post.post, display) })) }
          : {}),
      },
      warnings: state.warnings,
    };
  }

  async getReceipt(request: GetReceiptRequest): Promise<ShadowDemoServiceResult<ShadowDemoReceiptPayload>> {
    const state = await this.readRequiredSession(request.sessionId);
    const epoch = epochByIdOrCurrent(state, request.epochId);
    const item = state.corpus.items.find((candidate) => candidate.postUri === request.postUri);
    if (!item) {
      throw new DemoValidationError(`Post URI is not part of this frozen demo corpus: ${request.postUri}`);
    }
    const display = await this.projectDisplay(state.corpus, [item]);
    if (item.displayPost.kind !== 'public_post' || display.get(item.postUri)?.kind !== 'public_post') {
      throw new DemoValidationError('Receipt is unavailable for a post hidden by Bluesky public-view policy');
    }

    const previousEpoch = previousEpochFor(state, epoch);
    const ranked = rankedPosts({
      corpus: state.corpus,
      epoch,
      previousEpoch,
      limit: state.corpus.items.length,
      contentRulesEnabled: this.contentRulesEnabled,
    });
    const withheldEntry = ranked.withheld.find(
      (candidate) => candidate.post.kind === 'public_post' && candidate.post.uri === request.postUri
    );
    if (withheldEntry) {
      const rules = epoch.aggregate.contentRules;
      throw new DemoValidationError(
        `Post is withheld by adopted community rule "-${withheldEntry.keyword}" `
        + `(${withheldEntry.supportCount}/${rules?.electorate ?? SHADOW_DEMO_TOTAL_DEMO_VOTERS} support, `
        + `threshold ${rules?.threshold ?? '?'}); withheld posts have no rank receipt in this epoch`
      );
    }
    const rankedPost = ranked.posts.find(
      (candidate) => candidate.post.kind === 'public_post' && candidate.post.uri === request.postUri
    );
    if (!rankedPost) {
      throw new DemoValidationError(`Ranked post missing from frozen corpus: ${request.postUri}`);
    }
    if (rankedPost.score === null) {
      throw new DemoValidationError(`Receipt score unavailable for hidden post: ${request.postUri}`);
    }

    return {
      sessionId: state.sessionId,
      payload: {
        receipt: {
          type: 'shadow_demo_receipt',
          epochId: epoch.id,
          postUri: request.postUri,
          visibleRank: rankedPost.rank,
          previousRank: rankedPost.previousRank,
          score: rankedPost.score,
          componentScore: rankedPost.componentScore ?? rankedPost.score,
          publicationAdjustment: rankedPost.publicationAdjustment ?? 1,
          publishedRank: rankedPost.publishedRank,
          publishedScore: rankedPost.publishedScore,
          scoredAt: item.scoredAt,
          aggregate: publicAggregate(epoch.aggregate, this.contentRulesEnabled),
          reviewerBallotShare: reviewerBallotShareFor(state, epoch),
          components: receiptContributions(
            item,
            epoch.aggregate.weights,
            epoch.aggregate.topicIntent
          ),
          topicRelevanceFormula: explainTopicRelevance(
            item.rawScores.relevance,
            item.topicVector,
            epoch.aggregate.topicIntent
          ),
          provenance: {
            ...corpusProvenanceFor(state),
            shadowEpochId: epoch.id,
            postInclusionReasons: item.inclusionReasons,
          },
          counterfactuals: counterfactualsForReceipt({
            state,
            item,
            epoch,
            visibleRank: rankedPost.rank,
            contentRulesEnabled: this.contentRulesEnabled,
          }),
          ...(this.contentRulesEnabled && epoch.aggregate.contentRules
            ? {
                contentRules: {
                  adoptedExcludeKeywords: [...epoch.aggregate.contentRules.adoptedExcludeKeywords],
                  threshold: epoch.aggregate.contentRules.threshold,
                  electorate: epoch.aggregate.contentRules.electorate,
                  matchedKeyword: null,
                },
              }
            : {}),
        },
      },
      warnings: state.warnings,
    };
  }

  private validateExcludeKeywordsForApi(value: unknown): string[] {
    if (!this.contentRulesEnabled) {
      // Reject any explicitly supplied value (including null); only an omitted
      // field is treated as "no content-rule ballot".
      if (value !== undefined) {
        throw new DemoValidationError('Shadow demo content rules are not enabled on this deployment');
      }
      return [];
    }
    try {
      return validateShadowExcludeKeywords(value);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new DemoValidationError(message);
    }
  }

  private async projectSessionResult(
    result: ShadowDemoServiceResult<ShadowDemoSessionPayload>
  ): Promise<ShadowDemoServiceResult<ShadowDemoSessionPayload>> {
    if (!this.contentRulesEnabled || result.sessionId === null) return result;
    try {
      const state = await this.readRequiredSession(result.sessionId);
      const display = await this.projectDisplay(state.corpus, state.corpus.items);
      const items = state.corpus.items.map((item) => ({
        ...item,
        displayPost: display.get(item.postUri) ?? hiddenDisplayPost('Current display eligibility unavailable'),
      }));
      return {
        ...result,
        payload: { session: {
          ...result.payload.session,
          suggestedExcludeKeywords: suggestedExcludeKeywords(items, SHADOW_DEMO_SUGGESTED_KEYWORD_COUNT),
        } },
      };
    } catch (error) {
      const errorKind = error instanceof Error ? error.name : typeof error;
      logger.warn(
        { errorKind, sessionId: result.sessionId },
        'Shadow demo content-rule suggestions unavailable after committed session result'
      );
      return {
        ...result,
        warnings: [...result.warnings, {
          code: 'content_rule_suggestions_unavailable',
          message: 'Content-rule suggestions are temporarily unavailable; the session change was saved.',
          severity: 'warning',
        }],
        payload: { session: {
          ...result.payload.session,
          suggestedExcludeKeywords: [],
        } },
      };
    }
  }

  private async readRequiredSession(sessionId: string): Promise<ShadowDemoSessionState> {
    const state = await this.store.readSession(sessionId);
    if (!state) {
      throw new DemoNotFoundError(`Shadow demo session not found or expired: ${sessionId}`);
    }
    return state;
  }

  private async loadCorpusForSession(options: {
    communityId: ShadowDemoCommunityId;
    now: Date;
  }): Promise<ShadowDemoCorpus> {
    const cached = await this.store.readSharedCorpus(options.communityId);
    if (cached && cached.health.status === 'live' && cached.health.source !== 'fixture_fallback') {
      return cloneCorpusForSession({
        corpus: cached,
        communityId: options.communityId,
        now: options.now,
      });
    }

    const token = randomUUID();
    let acquired = await this.store.acquireCorpusBuildLock(
      options.communityId,
      token,
      CORPUS_BUILD_LOCK_TTL_MS
    );
    if (!acquired) {
      const waited = await this.waitForSharedCorpus(options.communityId, token);
      if (waited.kind === 'cached') {
        return cloneCorpusForSession({
          corpus: waited.corpus,
          communityId: options.communityId,
          now: options.now,
        });
      }
      acquired = waited.kind === 'acquired';
      if (!acquired) {
        throw new DemoConflictError(
          `Shadow demo corpus is warming for ${options.communityId}; retry session creation shortly`
        );
      }
    }

    const leaseState: { failure: Error | null } = { failure: null };
    let renewalInFlight: Promise<void> = Promise.resolve();
    const renewalTimer = setInterval(() => {
      renewalInFlight = renewalInFlight
        .then(async () => {
          if (leaseState.failure !== null) {
            return;
          }
          const renewed = await this.store.renewCorpusBuildLock(
            options.communityId,
            token,
            CORPUS_BUILD_LOCK_TTL_MS
          );
          if (!renewed) {
            throw new Error(`Corpus build lease was lost for ${options.communityId}`);
          }
        })
        .catch((err: unknown) => {
          leaseState.failure = err instanceof Error ? err : new Error(String(err));
        });
    }, CORPUS_BUILD_LOCK_RENEW_INTERVAL_MS);

    try {
      // A previous owner may have published after the waiter's cache read.
      const published = await this.store.readSharedCorpus(options.communityId);
      if (published && published.health.status === 'live' && published.health.source !== 'fixture_fallback') {
        return cloneCorpusForSession({ corpus: published, communityId: options.communityId, now: options.now });
      }
      const corpus = await this.loadCorpus(options);
      await renewalInFlight;
      if (leaseState.failure !== null) {
        throw new DemoConflictError(leaseState.failure.message);
      }
      const stillOwned = await this.store.renewCorpusBuildLock(
        options.communityId,
        token,
        CORPUS_BUILD_LOCK_TTL_MS
      );
      if (!stillOwned) {
        throw new DemoConflictError(`Corpus build lease was lost for ${options.communityId}`);
      }
      if (corpus.health.status === 'live' && corpus.health.source !== 'fixture_fallback') {
        const committed = await this.store.commitSharedCorpus(
          options.communityId,
          token,
          corpus,
          SHADOW_DEMO_SHARED_CORPUS_TTL_SECONDS
        );
        if (!committed) {
          throw new DemoConflictError(`Corpus build lease was lost for ${options.communityId}`);
        }
      }
      return cloneCorpusForSession({
        corpus,
        communityId: options.communityId,
        now: options.now,
      });
    } finally {
      clearInterval(renewalTimer);
      await renewalInFlight;
      if (acquired) {
        await this.store.releaseCorpusBuildLock(options.communityId, token);
      }
    }
  }

  private async waitForSharedCorpus(
    communityId: ShadowDemoCommunityId,
    token: string
  ): Promise<{ kind: 'cached'; corpus: ShadowDemoCorpus } | { kind: 'acquired' } | { kind: 'timed-out' }> {
    const maxAttempts = Math.ceil(
      (CORPUS_BUILD_LOCK_TTL_MS + CORPUS_BUILD_WAIT_MARGIN_MS) / CORPUS_BUILD_WAIT_INTERVAL_MS
    );
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await delay(CORPUS_BUILD_WAIT_INTERVAL_MS);
      const cached = await this.store.readSharedCorpus(communityId);
      if (cached && cached.health.status === 'live' && cached.health.source !== 'fixture_fallback') {
        return { kind: 'cached', corpus: cached };
      }
      if (await this.store.acquireCorpusBuildLock(communityId, token, CORPUS_BUILD_LOCK_TTL_MS)) {
        return { kind: 'acquired' };
      }
    }
    return { kind: 'timed-out' };
  }

  private async runIdempotent<TPayload>(options: {
    sessionId: string;
    idempotencyKey: string | null;
    requestPayload: unknown;
    operation: () => Promise<PendingSessionMutation<TPayload>>;
    mapReplay: (response: TPayload) => TPayload;
  }): Promise<TPayload> {
    const token = randomUUID();
    const acquired = await this.store.acquireSessionLock(options.sessionId, token, LOCK_TTL_MS);
    if (!acquired) {
      throw new DemoConflictError(`Shadow demo session is busy: ${options.sessionId}`);
    }
    try {
      const requestHash = hashPayload(options.requestPayload);
      if (options.idempotencyKey) {
        const existing = await this.store.readIdempotency<TPayload>(
          options.sessionId,
          options.idempotencyKey
        );
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new DemoConflictError(`Idempotency key reused with a different payload: ${options.idempotencyKey}`);
          }
          return options.mapReplay(existing.response);
        }
      }

      const mutation = await options.operation();
      const idempotencyRecord: IdempotencyRecord<TPayload> | null = options.idempotencyKey
        ? {
          requestHash,
          response: mutation.response,
          createdAt: this.now().toISOString(),
        }
        : null;
      const committed = await this.store.commitSessionMutation({
        session: mutation.state,
        ttlSeconds: ttlSecondsForState(mutation.state, this.now()),
        lockToken: token,
        idempotencyKey: options.idempotencyKey,
        idempotencyRecord,
      });
      if (!committed) {
        throw new DemoConflictError(
          `Shadow demo mutation ownership expired for ${options.sessionId}; refresh the session before retrying`
        );
      }
      return mutation.response;
    } finally {
      await this.store.releaseSessionLock(options.sessionId, token);
    }
  }
}

function publicSessionMutationResult(
  result: ShadowDemoServiceResult<ShadowDemoSessionPayload>,
  contentRulesEnabled: boolean
): ShadowDemoServiceResult<ShadowDemoSessionPayload> {
  if (contentRulesEnabled) {
    return result;
  }
  const {
    contentRulesEnabled: _contentRulesEnabled,
    suggestedExcludeKeywords: _suggestedExcludeKeywords,
    ...session
  } = result.payload.session;
  return {
    ...result,
    payload: {
      session: {
        ...session,
        epochs: session.epochs.map((epoch) => publicEpoch(epoch, false)),
        pendingAggregate: session.pendingAggregate
          ? publicAggregate(session.pendingAggregate, false)
          : null,
        votes: session.votes.map((vote) => publicVote(vote, false)),
      },
    },
  };
}

export function createDefaultShadowDemoService(): ShadowDemoService {
  return new ShadowDemoService({
    store: createRedisDemoStore(),
    loadCorpus: createDefaultCorpusLoader(),
    now: () => new Date(),
    contentRulesEnabled: config.DEMO_CONTENT_RULES_ENABLED,
  });
}

function sessionPayload(
  state: ShadowDemoSessionState,
  contentRulesEnabled: boolean
): ShadowDemoSessionPayload {
  return {
    session: {
      sessionId: state.sessionId,
      community: DEMO_COMMUNITIES[state.communityId],
      phase: state.phase,
      currentEpochId: state.currentEpochId,
      expiresAt: state.expiresAt,
      corpusHealth: state.corpus.health,
      epochs: state.epochs.map((epoch) => publicEpoch(epoch, contentRulesEnabled)),
      pendingAggregate: pendingAggregateFor(state, contentRulesEnabled),
      voteCount: state.votes.length,
      guidedEpochs: SHADOW_DEMO_GUIDED_EPOCHS,
      maxEpochs: SHADOW_DEMO_MAX_EPOCHS_PER_SESSION,
      syntheticVoterCount: SHADOW_DEMO_SYNTHETIC_VOTER_COUNT,
      totalDemoVoters: SHADOW_DEMO_TOTAL_DEMO_VOTERS,
      corpusProvenance: corpusProvenanceFor(state),
      voterProfiles: getShadowDemoVoterProfiles(state.communityId),
      votes: state.votes.map((vote) => publicVote(vote, contentRulesEnabled)),
      topicCatalog: state.corpus.topicCatalog,
      sourceFeedUri: state.corpus.sourceFeedUri,
      ...(contentRulesEnabled
        ? {
            contentRulesEnabled: true,
            suggestedExcludeKeywords: [],
          }
        : {}),
    },
  };
}

function corpusProvenanceFor(state: ShadowDemoSessionState): ShadowDemoSessionPayload['session']['corpusProvenance'] {
  if (state.corpus.health.source === 'fixture_fallback') {
    return {
      mode: 'illustrative_fixture_session_frozen',
      label: 'Illustrative mechanics fixture',
      description:
        'Illustrative posts and score inputs are frozen for this session because the approved production snapshot was unavailable or did not pass its release gates.',
      corpusId: state.corpusId,
      productionEpochId: state.corpus.baseProductionEpochId,
      sampledAt: state.corpus.health.sampledAt,
      windowHours: 0,
      topicScoreThreshold: 0,
      eligiblePostCount: state.corpus.items.length,
    };
  }
  if (state.communityId === 'community_gov' && state.corpus.sourceSnapshot) {
    if (!state.corpus.sourceFeedUri) {
      throw new Error(`Corgi Commons snapshot corpus is missing its source feed URI: ${state.corpusId}`);
    }
    return {
      mode: 'production_feed_snapshot_session_frozen',
      label: 'Reviewer-safe snapshot of the live Community Governed Feed',
      description:
        'Posts were sourced from the published Corgi Commons feed and frozen so rank movement is attributable to shadow policy changes.',
      corpusId: state.corpusId,
      productionEpochId: state.corpus.baseProductionEpochId,
      sampledAt: state.corpus.health.sampledAt,
      windowHours: 0,
      topicScoreThreshold: 0,
      eligiblePostCount: state.corpus.health.eligiblePostCount ?? state.corpus.items.length,
      sourceFeedUri: state.corpus.sourceFeedUri,
      sourceFeedName: state.corpus.sourceSnapshot.feedName,
      sourceSnapshotDigest: state.corpus.sourceSnapshot.digest,
      sourceRunId: state.corpus.sourceSnapshot.runId,
      sourceUpdatedAt: state.corpus.sourceSnapshot.updatedAt,
      sourceReviewedAt: state.corpus.sourceSnapshot.reviewedAt ?? undefined,
      sourcePostCount: state.corpus.sourceSnapshot.sourcePostCount,
      selectionPolicyVersion: state.corpus.sourceSnapshot.selectionPolicyVersion,
      baselineOrderDigest: state.corpus.sourceSnapshot.baselineOrderDigest,
    };
  }
  return {
    ...SHADOW_DEMO_CORPUS_PROVENANCE,
    corpusId: state.corpusId,
    productionEpochId: state.corpus.baseProductionEpochId,
    sampledAt: state.corpus.health.sampledAt,
    eligiblePostCount: state.corpus.health.candidatePosts72h,
  };
}

function reviewerBallotShareFor(state: ShadowDemoSessionState, epoch: ShadowDemoEpoch): number {
  if (!epoch.decidedByEpochId || epoch.aggregate.voteCount === 0) {
    return 0;
  }
  const hasReviewerBallot = state.votes.some(
    (vote) => vote.epochId === epoch.decidedByEpochId && vote.actorType === 'reviewer'
  );
  return hasReviewerBallot ? 1 / epoch.aggregate.voteCount : 0;
}

function cloneCorpusForSession(options: {
  corpus: ShadowDemoCorpus;
  communityId: ShadowDemoCommunityId;
  now: Date;
}): ShadowDemoCorpus {
  return {
    ...(JSON.parse(JSON.stringify(options.corpus)) as ShadowDemoCorpus),
    corpusId: `corpus-${randomUUID()}`,
    communityId: options.communityId,
    createdAt: options.now.toISOString(),
    expiresAt: new Date(options.now.getTime() + SHADOW_DEMO_SESSION_TTL_SECONDS * 1000).toISOString(),
  };
}

function ttlSecondsForState(state: ShadowDemoSessionState, now: Date): number {
  const expiresAt = new Date(state.expiresAt).getTime();
  const ttlMs = expiresAt - now.getTime();
  return Math.max(1, Math.ceil(ttlMs / 1000));
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createEpoch(options: {
  sequence: number;
  createdAt: string;
  label: string;
  decidedByEpochId: string | null;
  aggregate: ShadowDemoEpoch['aggregate'];
}): ShadowDemoEpoch {
  return {
    id: `shadow-epoch-${options.sequence}`,
    sequence: options.sequence,
    label: options.label,
    status: 'open',
    createdAt: options.createdAt,
    advancedAt: null,
    decidedByEpochId: options.decidedByEpochId,
    aggregate: {
      ...options.aggregate,
      weights: { ...options.aggregate.weights },
      topicIntent: cloneShadowTopicIntent(options.aggregate.topicIntent),
      ...(options.aggregate.contentRules
        ? {
            contentRules: {
              ...options.aggregate.contentRules,
              adoptedExcludeKeywords: [...options.aggregate.contentRules.adoptedExcludeKeywords],
              support: options.aggregate.contentRules.support.map((entry) => ({ ...entry })),
            },
          }
        : {}),
    },
  };
}

function validateWeightsForApi(value: unknown): ShadowDemoWeights {
  try {
    return validateShadowWeights(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DemoValidationError(message);
  }
}

function validateTopicIntentForApi(value: unknown): ShadowDemoTopicIntent {
  try {
    return validateShadowTopicIntent(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DemoValidationError(message);
  }
}

function validateTopicIntentForSession(
  state: ShadowDemoSessionState,
  value: unknown
): ShadowDemoTopicIntent {
  if (state.communityId !== 'community_gov') {
    return validateTopicIntentForApi(value);
  }
  const topicSlugs = (state.corpus.topicCatalog ?? []).map((topic) => topic.slug);
  let intent: ShadowDemoTopicIntent;
  try {
    intent = validateShadowTopicIntentForCatalog(value, topicSlugs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DemoValidationError(message);
  }
  const expected = new Set(topicSlugs);
  const received = Object.keys(intent.topicWeights);
  if (expected.size === 0) {
    throw new DemoValidationError('Corgi Commons topic catalog is unavailable for this session');
  }
  const missing = [...expected].filter((slug) => intent.topicWeights[slug] === undefined);
  const unknown = received.filter((slug) => !expected.has(slug));
  if (missing.length > 0 || unknown.length > 0 || received.length !== expected.size) {
    throw new DemoValidationError(
      `Corgi Commons vote must include the complete frozen topic catalog; missing=${missing.join(',') || 'none'} unknown=${unknown.join(',') || 'none'}`
    );
  }
  return intent;
}

function assertCurrentEpoch(state: ShadowDemoSessionState, epochId: string): void {
  if (state.currentEpochId !== epochId) {
    throw new DemoConflictError(
      `Stale shadow demo epoch. Current epoch is ${state.currentEpochId}; received ${epochId}`
    );
  }
}

function currentEpochOf(state: ShadowDemoSessionState): ShadowDemoEpoch {
  const epoch = state.epochs.find((candidate) => candidate.id === state.currentEpochId);
  if (!epoch) {
    throw new DemoConflictError(`Current shadow demo epoch is missing: ${state.currentEpochId}`);
  }
  return epoch;
}

function epochByIdOrCurrent(state: ShadowDemoSessionState, epochId: string | null): ShadowDemoEpoch {
  if (!epochId) {
    return currentEpochOf(state);
  }
  const epoch = state.epochs.find((candidate) => candidate.id === epochId);
  if (!epoch) {
    throw new DemoValidationError(`Unknown shadow demo epoch for this session: ${epochId}`);
  }
  return epoch;
}

function previousEpochFor(state: ShadowDemoSessionState, epoch: ShadowDemoEpoch): ShadowDemoEpoch | null {
  const previousSequence = epoch.sequence - 1;
  return state.epochs.find((candidate) => candidate.sequence === previousSequence) ?? null;
}

function latestReviewerVoteForEpoch(
  state: ShadowDemoSessionState,
  epochId: string
): ShadowDemoVote | null {
  const vote = [...state.votes]
    .reverse()
    .find((candidate) => candidate.epochId === epochId && candidate.actorType === 'reviewer');
  return vote ?? null;
}

function votesForEpoch(state: ShadowDemoSessionState, epochId: string): ShadowDemoVote[] {
  return state.votes.filter((vote) => vote.epochId === epochId);
}

function pendingAggregateFor(
  state: ShadowDemoSessionState,
  contentRulesEnabled: boolean
): ReturnType<typeof aggregateShadowVotes> | null {
  const votes = votesForEpoch(state, state.currentEpochId);
  if (votes.length === 0) {
    return null;
  }
  return {
    ...aggregateShadowVotes(votes),
    ...(contentRulesEnabled
      ? {
          // Live support preview while the electorate is still assembling:
          // threshold stays at the full-electorate bar the decision will use.
          contentRules: aggregateShadowContentRules(votes, SHADOW_DEMO_TOTAL_DEMO_VOTERS),
        }
      : {}),
  };
}

function assertPhaseForReviewerVote(state: ShadowDemoSessionState): void {
  if (!['created', 'epoch_advanced', 'reviewer_voted'].includes(state.phase)) {
    throw new DemoConflictError(`Cannot cast a reviewer vote during phase ${state.phase}`);
  }
}

function assertCompleteDemoElectorate(votes: ShadowDemoVote[], epochId: string): void {
  const reviewerVotes = votes.filter((vote) => vote.actorType === 'reviewer').length;
  const syntheticVotes = votes.filter((vote) => vote.actorType === 'synthetic_voter').length;
  if (reviewerVotes !== 1 || syntheticVotes !== SHADOW_DEMO_SYNTHETIC_VOTER_COUNT) {
    throw new DemoConflictError(
      `Shadow epoch ${epochId} requires 1 reviewer and ${SHADOW_DEMO_SYNTHETIC_VOTER_COUNT} synthetic votes; received ${reviewerVotes} reviewer and ${syntheticVotes} synthetic votes`
    );
  }
}

// When the flag is off, stored rules are ignored so an off deployment is fully
// inert even if a session persisted rules while the flag was on (flip-off must
// stay byte-identical to v4).
function adoptedRulesFor(epoch: ShadowDemoEpoch, contentRulesEnabled: boolean): string[] {
  if (!contentRulesEnabled) {
    return [];
  }
  return epoch.aggregate.contentRules?.adoptedExcludeKeywords ?? [];
}

// Strip persisted content-rule metadata from an aggregate when the flag is off,
// so a session that adopted rules while enabled reads back byte-identical to v4
// after a flip-off. No-op when enabled or when the aggregate never had rules.
function publicAggregate(
  aggregate: ShadowDemoEpoch['aggregate'],
  contentRulesEnabled: boolean
): ShadowDemoEpoch['aggregate'] {
  if (contentRulesEnabled || aggregate.contentRules === undefined) {
    return aggregate;
  }
  const { contentRules: _omitted, ...rest } = aggregate;
  return rest;
}

function publicEpoch(epoch: ShadowDemoEpoch, contentRulesEnabled: boolean): ShadowDemoEpoch {
  const aggregate = publicAggregate(epoch.aggregate, contentRulesEnabled);
  return aggregate === epoch.aggregate ? epoch : { ...epoch, aggregate };
}

// Strip the persisted per-ballot excludeKeywords from a vote when the flag is
// off, so flipped-off session payloads leak no rule-ballot metadata.
function publicVote(vote: ShadowDemoVote, contentRulesEnabled: boolean): ShadowDemoVote {
  if (contentRulesEnabled || vote.excludeKeywords === undefined) {
    return vote;
  }
  const { excludeKeywords: _omitted, ...rest } = vote;
  return rest;
}

function hasPublishedBaseline(corpus: ShadowDemoCorpus, epoch: ShadowDemoEpoch): boolean {
  return corpus.communityId === 'community_gov'
    && epoch.sequence === 1
    && corpus.items.length > 0
    && corpus.items.every((item) => item.publishedRank !== undefined);
}

function rankedPosts(options: {
  corpus: ShadowDemoCorpus;
  epoch: ShadowDemoEpoch;
  previousEpoch: ShadowDemoEpoch | null;
  limit: number;
  contentRulesEnabled: boolean;
}): { posts: ShadowDemoRankedPost[]; withheld: ShadowDemoWithheldPost[] } {
  const previousRanks = options.previousEpoch
    ? rankMapForEpoch(options.corpus, options.previousEpoch, options.contentRulesEnabled)
    : new Map<string, number>();
  const isPublishedBaseline = hasPublishedBaseline(options.corpus, options.epoch);
  const ruleApplication = applyShadowContentRules(
    options.corpus.items,
    adoptedRulesFor(options.epoch, options.contentRulesEnabled)
  );
  const support = new Map(
    (options.epoch.aggregate.contentRules?.support ?? []).map((entry) => [entry.keyword, entry.supportCount])
  );
  const withheld = ruleApplication.withheld.map((entry) => ({
    keyword: entry.keyword,
    supportCount: support.get(entry.keyword) ?? 0,
    previousRank: previousRanks.get(entry.item.postUri) ?? null,
    post: entry.item.displayPost,
  }));
  const posts = scoreAndPublishItems(
    ruleApplication.eligible,
    options.epoch.aggregate.weights,
    options.epoch.aggregate.topicIntent,
    isPublishedBaseline,
    publicationPolicyFor(options.corpus)
  )
    .slice(0, options.limit)
    .map((entry, index) => {
      const rank = isPublishedBaseline ? entry.item.publishedRank ?? index + 1 : index + 1;
      const previousRank = previousRanks.get(entry.item.postUri) ?? null;
      return {
        rank,
        previousRank,
        movement: previousRank === null ? null : previousRank - rank,
        score: entry.item.displayPost.kind === 'public_post' ? entry.score : null,
        weightedComponents:
          entry.item.displayPost.kind === 'public_post' ? entry.weightedComponents : null,
        rawScores: entry.item.displayPost.kind === 'public_post' ? entry.effectiveRawScores : null,
        post: entry.item.displayPost,
        publishedRank: entry.item.publishedRank,
        publishedScore: entry.item.publishedScore,
        componentScore: entry.item.displayPost.kind === 'public_post' ? entry.componentScore : null,
        publicationAdjustment: entry.item.displayPost.kind === 'public_post'
          ? entry.publicationAdjustment
          : null,
      };
    });
  return { posts, withheld };
}

function rankMapForEpoch(
  corpus: ShadowDemoCorpus,
  epoch: ShadowDemoEpoch,
  contentRulesEnabled: boolean
): Map<string, number> {
  const ranks = new Map<string, number>();
  if (hasPublishedBaseline(corpus, epoch)) {
    for (const item of corpus.items) ranks.set(item.postUri, item.publishedRank as number);
    return ranks;
  }
  scoreAndPublishItems(
    applyShadowContentRules(corpus.items, adoptedRulesFor(epoch, contentRulesEnabled)).eligible,
    epoch.aggregate.weights,
    epoch.aggregate.topicIntent,
    false,
    publicationPolicyFor(corpus)
  )
    .forEach((entry, index) => ranks.set(entry.item.postUri, index + 1));
  return ranks;
}

function receiptContributions(
  item: ShadowDemoCorpusItem,
  weights: ShadowDemoWeights,
  topicIntent: ShadowDemoTopicIntent
): ShadowDemoReceiptContribution[] {
  const scored = scoreFromRawWeights(item.rawScores, weights, item.topicVector, topicIntent);
  return Object.entries(scored.weightedComponents).map(([signal, contribution]) => ({
    signal: signal as ShadowDemoReceiptContribution['signal'],
    rawScore: scored.effectiveRawScores[signal as keyof typeof scored.effectiveRawScores],
    weight: weights[signal as keyof ShadowDemoWeights],
    contribution,
  }));
}

function counterfactualsForReceipt(options: {
  state: ShadowDemoSessionState;
  item: ShadowDemoCorpusItem;
  epoch: ShadowDemoEpoch;
  visibleRank: number;
  contentRulesEnabled: boolean;
}): ShadowDemoCounterfactual[] {
  const previousEpoch = previousEpochFor(options.state, options.epoch);
  const previousWeights = previousEpoch?.aggregate.weights ?? options.state.corpus.baseWeights;
  const previousTopicIntent = previousEpoch?.aggregate.topicIntent ?? options.state.corpus.baseTopicIntent;
  const directReviewerBallotRemoved = aggregateWithoutReviewerVote(options.state, options.epoch);
  const previousCounterfactual = previousEpoch?.sequence === 1 && options.item.publishedRank !== undefined
    ? {
        label: 'previous_epoch' as const,
        description: 'Published rank in the frozen Corgi Commons baseline.',
        rank: options.item.publishedRank,
        deltaFromVisible: options.item.publishedRank - options.visibleRank,
      }
    : counterfactualForWeights({
        label: 'previous_epoch',
        description: 'Rank under the policy applied in the prior shadow epoch.',
        state: options.state,
        item: options.item,
        weights: previousWeights,
        topicIntent: previousTopicIntent,
        visibleRank: options.visibleRank,
        adoptedExcludeKeywords: previousEpoch ? adoptedRulesFor(previousEpoch, options.contentRulesEnabled) : [],
      });
  return [
    previousCounterfactual,
    counterfactualForWeights({
      label: 'engagement_only',
      description: 'Rank if engagement were the only ranking signal.',
      state: options.state,
      item: options.item,
      weights: engagementOnlyWeights(),
      topicIntent: options.epoch.aggregate.topicIntent,
      visibleRank: options.visibleRank,
      adoptedExcludeKeywords: adoptedRulesFor(options.epoch, options.contentRulesEnabled),
    }),
    counterfactualForWeights({
      label: 'direct_reviewer_ballot_removed',
      description: 'Direct reviewer ballot removed while all 24 scripted deterministic ballots are held fixed.',
      state: options.state,
      item: options.item,
      weights: directReviewerBallotRemoved.weights,
      topicIntent: directReviewerBallotRemoved.topicIntent,
      visibleRank: options.visibleRank,
      adoptedExcludeKeywords: adoptedRulesFor(options.epoch, options.contentRulesEnabled),
    }),
  ];
}

function aggregateWithoutReviewerVote(
  state: ShadowDemoSessionState,
  epoch: ShadowDemoEpoch
): ShadowDemoEpoch['aggregate'] {
  const decisionEpochId = epoch.decidedByEpochId;
  if (!decisionEpochId) {
    return previousEpochFor(state, epoch)?.aggregate ?? epoch.aggregate;
  }
  const nonReviewerVotes = state.votes
    .filter((vote) => vote.epochId === decisionEpochId && vote.actorType !== 'reviewer');
  if (nonReviewerVotes.length === 0) {
    return previousEpochFor(state, epoch)?.aggregate ?? epoch.aggregate;
  }
  return aggregateShadowVotes(nonReviewerVotes);
}

function counterfactualForWeights(options: {
  label: ShadowDemoCounterfactual['label'];
  description: string;
  state: ShadowDemoSessionState;
  item: ShadowDemoCorpusItem;
  weights: ShadowDemoWeights;
  topicIntent: ShadowDemoTopicIntent;
  visibleRank: number;
  adoptedExcludeKeywords?: readonly string[];
}): ShadowDemoCounterfactual {
  const rank = rankForWeights(
    options.state.corpus,
    options.item.postUri,
    options.weights,
    options.topicIntent,
    options.adoptedExcludeKeywords ?? []
  );
  return {
    label: options.label,
    description: options.description,
    rank,
    deltaFromVisible: rank === null ? null : rank - options.visibleRank,
  };
}

function rankForWeights(
  corpus: ShadowDemoCorpus,
  postUri: string,
  weights: ShadowDemoWeights,
  topicIntent: ShadowDemoTopicIntent,
  adoptedExcludeKeywords: readonly string[] = []
): number | null {
  const ranked = scoreAndPublishItems(
    applyShadowContentRules(corpus.items, adoptedExcludeKeywords).eligible,
    weights,
    topicIntent,
    false,
    publicationPolicyFor(corpus)
  );
  const index = ranked.findIndex((entry) => entry.item.postUri === postUri);
  return index < 0 ? null : index + 1;
}

function scoreAndPublishItems(
  items: ShadowDemoCorpusItem[],
  weights: ShadowDemoWeights,
  topicIntent: ShadowDemoTopicIntent,
  preservePublishedBaseline: boolean,
  publicationPolicy: ShadowDemoPublicationPolicy
): Array<{
  item: ShadowDemoCorpusItem;
  componentScore: number;
  score: number;
  publicationAdjustment: number;
  weightedComponents: Record<keyof ShadowDemoWeights, number>;
  effectiveRawScores: Record<keyof ShadowDemoWeights, number>;
}> {
  const scored = items.map((item) => {
    const result = scoreFromRawWeights(item.rawScores, weights, item.topicVector, topicIntent);
    return {
      item,
      componentScore: result.score,
      weightedComponents: result.weightedComponents,
      effectiveRawScores: result.effectiveRawScores,
    };
  });
  if (preservePublishedBaseline) {
    return scored
      .map((entry) => ({
        ...entry,
        score: entry.item.publishedScore ?? entry.componentScore,
        publicationAdjustment: entry.item.publishedScore !== undefined && entry.componentScore !== 0
          ? entry.item.publishedScore / entry.componentScore
          : 1,
      }))
      .sort((left, right) => (left.item.publishedRank ?? Number.MAX_SAFE_INTEGER) - (right.item.publishedRank ?? Number.MAX_SAFE_INTEGER));
  }
  const relevanceEligible = scored.filter(
    (entry) => entry.effectiveRawScores.relevance >= publicationPolicy.minimumRelevance
  );
  relevanceEligible.sort((left, right) => right.componentScore - left.componentScore || left.item.postUri.localeCompare(right.item.postUri));
  return applyFeedUrlDedup(
    relevanceEligible.map((entry) => ({
      id: entry.item.postUri,
      score: entry.componentScore,
      embedUrl: entry.item.embedUrl ?? null,
      textLength: entry.item.textLength
        ?? (entry.item.displayPost.kind === 'public_post'
          ? entry.item.displayPost.text.length
          : publicationPolicy.minimumOriginalTextLength),
      value: entry,
    })),
    {
      enabled: publicationPolicy.urlDedupEnabled,
      minimumOriginalTextLength: publicationPolicy.minimumOriginalTextLength,
      decay: publicationPolicy.decay,
    }
  ).entries.map((entry) => ({
    ...entry.value,
    score: entry.score,
    publicationAdjustment: entry.publicationAdjustment,
  }));
}

function publicationPolicyFor(corpus: ShadowDemoCorpus): ShadowDemoPublicationPolicy {
  const frozen = corpus.sourceSnapshot?.publicationPolicy;
  return frozen
    ? { ...frozen, decay: [...frozen.decay] }
    : {
        urlDedupEnabled: config.FEED_DEDUP_ENABLED,
        minimumOriginalTextLength: config.FEED_DEDUP_MIN_TEXT,
        minimumRelevance: config.FEED_MIN_RELEVANCE,
        decay: [...FEED_URL_DEDUP_DECAY],
      };
}

function hashPayload(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function projectedPost(
  post: ShadowDemoDisplayPost,
  display: ReadonlyMap<string, ShadowDemoDisplayPost>
): ShadowDemoDisplayPost {
  if (post.kind === 'hidden_post') return post;
  return display.get(post.uri) ?? hiddenDisplayPost('Current display eligibility unavailable');
}

function projectRankedPost(
  entry: ShadowDemoRankedPost,
  display: ReadonlyMap<string, ShadowDemoDisplayPost>
): ShadowDemoRankedPost {
  const post = projectedPost(entry.post, display);
  if (post.kind === 'public_post') return { ...entry, post };
  // Preserve frozen rank slots and movement; withhold all score disclosures and source identity.
  return {
    rank: entry.rank,
    previousRank: entry.previousRank,
    movement: entry.movement,
    score: null,
    weightedComponents: null,
    rawScores: null,
    componentScore: null,
    publicationAdjustment: null,
    post,
  };
}
