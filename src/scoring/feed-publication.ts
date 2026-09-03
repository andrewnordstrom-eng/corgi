import { createHash } from 'node:crypto';

export interface FeedPublicationCandidate<TValue> {
  id: string;
  score: number;
  embedUrl: string | null;
  textLength: number;
  value: TValue;
  /** Used to make the pre-adjustment order explicit when scores tie. */
  createdAt?: Date | string;
}

export interface FeedPublicationEntry<TValue> extends FeedPublicationCandidate<TValue> {
  /** Score before the publication-only URL adjustment. */
  baseScore: number;
  publicationAdjustment: number;
  /** One-based position in base-score DESC, createdAt DESC, URI ASC order. */
  preAdjustmentPosition: number;
}

export interface FeedUrlDedupResult<TValue> {
  entries: FeedPublicationEntry<TValue>[];
  dedupedUrlCount: number;
  totalUrlCount: number;
}

export const FEED_URL_DEDUP_DECAY = [1, 0.7, 0.5, 0.3] as const;

export const FEED_PUBLICATION_SCHEMA_VERSION = 'corgi.feed-publication.v1' as const;

export const PUBLIC_FEED_COMPONENT_KEYS = [
  'recency',
  'engagement',
  'bridging',
  'source_diversity',
  'relevance',
] as const;

export type PublicFeedComponentKey = typeof PUBLIC_FEED_COMPONENT_KEYS[number];

export interface PublicFeedScoreComponent {
  raw_score: number;
  weight: number;
  weighted: number;
}

export interface PublicFeedScoreComponents {
  recency: PublicFeedScoreComponent;
  engagement: PublicFeedScoreComponent;
  bridging: PublicFeedScoreComponent;
  source_diversity: PublicFeedScoreComponent;
  relevance: PublicFeedScoreComponent;
}

export interface PublicFeedWeights {
  recency: number;
  engagement: number;
  bridging: number;
  source_diversity: number;
  relevance: number;
}

/** Exact, public-safe explanation for one row in a published feed snapshot. */
export interface PublicFeedExplanationEntry {
  post_uri: string;
  epoch_id: number;
  ranked_position: number;
  base_score: number;
  publication_adjustment: number;
  final_score: number;
  engagement_only_position: number;
  source_score_run_id: string;
  scored_at: string;
  classification_method: 'keyword' | 'embedding';
  components: PublicFeedScoreComponents;
}

/** Internal builder input. It deliberately contains no post text or viewer data. */
export interface FeedPublicationExplanationCandidate {
  postUri: string;
  preAdjustmentPosition: number;
  createdAt: Date | string;
  baseScore: number;
  publicationAdjustment: number;
  finalScore: number;
  sourceScoreRunId: string;
  scoredAt: string;
  classificationMethod: 'keyword' | 'embedding';
  components: PublicFeedScoreComponents;
}

export interface FeedPublicationArtifactMetadata {
  epochId: number;
  publicationRunId: string;
  publishedAt: string;
  weights: PublicFeedWeights;
  dedupedUrlCount: number;
  totalUrlCount: number;
}

/** Canonical materialization promoted alongside the Redis sorted set. */
export interface FeedPublicationArtifact {
  schemaVersion: typeof FEED_PUBLICATION_SCHEMA_VERSION;
  epochId: number;
  publicationRunId: string;
  publishedAt: string;
  feedCount: number;
  dedupedUrlCount: number;
  totalUrlCount: number;
  sourceScoreRunIds: string[];
  mixedScoreRunProvenance: boolean;
  weights: PublicFeedWeights;
  entries: PublicFeedExplanationEntry[];
}

export interface FeedPublicationStorageSealInput {
  metadataValues: readonly string[];
  entries: ReadonlyArray<{
    postUri: string;
    serializedExplanation: string;
    explanationSeal: string;
  }>;
}

export class FeedPublicationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedPublicationValidationError';
  }
}

interface OrderedFeedPublicationCandidate<TValue> {
  candidate: FeedPublicationCandidate<TValue>;
  createdAtMs: number | null;
}

const SCORE_TOLERANCE = 1e-9;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Compare candidates using the authoritative order before publication-only
 * adjustments: base score DESC, creation time DESC, then URI ASC.
 */
