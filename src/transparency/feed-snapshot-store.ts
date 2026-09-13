import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { redis } from '../db/redis.js';
import { composeFeedItems, parsePinnedAnnouncementUri } from '../feed/pinned-composition.js';
import {
  FEED_PUBLICATION_SNAPSHOT_REDIS_KEYS,
} from '../scoring/feed-publication-keys.js';
import {
  PUBLIC_FEED_COMPONENT_KEYS,
  FeedPublicationValidationError,
  assertFeedPublicationDigest,
} from '../scoring/feed-publication.js';
import type {
  TransparencyFeedItem,
  TransparencyFeedRankedItem,
  TransparencyFeedScoredPinnedItem,
  TransparencyFeedSnapshot,
  TransparencySnapshotStatus,
} from './transparency.types.js';

export const FEED_EXPLANATION_SCHEMA_VERSION = 1;
const MAX_TRANSPARENCY_ITEMS = 50;
export const PUBLIC_SNAPSHOT_DEPTH = 50;

const ComponentSchema = z.object({
  raw_score: z.number().finite(),
  weight: z.number().finite(),
  weighted: z.number().finite(),
}).strict();

export const MaterializedFeedExplanationSchema = z.object({
  post_uri: z.string().min(1),
  ranked_position: z.number().int().positive(),
  base_score: z.number().finite(),
  publication_adjustment: z.number().finite().positive().max(1),
  final_score: z.number().finite(),
  components: z.object({
    recency: ComponentSchema,
    engagement: ComponentSchema,
    bridging: ComponentSchema,
    source_diversity: ComponentSchema,
    relevance: ComponentSchema,
  }).strict(),
  source_score_run_id: z.string().min(1),
  scored_at: z.string().datetime(),
  epoch_id: z.number().int().positive(),
  classification_method: z.enum(['keyword', 'embedding']),
  engagement_only_position: z.number().int().positive(),
}).strict();

const ActiveWeightsSchema = z.object({
  recency: z.number().finite().nonnegative(),
  engagement: z.number().finite().nonnegative(),
  bridging: z.number().finite().nonnegative(),
  source_diversity: z.number().finite().nonnegative(),
  relevance: z.number().finite().nonnegative(),
}).strict();

const RedisSnapshotEnvelopeSchema = z.object({
  status: z.enum(['current', 'last_known_good']),
  epochId: z.string().min(1),
  publicationRunId: z.string().min(1),
  publishedAt: z.string().min(1),
  totalPublishedItems: z.string().min(1),
  schemaVersion: z.string().min(1),
  digest: z.string().min(1),
  weights: z.string().min(1),
  ranked: z.array(z.object({
    postUri: z.string().min(1),
    redisScore: z.string().min(1),
    explanation: z.string().min(1),
  }).strict()),
}).strict();

const RedisSnapshotResultSchema = z.object({
  snapshots: z.array(RedisSnapshotEnvelopeSchema).max(2),
  pinnedAnnouncement: z.string().nullable(),
  unavailable: z.literal(true).optional(),
}).strict();

const PublishedPostEnvelopeSchema = z.object({
  snapshotStatus: z.enum(['current', 'last_known_good']),
  found: z.literal(true),
  explanation: z.string().min(1),
  redisScore: z.string().min(1),
  reverseRank: z.number().int().nonnegative(),
  epochId: z.string().min(1),
  schemaVersion: z.string().min(1),
  digest: z.string().min(1),
  weights: z.string().min(1),
  pinnedReverseRank: z.union([z.number().int().nonnegative(), z.literal(false)]),
  publicationRunId: z.string().min(1),
  publishedAt: z.string().datetime(),
}).strict();

const PublishedPostCandidateSchema = z.union([
  PublishedPostEnvelopeSchema,
  z.object({
    snapshotStatus: z.enum(['current', 'last_known_good']),
    found: z.literal(false),
  }).strict(),
]);

const PublishedPostResultSchema = z.object({
  snapshots: z.array(PublishedPostCandidateSchema).max(2),
  pinnedAnnouncement: z.string().nullable(),
  unavailable: z.literal(true).optional(),
}).strict();

