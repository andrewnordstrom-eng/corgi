import axios from 'axios';
import type { GovernanceWeights } from './types';
import {
  parseSessionResponse,
  type AnonymousSessionResponse,
  type AuthenticatedSessionResponse,
  type SessionResponse,
} from './session-contract';
import {
  waitlistJoinResponseSchema,
  type WaitlistJoinResponse,
} from './waitlist-contract';

export {
  parseSessionResponse,
  type AnonymousSessionResponse,
  type AuthenticatedSessionResponse,
  type SessionResponse,
};

// API base URL — same-origin relative by default (the Fastify backend serves
// this build), overridable via NEXT_PUBLIC_API_URL for local dev against a
// separately-running backend (e.g. http://localhost:3000).
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// Create axios instance
export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15_000,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Auth types
export interface LoginResponse {
  success: boolean;
  did: string;
  handle: string;
  expiresAt: string;
}

// Auth API
export const authApi = {
  login: async (handle: string, appPassword: string, signal: AbortSignal): Promise<LoginResponse> => {
    const response = await api.post<LoginResponse>('/api/governance/auth/login', {
      handle,
      appPassword,
    }, {
      signal,
    });
    return response.data;
  },

  getSession: async (): Promise<SessionResponse> => {
    const response = await api.get<unknown>('/api/governance/auth/session');
    return parseSessionResponse(response.data);
  },

  logout: async (): Promise<void> => {
    await api.post('/api/governance/auth/logout');
  },
};

export const waitlistApi = {
  join: async (handle: string, note?: string): Promise<WaitlistJoinResponse> => {
    const trimmedNote = note?.trim();
    const response = await api.post<WaitlistJoinResponse>('/api/governance/waitlist', {
      handle: handle.trim(),
      ...(trimmedNote ? { note: trimmedNote } : {}),
    });
    return waitlistJoinResponseSchema.parse(response.data);
  },
};

// Topic catalog types
export interface TopicCatalogEntry {
  slug: string;
  name: string;
  description: string | null;
  parentSlug: string | null;
  currentWeight: number;
}

export interface TopicCatalogResponse {
  topics: TopicCatalogEntry[];
  epochId: number | null;
  voteCount: number;
}

// Vote types
export interface VotePayload {
  recency_weight: number;
  engagement_weight: number;
  bridging_weight: number;
  source_diversity_weight: number;
  relevance_weight: number;
}

export interface VoteResponse {
  success: boolean;
  epoch_id: number;
  is_update?: boolean;
  message: string;
  weights: {
    recency: number;
    engagement: number;
    bridging: number;
    sourceDiversity: number;
    relevance: number;
  };
}

/** Content vote (keywords) */
export interface ContentVote {
  includeKeywords: string[];
  excludeKeywords: string[];
}

export interface GetVoteResponse {
  vote: {
    recency: number;
    engagement: number;
    bridging: number;
    sourceDiversity: number;
    relevance: number;
  } | null;
  contentVote: ContentVote | null;
  topicWeights: Record<string, number> | null;
  voted_at: string | null;
  epoch_id: number | null;
}

/** Content rules response from API */
export interface ContentRulesResponse {
  epoch_id: number;
  include_keywords: string[];
  exclude_keywords: string[];
  include_keyword_votes: Record<string, number>;
  exclude_keyword_votes: Record<string, number>;
  total_voters: number;
  threshold: number;
}

// Vote API
export const voteApi = {
  /**
   * Submit a vote with weights, content rules, and/or topic preferences.
   * @param weights - Algorithm weights (optional)
   * @param contentVote - Content keywords (optional)
   * @param topicWeights - Per-topic weight preferences (optional)
   */
  submitVote: async (
    weights: GovernanceWeights | null,
    contentVote?: ContentVote,
    topicWeights?: Record<string, number> | null
  ): Promise<VoteResponse> => {
    const payload: Record<string, unknown> = {};

    // Add weights if provided
    if (weights) {
      payload.recency_weight = weights.recency;
      payload.engagement_weight = weights.engagement;
      payload.bridging_weight = weights.bridging;
      payload.source_diversity_weight = weights.sourceDiversity;
      payload.relevance_weight = weights.relevance;
    }

    // Add content vote if provided
    if (contentVote) {
      payload.include_keywords = contentVote.includeKeywords;
      payload.exclude_keywords = contentVote.excludeKeywords;
    }

    // Add topic weights if provided
    if (topicWeights && Object.keys(topicWeights).length > 0) {
      payload.topic_weights = topicWeights;
    }

    const response = await api.post<VoteResponse>('/api/governance/vote', payload);
    return response.data;
  },

  getVote: async (): Promise<GetVoteResponse> => {
    const response = await api.get<GetVoteResponse>('/api/governance/vote');
    return response.data;
  },

  /** Get current community content rules and vote statistics */
  getContentRules: async (): Promise<ContentRulesResponse> => {
    const response = await api.get<ContentRulesResponse>('/api/governance/content-rules');
    return response.data;
  },

  /** Get topic catalog with current community weights (public, no auth required) */
  getTopicCatalog: async (): Promise<TopicCatalogResponse> => {
    const response = await api.get<TopicCatalogResponse>('/api/governance/topics');
    return response.data;
  },
};