export function compareFeedPublicationBaseOrder<TValue>(
  left: FeedPublicationCandidate<TValue>,
  right: FeedPublicationCandidate<TValue>
): number {
  const scoreComparison = compareNumbersDescending(left.score, right.score);
  if (scoreComparison !== 0) {
    return scoreComparison;
  }

  const createdAtComparison = compareNullableNumbersDescending(
    parseOptionalTimestamp(left.createdAt, `candidate ${left.id} createdAt`),
    parseOptionalTimestamp(right.createdAt, `candidate ${right.id} createdAt`)
  );
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return compareStringsAscending(left.id, right.id);
}

/** Final-score DESC with the immutable pre-adjustment position as the tie-breaker. */
export function compareFeedPublicationFinalOrder<TValue>(
  left: FeedPublicationEntry<TValue>,
  right: FeedPublicationEntry<TValue>
): number {
  const scoreComparison = compareNumbersDescending(left.score, right.score);
  if (scoreComparison !== 0) {
    return scoreComparison;
  }

  return left.preAdjustmentPosition - right.preAdjustmentPosition;
}

export function applyFeedUrlDedup<TValue>(
  orderedCandidates: readonly FeedPublicationCandidate<TValue>[],
  options: {
    enabled: boolean;
    minimumOriginalTextLength: number;
    decay: readonly number[];
  }
): FeedUrlDedupResult<TValue> {
  if (!Number.isFinite(options.minimumOriginalTextLength) || options.minimumOriginalTextLength < 0) {
    throw new FeedPublicationValidationError(
      `Feed URL dedup minimumOriginalTextLength must be finite and non-negative: ${options.minimumOriginalTextLength}`
    );
  }
  if (options.decay.length === 0 || options.decay.some((value) => !Number.isFinite(value) || value <= 0 || value > 1)) {
    throw new FeedPublicationValidationError('Feed URL dedup decay must contain finite values in (0, 1]');
  }

  const seenIds = new Set<string>();
  const preAdjusted: OrderedFeedPublicationCandidate<TValue>[] = orderedCandidates.map((candidate) => {
    assertNonEmptyString(candidate.id, 'candidate id');
    assertFiniteNumber(candidate.score, `candidate ${candidate.id} score`);
    assertFiniteNumber(candidate.textLength, `candidate ${candidate.id} textLength`);
    if (candidate.textLength < 0) {
      throw new FeedPublicationValidationError(`candidate ${candidate.id} textLength must be non-negative`);
    }
    if (candidate.embedUrl !== null && typeof candidate.embedUrl !== 'string') {
      throw new FeedPublicationValidationError(`candidate ${candidate.id} embedUrl must be a string or null`);
    }
    if (seenIds.has(candidate.id)) {
      throw new FeedPublicationValidationError(`Feed publication candidate id is duplicated: ${candidate.id}`);
    }
    seenIds.add(candidate.id);
    return {
      candidate,
      createdAtMs: parseOptionalTimestamp(candidate.createdAt, `candidate ${candidate.id} createdAt`),
    };
  });

  preAdjusted.sort((left, right) => {
    const scoreComparison = compareNumbersDescending(left.candidate.score, right.candidate.score);
    if (scoreComparison !== 0) {
      return scoreComparison;
    }
    const createdAtComparison = compareNullableNumbersDescending(left.createdAtMs, right.createdAtMs);
    if (createdAtComparison !== 0) {
      return createdAtComparison;
    }
    return compareStringsAscending(left.candidate.id, right.candidate.id);
  });

  const urlCounts = new Map<string, number>();
  const entries = preAdjusted.map(({ candidate }, index): FeedPublicationEntry<TValue> => {
    let publicationAdjustment = 1;
    if (options.enabled && candidate.embedUrl && candidate.textLength < options.minimumOriginalTextLength) {
      const count = urlCounts.get(candidate.embedUrl) ?? 0;
      urlCounts.set(candidate.embedUrl, count + 1);
      publicationAdjustment = options.decay[Math.min(count, options.decay.length - 1)];
    }
    const finalScore = candidate.score * publicationAdjustment;
    if (!Number.isFinite(finalScore)) {
      throw new FeedPublicationValidationError(
        `candidate ${candidate.id} final score must be finite: ${finalScore}`
      );
    }
    return {
      ...candidate,
      score: finalScore,
      baseScore: candidate.score,
      publicationAdjustment,
      preAdjustmentPosition: index + 1,
    };
  });
  entries.sort(compareFeedPublicationFinalOrder);
  return {
    entries,
    dedupedUrlCount: [...urlCounts.values()].filter((count) => count > 1).length,
    totalUrlCount: urlCounts.size,
  };
}