type RedisSnapshotEnvelope = z.infer<typeof RedisSnapshotEnvelopeSchema>;

export interface PublishedPostSnapshotReceipt {
  explanation: z.infer<typeof MaterializedFeedExplanationSchema>;
  publishedPosition: number;
  presentationSnapshotId: string;
  activeWeights: z.infer<typeof ActiveWeightsSchema>;
  snapshotStatus: 'current' | 'last_known_good';
}

export function isPublishedSnapshotIntegrityFailure(error: unknown): boolean {
  return error instanceof TypeError || error instanceof RangeError ||
    error instanceof SyntaxError || error instanceof z.ZodError ||
    error instanceof FeedPublicationValidationError;
}

const READ_TRANSPARENCY_SNAPSHOT_SCRIPT = `
local limit = tonumber(ARGV[1])
if limit == nil or limit < 1 or limit > 50 then
  return redis.error_reply('invalid transparency snapshot limit')
end

local function framed(value)
  return tostring(string.len(value)) .. ':' .. value
end

local function explanationSealMatches(metadata, postUri, explanation, expectedSeal)
  local sealedValue = ''
  for _, value in ipairs(metadata) do
    sealedValue = sealedValue .. framed(value)
  end
  sealedValue = sealedValue .. framed(postUri) .. framed(explanation)
  return redis.sha1hex(sealedValue) == expectedSeal
end

local snapshotIntegrityFailed = false

local function readSnapshot(offset, status)
  local schemaVersion = redis.call('GET', KEYS[offset + 8])
  if not schemaVersion then
    return nil
  end
  local epochId = redis.call('GET', KEYS[offset + 4])
  local publicationRunId = redis.call('GET', KEYS[offset + 5])
  local publishedAt = redis.call('GET', KEYS[offset + 6])
  local totalPublishedItems = redis.call('GET', KEYS[offset + 7])
  local digest = redis.call('GET', KEYS[offset + 9])
  local weights = redis.call('GET', KEYS[offset + 10])
  if not epochId or not publicationRunId or not publishedAt or not totalPublishedItems or
     not digest or not weights then
    snapshotIntegrityFailed = true
    return nil
  end
  local metadata = {
    epochId,
    publicationRunId,
    publishedAt,
    totalPublishedItems,
    schemaVersion,
    digest,
    weights
  }

  local expectedCount = tonumber(totalPublishedItems)
  if expectedCount == nil or expectedCount <= 0 then
    snapshotIntegrityFailed = true
    return nil
  end
  if redis.call('ZCARD', KEYS[offset]) ~= expectedCount or
     redis.call('LLEN', KEYS[offset + 1]) ~= expectedCount or
     redis.call('HLEN', KEYS[offset + 2]) ~= expectedCount or
     redis.call('HLEN', KEYS[offset + 3]) ~= expectedCount then
    snapshotIntegrityFailed = true
    return nil
  end

  local values = redis.call('LRANGE', KEYS[offset + 1], 0, limit - 1)
  local ranked = {}
  for index = 1, #values do
    local explanation = redis.call('HGET', KEYS[offset + 2], values[index])
    local explanationSeal = redis.call('HGET', KEYS[offset + 3], values[index])
    local redisScore = redis.call('ZSCORE', KEYS[offset], values[index])
    if not explanation or not explanationSeal or not redisScore or
       not explanationSealMatches(metadata, values[index], explanation, explanationSeal) then
      snapshotIntegrityFailed = true
      return nil
    end
    table.insert(ranked, {
      postUri = values[index],
      redisScore = redisScore,
      explanation = explanation
    })
  end

  return {
    status = status,
    epochId = epochId,
    publicationRunId = publicationRunId,
    publishedAt = publishedAt,
    totalPublishedItems = totalPublishedItems,
    schemaVersion = schemaVersion,
    digest = digest,
    weights = weights,
    ranked = ranked
  }
end

local snapshots = {}
local current = readSnapshot(1, 'current')
if current then
  table.insert(snapshots, current)
end
local lastKnownGood = readSnapshot(12, 'last_known_good')
if lastKnownGood then
  table.insert(snapshots, lastKnownGood)
end
if #snapshots == 0 then
  if snapshotIntegrityFailed then
    return '{"snapshots":[],"pinnedAnnouncement":null,"unavailable":true}'
  end
  return '{"snapshots":[],"pinnedAnnouncement":null}'
end
local pinnedAnnouncement = redis.call('GET', KEYS[23])
if not pinnedAnnouncement then
  pinnedAnnouncement = cjson.null
end
return cjson.encode({
  snapshots = snapshots,
  pinnedAnnouncement = pinnedAnnouncement
})
`;