// Weights types
export interface WeightsResponse {
  epoch_id: number;
  status: string;
  weights: {
    recency: number;
    engagement: number;
    bridging: number;
    source_diversity: number;
    relevance: number;
  };
  vote_count: number;
  created_at: string;
}

export interface EpochResponse {
  id: number;
  status: string;
  phase?: 'running' | 'voting' | 'results';
  weights: {
    recency: number;
    engagement: number;
    bridging: number;
    source_diversity: number;
    relevance: number;
  };
  vote_count: number;
  subscriber_count?: number;
  created_at: string;
  closed_at?: string;
  results_approved_at?: string | null;
  description?: string;
  voting_started_at?: string | null;
  voting_ends_at?: string | null;
  voting_closed_at?: string | null;
  content_rules?: {
    include_keywords: string[];
    exclude_keywords: string[];
  };
}

interface EpochApiResponse {
  epoch_id?: number;
  id?: number;
  status: string;
  phase?: 'running' | 'voting' | 'results';
  weights: {
    recency: number;
    engagement: number;
    bridging: number;
    sourceDiversity?: number;
    source_diversity?: number;
    relevance: number;
  };
  vote_count: number;
  subscriber_count?: number;
  created_at: string;
  closed_at?: string;
  results_approved_at?: string | null;
  description?: string;
  voting_started_at?: string | null;
  voting_ends_at?: string | null;
  voting_closed_at?: string | null;
  content_rules?: {
    include_keywords?: string[];
    exclude_keywords?: string[];
  };
}

function toEpochResponse(epoch: EpochApiResponse): EpochResponse {
  return {
    id: epoch.epoch_id ?? epoch.id ?? 0,
    status: epoch.status,
    phase: epoch.phase,
    weights: {
      recency: epoch.weights.recency,
      engagement: epoch.weights.engagement,
      bridging: epoch.weights.bridging,
      source_diversity: epoch.weights.sourceDiversity ?? epoch.weights.source_diversity ?? 0,
      relevance: epoch.weights.relevance,
    },
    vote_count: epoch.vote_count,
    subscriber_count: epoch.subscriber_count,
    created_at: epoch.created_at,
    closed_at: epoch.closed_at,
    results_approved_at: epoch.results_approved_at,
    description: epoch.description,
    voting_started_at: epoch.voting_started_at,
    voting_ends_at: epoch.voting_ends_at,
    voting_closed_at: epoch.voting_closed_at,
    content_rules: {
      include_keywords: Array.isArray(epoch.content_rules?.include_keywords)
        ? epoch.content_rules.include_keywords
        : [],
      exclude_keywords: Array.isArray(epoch.content_rules?.exclude_keywords)
        ? epoch.content_rules.exclude_keywords
        : [],
    },
  };
}

// Weights API
export const weightsApi = {
  getCurrent: async (): Promise<WeightsResponse> => {
    const response = await api.get<WeightsResponse>('/api/governance/weights');
    return response.data;
  },

  getHistory: async (limit = 10): Promise<{ epochs: EpochResponse[] }> => {
    const response = await api.get<{ epochs: EpochResponse[] }>('/api/governance/weights/history', {
      params: { limit },
    });
    return response.data;
  },

  getCurrentEpoch: async (): Promise<EpochResponse> => {
    const response = await api.get<EpochApiResponse>('/api/governance/epochs/current');
    return toEpochResponse(response.data);
  },
};

// Transparency types
export interface ScoreComponent {
  raw_score: number;
  weight: number;
  weighted: number;
}

export interface TopicBreakdownEntry {
  postScore: number;
  communityWeight: number;
  contribution: number;
}

export interface PostExplanationResponse {
  post_uri: string;
  epoch_id: number;
  epoch_description: string | null;
  total_score: number;
  rank: number;
  components: {
    recency: ScoreComponent;
    engagement: ScoreComponent;
    bridging: ScoreComponent;
    source_diversity: ScoreComponent;
    relevance: ScoreComponent & {
      topicBreakdown?: Record<string, TopicBreakdownEntry>;
    };
  };
  governance_weights: {
    recency: number;
    engagement: number;
    bridging: number;
    source_diversity: number;
    relevance: number;
  };
  counterfactual: {
    pure_engagement_rank: number;
    community_governed_rank: number;
    difference: number;
  };
  scored_at: string;
  component_details: Record<string, unknown> | null;
}

