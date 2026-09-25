import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dbQueryMock,
  dbConnectMock,
  clientQueryMock,
  invalidateContentRulesCacheMock,
  invalidateGovernanceGateCacheMock,
  aggregateVotesMock,
  aggregateContentVotesMock,
  aggregateTopicWeightsMock,
  writeEpochWeightsMock,
  requestFullRescoreMock,
  tryTriggerManualScoringRunMock,
  forceEpochTransitionMock,
  triggerEpochTransitionMock,
} = vi.hoisted(() => ({
  dbQueryMock: vi.fn(),
  dbConnectMock: vi.fn(),
  clientQueryMock: vi.fn(),
  invalidateContentRulesCacheMock: vi.fn(),
  invalidateGovernanceGateCacheMock: vi.fn(),
  aggregateVotesMock: vi.fn(),
  aggregateContentVotesMock: vi.fn(),
  aggregateTopicWeightsMock: vi.fn(),
  writeEpochWeightsMock: vi.fn(),
  requestFullRescoreMock: vi.fn(),
  tryTriggerManualScoringRunMock: vi.fn(),
  forceEpochTransitionMock: vi.fn(),
  triggerEpochTransitionMock: vi.fn(),
}));

vi.mock('../src/db/client.js', () => ({
  db: {
    query: dbQueryMock,
    connect: dbConnectMock,
  },
}));

vi.mock('../src/auth/admin.js', () => ({
  getAdminDid: () => 'did:plc:admin',
}));

vi.mock('../src/governance/content-filter.js', () => ({
  invalidateContentRulesCache: invalidateContentRulesCacheMock,
}));

vi.mock('../src/ingestion/governance-gate.js', () => ({
  invalidateGovernanceGateCache: invalidateGovernanceGateCacheMock,
}));

vi.mock('../src/governance/aggregation.js', () => ({
  aggregateVotes: aggregateVotesMock,
  aggregateContentVotes: aggregateContentVotesMock,
  aggregateTopicWeights: aggregateTopicWeightsMock,
}));

vi.mock('../src/governance/weight-longtable.js', () => ({
  readEpochWeightsForMultipleEpochs: vi.fn().mockResolvedValue({}),
  writeEpochWeights: writeEpochWeightsMock,
}));

vi.mock('../src/scoring/scheduler.js', () => ({
  tryTriggerManualScoringRun: tryTriggerManualScoringRunMock,
}));

vi.mock('../src/scoring/pipeline.js', () => ({
  requestFullRescore: requestFullRescoreMock,
}));

vi.mock('../src/governance/epoch-manager.js', () => ({
  forceEpochTransition: forceEpochTransitionMock,
  triggerEpochTransition: triggerEpochTransitionMock,
}));

vi.mock('../src/bot/governance-announcements.js', () => ({
  announceResultsApproved: vi.fn().mockResolvedValue(undefined),
  announceVoteScheduled: vi.fn().mockResolvedValue(undefined),
  announceVotingClosed: vi.fn().mockResolvedValue(undefined),
  announceVotingOpen: vi.fn().mockResolvedValue(undefined),
}));

import { registerGovernanceRoutes } from '../src/admin/routes/governance.js';

function epochRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 7,
    status: 'active',
    voting_ends_at: '2026-02-10T00:00:00.000Z',
    auto_transition: true,
    recency_weight: 0.2,
    engagement_weight: 0.2,
    bridging_weight: 0.2,
    source_diversity_weight: 0.2,
    relevance_weight: 0.2,
    content_rules: {
      include_keywords: ['ai'],
      exclude_keywords: ['spam'],
    },
    topic_weights: {
      'software-development': 0.5,
    },
    proposed_weights: null,
    proposed_topic_weights: null,
    proposed_content_rules: null,
    created_at: '2026-02-08T00:00:00.000Z',
    closed_at: null,
    ...overrides,
  };
}

