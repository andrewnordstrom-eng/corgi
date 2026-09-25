import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  communityGovManifestDigest,
  DEMO_SOURCE_SNAPSHOT_LIMIT,
  parseApprovedCommunityGovPolicy,
  parseApprovedSnapshotManifest,
  readApprovedCommunityGovSnapshot,
  readApprovedCommunityGovPolicy,
  readPublishedCommunityGovSnapshot,
} from '../src/feed/demo-snapshot-source.js';
import {
  COMMUNITY_GOV_SNAPSHOT_GATE,
  applyCommunityGovSnapshotGateStatus,
  communityGovSnapshotGateFailures,
  isEnglishLanguageTag,
  loadCommunityGovCaptureCorpus,
  loadShadowDemoCorpus,
} from '../src/demo/corpus.js';
import { applyFeedUrlDedup, FEED_URL_DEDUP_DECAY } from '../src/scoring/feed-publication.js';
import {
  canonicalizeFrozenEmbedUrl,
  captureReportApprovalFailures,
  createBoundedDemoFetch,
  parseSnapshotCaptureReport,
  scoreCompletenessRate,
  snapshotApprovalWriteFlag,
  writeSnapshotCaptureArtifacts,
  type SnapshotCaptureReport,
} from '../src/demo/snapshot-capture.js';
import { ShadowDemoService } from '../src/demo/service.js';
import { MemoryDemoStore } from '../src/demo/store.js';
import type { PostScoreRecord } from '../src/scoring/score-reader.js';
import { readFileSync } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Corgi Commons release snapshot', () => {
  it('provides safe temporary output paths for the documented capture command', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['demo:capture-community-gov']).toContain('--manifest /tmp/');
    expect(packageJson.scripts['demo:capture-community-gov']).toContain('--report /tmp/');
    expect(packageJson.scripts['demo:capture-community-gov']).toContain('--review-sheet /tmp/');
    expect(packageJson.scripts['demo:approve-community-gov']).toBe('tsx scripts/approve-demo-snapshot.ts');
    expect(snapshotApprovalWriteFlag(false)).toBe('wx');
    expect(snapshotApprovalWriteFlag(true)).toBe('w');
  });

  it('refuses to replace an existing approved output unless force is explicit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'corgi-snapshot-approval-output-'));
    const outputPath = join(directory, 'approved.json');
    try {
      await writeFile(outputPath, 'existing approval', 'utf8');

      await expect(writeFile(outputPath, 'replacement', {
        encoding: 'utf8',
        flag: snapshotApprovalWriteFlag(false),
      })).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(outputPath, 'utf8')).toBe('existing approval');

      await writeFile(outputPath, 'reviewed replacement', {
        encoding: 'utf8',
        flag: snapshotApprovalWriteFlag(true),
      });
      expect(await readFile(outputPath, 'utf8')).toBe('reviewed replacement');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('emits only a non-approvable report when live snapshot gates fail', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'corgi-snapshot-fail-closed-'));
    const paths = {
      manifest: join(directory, 'manifest.json'),
      report: join(directory, 'report.json'),
      reviewSheet: join(directory, 'review.html'),
    };
    await Promise.all([
      writeFile(paths.manifest, 'stale manifest', 'utf8'),
      writeFile(paths.reviewSheet, 'stale review sheet', 'utf8'),
    ]);
    const report = captureReport({
      approvable: false,
      eligibleCount: 8,
      displayableCount: 8,
      gateFailures: ['eligible posts 8 < 40'],
    });

    try {
      await writeSnapshotCaptureArtifacts({
        paths,
        report,
        manifestJson: '{"must":"not be written"}\n',
        reviewSheetHtml: '<p>must not be written</p>',
      });

      expect(JSON.parse(await readFile(paths.report, 'utf8'))).toMatchObject({
        artifactKind: 'live_production_snapshot_capture',
        corpusSource: 'production_feed_snapshot',
        approvable: false,
      });
      await expect(access(paths.manifest)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(paths.reviewSheet)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(captureReportApprovalFailures(report, report.manifestDigest)).toContain(
        'capture report is marked non-approvable'
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('removes both approval artifacts when either approvable write fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'corgi-snapshot-partial-write-'));
    const paths = {
      manifest: join(directory, 'manifest.json'),
      report: join(directory, 'report.json'),
      reviewSheet: join(directory, 'missing', 'review.html'),
    };
    const report = captureReport({ approvable: true });

    try {
      await expect(writeSnapshotCaptureArtifacts({
        paths,
        report,
        manifestJson: '{"approved":true}\n',
        reviewSheetHtml: '<p>reviewed</p>',
      })).rejects.toMatchObject({ code: 'ENOENT' });

      expect(JSON.parse(await readFile(paths.report, 'utf8'))).toMatchObject({ approvable: true });
      await expect(access(paths.manifest)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(paths.reviewSheet)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects fixture provenance and report-manifest mismatches at approval', () => {
    const report = captureReport({ approvable: true });

    expect(captureReportApprovalFailures(report, report.manifestDigest)).toEqual([]);
    expect(captureReportApprovalFailures(report, 'f'.repeat(64))).toContain(
      `capture report manifest digest ${report.manifestDigest} does not match ${'f'.repeat(64)}`
    );
    expect(() => parseSnapshotCaptureReport({
      ...report,
      corpusSource: 'fixture_fallback',
    })).toThrow(/corpusSource/);
  });

  it('removes tracking and fragment data from frozen external preview URLs', () => {
    expect(canonicalizeFrozenEmbedUrl('https://example.com/story?utm_source=feed#section'))
      .toBe('https://example.com/story');
    expect(canonicalizeFrozenEmbedUrl('http://example.com/story')).toBeNull();
    expect(canonicalizeFrozenEmbedUrl(null)).toBeNull();
    expect(() => canonicalizeFrozenEmbedUrl('javascript:alert(1)')).toThrow(/HTTPS/);
  });

  it('loads the approved manifest with exact contiguous ranks and a verified digest', () => {
    const snapshot = readApprovedCommunityGovSnapshot(DEMO_SOURCE_SNAPSHOT_LIMIT);

    expect(snapshot.feedName).toBe('Corgi Commons');
    expect(snapshot.entries).toHaveLength(100);
    expect(snapshot.entries.map((entry) => entry.publishedRank)).toEqual(
      Array.from({ length: 100 }, (_unused, index) => index + 1)
    );
    expect(snapshot.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(snapshot.entries.map((entry) => entry.uri)).size).toBe(100);
    const policy = readApprovedCommunityGovPolicy();
    expect(policy.topicCatalog).toHaveLength(26);
    expect(new Set(policy.topicCatalog.map((topic) => topic.slug)).size).toBe(26);
    expect(Object.values(policy.signalWeights).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 12);
  });

  it('freezes complete per-post score lineage instead of assigning the publication run to every post', () => {
    const snapshot = readApprovedCommunityGovSnapshot(DEMO_SOURCE_SNAPSHOT_LIMIT);
    const frozen = snapshot.entries.map((entry) => entry.frozen);

    expect(frozen.every((entry) => entry !== undefined)).toBe(true);
    expect(frozen.every((entry) => entry?.scoreRunId.trim())).toBe(true);
    expect(frozen.every((entry) => entry?.scoreEpochId === snapshot.productionEpochId)).toBe(true);
    expect(new Set(frozen.map((entry) => entry?.scoreRunId)).size).toBeGreaterThan(1);
  });

  it('binds policy and review metadata into the approved release digest', () => {
    const approved = readManifestFixture() as Record<string, unknown>;
    const originalDigest = communityGovManifestDigest(approved);
    const policyChanged = JSON.parse(JSON.stringify(approved)) as Record<string, unknown>;
    (policyChanged.publicationPolicy as { minimumOriginalTextLength: number }).minimumOriginalTextLength = 201;
    const reviewChanged = { ...approved, reviewedAt: '2026-07-11T22:43:10.000Z' };

    expect(originalDigest).toBe(readApprovedCommunityGovSnapshot(DEMO_SOURCE_SNAPSHOT_LIMIT).snapshotDigest);
    expect(communityGovManifestDigest(policyChanged)).not.toBe(originalDigest);
    expect(communityGovManifestDigest(reviewChanged)).not.toBe(originalDigest);
  });

  it('reads production feed state through a narrowly typed read-only provider', async () => {
    const ranked = Array.from({ length: DEMO_SOURCE_SNAPSHOT_LIMIT }, (_unused, index) => [
      `at://did:plc:source${index}/app.bsky.feed.post/post${index}`,
      String(1 - index / 1000),
    ]).flat();
    const reader = {
      eval: vi.fn(async () => [ranked, ['2', 'run-123', '2026-07-11T22:22:13.710Z']]),
    };

    const snapshot = await readPublishedCommunityGovSnapshot(reader, DEMO_SOURCE_SNAPSHOT_LIMIT);

    expect(reader.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('ZREVRANGE'"),
      4,
      'feed:current',
      'feed:epoch',
      'feed:run_id',
      'feed:updated_at',
      99
    );
    expect(snapshot.entries).toHaveLength(DEMO_SOURCE_SNAPSHOT_LIMIT);
    expect(snapshot.entries[0]).toMatchObject({ publishedRank: 1, publishedScore: 1 });
    expect(Object.keys(reader)).toEqual(['eval']);
  });

  it('fingerprints baseline order independently from publication scores', async () => {
    const entries = Array.from({ length: DEMO_SOURCE_SNAPSHOT_LIMIT }, (_unused, index) => [
      `at://did:plc:source${index}/app.bsky.feed.post/post${index}`,
      String(1 - index / 1000),
    ]);
    const read = async (rankedEntries: string[][]) => readPublishedCommunityGovSnapshot({
      eval: vi.fn(async () => [rankedEntries.flat(), ['2', 'run-123', '2026-07-11T22:22:13.710Z']]),
    }, DEMO_SOURCE_SNAPSHOT_LIMIT);
    const original = await read(entries);
    const scoreChanged = entries.map(([uri, score], index) => [uri, index === 0 ? String(Number(score) / 2) : score]);
    const reordered = entries.map((entry) => [...entry]);
    [reordered[0], reordered[1]] = [reordered[1], reordered[0]];

    const changedScoreSnapshot = await read(scoreChanged);
    const reorderedSnapshot = await read(reordered);
    expect(changedScoreSnapshot.snapshotDigest).not.toBe(original.snapshotDigest);
    expect(changedScoreSnapshot.baselineOrderDigest).toBe(original.baselineOrderDigest);
    expect(reorderedSnapshot.baselineOrderDigest).not.toBe(original.baselineOrderDigest);
  });

  it('rejects partial live snapshots and non-release limits', async () => {
    const reader = {
      eval: vi.fn(async () => [
        ['at://did:plc:one/app.bsky.feed.post/one', '0.9'],
        ['2', 'run-123', '2026-07-11T22:22:13.710Z'],
      ]),
    };

    await expect(readPublishedCommunityGovSnapshot(reader, 99)).rejects.toThrow(/must equal 100/);
    await expect(readPublishedCommunityGovSnapshot(reader, DEMO_SOURCE_SNAPSHOT_LIMIT)).rejects.toThrow(/expected 200/);
  });

  it('rejects malformed approved manifest provenance', () => {
    const approved = JSON.parse(JSON.stringify(readManifestFixture())) as Record<string, unknown>;
    for (const [field, value] of [
      ['productionEpochId', 0],
      ['sourceRunId', ''],
      ['sourceUpdatedAt', 'not-a-date'],
      ['capturedAt', 'not-a-date'],
      ['selectionPolicyVersion', ''],
    ] as const) {
      expect(() => parseApprovedSnapshotManifest({ ...approved, [field]: value })).toThrow(/manifest is invalid/);
    }
  });

  it('requires exactly 26 active frozen Corgi Commons topics', () => {
    const approved = readManifestFixture() as { topicCatalog: unknown[] };
    expect(() => parseApprovedSnapshotManifest({ ...approved, topicCatalog: approved.topicCatalog.slice(0, 25) })).toThrow(/26/);
    expect(() => parseApprovedSnapshotManifest({ ...approved, topicCatalog: [...approved.topicCatalog, approved.topicCatalog[0]] })).toThrow(/26/);
    expect(parseApprovedSnapshotManifest(approved).topicCatalog).toHaveLength(26);
  });

  it('accepts a zero publication score and rejects negative scores', () => {
    const approved = readManifestFixture() as { entries: Array<Record<string, unknown>> };
    const zeroScore = JSON.parse(JSON.stringify(approved)) as typeof approved;
    zeroScore.entries[0].publishedScore = 0;
    const negativeScore = JSON.parse(JSON.stringify(approved)) as typeof approved;
    negativeScore.entries[0].publishedScore = -0.001;

    expect(parseApprovedSnapshotManifest(zeroScore).entries[0]?.publishedScore).toBe(0);
    expect(() => parseApprovedSnapshotManifest(negativeScore)).toThrow(/manifest is invalid/);
  });

  it('keeps the approved policy usable when snapshot-entry provenance is invalid', () => {
    const approved = readManifestFixture() as Record<string, unknown>;
    expect(parseApprovedCommunityGovPolicy({ ...approved, snapshotDigest: 'invalid' }).topicCatalog).toHaveLength(26);
    expect(() => parseApprovedCommunityGovPolicy({ ...approved, topicCatalog: [] })).toThrow(/policy manifest is invalid/);
  });

  it('labels the mechanics fallback honestly without published-baseline metadata', async () => {
    const corpus = await loadShadowDemoCorpus({
      communityId: 'community_gov',
      now: new Date('2026-07-11T23:00:00.000Z'),
      fetchFn: vi.fn(),
      dbPool: { query: vi.fn() },
      readScore: vi.fn(),
      readPublishedSnapshot: vi.fn(async () => {
        throw new Error('approved snapshot unavailable');
      }),
    });

    expect(corpus.health).toMatchObject({ status: 'degraded', source: 'fixture_fallback' });
    expect(corpus.warnings[0]?.message).toContain('approved snapshot unavailable');
    expect(corpus.health.sourcePostCount).toBe(corpus.items.length);
    expect(corpus.health.candidatePosts72h).toBe(corpus.items.length);
    expect(corpus.health.eligiblePostCount).toBe(corpus.items.length);
    expect(corpus.items.every((item) =>
      item.publishedRank === undefined
      && item.publishedScore === undefined
      && item.publicationAdjustment === undefined
    )).toBe(true);
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store: new MemoryDemoStore(),
      loadCorpus: async () => corpus,
      now: () => new Date('2026-07-11T23:00:00.000Z'),
    });
    const session = await service.createSession({
      communityId: 'community_gov',
      clientNonce: 'fixture-provenance',
    });
    expect(session.payload.session.corpusProvenance).toMatchObject({
      mode: 'illustrative_fixture_session_frozen',
      label: 'Illustrative mechanics fixture',
    });
  });

  it('loads frozen inputs without retained rows or historical epoch and denies positive deletion', async () => {
    const snapshot = readApprovedCommunityGovSnapshot(DEMO_SOURCE_SNAPSHOT_LIMIT);
    const readScore = vi.fn(async () => {
      throw new Error('mutable score reader must not be called for approved snapshot entries');
    });
    const dbPool = {
      query: vi.fn(async (sql: string) => {
        expect(sql).toContain('deleted = TRUE');
        expect(sql).not.toContain('governance_epochs');
        return { rows: [] };
      }),
    };
    const appViewPost = (uri: string, index: number) => ({
      uri,
      cid: snapshot.entries.find((entry) => entry.uri === uri)?.frozen?.reviewedCid ?? `withheld-${index}`,
      author: {
        did: snapshot.entries.find((entry) => entry.uri === uri)?.frozen?.authorDid,
        handle: `review-${index}.bsky.social`,
        displayName: `Reviewer-safe source ${index + 1}`,
      },
      record: { text: `Public frozen comparison post ${index + 1}`, createdAt: snapshot.capturedAt, langs: ['en'] },
      indexedAt: snapshot.capturedAt,
      likeCount: 0,
      repostCount: 0,
      replyCount: 0,
      quoteCount: 0,
      labels: [],
      embed: {
        $type: 'app.bsky.embed.external#view',
        external: { uri: 'https://example.com/source', title: 'Source', description: 'Source preview' },
      },
    });
    const fetchFn = vi.fn(async (input: string) => {
      const uris = new URL(input).searchParams.getAll('uris');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          posts: uris.map(appViewPost),
        }),
      };
    });

    const corpus = await loadShadowDemoCorpus({
      communityId: 'community_gov',
      now: new Date(snapshot.capturedAt),
      fetchFn,
      dbPool,
      readScore,
      readPublishedSnapshot: vi.fn(async () => snapshot),
    });

    expect(readScore).not.toHaveBeenCalled();
    expect(corpus.health).toMatchObject({
      status: 'live',
      source: 'production_feed_snapshot',
      eligiblePostCount: 74,
      publicScoredPosts: 74,
    });
    expect(corpus.items[0]?.componentDetails).toMatchObject({
      run_id: snapshot.entries[0]?.frozen?.scoreRunId,
      source: 'approved_demo_snapshot',
    });

    const deniedUri = corpus.items[0].postUri;
    const deletedCorpus = await loadShadowDemoCorpus({
      communityId: 'community_gov', now: new Date(snapshot.capturedAt), fetchFn, readScore,
      dbPool: { query: vi.fn(async () => ({ rows: [{ uri: deniedUri }] })) },
      readPublishedSnapshot: async () => snapshot,
    });
    expect(deletedCorpus.health.eligiblePostCount).toBe(73);
    expect(deletedCorpus.items.some((item) => item.postUri === deniedUri)).toBe(false);
    const failedLookupFetch = vi.fn();
    const lookupFailure = await loadShadowDemoCorpus({
      communityId: 'community_gov', now: new Date(snapshot.capturedAt), fetchFn: failedLookupFetch, readScore,
      dbPool: { query: vi.fn(async () => { throw new Error('deletion lookup unavailable'); }) },
      readPublishedSnapshot: async () => snapshot,
    });
    expect(lookupFailure.health.source).toBe('fixture_fallback');
    expect(lookupFailure.warnings[0]?.message).toContain('deletion lookup unavailable');
    expect(failedLookupFetch).not.toHaveBeenCalled();

    const publicUris = new Set(snapshot.entries
      .filter((entry) => entry.frozen?.reviewedCid !== null)
      .slice(0, 39)
      .map((entry) => entry.uri));
    const limitedFetchFn = vi.fn(async (input: string) => {
      const uris = new URL(input).searchParams.getAll('uris').filter((uri) => publicUris.has(uri));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ posts: uris.map(appViewPost) }),
      };
    });
    const degraded = await loadShadowDemoCorpus({
      communityId: 'community_gov',
      now: new Date(snapshot.capturedAt),
      fetchFn: limitedFetchFn,
      dbPool,
      readScore,
      readPublishedSnapshot: vi.fn(async () => snapshot),
    });

    expect(degraded.health).toMatchObject({ status: 'degraded', source: 'fixture_fallback' });
    expect(degraded.warnings[0]?.message).toContain('eligible posts 39 < 40');
    expect(readScore).not.toHaveBeenCalled();

    const captureCorpus = await loadCommunityGovCaptureCorpus({
      now: new Date(snapshot.capturedAt),
      fetchFn: limitedFetchFn,
      dbPool,
      readScore,
      readPublishedSnapshot: vi.fn(async () => snapshot),
      policy: readApprovedCommunityGovPolicy(),
    });
    expect(captureCorpus.health).toMatchObject({
      status: 'degraded',
      source: 'production_feed_snapshot',
      eligiblePostCount: 39,
      publicScoredPosts: 39,
    });
    expect(captureCorpus.items).toHaveLength(39);
    expect(captureCorpus.warnings[0]?.code).toBe('shadow_demo_snapshot_not_approvable');
    expect(captureCorpus.items.some((item) => item.postUri.endsWith('/bird1'))).toBe(false);
  });

  it('fails release quality when any objective gate is below threshold', () => {
    const passing = {
      status: 'live' as const,
      source: 'production_feed_snapshot' as const,
      candidatePosts72h: 100,
      publicScoredPosts: 50,
      uniqueAuthors72h: 45,
      bridgePostShare: 0.4,
      topAuthorConcentration: COMMUNITY_GOV_SNAPSHOT_GATE.maximumTopAuthorConcentration,
      sampledAt: '2026-07-11T22:22:13.710Z',
      eligiblePostCount: 50,
      englishTaggedShare: COMMUNITY_GOV_SNAPSHOT_GATE.minimumEnglishTaggedShare,
      richMediaShare: COMMUNITY_GOV_SNAPSHOT_GATE.minimumRichMediaShare,
    };
    expect(communityGovSnapshotGateFailures(passing)).toEqual([]);
    expect(communityGovSnapshotGateFailures({ ...passing, eligiblePostCount: 39 })).toContain('eligible posts 39 < 40');
    expect(communityGovSnapshotGateFailures({ ...passing, eligiblePostCount: 40, publicScoredPosts: 12 })).toEqual([]);
    expect(communityGovSnapshotGateFailures({ ...passing, publicScoredPosts: 11 })).toContain('displayable posts 11 < 12');
    expect(communityGovSnapshotGateFailures({ ...passing, englishTaggedShare: 0.79 })[0]).toContain('English-tagged share');
    expect(communityGovSnapshotGateFailures({ ...passing, topAuthorConcentration: 0.11 })[0]).toContain('top-author concentration');
    expect(communityGovSnapshotGateFailures({ ...passing, richMediaShare: 0.19 })[0]).toContain('rich-media share');
  });

  it.each([
    [{ englishTaggedShare: 0.79 }, 'English-tagged share'],
    [{ richMediaShare: 0.19 }, 'rich-media share'],
    [{ topAuthorConcentration: 0.11 }, 'top-author concentration'],
  ] as const)('degrades capture health for an independent %s failure', (override, expectedFailure) => {
    const passing = {
      status: 'live' as const,
      source: 'production_feed_snapshot' as const,
      candidatePosts72h: 100,
      publicScoredPosts: 40,
      uniqueAuthors72h: 40,
      bridgePostShare: 0.4,
      topAuthorConcentration: COMMUNITY_GOV_SNAPSHOT_GATE.maximumTopAuthorConcentration,
      sampledAt: '2026-07-11T22:22:13.710Z',
      eligiblePostCount: 40,
      englishTaggedShare: COMMUNITY_GOV_SNAPSHOT_GATE.minimumEnglishTaggedShare,
      richMediaShare: COMMUNITY_GOV_SNAPSHOT_GATE.minimumRichMediaShare,
    };
    const health = { ...passing, ...override };

    expect(communityGovSnapshotGateFailures(health)[0]).toContain(expectedFailure);
    expect(applyCommunityGovSnapshotGateStatus(health).status).toBe('degraded');
  });

  it('keeps capture health live at every reviewer-safe quality boundary', () => {
    const health = {
      status: 'live' as const,
      source: 'production_feed_snapshot' as const,
      candidatePosts72h: 100,
      publicScoredPosts: COMMUNITY_GOV_SNAPSHOT_GATE.minimumDisplayablePosts,
      uniqueAuthors72h: 40,
      bridgePostShare: 0.4,
      topAuthorConcentration: COMMUNITY_GOV_SNAPSHOT_GATE.maximumTopAuthorConcentration,
      sampledAt: '2026-07-11T22:22:13.710Z',
      eligiblePostCount: COMMUNITY_GOV_SNAPSHOT_GATE.minimumEligiblePosts,
      englishTaggedShare: COMMUNITY_GOV_SNAPSHOT_GATE.minimumEnglishTaggedShare,
      richMediaShare: COMMUNITY_GOV_SNAPSHOT_GATE.minimumRichMediaShare,
    };

    expect(communityGovSnapshotGateFailures(health)).toEqual([]);
    expect(applyCommunityGovSnapshotGateStatus(health)).toBe(health);
  });

  it('uses the same ordered URL decay for production publication and shadow reranking', () => {
    const result = applyFeedUrlDedup([
      { id: 'first', score: 1, embedUrl: 'https://example.com/a', textLength: 20, value: 'first' },
      { id: 'second', score: 0.9, embedUrl: 'https://example.com/a', textLength: 20, value: 'second' },
      { id: 'original', score: 0.8, embedUrl: 'https://example.com/a', textLength: 300, value: 'original' },
    ], { enabled: true, minimumOriginalTextLength: 200, decay: FEED_URL_DEDUP_DECAY });

    expect(result.dedupedUrlCount).toBe(1);
    expect(result.entries.map((entry) => [entry.id, entry.score, entry.publicationAdjustment])).toEqual([
      ['first', 1, 1],
      ['original', 0.8, 1],
      ['second', 0.63, 0.7],
    ]);
    const boundary = applyFeedUrlDedup([
      { id: 'zero', score: 1, embedUrl: 'https://example.com/a', textLength: 0, value: null },
      { id: 'threshold', score: 0.9, embedUrl: 'https://example.com/a', textLength: 200, value: null },
    ], { enabled: true, minimumOriginalTextLength: 200, decay: [1, 0.7] });
    expect(boundary.entries.find((entry) => entry.id === 'threshold')?.publicationAdjustment).toBe(1);
    expect(applyFeedUrlDedup([], { enabled: true, minimumOriginalTextLength: 0, decay: [1] })).toMatchObject({
      entries: [], dedupedUrlCount: 0, totalUrlCount: 0,
    });
    for (const invalidMinimum of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => applyFeedUrlDedup([], {
        enabled: true,
        minimumOriginalTextLength: invalidMinimum,
        decay: [1],
      })).toThrow(/finite and non-negative/);
    }
  });

  it('recognizes English BCP-47 tags case-insensitively', () => {
    expect(isEnglishLanguageTag('en')).toBe(true);
    expect(isEnglishLanguageTag('EN')).toBe(true);
    expect(isEnglishLanguageTag('en-US')).toBe(true);
    expect(isEnglishLanguageTag('EN-gb')).toBe(true);
    expect(isEnglishLanguageTag('fr')).toBe(false);
    expect(isEnglishLanguageTag('eng')).toBe(false);
  });

  it('reports empty, partial, and complete score decomposition coverage', () => {
    const complete = scoreRecord();
    const partial = scoreRecord();
    delete partial.components.relevance;

    expect(scoreCompletenessRate([], 0)).toBe(0);
    expect(scoreCompletenessRate([complete, partial, null], 3)).toBeCloseTo(1 / 3, 6);
    expect(scoreCompletenessRate([complete, scoreRecord()], 2)).toBe(1);
    expect(() => scoreCompletenessRate([], -1)).toThrow(/non-negative integer/);
    expect(() => scoreCompletenessRate([complete], 0)).toThrow(/numerator 1 exceeds denominator 0/);
  });

  it('aborts a stalled AppView request at the configured deadline', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })));
    const fetchFn = createBoundedDemoFetch(5);

    await expect(fetchFn('https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts', {
      method: 'GET',
      signal: new AbortController().signal,
    })).rejects.toThrow(/exceeded 5 ms/);
  });
});