const SNAPSHOT_REDIS_KEYS = FEED_PUBLICATION_SNAPSHOT_REDIS_KEYS;

const READ_PUBLISHED_POST_SCRIPT = `
local viewDepth = tonumber(ARGV[2])
if viewDepth == nil or viewDepth < 1 or viewDepth > 100 then
  return redis.error_reply('invalid published receipt view depth')
end

local function framed(value)
  return tostring(string.len(value)) .. ':' .. value
end

local function explanationSealMatches(metadata, postUri, explanation, expectedSeal)
  local sealedValue = ''
  for _, value in ipairs(metadata) do
    sealedValue = sealedValue .. framed(value)
  end
  sealedValue = sealedValue .. framed(postUri) .. framed(explanation)
  return redis.sha1hex(sealedValue) == expectedSeal
end

local pinnedAnnouncement = redis.call('GET', KEYS[23])
local pinnedUri = nil
local snapshotIntegrityFailed = false
if pinnedAnnouncement then
  local decodedOk, decoded = pcall(cjson.decode, pinnedAnnouncement)
  if decodedOk and type(decoded) == 'table' and type(decoded.uri) == 'string' then
    pinnedUri = decoded.uri
  end
end

local function readSnapshot(offset, snapshotStatus)
  local schemaVersion = redis.call('GET', KEYS[offset + 8])
  if not schemaVersion then
    return nil
  end
  local epochId = redis.call('GET', KEYS[offset + 4])
  local publicationRunId = redis.call('GET', KEYS[offset + 5])
  local publishedAt = redis.call('GET', KEYS[offset + 6])
  local totalPublishedItems = redis.call('GET', KEYS[offset + 7])
  local expectedCount = tonumber(totalPublishedItems)
  local digest = redis.call('GET', KEYS[offset + 9])
  local weights = redis.call('GET', KEYS[offset + 10])
  if not epochId or not digest or not weights or
     not publicationRunId or not publishedAt or expectedCount == nil or expectedCount <= 0 or
     redis.call('ZCARD', KEYS[offset]) ~= expectedCount or
     redis.call('LLEN', KEYS[offset + 1]) ~= expectedCount or
     redis.call('HLEN', KEYS[offset + 2]) ~= expectedCount or
     redis.call('HLEN', KEYS[offset + 3]) ~= expectedCount then
    snapshotIntegrityFailed = true
    return nil
  end
  local metadata = {
    epochId,
    publicationRunId,
    publishedAt,
    totalPublishedItems,
    schemaVersion,
    digest,
    weights
  }
  local explanation = redis.call('HGET', KEYS[offset + 2], ARGV[1])
  local explanationSeal = redis.call('HGET', KEYS[offset + 3], ARGV[1])
  local redisScore = redis.call('ZSCORE', KEYS[offset], ARGV[1])
  if not explanation and not explanationSeal and not redisScore then
    return { snapshotStatus = snapshotStatus, found = false }
  end
  if not explanation or not explanationSeal or not redisScore or
     not explanationSealMatches(metadata, ARGV[1], explanation, explanationSeal) then
    snapshotIntegrityFailed = true
    return nil
  end
  local decodedOk, decodedExplanation = pcall(cjson.decode, explanation)
  if not decodedOk or type(decodedExplanation) ~= 'table' or
     type(decodedExplanation.ranked_position) ~= 'number' then
    snapshotIntegrityFailed = true
    return nil
  end
  local reverseRank = decodedExplanation.ranked_position - 1
  if redis.call('LINDEX', KEYS[offset + 1], reverseRank) ~= ARGV[1] then
    snapshotIntegrityFailed = true
    return nil
  end
  local pinnedReverseRank = false
  if pinnedUri then
    local visibleValues = redis.call('LRANGE', KEYS[offset + 1], 0, viewDepth - 1)
    for index, value in ipairs(visibleValues) do
      if value == pinnedUri then
        pinnedReverseRank = index - 1
        break
      end
    end
  end
  return {
    snapshotStatus = snapshotStatus,
    found = true,
    explanation = explanation,
    redisScore = redisScore,
    reverseRank = reverseRank,
    epochId = epochId,
    schemaVersion = schemaVersion,
    digest = digest,
    weights = weights,
    pinnedReverseRank = pinnedReverseRank,
    publicationRunId = publicationRunId,
    publishedAt = publishedAt
  }
end

local snapshots = {}
local current = readSnapshot(1, 'current')
if current then
  table.insert(snapshots, current)
end
local lastKnownGood = readSnapshot(12, 'last_known_good')
if lastKnownGood then
  table.insert(snapshots, lastKnownGood)
end
if #snapshots == 0 then
  if snapshotIntegrityFailed then
    return '{"snapshots":[],"pinnedAnnouncement":null,"unavailable":true}'
  end
  return '{"snapshots":[],"pinnedAnnouncement":null}'
end
if not pinnedAnnouncement then
  pinnedAnnouncement = cjson.null
end
return cjson.encode({
  snapshots = snapshots,
  pinnedAnnouncement = pinnedAnnouncement,
})
`;

