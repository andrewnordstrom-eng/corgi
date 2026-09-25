import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SHADOW_DEMO_AGGREGATION_METHOD,
  SHADOW_DEMO_CONTRACT_VERSION,
  SHADOW_DEMO_CORPUS_PROVENANCE,
  SHADOW_DEMO_ENDPOINTS,
  SHADOW_DEMO_GUIDED_EPOCHS,
  SHADOW_DEMO_ISOLATION_CONTRACT,
  SHADOW_DEMO_MAX_EPOCHS_PER_SESSION,
  SHADOW_DEMO_SIGNAL_KEYS,
  SHADOW_DEMO_SYNTHETIC_VOTER_COUNT,
  SHADOW_DEMO_TOTAL_DEMO_VOTERS,
  SHADOW_DEMO_VOTER_BLOC_IDS,
} from '../web-next/app/demo/shadow-demo-contract';
import {
  SHADOW_DEMO_COMMUNITY_IDS as BACKEND_COMMUNITY_IDS,
  SHADOW_DEMO_V4_CONTRACT_VERSION as BACKEND_CONTRACT_VERSION,
  SHADOW_DEMO_GUIDED_EPOCHS as BACKEND_GUIDED_EPOCHS,
  SHADOW_DEMO_MAX_EPOCHS_PER_SESSION as BACKEND_MAX_EPOCHS,
  SHADOW_DEMO_SIGNAL_KEYS as BACKEND_SIGNAL_KEYS,
  SHADOW_DEMO_SYNTHETIC_VOTER_COUNT as BACKEND_SYNTHETIC_VOTERS,
  SHADOW_DEMO_TOTAL_DEMO_VOTERS as BACKEND_TOTAL_VOTERS,
  SHADOW_DEMO_VOTER_BLOC_IDS as BACKEND_VOTER_BLOC_IDS,
} from '../src/demo/types';

describe('web-next shadow demo contract', () => {
  it('publishes the backend contract version, endpoints, and signal keys for the UI', () => {
    expect(SHADOW_DEMO_CONTRACT_VERSION).toBe('2026-07-11.shadow-demo.v4');
    expect(SHADOW_DEMO_SIGNAL_KEYS).toEqual([
      'recency',
      'engagement',
      'bridging',
      'source_diversity',
      'relevance',
    ]);
    expect(SHADOW_DEMO_ENDPOINTS).toEqual({
      createSession: '/api/demo/v4/sessions',
      readSession: '/api/demo/v4/sessions/:sessionId',
      castVote: '/api/demo/v4/sessions/:sessionId/votes',
      runSyntheticVoters: '/api/demo/v4/sessions/:sessionId/agents/run',
      advanceEpoch: '/api/demo/v4/sessions/:sessionId/epochs/advance',
      readFeed: '/api/demo/v4/sessions/:sessionId/feed?epochId=&limit=',
      readReceipt: '/api/demo/v4/sessions/:sessionId/receipts?epochId=&postUri=',
    });
    expect(SHADOW_DEMO_MAX_EPOCHS_PER_SESSION).toBe(10);
    expect(SHADOW_DEMO_GUIDED_EPOCHS).toBe(5);
    expect(SHADOW_DEMO_SYNTHETIC_VOTER_COUNT).toBe(24);
    expect(SHADOW_DEMO_TOTAL_DEMO_VOTERS).toBe(25);
    expect(SHADOW_DEMO_CORPUS_PROVENANCE.description).toContain('frozen for this demo run');
  });

  it('names production-faithful aggregation and demo-only isolation semantics', () => {
    expect(SHADOW_DEMO_AGGREGATION_METHOD).toBe('trimmed_mean_no_trim_under_10');
    expect(SHADOW_DEMO_ISOLATION_CONTRACT).toMatchObject({
      productionGovernanceMutates: false,
      productionFeedMutates: false,
      productionAuditLogMutates: false,
      researchExportsMutate: false,
      stateBackend: 'redis_only_demo_namespace',
      liveShadowCommunities: ['community_gov'],
    });
    expect(SHADOW_DEMO_ISOLATION_CONTRACT.redisPrefixes).toEqual([
      'demo:session:',
      'demo:session-nonce:',
      'demo:sessions:',
      'demo:corpus:',
      'demo:corpus:current:v4:',
      'demo:idempotency:',
      'demo:lock:',
      'demo:staging:',
      'demo:rate-limit:',
    ]);
  });

  it('keeps backend and exported web constants in exact parity', () => {
    expect(SHADOW_DEMO_CONTRACT_VERSION).toBe(BACKEND_CONTRACT_VERSION);
    expect(SHADOW_DEMO_SIGNAL_KEYS).toEqual(BACKEND_SIGNAL_KEYS);
    expect(SHADOW_DEMO_SYNTHETIC_VOTER_COUNT).toBe(BACKEND_SYNTHETIC_VOTERS);
    expect(SHADOW_DEMO_TOTAL_DEMO_VOTERS).toBe(BACKEND_TOTAL_VOTERS);
    expect(SHADOW_DEMO_GUIDED_EPOCHS).toBe(BACKEND_GUIDED_EPOCHS);
    expect(SHADOW_DEMO_MAX_EPOCHS_PER_SESSION).toBe(BACKEND_MAX_EPOCHS);
    expect(SHADOW_DEMO_VOTER_BLOC_IDS).toEqual(BACKEND_VOTER_BLOC_IDS);
    expect(SHADOW_DEMO_ISOLATION_CONTRACT.liveShadowCommunities).toEqual(
      BACKEND_COMMUNITY_IDS.filter((id) => id === 'community_gov')
    );

    expect(new Set(SHADOW_DEMO_SIGNAL_KEYS).size).toBe(SHADOW_DEMO_SIGNAL_KEYS.length);
    expect(SHADOW_DEMO_GUIDED_EPOCHS).toBeLessThanOrEqual(SHADOW_DEMO_MAX_EPOCHS_PER_SESSION);
    expect(SHADOW_DEMO_TOTAL_DEMO_VOTERS).toBe(SHADOW_DEMO_SYNTHETIC_VOTER_COUNT + 1);
  });

  it('keeps the lab contract aligned with the exported contract language', () => {
    const doc = readFileSync(new URL('../docs/lab/demo-shadow-governance-contract.md', import.meta.url), 'utf8');

    expect(doc).toContain('shadow-demo');
    expect(doc).toContain(SHADOW_DEMO_CONTRACT_VERSION);
    expect(doc).toContain(SHADOW_DEMO_AGGREGATION_METHOD);
    expect(doc).toContain('reviewer plus 24 deterministic synthetic community voters');
    expect(doc).toContain('5 guided shadow epochs');
    expect(doc).toContain('10 shadow epochs');
    expect(doc).toContain('demo:session:*');
    expect(doc).toContain('demo:lock:*');
    expect(doc).toContain('demo:sessions:*');
    expect(doc).toContain('demo:staging:*');
    expect(doc).toContain('demo:rate-limit:*');
    expect(doc).not.toContain('equal voter average');
  });
});