function readManifestFixture(): unknown {
  return JSON.parse(readFileSync(
    new URL('../src/demo/community-gov-release-snapshot.json', import.meta.url),
    'utf8'
  )) as unknown;
}

function captureReport(overrides: Partial<SnapshotCaptureReport>): SnapshotCaptureReport {
  return {
    schemaVersion: '2026-07-11.community-gov-snapshot.v3',
    artifactKind: 'live_production_snapshot_capture',
    corpusSource: 'production_feed_snapshot',
    approvable: true,
    manifestDigest: 'a'.repeat(64),
    capturedAt: '2026-07-11T22:22:13.710Z',
    productionEpochId: 2,
    sourceRunId: 'run-123',
    sourceCount: 100,
    eligibleCount: 40,
    displayableCount: 40,
    scoreCompletenessRate: 1,
    uniqueAuthorCount: 40,
    topAuthorConcentration: 0.1,
    englishTaggedShare: 0.8,
    richMediaShare: 0.2,
    languageDistribution: { en: 40 },
    mediaDistribution: { external: 8, none: 32 },
    gateFailures: [],
    safetyChecklist: {
      appViewVisibilityApplied: true,
      nestedLabelsApplied: true,
      reviewerLanguageGateApplied: true,
      sourceLinksValidated: true,
      copiedPostTextInManifest: false,
      manualReviewComplete: false,
    },
    warnings: [],
    ...overrides,
  };
}

function scoreRecord(): PostScoreRecord {
  const component = { raw: 0.5, weight: 0.2, weighted: 0.1 };
  return {
    postUri: 'at://did:plc:test/app.bsky.feed.post/test',
    epochId: 2,
    totalScore: 0.5,
    scoredAt: new Date('2026-07-11T22:22:13.710Z'),
    classificationMethod: 'keyword',
    componentDetails: null,
    components: {
      recency: { ...component },
      engagement: { ...component },
      bridging: { ...component },
      sourceDiversity: { ...component },
      relevance: { ...component },
    },
  };
}