/** Build exact published and engagement-only positions for one coherent feed. */
export function buildFeedPublicationArtifact(
  metadata: FeedPublicationArtifactMetadata,
  candidates: readonly FeedPublicationExplanationCandidate[]
): FeedPublicationArtifact {
  const preAdjustmentPositions = new Set<number>();
  for (const [index, candidate] of candidates.entries()) {
    assertNonEmptyString(candidate.postUri, `candidates[${index}].postUri`);
    assertPositiveInteger(candidate.preAdjustmentPosition, `candidates[${index}].preAdjustmentPosition`);
    if (preAdjustmentPositions.has(candidate.preAdjustmentPosition)) {
      throw new FeedPublicationValidationError(
        `Feed publication explanation preAdjustmentPosition is duplicated: ${candidate.preAdjustmentPosition}`
      );
    }
    preAdjustmentPositions.add(candidate.preAdjustmentPosition);
    parseOptionalTimestamp(candidate.createdAt, `candidates[${index}].createdAt`);
  }
  for (let position = 1; position <= candidates.length; position += 1) {
    if (!preAdjustmentPositions.has(position)) {
      throw new FeedPublicationValidationError(
        `Feed publication explanation is missing preAdjustmentPosition ${position}`
      );
    }
  }

  const orderedCandidates = [...candidates].sort(compareExplanationCandidatesByFinalOrder);
  const engagementOrder = [...candidates].sort(compareExplanationCandidatesByEngagement);
  const engagementPositions = new Map<string, number>();

  for (const [index, candidate] of engagementOrder.entries()) {
    if (engagementPositions.has(candidate.postUri)) {
      throw new FeedPublicationValidationError(
        `Feed publication explanation postUri is duplicated: ${candidate.postUri}`
      );
    }
    engagementPositions.set(candidate.postUri, index + 1);
  }

  const entries = orderedCandidates.map((candidate, index): PublicFeedExplanationEntry => {
    const engagementOnlyPosition = engagementPositions.get(candidate.postUri);
    if (engagementOnlyPosition === undefined) {
      throw new FeedPublicationValidationError(
        `Engagement-only position is missing for post ${candidate.postUri}`
      );
    }
    return {
      post_uri: candidate.postUri,
      epoch_id: metadata.epochId,
      ranked_position: index + 1,
      base_score: candidate.baseScore,
      publication_adjustment: candidate.publicationAdjustment,
      final_score: candidate.finalScore,
      engagement_only_position: engagementOnlyPosition,
      source_score_run_id: candidate.sourceScoreRunId,
      scored_at: candidate.scoredAt,
      classification_method: candidate.classificationMethod,
      components: clonePublicFeedScoreComponents(candidate.components),
    };
  });
  const sourceScoreRunIds = [...new Set(entries.map((entry) => entry.source_score_run_id))].sort(
    compareStringsAscending
  );
  const artifact: FeedPublicationArtifact = {
    schemaVersion: FEED_PUBLICATION_SCHEMA_VERSION,
    epochId: metadata.epochId,
    publicationRunId: metadata.publicationRunId,
    publishedAt: metadata.publishedAt,
    feedCount: entries.length,
    dedupedUrlCount: metadata.dedupedUrlCount,
    totalUrlCount: metadata.totalUrlCount,
    sourceScoreRunIds,
    mixedScoreRunProvenance: sourceScoreRunIds.length > 1,
    weights: { ...metadata.weights },
    entries,
  };

  assertFeedPublicationArtifact(artifact);
  return artifact;
}