function parseRedisSnapshotResult(
  raw: unknown
): z.infer<typeof RedisSnapshotResultSchema> {
  if (typeof raw !== 'string') {
    throw new TypeError(`Transparency snapshot Redis script returned ${typeof raw}, expected string`);
  }
  return RedisSnapshotResultSchema.parse(JSON.parse(raw) as unknown);
}

function scoresMatch(left: number, right: number): boolean {
  const tolerance = Math.max(1, Math.abs(left), Math.abs(right)) * 1e-9;
  return Math.abs(left - right) <= tolerance;
}

type ActiveWeights = z.infer<typeof ActiveWeightsSchema>;
type MaterializedFeedExplanation = z.infer<typeof MaterializedFeedExplanationSchema>;

function assertExplanationMath(
  explanation: MaterializedFeedExplanation,
  activeWeights: ActiveWeights,
  label: string
): void {
  let weightedTotal = 0;
  for (const componentKey of PUBLIC_FEED_COMPONENT_KEYS) {
    const component = explanation.components[componentKey];
    if (component.weight !== activeWeights[componentKey]) {
      throw new TypeError(
        `${label} ${componentKey} weight ${component.weight} disagrees with active weight ${activeWeights[componentKey]}`
      );
    }
    const expectedWeighted = component.raw_score * component.weight;
    if (!scoresMatch(component.weighted, expectedWeighted)) {
      throw new TypeError(`${label} ${componentKey} weighted score disagrees with raw_score * weight`);
    }
    weightedTotal += component.weighted;
  }
  if (!scoresMatch(explanation.base_score, weightedTotal)) {
    throw new TypeError(`${label} base score disagrees with the sum of weighted components`);
  }
  if (!scoresMatch(
    explanation.final_score,
    explanation.base_score * explanation.publication_adjustment
  )) {
    throw new TypeError(`${label} final score disagrees with base score * publication adjustment`);
  }
}

function presentationSnapshotId(
  publicationDigest: string,
  pinnedUri: string | null,
  status: TransparencySnapshotStatus
): string {
  return createHash('sha256')
    .update(publicationDigest)
    .update('\n')
    .update(pinnedUri ?? '')
    .update('\n')
    .update(status)
    .digest('hex');
}

