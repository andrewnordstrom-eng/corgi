/**
 * Transparency Server
 *
 * Registers all transparency routes with the Fastify application.
 * Provides the /api/transparency/* namespace for explainability and stats.
 */

import { FastifyInstance } from 'fastify';
import { registerPostExplainRoute } from './routes/post-explain.js';
import { registerFeedStatsRoute } from './routes/feed-stats.js';
import { registerCounterfactualRoute } from './routes/counterfactual.js';
import { registerAuditLogRoute } from './routes/audit-log.js';
import { registerFeedSnapshotRoute } from './routes/feed-snapshot.js';
import { logger } from '../lib/logger.js';

/**
 * Register all transparency routes with the Fastify application.
 *
 * Routes registered:
 * - GET /api/transparency/post/:uri - Per-post score explanation
 * - GET /api/transparency/stats - Feed-level statistics
 * - GET /api/transparency/counterfactual - What-if analysis with alternate weights
 * - GET /api/transparency/audit - Governance audit log
 */
export function registerTransparencyRoutes(app: FastifyInstance): void {
  logger.info('Registering transparency routes');

  // Per-post explanation
  registerPostExplainRoute(app);

  // Publication-bound live-feed snapshot
  registerFeedSnapshotRoute(app);

  // Feed-level statistics
  registerFeedStatsRoute(app);

  // Counterfactual analysis
  registerCounterfactualRoute(app);

  // Audit log
  registerAuditLogRoute(app);

  logger.info('Transparency routes registered');
}