describe('admin governance routes', () => {
  beforeEach(() => {
    dbQueryMock.mockReset();
    dbConnectMock.mockReset();
    clientQueryMock.mockReset();
    invalidateContentRulesCacheMock.mockReset();
    invalidateGovernanceGateCacheMock.mockReset();
    aggregateVotesMock.mockReset();
    aggregateContentVotesMock.mockReset();
    aggregateTopicWeightsMock.mockReset();
    writeEpochWeightsMock.mockReset();
    requestFullRescoreMock.mockReset();
    tryTriggerManualScoringRunMock.mockReset();
    forceEpochTransitionMock.mockReset();
    triggerEpochTransitionMock.mockReset();

    dbConnectMock.mockResolvedValue({
      query: clientQueryMock,
      release: vi.fn(),
    });

    invalidateContentRulesCacheMock.mockResolvedValue(undefined);
    invalidateGovernanceGateCacheMock.mockResolvedValue(undefined);
    tryTriggerManualScoringRunMock.mockReturnValue(true);
    aggregateVotesMock.mockResolvedValue(null);
    aggregateContentVotesMock.mockResolvedValue({ includeKeywords: [], excludeKeywords: [] });
    aggregateTopicWeightsMock.mockResolvedValue({});
    writeEpochWeightsMock.mockResolvedValue(undefined);
    forceEpochTransitionMock.mockResolvedValue(8);
    triggerEpochTransitionMock.mockResolvedValue({ success: true, newEpochId: 8 });
  });

  it('rejects keyword add when keyword has special characters', async () => {
    const app = Fastify();
    registerGovernanceRoutes(app);

    const response = await app.inject({
      method: 'POST',
      url: '/governance/content-rules/keyword',
      payload: {
        type: 'include',
        keyword: 'bad@keyword',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'ValidationError' });
    expect(clientQueryMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('returns a bounded error when overview policy data is malformed', async () => {
    dbQueryMock.mockResolvedValueOnce({
      rows: [{ ...epochRow({ topic_weights: 'malformed' }), vote_count: '1' }],
    });

    const app = Fastify();
    registerGovernanceRoutes(app);

    const response = await app.inject({ method: 'GET', url: '/governance' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: 'InvalidGovernancePolicy',
      message: 'Stored governance policy is invalid',
    });

    await app.close();
  });

  it('returns a bounded error when round detail policy data is malformed', async () => {
    dbQueryMock
      .mockResolvedValueOnce({ rows: [epochRow({ topic_weights: 'malformed' })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const app = Fastify();
    registerGovernanceRoutes(app);

    const response = await app.inject({ method: 'GET', url: '/governance/rounds/7' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: 'InvalidGovernancePolicy',
      message: 'Stored governance policy is invalid',
    });

    await app.close();
  });

  it('returns 409 when adding duplicate keyword', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [epochRow()] })
      .mockResolvedValueOnce({ rows: [] });

    const app = Fastify();
    registerGovernanceRoutes(app);

    const response = await app.inject({
      method: 'POST',
      url: '/governance/content-rules/keyword',
      payload: {
        type: 'include',
        keyword: 'ai',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'Conflict' });

    await app.close();
  });

  it('requires confirmation when removing last include keyword', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [epochRow({ content_rules: { include_keywords: ['only'], exclude_keywords: [] } })] })
      .mockResolvedValueOnce({ rows: [] });

    const app = Fastify();
    registerGovernanceRoutes(app);

    const response = await app.inject({
      method: 'DELETE',
      url: '/governance/content-rules/keyword',
      payload: {
        type: 'include',
        keyword: 'only',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'ConfirmationRequired' });

    await app.close();
  });

  describe.each([
    { method: 'PATCH' as const, url: '/governance/content-rules', payload: { excludeKeywords: ['blocked'] }, action: 'admin_rules_override' },
    { method: 'POST' as const, url: '/governance/content-rules/keyword', payload: { type: 'exclude', keyword: 'blocked' }, action: 'admin_keyword_added' },
    { method: 'DELETE' as const, url: '/governance/content-rules/keyword', payload: { type: 'exclude', keyword: 'spam' }, action: 'admin_keyword_removed' },
    { method: 'PATCH' as const, url: '/governance/weights', payload: { recency: 0.6 }, action: 'admin_weights_override' },
  ])('C4 durable override $action', ({ method, url, payload, action }) => {
    it('queues and audits generation before commit and trigger', async () => {
      clientQueryMock.mockImplementation(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) return { rows: [epochRow()] };
        if (sql.includes('INSERT INTO governance_rescore_requests')) return { rows: [{ requested_generation: '9' }] };
        return { rows: [] };
      });
      const app = Fastify();
      registerGovernanceRoutes(app);
      try {
        const response = await app.inject({ method, url, payload });
        expect(response.statusCode).toBe(200);
        const calls = clientQueryMock.mock.calls;
        const queueIndex = calls.findIndex(([sql]) => String(sql).includes('INSERT INTO governance_rescore_requests'));
        const auditIndex = calls.findIndex(([sql]) => String(sql).includes(`VALUES ('${action}'`));
        const commitIndex = calls.findIndex(([sql]) => sql === 'COMMIT');
        expect(queueIndex).toBeGreaterThan(0);
        expect(auditIndex).toBeGreaterThan(queueIndex);
        expect(commitIndex).toBeGreaterThan(auditIndex);
        expect(calls.filter(([sql]) => String(sql).includes('INSERT INTO governance_rescore_requests'))).toHaveLength(1);
        expect(JSON.parse(calls[auditIndex][1][2])).toMatchObject({ rescore_generation: 9 });
        expect(tryTriggerManualScoringRunMock).toHaveBeenCalledTimes(1);
        expect(tryTriggerManualScoringRunMock.mock.invocationCallOrder[0]).toBeGreaterThan(clientQueryMock.mock.invocationCallOrder[commitIndex]);
      } finally { await app.close(); }
    });

    it('rolls back enqueue failure without commit or scoring trigger', async () => {
      clientQueryMock.mockImplementation(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) return { rows: [epochRow()] };
        if (sql.includes('INSERT INTO governance_rescore_requests')) throw new Error('C4 queue unavailable');
        return { rows: [] };
      });
      const app = Fastify();
      registerGovernanceRoutes(app);
      try {
        const response = await app.inject({ method, url, payload });
        expect(response.statusCode).toBe(500);
        expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
        expect(clientQueryMock).not.toHaveBeenCalledWith('COMMIT');
        expect(clientQueryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO governance_audit_log'))).toBe(false);
        expect(requestFullRescoreMock).not.toHaveBeenCalled();
        expect(tryTriggerManualScoringRunMock).not.toHaveBeenCalled();
      } finally { await app.close(); }
    });
  });

  it('normalizes weight override and triggers rescore', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [epochRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ requested_generation: '1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const app = Fastify();
    registerGovernanceRoutes(app);

    const response = await app.inject({
      method: 'PATCH',
      url: '/governance/weights',
      payload: {
        recency: 0.6,
        engagement: 0.2,
        bridging: 0.1,
        sourceDiversity: 0.05,
        relevance: 0.05,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ weights: Record<string, number>; rescoreTriggered: boolean }>();
    const sum = Object.values(body.weights).reduce((acc: number, value: number) => acc + value, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(body.rescoreTriggered).toBe(true);
    expect(tryTriggerManualScoringRunMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('rejects negative weight override', async () => {
    const app = Fastify();
    app.setValidatorCompiler(() => () => true);
    registerGovernanceRoutes(app);

    const response = await app.inject({
      method: 'PATCH',
      url: '/governance/weights',
      payload: {
        recency: -0.1,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'ValidationError' });
    expect(clientQueryMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('extends voting and returns updated round', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [epochRow({ phase: 'voting' })] })
      .mockResolvedValueOnce({ rows: [epochRow({ phase: 'voting', voting_ends_at: '2026-02-11T00:00:00.000Z' })] })
      .mockResolvedValueOnce({ rows: [{ count: '4' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const app = Fastify();
    registerGovernanceRoutes(app);

    const response = await app.inject({
      method: 'POST',
      url: '/governance/extend-voting',
      payload: { hours: 24 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      round: {
        votingEndsAt: '2026-02-11T00:00:00.000Z',
      },
    });

    await app.close();
  });

  it('legacy apply-results alias rejects a reviewed window with no ballots', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [epochRow({ phase: 'results' })] })
      .mockResolvedValueOnce({ rows: [{ total: '0', content: '0', topic: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    const app = Fastify();
    registerGovernanceRoutes(app);

    const response = await app.inject({
      method: 'POST',
      url: '/governance/apply-results',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'NoBallots',
    });
    expect(aggregateVotesMock).not.toHaveBeenCalled();
    expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(
      clientQueryMock.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE governance_epochs')
      )
    ).toBe(false);

    await app.close();
  });

  it('does not let the legacy apply-results alias bypass results review', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [epochRow({ phase: 'voting' })] })
      .mockResolvedValueOnce({ rows: [] });

    const app = Fastify();
    registerGovernanceRoutes(app);

    const response = await app.inject({
      method: 'POST',
      url: '/governance/apply-results',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'ResultsNotPending' });
    expect(aggregateVotesMock).not.toHaveBeenCalled();
    expect(aggregateTopicWeightsMock).not.toHaveBeenCalled();
    expect(aggregateContentVotesMock).not.toHaveBeenCalled();
    expect(writeEpochWeightsMock).not.toHaveBeenCalled();
    expect(invalidateContentRulesCacheMock).not.toHaveBeenCalled();
    expect(invalidateGovernanceGateCacheMock).not.toHaveBeenCalled();
    expect(requestFullRescoreMock).not.toHaveBeenCalled();
    expect(tryTriggerManualScoringRunMock).not.toHaveBeenCalled();
    expect(
      clientQueryMock.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE governance_epochs')
      )
    ).toBe(false);
    expect(
      clientQueryMock.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO governance_rescore_requests')
      )
    ).toBe(false);

    await app.close();
  });

  it('rejects canonical approval when the reviewed window has no ballots', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [epochRow({ phase: 'results' })] })
      .mockResolvedValueOnce({ rows: [{ total: '0', content: '0', topic: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    const app = Fastify();
    registerGovernanceRoutes(app);

    const response = await app.inject({
      method: 'POST',
      url: '/governance/approve-results',
      payload: { announce: false },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'NoBallots' });
    expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(requestFullRescoreMock).not.toHaveBeenCalled();
    expect(tryTriggerManualScoringRunMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('rolls back approval when stored proposed topic policy is malformed', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [epochRow({ phase: 'results', proposed_topic_weights: ['invalid'] })],
      })
      .mockResolvedValueOnce({ rows: [{ total: '25', content: '8', topic: '25' }] })
      .mockResolvedValueOnce({ rows: [] });

    const app = Fastify();
    registerGovernanceRoutes(app);

    const response = await app.inject({
      method: 'POST',
      url: '/governance/approve-results',
      payload: { announce: false },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: 'ApproveResultsFailed' });
    expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(
      clientQueryMock.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE governance_epochs')
      )
    ).toBe(false);
    expect(requestFullRescoreMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('reviews and applies signal, topic, and content-rule proposals before rescoring', async () => {
    const proposedWeights = {
      recency: 0.1,
      engagement: 0.2,
      bridging: 0.25,
      sourceDiversity: 0.15,
      relevance: 0.3,
    };
    const proposedTopicWeights = {
      'science-research': 0.9,
      'software-development': 0.75,
    };
    const proposedContentRules = {
      include_keywords: ['research'],
      exclude_keywords: ['spam'],
    };

    aggregateVotesMock.mockResolvedValue(proposedWeights);
    aggregateTopicWeightsMock.mockResolvedValue(proposedTopicWeights);
    aggregateContentVotesMock.mockResolvedValue({
      includeKeywords: proposedContentRules.include_keywords,
      excludeKeywords: proposedContentRules.exclude_keywords,
    });

    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [epochRow({ phase: 'voting' })] })
      .mockResolvedValueOnce({ rows: [{ total: '25', content: '8', topic: '25' }] })
      .mockResolvedValueOnce({
        rows: [epochRow({
          phase: 'results',
          proposed_weights: proposedWeights,
          proposed_topic_weights: proposedTopicWeights,
          proposed_content_rules: proposedContentRules,
        })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const app = Fastify();
    registerGovernanceRoutes(app);

    const closed = await app.inject({
      method: 'POST',
      url: '/governance/end-voting',
      payload: { announce: false },
    });

    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({
      voteCount: 25,
      proposedWeights,
      proposedTopicWeights,
      proposedContentRules: {
        includeKeywords: ['research'],
        excludeKeywords: ['spam'],
      },
    });

    clientQueryMock.mockReset();
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [epochRow({
          phase: 'results',
          proposed_weights: proposedWeights,
          proposed_topic_weights: proposedTopicWeights,
          proposed_content_rules: proposedContentRules,
        })],
      })
      .mockResolvedValueOnce({ rows: [{ total: '25', content: '8', topic: '25' }] })
      .mockResolvedValueOnce({
        rows: [epochRow({
          phase: 'running',
          recency_weight: proposedWeights.recency,
          engagement_weight: proposedWeights.engagement,
          bridging_weight: proposedWeights.bridging,
          source_diversity_weight: proposedWeights.sourceDiversity,
          relevance_weight: proposedWeights.relevance,
          topic_weights: proposedTopicWeights,
          content_rules: proposedContentRules,
        })],
      })
      .mockResolvedValueOnce({ rows: [{ requested_generation: '1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const approved = await app.inject({
      method: 'POST',
      url: '/governance/approve-results',
      payload: { announce: false },
    });

    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      weights: proposedWeights,
      topicWeights: proposedTopicWeights,
      contentRules: {
        includeKeywords: ['research'],
        excludeKeywords: ['spam'],
      },
      rescoreTriggered: true,
    });
    expect(writeEpochWeightsMock).toHaveBeenCalledWith(expect.anything(), 7, proposedWeights);
    expect(invalidateContentRulesCacheMock).not.toHaveBeenCalled();
    expect(invalidateGovernanceGateCacheMock).not.toHaveBeenCalled();
    expect(requestFullRescoreMock).toHaveBeenCalledTimes(1);
    expect(tryTriggerManualScoringRunMock).toHaveBeenCalledWith();

    const update = clientQueryMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('topic_weights = $6')
    );
    expect(update?.[1]).toEqual([
      proposedWeights.recency,
      proposedWeights.engagement,
      proposedWeights.bridging,
      proposedWeights.sourceDiversity,
      proposedWeights.relevance,
      JSON.stringify(proposedTopicWeights),
      JSON.stringify(proposedContentRules),
      'did:plc:admin',
      7,
    ]);

    const rescoreInsert = clientQueryMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO governance_rescore_requests')
    );
    expect(rescoreInsert?.[1]).toEqual([7]);
    expect(rescoreInsert?.[0]).toContain(
      'requested_generation = governance_rescore_requests.requested_generation + 1'
    );

    await app.close();
  });

  it('rolls back approved policy changes when the durable rescore cannot be enqueued', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [epochRow({ phase: 'results' })] })
      .mockResolvedValueOnce({ rows: [{ total: '25', content: '8', topic: '25' }] })
      .mockResolvedValueOnce({ rows: [epochRow({ phase: 'running' })] })
      .mockRejectedValueOnce(new Error('rescore outbox unavailable'));

    const app = Fastify();
    registerGovernanceRoutes(app);

    const response = await app.inject({
      method: 'POST',
      url: '/governance/approve-results',
      payload: { announce: false },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: 'ApproveResultsFailed' });
    expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(clientQueryMock).not.toHaveBeenCalledWith('COMMIT');
    expect(requestFullRescoreMock).not.toHaveBeenCalled();
    expect(tryTriggerManualScoringRunMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('reports a deferred rescore without undoing a committed policy approval', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [epochRow({ phase: 'results' })] })
      .mockResolvedValueOnce({ rows: [{ total: '25', content: '8', topic: '25' }] })
      .mockResolvedValueOnce({ rows: [epochRow({ phase: 'running' })] })
      .mockResolvedValueOnce({ rows: [{ requested_generation: '2' }] })
      .mockResolvedValueOnce({ rows: [] });
    tryTriggerManualScoringRunMock.mockRejectedValueOnce(new Error('scoring trigger unavailable'));

    const app = Fastify();
    registerGovernanceRoutes(app);

    const response = await app.inject({
      method: 'POST',
      url: '/governance/approve-results',
      payload: { announce: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, rescoreTriggered: false });
    expect(clientQueryMock).toHaveBeenCalledWith('COMMIT');
    expect(requestFullRescoreMock).toHaveBeenCalledTimes(1);
    expect(tryTriggerManualScoringRunMock).toHaveBeenCalledTimes(1);
    const commitCallIndex = clientQueryMock.mock.calls.findIndex(([sql]) => sql === 'COMMIT');
    expect(commitCallIndex).toBeGreaterThanOrEqual(0);
    expect(tryTriggerManualScoringRunMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      clientQueryMock.mock.invocationCallOrder[commitCallIndex]
    );

    await app.close();
  });

  it('rejects the legacy direct end-round bypass', async () => {
    const app = Fastify();
    registerGovernanceRoutes(app);

    const response = await app.inject({
      method: 'POST',
      url: '/governance/end-round',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'DirectTransitionDisabled' });
    expect(clientQueryMock).not.toHaveBeenCalled();
    expect(dbQueryMock).not.toHaveBeenCalled();

    await app.close();
  });
});
