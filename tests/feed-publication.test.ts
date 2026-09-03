import { describe, expect, it } from 'vitest';
import {
  FEED_PUBLICATION_SCHEMA_VERSION,
  FeedPublicationValidationError,
  applyFeedUrlDedup,
  assertFeedPublicationArtifact,
  assertFeedPublicationDigest,
  buildFeedPublicationArtifact,
  digestFeedPublicationArtifact,
  parseFeedPublicationArtifact,
  sealFeedPublicationExplanation,
  sealFeedPublicationStorage,
  serializeFeedPublicationArtifact,
  type FeedPublicationArtifact,
  type FeedPublicationCandidate,
  type FeedPublicationExplanationCandidate,
  type PublicFeedScoreComponents,
  type PublicFeedWeights,
} from '../src/scoring/feed-publication.js';

const WEIGHTS: PublicFeedWeights = {
  recency: 0.25,
  engagement: 0.2,
  bridging: 0.1,
  source_diversity: 0.1,
  relevance: 0.35,
};

function makePublicationCandidate(
  id: string,
  score: number,
  createdAt: string,
  embedUrl: string | null
): FeedPublicationCandidate<{ id: string }> {
  return {
    id,
    score,
    createdAt,
    embedUrl,
    textLength: 10,
    value: { id },
  };
}

function makeComponents(engagementRawScore: number): PublicFeedScoreComponents {
  const rawScores = {
    recency: 0.8,
    engagement: engagementRawScore,
    bridging: 0.5,
    source_diversity: 0.5,
    relevance: 0.5,
  };
  return {
    recency: {
      raw_score: rawScores.recency,
      weight: WEIGHTS.recency,
      weighted: rawScores.recency * WEIGHTS.recency,
    },
    engagement: {
      raw_score: rawScores.engagement,
      weight: WEIGHTS.engagement,
      weighted: rawScores.engagement * WEIGHTS.engagement,
    },
    bridging: {
      raw_score: rawScores.bridging,
      weight: WEIGHTS.bridging,
      weighted: rawScores.bridging * WEIGHTS.bridging,
    },
    source_diversity: {
      raw_score: rawScores.source_diversity,
      weight: WEIGHTS.source_diversity,
      weighted: rawScores.source_diversity * WEIGHTS.source_diversity,
    },
    relevance: {
      raw_score: rawScores.relevance,
      weight: WEIGHTS.relevance,
      weighted: rawScores.relevance * WEIGHTS.relevance,
    },
  };
}

function makeExplanationCandidate(
  postUri: string,
  preAdjustmentPosition: number,
  createdAt: string,
  engagementRawScore: number,
  sourceScoreRunId: string,
  publicationAdjustment: number
): FeedPublicationExplanationCandidate {
  const components = makeComponents(engagementRawScore);
  const baseScore = Object.values(components).reduce((total, component) => total + component.weighted, 0);
  return {
    postUri,
    preAdjustmentPosition,
    createdAt,
    baseScore,
    publicationAdjustment,
    finalScore: baseScore * publicationAdjustment,
    sourceScoreRunId,
    scoredAt: '2026-09-02T20:00:00.000Z',
    classificationMethod: 'keyword',
    components,
  };
}

function makeArtifact(): FeedPublicationArtifact {
  return buildFeedPublicationArtifact(
    {
      epochId: 7,
      publicationRunId: 'publication-run',
      publishedAt: '2026-09-02T20:01:00.000Z',
      weights: WEIGHTS,
      dedupedUrlCount: 1,
      totalUrlCount: 1,
    },
    [
      makeExplanationCandidate(
        'at://did:plc:one/app.bsky.feed.post/a',
        1,
        '2026-09-02T19:00:00.000Z',
        0.9,
        'score-run-b',
        0.5
      ),
      makeExplanationCandidate(
        'at://did:plc:two/app.bsky.feed.post/b',
        2,
        '2026-09-02T19:01:00.000Z',
        0.5,
        'score-run-a',
        1
      ),
    ]
  );
}