/** Validate and serialize with recursively sorted object keys. */
export function serializeFeedPublicationArtifact(artifact: FeedPublicationArtifact): string {
  assertFeedPublicationArtifact(artifact);
  return canonicalJson(artifact);
}

/** Parse untrusted storage bytes and enforce the complete public artifact contract. */
export function parseFeedPublicationArtifact(serialized: string): FeedPublicationArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new FeedPublicationValidationError(`Feed publication artifact is not valid JSON: ${detail}`);
  }
  assertFeedPublicationArtifact(parsed);
  return parsed;
}

/** SHA-256 over the canonical, validated artifact bytes. */
export function digestFeedPublicationArtifact(artifact: FeedPublicationArtifact): string {
  return createHash('sha256')
    .update(serializeFeedPublicationArtifact(artifact), 'utf8')
    .digest('hex');
}

export function assertFeedPublicationDigest(value: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new FeedPublicationValidationError('Feed publication digest must be a lowercase SHA-256 hex digest');
  }
}

/**
 * Produce the operational seal checked inside the atomic Redis promotion
 * script. The public snapshot identity remains the SHA-256 artifact digest;
 * this Redis-compatible SHA-1 seal prevents a staged list/hash projection
 * from being promoted under a digest that describes different bytes.
 */
export function sealFeedPublicationStorage(input: FeedPublicationStorageSealInput): string {
  if (input.metadataValues.length === 0) {
    throw new FeedPublicationValidationError('Feed publication storage seal requires metadata values');
  }
  if (input.entries.length === 0) {
    throw new FeedPublicationValidationError('Feed publication storage seal requires explanation entries');
  }

  const hash = createHash('sha1');
  for (const [index, value] of input.metadataValues.entries()) {
    assertNonEmptyString(value, `storage seal metadataValues[${index}]`);
    updateLengthPrefixedHash(hash, value);
  }
  for (const [index, entry] of input.entries.entries()) {
    assertNonEmptyString(entry.postUri, `storage seal entries[${index}].postUri`);
    assertNonEmptyString(
      entry.serializedExplanation,
      `storage seal entries[${index}].serializedExplanation`
    );
    assertNonEmptyString(entry.explanationSeal, `storage seal entries[${index}].explanationSeal`);
    updateLengthPrefixedHash(hash, entry.postUri);
    updateLengthPrefixedHash(hash, entry.serializedExplanation);
    updateLengthPrefixedHash(hash, entry.explanationSeal);
  }
  return hash.digest('hex');
}

/** Seal one exact Redis explanation row for bounded read-time verification. */
export function sealFeedPublicationExplanation(
  metadataValues: readonly string[],
  postUri: string,
  serializedExplanation: string
): string {
  if (metadataValues.length === 0) {
    throw new FeedPublicationValidationError('Feed publication explanation seal requires metadata values');
  }
  assertNonEmptyString(postUri, 'explanation seal postUri');
  assertNonEmptyString(serializedExplanation, 'explanation seal serializedExplanation');
  const hash = createHash('sha1');
  for (const [index, value] of metadataValues.entries()) {
    assertNonEmptyString(value, `explanation seal metadataValues[${index}]`);
    updateLengthPrefixedHash(hash, value);
  }
  updateLengthPrefixedHash(hash, postUri);
  updateLengthPrefixedHash(hash, serializedExplanation);
  return hash.digest('hex');
}

