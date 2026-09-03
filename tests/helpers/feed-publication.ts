export interface FeedPublicationRowOverrides {
  post_uri?: string;
  total_score?: number | string;
  author_did?: string;
  bridging_score?: number | string;
  engagement_score?: number | string;
  embed_url?: string | null;
  text_length?: number | string;
  created_at?: string;
  scored_at?: string;
  classification_method?: 'keyword' | 'embedding';
  source_score_run_id?: string;
}

export function buildFeedPublicationRow(
  overrides: FeedPublicationRowOverrides
): FeedPublicationDatabaseRow {
  const rawTotalScore = Number(overrides.total_score ?? 0.5);
  const totalScore = Number.isFinite(rawTotalScore) ? rawTotalScore : 0.5;
  const engagementScore = Number(overrides.engagement_score ?? 0);
  const bridgingScore = Number(overrides.bridging_score ?? 0);
  const componentWeight = 0.2;
  const engagementWeighted = engagementScore * componentWeight;
  const bridgingWeighted = bridgingScore * componentWeight;
  const recencyWeighted = totalScore - engagementWeighted - bridgingWeighted;
  const recencyScore = recencyWeighted / componentWeight;
  return {
    post_uri: overrides.post_uri ?? 'at://did:plc:test/app.bsky.feed.post/1',
    total_score: overrides.total_score ?? totalScore,
    author_did: overrides.author_did ?? 'did:plc:author',
    bridging_score: overrides.bridging_score ?? 0,
    engagement_score: overrides.engagement_score ?? 0,
    embed_url: overrides.embed_url ?? null,
    text_length: overrides.text_length ?? 50,
    created_at: overrides.created_at ?? '2026-09-02T00:00:00.000Z',
    scored_at: overrides.scored_at ?? '2026-09-02T00:01:00.000Z',
    classification_method: overrides.classification_method ?? 'keyword',
    source_score_run_id: overrides.source_score_run_id ?? 'score-run-1',
    recency_score: recencyScore,
    source_diversity_score: 0,
    relevance_score: 0,
    recency_weight: componentWeight,
    engagement_weight: componentWeight,
    bridging_weight: componentWeight,
    source_diversity_weight: componentWeight,
    relevance_weight: componentWeight,
    recency_weighted: recencyWeighted,
    engagement_weighted: engagementWeighted,
    bridging_weighted: bridgingWeighted,
    source_diversity_weighted: 0,
    relevance_weighted: 0,
  };
}
import type { FeedPublicationDatabaseRow } from '../../src/scoring/pipeline.js';