export async function readTransparencyFeedSnapshot(limit: number): Promise<TransparencyFeedSnapshot | null> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRANSPARENCY_ITEMS) {
    throw new RangeError(`Transparency snapshot limit must be an integer from 1 to 50: ${limit}`);
  }

  const raw = await redis.eval(
    READ_TRANSPARENCY_SNAPSHOT_SCRIPT,
    SNAPSHOT_REDIS_KEYS.length,
    ...SNAPSHOT_REDIS_KEYS,
    limit.toString()
  );
  const result = parseRedisSnapshotResult(raw);
  if (result.unavailable === true) {
    throw new TypeError('Published transparency snapshot is incomplete');
  }
  if (result.snapshots.length === 0) {
    return null;
  }

  let lastValidationError: unknown = null;
  for (const envelope of result.snapshots) {
    try {
      return materializeTransparencyFeedSnapshot(envelope, result.pinnedAnnouncement, limit);
    } catch (error) {
      lastValidationError = error;
    }
  }
  throw new TypeError('No valid current or last-known-good transparency snapshot exists', {
    cause: lastValidationError,
  });
}

function materializeTransparencyFeedSnapshot(
  envelope: RedisSnapshotEnvelope,
  pinnedAnnouncement: string | null,
  limit: number
): TransparencyFeedSnapshot {
  const epochId = Number(envelope.epochId);
  const totalPublishedItems = Number(envelope.totalPublishedItems);
  const schemaVersion = Number(envelope.schemaVersion);
  const activeWeights = ActiveWeightsSchema.parse(JSON.parse(envelope.weights) as unknown);
  if (!Number.isInteger(epochId) || epochId <= 0 || !Number.isInteger(totalPublishedItems) || totalPublishedItems <= 0) {
    throw new TypeError('Transparency snapshot metadata contains invalid epoch or item count');
  }
  if (schemaVersion !== FEED_EXPLANATION_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported transparency snapshot schema version: ${envelope.schemaVersion}`);
  }
  if (Number.isNaN(Date.parse(envelope.publishedAt))) {
    throw new TypeError(`Transparency snapshot publication timestamp is invalid: ${envelope.publishedAt}`);
  }
  assertFeedPublicationDigest(envelope.digest);
  if (envelope.ranked.length === 0 || envelope.ranked.length > totalPublishedItems) {
    throw new TypeError('Transparency snapshot contains an invalid number of ranked items');
  }

  const rankedItems = envelope.ranked.map((item, index) => {
    const explanation = MaterializedFeedExplanationSchema.parse(JSON.parse(item.explanation) as unknown);
    const redisScore = Number(item.redisScore);
    if (explanation.post_uri !== item.postUri || explanation.epoch_id !== epochId ||
        explanation.ranked_position !== index + 1 || !Number.isFinite(redisScore) ||
        !scoresMatch(redisScore, explanation.final_score)) {
      throw new TypeError(`Transparency snapshot artifact disagrees for post ${item.postUri}`);
    }
    assertExplanationMath(explanation, activeWeights, `Transparency snapshot post ${item.postUri}`);
    return explanation;
  });

  const pinnedUri = parsePinnedAnnouncementUri(pinnedAnnouncement);
  const explanationsByUri = new Map(rankedItems.map((item) => [item.post_uri, item]));
  const composed = composeFeedItems(rankedItems.map((item) => item.post_uri), limit, pinnedUri);
  const items: TransparencyFeedItem[] = composed.map((item) => {
    if (item.rankedPosition === null) {
      return {
        position: item.position,
        epoch_id: null,
        ranked_position: null,
        placement: 'pinned_announcement',
        post_uri: item.postUri,
        base_score: null,
        publication_adjustment: null,
        final_score: null,
        components: null,
        source_score_run_id: null,
        scored_at: null,
        classification_method: null,
        engagement_only_position: null,
      };
    }
    const explanation = explanationsByUri.get(item.postUri);
    if (explanation === undefined) {
      throw new TypeError(`Transparency snapshot is missing explanation for post ${item.postUri}`);
    }
    const rankedItem: TransparencyFeedRankedItem | TransparencyFeedScoredPinnedItem = {
      ...explanation,
      position: item.position,
      placement: item.placement,
    };
    return rankedItem;
  });

  const publisherDid = config.FEEDGEN_PUBLISHER_DID;
  return {
    schema_version: 1,
    feed_uri: `at://${publisherDid}/app.bsky.feed.generator/community-gov`,
    presentation_snapshot_id: presentationSnapshotId(
      envelope.digest,
      pinnedUri,
      envelope.status
    ),
    publication_run_id: envelope.publicationRunId,
    epoch_id: epochId,
    published_at: new Date(envelope.publishedAt).toISOString(),
    status: envelope.status,
    total_published_items: totalPublishedItems,
    expected_refresh_seconds: Math.ceil(config.SCORING_INTERVAL_MS / 1000),
    active_weights: activeWeights,
    items,
  };
}

