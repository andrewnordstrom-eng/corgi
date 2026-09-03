import { COMMUNITY_GOV_REDIS_KEYS } from '../feed/community-registry.js';

export const CURRENT_FEED_PUBLICATION_KEYS = {
  sortedSet: COMMUNITY_GOV_REDIS_KEYS.current,
  order: COMMUNITY_GOV_REDIS_KEYS.order,
  explanations: 'feed:explanations',
  explanationSeals: 'feed:explanation_seals',
  metadata: {
    epoch: 'feed:epoch',
    publicationRunId: 'feed:run_id',
    publishedAt: 'feed:updated_at',
    totalPublishedItems: COMMUNITY_GOV_REDIS_KEYS.count,
    schemaVersion: 'feed:explanation_schema_version',
    digest: 'feed:snapshot_digest',
    weights: 'feed:weights',
  },
  publicationIntegritySeal: 'feed:publication_integrity_seal',
} as const;

export const LAST_KNOWN_GOOD_FEED_PUBLICATION_KEYS = {
  sortedSet: COMMUNITY_GOV_REDIS_KEYS.lastKnownGood,
  order: COMMUNITY_GOV_REDIS_KEYS.lastKnownGoodOrder,
  explanations: 'feed:last_known_good_explanations',
  explanationSeals: 'feed:last_known_good_explanation_seals',
  metadata: {
    epoch: 'feed:last_known_good_epoch',
    publicationRunId: 'feed:last_known_good_run_id',
    publishedAt: 'feed:last_known_good_updated_at',
    totalPublishedItems: COMMUNITY_GOV_REDIS_KEYS.lastKnownGoodCount,
    schemaVersion: 'feed:last_known_good_explanation_schema_version',
    digest: 'feed:last_known_good_snapshot_digest',
    weights: 'feed:last_known_good_weights',
  },
  publicationIntegritySeal: 'feed:last_known_good_publication_integrity_seal',
} as const;

export const CURRENT_FEED_PUBLICATION_METADATA_KEYS = [
  CURRENT_FEED_PUBLICATION_KEYS.metadata.epoch,
  CURRENT_FEED_PUBLICATION_KEYS.metadata.publicationRunId,
  CURRENT_FEED_PUBLICATION_KEYS.metadata.publishedAt,
  CURRENT_FEED_PUBLICATION_KEYS.metadata.totalPublishedItems,
  CURRENT_FEED_PUBLICATION_KEYS.metadata.schemaVersion,
  CURRENT_FEED_PUBLICATION_KEYS.metadata.digest,
  CURRENT_FEED_PUBLICATION_KEYS.metadata.weights,
] as const;

export const LAST_KNOWN_GOOD_FEED_PUBLICATION_METADATA_KEYS = [
  LAST_KNOWN_GOOD_FEED_PUBLICATION_KEYS.metadata.epoch,
  LAST_KNOWN_GOOD_FEED_PUBLICATION_KEYS.metadata.publicationRunId,
  LAST_KNOWN_GOOD_FEED_PUBLICATION_KEYS.metadata.publishedAt,
  LAST_KNOWN_GOOD_FEED_PUBLICATION_KEYS.metadata.totalPublishedItems,
  LAST_KNOWN_GOOD_FEED_PUBLICATION_KEYS.metadata.schemaVersion,
  LAST_KNOWN_GOOD_FEED_PUBLICATION_KEYS.metadata.digest,
  LAST_KNOWN_GOOD_FEED_PUBLICATION_KEYS.metadata.weights,
] as const;

export const PINNED_ANNOUNCEMENT_KEY = 'bot:latest_announcement';

// Lua readers depend on this 1-based layout: current 1-11, last-known-good 12-22, pin 23.
export const FEED_PUBLICATION_SNAPSHOT_REDIS_KEYS = [
  CURRENT_FEED_PUBLICATION_KEYS.sortedSet,
  CURRENT_FEED_PUBLICATION_KEYS.order,
  CURRENT_FEED_PUBLICATION_KEYS.explanations,
  CURRENT_FEED_PUBLICATION_KEYS.explanationSeals,
  ...CURRENT_FEED_PUBLICATION_METADATA_KEYS,
  LAST_KNOWN_GOOD_FEED_PUBLICATION_KEYS.sortedSet,
  LAST_KNOWN_GOOD_FEED_PUBLICATION_KEYS.order,
  LAST_KNOWN_GOOD_FEED_PUBLICATION_KEYS.explanations,
  LAST_KNOWN_GOOD_FEED_PUBLICATION_KEYS.explanationSeals,
  ...LAST_KNOWN_GOOD_FEED_PUBLICATION_METADATA_KEYS,
  PINNED_ANNOUNCEMENT_KEY,
] as const;

// `as const` gives `.length` a literal type, so adding or removing a key fails compilation.
const FEED_PUBLICATION_SNAPSHOT_REDIS_KEY_COUNT: 23 = FEED_PUBLICATION_SNAPSHOT_REDIS_KEYS.length;
void FEED_PUBLICATION_SNAPSHOT_REDIS_KEY_COUNT;