describe('feed publication ordering', () => {
  it('derives base tie order from createdAt DESC and URI ASC', () => {
    const candidates = [
      makePublicationCandidate('at://post/c', 10, '2026-09-02T19:01:00.000Z', null),
      makePublicationCandidate('at://post/b', 10, '2026-09-02T19:00:00.000Z', null),
      makePublicationCandidate('at://post/a', 10, '2026-09-02T19:01:00.000Z', null),
    ];

    const result = applyFeedUrlDedup(candidates, {
      enabled: true,
      minimumOriginalTextLength: 100,
      decay: [1, 0.5],
    });

    expect(result.entries.map((entry) => [entry.id, entry.preAdjustmentPosition])).toEqual([
      ['at://post/a', 1],
      ['at://post/c', 2],
      ['at://post/b', 3],
    ]);
  });

  it('breaks final-score ties with the immutable pre-adjustment position', () => {
    const result = applyFeedUrlDedup([
      makePublicationCandidate('at://post/a', 10, '2026-09-02T19:02:00.000Z', 'https://example.com'),
      makePublicationCandidate('at://post/b', 8, '2026-09-02T19:01:00.000Z', 'https://example.com'),
      makePublicationCandidate('at://post/c', 4, '2026-09-02T19:00:00.000Z', null),
    ], {
      enabled: true,
      minimumOriginalTextLength: 100,
      decay: [1, 0.5],
    });

    expect(result.entries.map((entry) => [entry.id, entry.score, entry.preAdjustmentPosition])).toEqual([
      ['at://post/a', 10, 1],
      ['at://post/b', 4, 2],
      ['at://post/c', 4, 3],
    ]);
  });
});