/** Strictly validate unknown Redis/HTTP data without allowing private extra fields. */
export function assertFeedPublicationArtifact(value: unknown): asserts value is FeedPublicationArtifact {
  const artifact = assertRecord(value, 'artifact');
  assertExactKeys(artifact, [
    'schemaVersion',
    'epochId',
    'publicationRunId',
    'publishedAt',
    'feedCount',
    'dedupedUrlCount',
    'totalUrlCount',
    'sourceScoreRunIds',
    'mixedScoreRunProvenance',
    'weights',
    'entries',
  ], 'artifact');
  if (artifact.schemaVersion !== FEED_PUBLICATION_SCHEMA_VERSION) {
    throw new FeedPublicationValidationError(
      `artifact.schemaVersion must equal ${FEED_PUBLICATION_SCHEMA_VERSION}`
    );
  }
  assertPositiveInteger(artifact.epochId, 'artifact.epochId');
  assertNonEmptyString(artifact.publicationRunId, 'artifact.publicationRunId');
  assertIsoTimestamp(artifact.publishedAt, 'artifact.publishedAt');
  assertPositiveInteger(artifact.feedCount, 'artifact.feedCount');
  assertNonNegativeInteger(artifact.dedupedUrlCount, 'artifact.dedupedUrlCount');
  assertNonNegativeInteger(artifact.totalUrlCount, 'artifact.totalUrlCount');
  if (artifact.dedupedUrlCount > artifact.totalUrlCount) {
    throw new FeedPublicationValidationError('artifact.dedupedUrlCount cannot exceed artifact.totalUrlCount');
  }
  if (typeof artifact.mixedScoreRunProvenance !== 'boolean') {
    throw new FeedPublicationValidationError('artifact.mixedScoreRunProvenance must be a boolean');
  }

  const weights = assertPublicFeedWeights(artifact.weights, 'artifact.weights');
  if (!Array.isArray(artifact.entries)) {
    throw new FeedPublicationValidationError('artifact.entries must be an array');
  }
  if (artifact.feedCount !== artifact.entries.length) {
    throw new FeedPublicationValidationError(
      `artifact.feedCount ${artifact.feedCount} does not match entries length ${artifact.entries.length}`
    );
  }

  const postUris = new Set<string>();
  const engagementPositions = new Set<number>();
  const entryRunIds = new Set<string>();
  for (const [index, entry] of artifact.entries.entries()) {
    assertPublicFeedExplanationEntry(entry, index, weights);
    if (entry.ranked_position !== index + 1) {
      throw new FeedPublicationValidationError(
        `artifact.entries[${index}].ranked_position must equal ${index + 1}`
      );
    }
    if (entry.epoch_id !== artifact.epochId) {
      throw new FeedPublicationValidationError(
        `artifact.entries[${index}].epoch_id disagrees with artifact.epochId`
      );
    }
    if (postUris.has(entry.post_uri)) {
      throw new FeedPublicationValidationError(`artifact contains duplicate post_uri ${entry.post_uri}`);
    }
    if (engagementPositions.has(entry.engagement_only_position)) {
      throw new FeedPublicationValidationError(
        `artifact contains duplicate engagement_only_position ${entry.engagement_only_position}`
      );
    }
    postUris.add(entry.post_uri);
    engagementPositions.add(entry.engagement_only_position);
    entryRunIds.add(entry.source_score_run_id);
    if (index > 0 && artifact.entries[index - 1].final_score < entry.final_score) {
      throw new FeedPublicationValidationError(
        `artifact.entries[${index}].final_score violates descending publication order`
      );
    }
  }
  for (let position = 1; position <= artifact.entries.length; position += 1) {
    if (!engagementPositions.has(position)) {
      throw new FeedPublicationValidationError(`artifact is missing engagement_only_position ${position}`);
    }
  }
  const engagementOrderedEntries = [...artifact.entries].sort(
    (left, right) => left.engagement_only_position - right.engagement_only_position
  );
  for (let index = 1; index < engagementOrderedEntries.length; index += 1) {
    if (
      engagementOrderedEntries[index - 1].components.engagement.raw_score
      < engagementOrderedEntries[index].components.engagement.raw_score
    ) {
      throw new FeedPublicationValidationError(
        'artifact engagement_only_position values disagree with engagement raw-score order'
      );
    }
  }

  if (!Array.isArray(artifact.sourceScoreRunIds)) {
    throw new FeedPublicationValidationError('artifact.sourceScoreRunIds must be an array');
  }
  for (const [index, runId] of artifact.sourceScoreRunIds.entries()) {
    assertNonEmptyString(runId, `artifact.sourceScoreRunIds[${index}]`);
    if (index > 0 && compareStringsAscending(artifact.sourceScoreRunIds[index - 1], runId) >= 0) {
      throw new FeedPublicationValidationError('artifact.sourceScoreRunIds must be unique and sorted');
    }
  }
  const expectedRunIds = [...entryRunIds].sort(compareStringsAscending);
  if (!arraysEqual(artifact.sourceScoreRunIds, expectedRunIds)) {
    throw new FeedPublicationValidationError(
      'artifact.sourceScoreRunIds must exactly match entry source_score_run_id values'
    );
  }
  if (artifact.mixedScoreRunProvenance !== (artifact.sourceScoreRunIds.length > 1)) {
    throw new FeedPublicationValidationError(
      'artifact.mixedScoreRunProvenance does not match sourceScoreRunIds'
    );
  }
}