export interface FeedStatsResponse {
  epoch: {
    id: number;
    status: string;
    weights: {
      recency: number;
      engagement: number;
      bridging: number;
      source_diversity: number;
      relevance: number;
    };
    created_at: string;
  };
  feed_stats: {
    total_posts_scored: number;
    unique_authors: number;
    avg_bridging_score: number;
    avg_engagement_score: number;
    median_bridging_score: number;
    median_total_score: number;
  };
  governance: {
    votes_this_epoch: number;
  };
  metrics?: {
    author_gini: number | null;
    vs_chronological_overlap: number | null;
    vs_engagement_overlap: number | null;
  };
}

export interface AuditLogEntry {
  id: number;
  action: string;
  actor_did: string | null;
  epoch_id: number | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface AuditLogResponse {
  entries: AuditLogEntry[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  };
}

export interface CounterfactualPost {
  post_uri: string;
  original_score: number;
  original_rank: number;
  counterfactual_score: number;
  counterfactual_rank: number;
  rank_delta: number;
}

export interface CounterfactualResponse {
  alternate_weights: {
    recency: number;
    engagement: number;
    bridging: number;
    source_diversity: number;
    relevance: number;
  };
  current_weights: {
    recency: number;
    engagement: number;
    bridging: number;
    source_diversity: number;
    relevance: number;
  };
  posts: CounterfactualPost[];
  summary: {
    total_posts: number;
    posts_moved_up: number;
    posts_moved_down: number;
    posts_unchanged: number;
    max_rank_change: number;
    avg_rank_change: number;
  };
}

// Transparency API
export const transparencyApi = {
  getPostExplanation: async (uri: string): Promise<PostExplanationResponse> => {
    const response = await api.get<PostExplanationResponse>(
      `/api/transparency/post/${encodeURIComponent(uri)}`
    );
    return response.data;
  },

  getStats: async (): Promise<FeedStatsResponse> => {
    const response = await api.get<FeedStatsResponse>('/api/transparency/stats');
    return response.data;
  },

  getCounterfactual: async (
    weights: GovernanceWeights,
    limit = 50
  ): Promise<CounterfactualResponse> => {
    const response = await api.get<CounterfactualResponse>('/api/transparency/counterfactual', {
      params: {
        recency: weights.recency,
        engagement: weights.engagement,
        bridging: weights.bridging,
        source_diversity: weights.sourceDiversity,
        relevance: weights.relevance,
        limit,
      },
    });
    return response.data;
  },

  getAuditLog: async (options: {
    limit?: number;
    offset?: number;
    action?: string;
  } = {}): Promise<AuditLogResponse> => {
    const response = await api.get<AuditLogResponse>('/api/transparency/audit', {
      params: options,
    });
    return response.data;
  },

  getEpochHistory: async (limit = 20): Promise<{ epochs: EpochResponse[] }> => {
    const response = await api.get<{ epochs: EpochApiResponse[] }>('/api/governance/epochs', {
      params: { limit },
    });
    const epochs = response.data.epochs.map(toEpochResponse);
    return { epochs };
  },
};

// Legal document types
export interface LegalDocResponse {
  content: string;
  document: 'tos' | 'privacy';
  version: string;
  lastUpdated: string;
}

// Legal API
export const legalApi = {
  getTos: async (): Promise<LegalDocResponse> => {
    const response = await api.get<LegalDocResponse>('/api/legal/tos');
    return response.data;
  },

  getPrivacy: async (): Promise<LegalDocResponse> => {
    const response = await api.get<LegalDocResponse>('/api/legal/privacy');
    return response.data;
  },
};

// Research consent types
export interface ResearchConsentResponse {
  consent: boolean | null;
  consentedAt: string | null;
  consentVersion: string | null;
}

// Research consent API
export const consentApi = {
  getStatus: async (): Promise<ResearchConsentResponse> => {
    const response = await api.get<ResearchConsentResponse>('/api/governance/research-consent');
    return response.data;
  },

  submit: async (consent: boolean): Promise<{ success: boolean }> => {
    const response = await api.post<{ success: boolean }>('/api/governance/research-consent', {
      consent,
    });
    return response.data;
  },
};

/** Contact intake is independent of pilot voting access. */
export const interestApi = {
  submit: async (payload: { email: string; handle: string; interests: string[]; note: string; contactConsent: boolean; website: string }): Promise<WaitlistJoinResponse> => {
    const response = await api.post<WaitlistJoinResponse>('/api/interest', payload);
    return waitlistJoinResponseSchema.parse(response.data);
  },
};
