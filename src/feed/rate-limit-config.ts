import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';

export interface RouteRateLimitConfig {
  max: number;
  timeWindow: number;
  keyGenerator?: (request: FastifyRequest) => string | Promise<string>;
}

function normalizeRouteMethods(method: string | string[]): string[] {
  if (Array.isArray(method)) {
    return method.map((value) => value.toUpperCase());
  }
  return [method.toUpperCase()];
}

export function buildRouteRateLimitConfig(
  url: string,
  method: string | string[],
  governanceMutationKeyGenerator: (request: FastifyRequest) => string | Promise<string>
): RouteRateLimitConfig | null {
  const methods = normalizeRouteMethods(method);
  const isReadOnly = methods.every((value) => value === 'GET' || value === 'HEAD' || value === 'OPTIONS');

  if (url === '/xrpc/app.bsky.feed.sendInteractions') {
    return {
      max: config.RATE_LIMIT_INTERACTIONS_MAX,
      timeWindow: config.RATE_LIMIT_INTERACTIONS_WINDOW_MS,
    };
  }

  if (url === '/mcp') {
    return {
      max: config.RATE_LIMIT_ADMIN_CRITICAL_MAX,
      timeWindow: config.RATE_LIMIT_ADMIN_CRITICAL_WINDOW_MS,
    };
  }

  if (url === '/api/interest') {
    return { max: 20, timeWindow: 600_000 };
  }

  if (url.startsWith('/api/governance/auth/login')) {
    return {
      max: config.RATE_LIMIT_LOGIN_MAX,
      timeWindow: config.RATE_LIMIT_LOGIN_WINDOW_MS,
    };
  }

  // Waitlist intake is unauthenticated — reuse the login limits (IP-keyed).
  // Must sit above the generic governance-mutation branch, which would
  // otherwise key this route by DID and apply vote limits.
  if (url.startsWith('/api/governance/waitlist')) {
    return {
      max: config.RATE_LIMIT_LOGIN_MAX,
      timeWindow: config.RATE_LIMIT_LOGIN_WINDOW_MS,
    };
  }

  if (url.startsWith('/api/governance/vote')) {
    return {
      max: config.RATE_LIMIT_VOTE_MAX,
      timeWindow: config.RATE_LIMIT_VOTE_WINDOW_MS,
      keyGenerator: governanceMutationKeyGenerator,
    };
  }

  if (url.startsWith('/api/governance/') && !isReadOnly) {
    const isCriticalGovernanceMutation =
      url === '/api/governance/epochs/transition' ||
      url === '/api/governance/auth/logout';
    return {
      max: isCriticalGovernanceMutation
        ? config.RATE_LIMIT_ADMIN_CRITICAL_MAX
        : config.RATE_LIMIT_VOTE_MAX,
      timeWindow: isCriticalGovernanceMutation
        ? config.RATE_LIMIT_ADMIN_CRITICAL_WINDOW_MS
        : config.RATE_LIMIT_VOTE_WINDOW_MS,
      keyGenerator: governanceMutationKeyGenerator,
    };
  }

  if (url.startsWith('/api/admin/')) {
    const isCriticalAdminAction =
      url === '/api/admin/epochs/transition' ||
      url === '/api/admin/feed/rescore' ||
      url === '/api/admin/scheduler/check' ||
      (url.startsWith('/api/admin/governance/') && !isReadOnly);
    return {
      max: isCriticalAdminAction
        ? config.RATE_LIMIT_ADMIN_CRITICAL_MAX
        : config.RATE_LIMIT_ADMIN_MAX,
      timeWindow: isCriticalAdminAction
        ? config.RATE_LIMIT_ADMIN_CRITICAL_WINDOW_MS
        : config.RATE_LIMIT_ADMIN_WINDOW_MS,
    };
  }

  if (
    url === '/api/bot/announce' ||
    url === '/api/bot/retry' ||
    url === '/api/bot/unpin'
  ) {
    return {
      max: config.RATE_LIMIT_ADMIN_CRITICAL_MAX,
      timeWindow: config.RATE_LIMIT_ADMIN_CRITICAL_WINDOW_MS,
    };
  }

  return null;
}