function compareExplanationCandidatesByFinalOrder(
  left: FeedPublicationExplanationCandidate,
  right: FeedPublicationExplanationCandidate
): number {
  const scoreComparison = compareNumbersDescending(left.finalScore, right.finalScore);
  if (scoreComparison !== 0) {
    return scoreComparison;
  }
  const positionComparison = left.preAdjustmentPosition - right.preAdjustmentPosition;
  if (positionComparison !== 0) {
    return positionComparison;
  }
  return compareStringsAscending(left.postUri, right.postUri);
}

function compareExplanationCandidatesByEngagement(
  left: FeedPublicationExplanationCandidate,
  right: FeedPublicationExplanationCandidate
): number {
  const engagementComparison = compareNumbersDescending(
    left.components.engagement.raw_score,
    right.components.engagement.raw_score
  );
  if (engagementComparison !== 0) {
    return engagementComparison;
  }
  const createdAtComparison = compareNullableNumbersDescending(
    parseOptionalTimestamp(left.createdAt, `explanation candidate ${left.postUri} createdAt`),
    parseOptionalTimestamp(right.createdAt, `explanation candidate ${right.postUri} createdAt`)
  );
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }
  return compareStringsAscending(left.postUri, right.postUri);
}

function assertPublicFeedExplanationEntry(
  value: unknown,
  index: number,
  weights: PublicFeedWeights
): asserts value is PublicFeedExplanationEntry {
  const path = `artifact.entries[${index}]`;
  const entry = assertRecord(value, path);
  assertExactKeys(entry, [
    'post_uri',
    'epoch_id',
    'ranked_position',
    'base_score',
    'publication_adjustment',
    'final_score',
    'engagement_only_position',
    'source_score_run_id',
    'scored_at',
    'classification_method',
    'components',
  ], path);
  assertNonEmptyString(entry.post_uri, `${path}.post_uri`);
  assertPositiveInteger(entry.epoch_id, `${path}.epoch_id`);
  assertPositiveInteger(entry.ranked_position, `${path}.ranked_position`);
  assertFiniteNumber(entry.base_score, `${path}.base_score`);
  assertFiniteNumber(entry.publication_adjustment, `${path}.publication_adjustment`);
  if (entry.publication_adjustment <= 0 || entry.publication_adjustment > 1) {
    throw new FeedPublicationValidationError(`${path}.publication_adjustment must be in (0, 1]`);
  }
  assertFiniteNumber(entry.final_score, `${path}.final_score`);
  assertPositiveInteger(entry.engagement_only_position, `${path}.engagement_only_position`);
  assertNonEmptyString(entry.source_score_run_id, `${path}.source_score_run_id`);
  assertIsoTimestamp(entry.scored_at, `${path}.scored_at`);
  if (entry.classification_method !== 'keyword' && entry.classification_method !== 'embedding') {
    throw new FeedPublicationValidationError(
      `${path}.classification_method must be keyword or embedding`
    );
  }

  const components = assertPublicFeedScoreComponents(entry.components, `${path}.components`, weights);
  const expectedBaseScore = PUBLIC_FEED_COMPONENT_KEYS.reduce(
    (total, key) => total + components[key].weighted,
    0
  );
  if (!numbersApproximatelyEqual(entry.base_score, expectedBaseScore)) {
    throw new FeedPublicationValidationError(
      `${path}.base_score disagrees with the sum of weighted components`
    );
  }
  const expectedFinalScore = entry.base_score * entry.publication_adjustment;
  if (!numbersApproximatelyEqual(entry.final_score, expectedFinalScore)) {
    throw new FeedPublicationValidationError(
      `${path}.final_score disagrees with base_score * publication_adjustment`
    );
  }
}