export async function readPublishedPostSnapshotReceipt(
  postUri: string,
  viewDepth: number
): Promise<PublishedPostSnapshotReceipt | null> {
  if (!Number.isInteger(viewDepth) || viewDepth < 1 || viewDepth > 100) {
    throw new RangeError(`Published post receipt view depth must be an integer from 1 to 100, received ${viewDepth}`);
  }
  const raw = await redis.eval(
    READ_PUBLISHED_POST_SCRIPT,
    SNAPSHOT_REDIS_KEYS.length,
    ...SNAPSHOT_REDIS_KEYS,
    postUri,
    viewDepth.toString()
  );
  if (typeof raw !== 'string') {
    throw new TypeError(`Published post receipt Redis script returned ${typeof raw}, expected string`);
  }
  const result = PublishedPostResultSchema.parse(JSON.parse(raw) as unknown);
  if (result.unavailable === true) {
    throw new TypeError(`Published post receipt snapshot is incomplete for ${postUri}`);
  }
  if (result.snapshots.length === 0) {
    return null;
  }
  const pinnedUri = parsePinnedAnnouncementUri(result.pinnedAnnouncement);
  let lastValidationError: unknown = null;
  for (const envelope of result.snapshots) {
    if (!envelope.found) {
      return null;
    }
    try {
      const explanation = MaterializedFeedExplanationSchema.parse(
        JSON.parse(envelope.explanation) as unknown
      );
      const redisScore = Number(envelope.redisScore);
      const epochId = Number(envelope.epochId);
      const schemaVersion = Number(envelope.schemaVersion);
      const activeWeights = ActiveWeightsSchema.parse(JSON.parse(envelope.weights) as unknown);
      assertFeedPublicationDigest(envelope.digest);
      if (
        !Number.isInteger(epochId) || epochId <= 0 ||
        explanation.post_uri !== postUri ||
        explanation.epoch_id !== epochId ||
        explanation.ranked_position !== envelope.reverseRank + 1 ||
        schemaVersion !== FEED_EXPLANATION_SCHEMA_VERSION ||
        !scoresMatch(redisScore, explanation.final_score)
      ) {
        throw new TypeError(`Published post receipt artifact disagrees for post ${postUri}`);
      }
      assertExplanationMath(explanation, activeWeights, `Published post receipt ${postUri}`);
      const pinIsAlreadyVisible = envelope.pinnedReverseRank !== false &&
        envelope.pinnedReverseRank < viewDepth;
      const pinIsInserted = pinnedUri !== null && !pinIsAlreadyVisible;
      const publishedPosition = pinIsInserted && pinnedUri === postUri
        ? 1
        : explanation.ranked_position + (pinIsInserted ? 1 : 0);
      if (publishedPosition > viewDepth) {
        return null;
      }

      return {
        explanation,
        publishedPosition,
        presentationSnapshotId: presentationSnapshotId(
          envelope.digest,
          pinnedUri,
          envelope.snapshotStatus
        ),
        activeWeights,
        snapshotStatus: envelope.snapshotStatus,
      };
    } catch (error) {
      lastValidationError = error;
    }
  }
  if (lastValidationError instanceof Error) {
    throw lastValidationError;
  }
  throw new TypeError(`No valid current or last-known-good post receipt exists for ${postUri}`, {
    cause: lastValidationError,
  });
}