describe('feed publication artifact', () => {
  it('assigns published and engagement-only positions and exposes mixed provenance', () => {
    const artifact = makeArtifact();

    expect(artifact.schemaVersion).toBe(FEED_PUBLICATION_SCHEMA_VERSION);
    expect(artifact.entries.map((entry) => entry.post_uri)).toEqual([
      'at://did:plc:two/app.bsky.feed.post/b',
      'at://did:plc:one/app.bsky.feed.post/a',
    ]);
    expect(artifact.entries.map((entry) => entry.engagement_only_position)).toEqual([2, 1]);
    expect(artifact.sourceScoreRunIds).toEqual(['score-run-a', 'score-run-b']);
    expect(artifact.mixedScoreRunProvenance).toBe(true);
  });

  it('breaks engagement-only ties with createdAt DESC and URI ASC', () => {
    const older = makeExplanationCandidate(
      'at://post/a',
      1,
      '2026-09-02T19:00:00.000Z',
      0.5,
      'score-run',
      1
    );
    const newerZ = makeExplanationCandidate(
      'at://post/z',
      2,
      '2026-09-02T19:01:00.000Z',
      0.5,
      'score-run',
      1
    );
    const newerB = makeExplanationCandidate(
      'at://post/b',
      3,
      '2026-09-02T19:01:00.000Z',
      0.5,
      'score-run',
      1
    );
    const artifact = buildFeedPublicationArtifact(
      {
        epochId: 7,
        publicationRunId: 'publication-run',
        publishedAt: '2026-09-02T20:01:00.000Z',
        weights: WEIGHTS,
        dedupedUrlCount: 0,
        totalUrlCount: 0,
      },
      [older, newerZ, newerB]
    );
    const engagementOrder = [...artifact.entries]
      .sort((left, right) => left.engagement_only_position - right.engagement_only_position)
      .map((entry) => entry.post_uri);

    expect(engagementOrder).toEqual(['at://post/b', 'at://post/z', 'at://post/a']);
  });

  it('round-trips canonical JSON and produces a stable digest', () => {
    const artifact = makeArtifact();
    const serialized = serializeFeedPublicationArtifact(artifact);
    const reordered: FeedPublicationArtifact = {
      entries: artifact.entries,
      weights: artifact.weights,
      mixedScoreRunProvenance: artifact.mixedScoreRunProvenance,
      sourceScoreRunIds: artifact.sourceScoreRunIds,
      totalUrlCount: artifact.totalUrlCount,
      dedupedUrlCount: artifact.dedupedUrlCount,
      feedCount: artifact.feedCount,
      publishedAt: artifact.publishedAt,
      publicationRunId: artifact.publicationRunId,
      epochId: artifact.epochId,
      schemaVersion: artifact.schemaVersion,
    };

    expect(parseFeedPublicationArtifact(serialized)).toEqual(artifact);
    expect(serializeFeedPublicationArtifact(reordered)).toBe(serialized);
    expect(digestFeedPublicationArtifact(reordered)).toBe(digestFeedPublicationArtifact(artifact));
    expect(() => assertFeedPublicationDigest(digestFeedPublicationArtifact(artifact))).not.toThrow();
  });

  it('rejects non-finite score fields and weight disagreement', () => {
    const nonFinite = structuredClone(makeArtifact());
    nonFinite.entries[0].final_score = Number.NaN;
    expect(() => assertFeedPublicationArtifact(nonFinite)).toThrow(/final_score must be a finite number/);

    const weightMismatch = structuredClone(makeArtifact());
    weightMismatch.entries[0].components.recency.weight = 0.2;
    expect(() => assertFeedPublicationArtifact(weightMismatch)).toThrow(/disagrees with artifact.weights.recency/);
  });

  it('rejects missing and extra public fields', () => {
    const artifact = makeArtifact();
    const withPrivateField: unknown = { ...artifact, internalPostText: 'must not leak' };
    expect(() => assertFeedPublicationArtifact(withPrivateField)).toThrow(/unsupported field internalPostText/);

    const missingField = structuredClone(artifact) as unknown as {
      entries: Array<Record<string, unknown>>;
    };
    delete missingField.entries[0].source_score_run_id;
    expect(() => assertFeedPublicationArtifact(missingField)).toThrow(/missing required field source_score_run_id/);
  });

  it('uses a specific validation error for malformed serialized artifacts', () => {
    expect(() => parseFeedPublicationArtifact('{not-json')).toThrow(FeedPublicationValidationError);
    expect(() => assertFeedPublicationDigest('ABC')).toThrow(FeedPublicationValidationError);
  });

  it('binds the Redis storage seal to metadata, ordered URIs, and exact explanation bytes', () => {
    const artifact = makeArtifact();
    const digest = digestFeedPublicationArtifact(artifact);
    const metadataValues = [
      artifact.epochId.toString(),
      artifact.publicationRunId,
      artifact.publishedAt,
      artifact.feedCount.toString(),
      '1',
      digest,
      JSON.stringify(artifact.weights),
    ];
    const entries = artifact.entries.map((entry) => {
      const serializedExplanation = JSON.stringify(entry);
      return {
        postUri: entry.post_uri,
        serializedExplanation,
        explanationSeal: sealFeedPublicationExplanation(
          metadataValues,
          entry.post_uri,
          serializedExplanation
        ),
      };
    });
    const seal = sealFeedPublicationStorage({ metadataValues, entries });
    const changedDigestMetadata = [...metadataValues];
    changedDigestMetadata[5] = 'f'.repeat(64);
    const changedExplanationEntries = [...entries];
    changedExplanationEntries[0] = {
      ...entries[0],
      serializedExplanation: `${entries[0].serializedExplanation} `,
    };

    expect(seal).toMatch(/^[0-9a-f]{40}$/);
    expect(sealFeedPublicationStorage({ metadataValues, entries: [...entries].reverse() })).not.toBe(seal);
    expect(sealFeedPublicationStorage({
      metadataValues: changedDigestMetadata,
      entries,
    })).not.toBe(seal);
    expect(sealFeedPublicationStorage({
      metadataValues,
      entries: changedExplanationEntries,
    })).not.toBe(seal);

    const rowSeal = sealFeedPublicationExplanation(
      metadataValues,
      entries[0].postUri,
      entries[0].serializedExplanation
    );
    expect(rowSeal).toMatch(/^[0-9a-f]{40}$/);
    expect(sealFeedPublicationExplanation(
      changedDigestMetadata,
      entries[0].postUri,
      entries[0].serializedExplanation
    )).not.toBe(rowSeal);
    expect(sealFeedPublicationExplanation(
      metadataValues,
      entries[0].postUri,
      `${entries[0].serializedExplanation} `
    )).not.toBe(rowSeal);
  });
});
