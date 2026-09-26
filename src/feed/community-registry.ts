export const BIRDERS_CANDIDATE_TERMS = [
  'birding',
  'birdwatching',
  'birder',
  'ebird',
  'merlin',
  'audubon',
  'ornithology',
  'warbler',
  'sparrow',
  'finch',
  'owl',
  'migration',
  'field notes',
  'binoculars',
] as const;

export const BIRDERS_BRIDGE_TERMS = [
  'python',
  'script',
  'csv',
  'dataset',
  'classifier',
  'api',
  'computer vision',
  'github',
] as const;

export type FeedCommunityStatus = 'enabled' | 'disabled';
export type FeedCommunityId = 'community-gov' | 'birders_who_code';

export interface FeedCommunitySeedWeights {
  recency: number;
  engagement: number;
  bridging: number;
  sourceDiversity: number;
  relevance: number;
}

export interface FeedCommunityTerms {
  candidateTerms: readonly string[];
  bridgeTerms: readonly string[];
}

export interface FeedCommunityRedisKeys {
  current: string;
  order: string | null;
  count: string | null;
  lastKnownGood: string | null;
  lastKnownGoodOrder: string | null;
  lastKnownGoodCount: string | null;
  lastKnownGoodFallbackTotal: string | null;
  epoch: string;
  health: string;
  currentSnapshot: string;
  snapshotGeneration: string;
  snapshotPrefix: string;
}

export interface FeedCommunity {
  communityId: FeedCommunityId;
  name: string;
  feedRkey: string;
  status: FeedCommunityStatus;
  public: boolean;
  redisPrefix: string;
  redis: FeedCommunityRedisKeys;
  terms: FeedCommunityTerms;
  seedWeights: FeedCommunitySeedWeights;
  includePinnedAnnouncements: boolean;
}

export const COMMUNITY_GOV_REDIS_KEYS = {
  current: 'feed:current',
  order: 'feed:order',
  count: 'feed:count',
  lastKnownGood: 'feed:last_known_good',
  lastKnownGoodOrder: 'feed:last_known_good_order',
  lastKnownGoodCount: 'feed:last_known_good_count',
  lastKnownGoodFallbackTotal: 'feed:last_known_good_fallback_total',
  epoch: 'feed:epoch',
  health: 'feed:health',
  currentSnapshot: 'feed:current_snapshot_id',
  snapshotGeneration: 'feed:current_snapshot_generation',
  snapshotPrefix: 'snapshot:',
} as const satisfies FeedCommunityRedisKeys;

export const BIRDERS_REDIS_PREFIX = 'feed:community:birders_who_code';

export const BIRDERS_REDIS_KEYS = {
  current: `${BIRDERS_REDIS_PREFIX}:current`,
  order: null,
  count: null,
  lastKnownGood: null,
  lastKnownGoodOrder: null,
  lastKnownGoodCount: null,
  lastKnownGoodFallbackTotal: null,
  epoch: `${BIRDERS_REDIS_PREFIX}:epoch`,
  health: `${BIRDERS_REDIS_PREFIX}:health`,
  currentSnapshot: `${BIRDERS_REDIS_PREFIX}:current_snapshot_id`,
  snapshotGeneration: `${BIRDERS_REDIS_PREFIX}:snapshot_generation`,
  snapshotPrefix: 'snapshot:community:birders_who_code:',
} as const satisfies FeedCommunityRedisKeys;

export const FEED_COMMUNITIES = [
  {
    communityId: 'community-gov',
    name: 'Corgi Community Governance',
    feedRkey: 'community-gov',
    status: 'enabled',
    public: true,
    redisPrefix: 'feed',
    redis: COMMUNITY_GOV_REDIS_KEYS,
    terms: {
      candidateTerms: [],
      bridgeTerms: [],
    },
    seedWeights: {
      recency: 0.2,
      engagement: 0.2,
      bridging: 0.2,
      sourceDiversity: 0.2,
      relevance: 0.2,
    },
    includePinnedAnnouncements: true,
  },
  {
    communityId: 'birders_who_code',
    name: 'Birders Who Code',
    feedRkey: 'birders-who-code',
    status: 'disabled',
    public: false,
    redisPrefix: BIRDERS_REDIS_PREFIX,
    redis: BIRDERS_REDIS_KEYS,
    terms: {
      candidateTerms: BIRDERS_CANDIDATE_TERMS,
      bridgeTerms: BIRDERS_BRIDGE_TERMS,
    },
    seedWeights: {
      recency: 0.22,
      engagement: 0.12,
      bridging: 0.2,
      sourceDiversity: 0.16,
      relevance: 0.3,
    },
    includePinnedAnnouncements: false,
  },
] as const satisfies readonly FeedCommunity[];

export function getFeedCommunities(): readonly FeedCommunity[] {
  return FEED_COMMUNITIES;
}

export function feedUriForCommunity(community: FeedCommunity, publisherDid: string): string {
  return `at://${publisherDid}/app.bsky.feed.generator/${community.feedRkey}`;
}

export function feedUriForRkey(feedRkey: string, publisherDid: string): string {
  return `at://${publisherDid}/app.bsky.feed.generator/${feedRkey}`;
}

export function resolveFeedCommunityByUri(
  feedUri: string,
  publisherDid: string,
  communities: readonly FeedCommunity[]
): FeedCommunity | null {
  return communities.find((community) => feedUriForCommunity(community, publisherDid) === feedUri) ?? null;
}

export function resolveFeedCommunityByRkey(
  feedRkey: string,
  communities: readonly FeedCommunity[]
): FeedCommunity | null {
  return communities.find((community) => community.feedRkey === feedRkey) ?? null;
}

export function publicFeedUris(communities: readonly FeedCommunity[], publisherDid: string): string[] {
  return communities
    .filter((community) => community.status === 'enabled' && community.public)
    .map((community) => feedUriForCommunity(community, publisherDid));
}

export function isFeedCommunityServable(community: FeedCommunity): boolean {
  return community.status === 'enabled';
}