function assertPublicFeedWeights(value: unknown, path: string): PublicFeedWeights {
  const weights = assertRecord(value, path);
  assertExactKeys(weights, PUBLIC_FEED_COMPONENT_KEYS, path);
  for (const key of PUBLIC_FEED_COMPONENT_KEYS) {
    assertFiniteNumber(weights[key], `${path}.${key}`);
    if (weights[key] < 0) {
      throw new FeedPublicationValidationError(`${path}.${key} must be non-negative`);
    }
  }
  return weights as unknown as PublicFeedWeights;
}

function assertPublicFeedScoreComponents(
  value: unknown,
  path: string,
  weights: PublicFeedWeights
): PublicFeedScoreComponents {
  const components = assertRecord(value, path);
  assertExactKeys(components, PUBLIC_FEED_COMPONENT_KEYS, path);
  for (const key of PUBLIC_FEED_COMPONENT_KEYS) {
    const componentPath = `${path}.${key}`;
    const component = assertRecord(components[key], componentPath);
    assertExactKeys(component, ['raw_score', 'weight', 'weighted'], componentPath);
    assertFiniteNumber(component.raw_score, `${componentPath}.raw_score`);
    assertFiniteNumber(component.weight, `${componentPath}.weight`);
    assertFiniteNumber(component.weighted, `${componentPath}.weighted`);
    if (component.weight !== weights[key]) {
      throw new FeedPublicationValidationError(
        `${componentPath}.weight ${component.weight} disagrees with artifact.weights.${key} ${weights[key]}`
      );
    }
    const expectedWeighted = component.raw_score * component.weight;
    if (!numbersApproximatelyEqual(component.weighted, expectedWeighted)) {
      throw new FeedPublicationValidationError(
        `${componentPath}.weighted disagrees with raw_score * weight`
      );
    }
  }
  return components as unknown as PublicFeedScoreComponents;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new FeedPublicationValidationError(`Cannot serialize non-finite number: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareStringsAscending)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new FeedPublicationValidationError(`Cannot serialize unsupported value of type ${typeof value}`);
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new FeedPublicationValidationError(`${path} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  path: string
): void {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new FeedPublicationValidationError(`${path} contains unsupported field ${key}`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new FeedPublicationValidationError(`${path} is missing required field ${key}`);
    }
  }
}

function assertPositiveInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new FeedPublicationValidationError(`${path} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new FeedPublicationValidationError(`${path} must be a non-negative integer`);
  }
}

function assertIsoTimestamp(value: unknown, path: string): asserts value is string {
  assertNonEmptyString(value, path);
  if (!ISO_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new FeedPublicationValidationError(`${path} must be a canonical UTC ISO timestamp`);
  }
}

function clonePublicFeedScoreComponents(
  components: PublicFeedScoreComponents
): PublicFeedScoreComponents {
  return {
    recency: { ...components.recency },
    engagement: { ...components.engagement },
    bridging: { ...components.bridging },
    source_diversity: { ...components.source_diversity },
    relevance: { ...components.relevance },
  };
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function numbersApproximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= SCORE_TOLERANCE * Math.max(1, Math.abs(left), Math.abs(right));
}

function parseOptionalTimestamp(value: Date | string | undefined, path: string): number | null {
  if (value === undefined) {
    return null;
  }
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new FeedPublicationValidationError(`${path} must be a valid timestamp when provided`);
  }
  return timestamp;
}

function compareNumbersDescending(left: number, right: number): number {
  if (left === right) {
    return 0;
  }
  return left > right ? -1 : 1;
}

function compareNullableNumbersDescending(left: number | null, right: number | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return compareNumbersDescending(left, right);
}

function compareStringsAscending(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FeedPublicationValidationError(`${path} must be a non-empty string`);
  }
}

function assertFiniteNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FeedPublicationValidationError(`${path} must be a finite number`);
  }
}

function updateLengthPrefixedHash(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(Buffer.byteLength(value, 'utf8').toString(), 'utf8');
  hash.update(':', 'utf8');
  hash.update(value, 'utf8');
}
