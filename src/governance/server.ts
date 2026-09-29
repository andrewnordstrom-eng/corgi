/**
 * Governance Server
 *
 * Registers all governance routes with the Fastify application.
 * Provides the /api/governance/* namespace for voting, epochs, weights, and auth.
 */

import { FastifyInstance } from 'fastify';
import { registerVoteRoute } from './routes/vote.js';
import { registerTopicRoutes } from './routes/topics.js';
import { registerWeightsRoute } from './routes/weights.js';
import { registerEpochsRoute } from './routes/epochs.js';
import { registerAuthRoute } from './routes/auth.js';
import { registerPolisRoute } from './routes/polis.js';
import { registerContentRulesRoute } from './routes/content-rules.js';
import { registerResearchConsentRoute } from './routes/research-consent.js';
import { registerInterestRoute } from './routes/interest.js';
import { registerWaitlistRoute } from './routes/waitlist.js';
import { logger } from '../lib/logger.js';

/**
 * Register all governance routes with the Fastify application.
 *
 * Routes registered:
 * - POST /api/governance/auth/login - Authenticate with Bluesky
 * - GET /api/governance/auth/session - Get current session
 * - POST /api/governance/auth/logout - Logout
 * - POST /api/governance/vote - Submit vote (weights, keywords, topic weights)
 * - GET /api/governance/vote - Get current vote
 * - GET /api/governance/topics - Get active topic catalog (public)
 * - GET /api/governance/weights - Get current weights
 * - GET /api/governance/weights/history - Get weight history
 * - GET /api/governance/weights/compare - Compare epochs
 * - GET /api/governance/epochs - List epochs
 * - GET /api/governance/epochs/current - Get current epoch
 * - GET /api/governance/epochs/:id - Get epoch details
 * - GET /api/governance/polis - Polis integration info
 * - GET /api/governance/polis/status - Polis integration status
 */
export function registerGovernanceRoutes(app: FastifyInstance): void {
  logger.info('Registering governance routes');

  // Auth routes
  registerAuthRoute(app);

  // Vote routes
  registerVoteRoute(app);

  // Topic catalog routes (public)
  registerTopicRoutes(app);

  // Weights routes
  registerWeightsRoute(app);

  // Epochs routes
  registerEpochsRoute(app);

  // Polis routes (placeholder)
  registerPolisRoute(app);

  // Content rules route
  registerContentRulesRoute(app);

  // Research consent route
  registerResearchConsentRoute(app);

  // Waitlist route (public pilot-access intake)
  registerWaitlistRoute(app);

  // Contact interest never enters the pilot approval queue.
  registerInterestRoute(app);

  logger.info('Governance routes registered');
}
