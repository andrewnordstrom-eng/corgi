/**
 * Direct DB helpers for CLI read-only commands.
 */

import pg from 'pg';

const { Pool } = pg;
const DIRECT_DATABASE_STATEMENT_TIMEOUT_MILLIS = 5_000;
const DIRECT_DATABASE_QUERY_TIMEOUT_MILLIS = 7_000;

interface EpochRow {
  id: number;
  status: string;
  phase: string | null;
  recency_weight: string;
  engagement_weight: string;
  bridging_weight: string;
  source_diversity_weight: string;
  relevance_weight: string;
}

interface SubscriberCountRow {
  count: string;
}

/**
 * Normalized epoch status shape used by CLI output rendering.
 */
export interface EpochStatusData {
  epoch: {
    id: number;
    phase: string;
    weights: Record<string, number>;
  } | null;
  feedPrivateMode: boolean;
  scoringRunning: boolean | null;
  subscriberCount: number;
}

/**
 * Resolve current epoch status directly from PostgreSQL.
 */
export async function getDirectEpochStatus(databaseUrl: string): Promise<EpochStatusData> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: DIRECT_DATABASE_STATEMENT_TIMEOUT_MILLIS,
    query_timeout: DIRECT_DATABASE_QUERY_TIMEOUT_MILLIS,
  });

  try {
    const epochResult = await pool.query<EpochRow>(
      `
        SELECT
          id,
          status,
          phase,
          recency_weight,
          engagement_weight,
          bridging_weight,
          source_diversity_weight,
          relevance_weight
        FROM governance_epochs
        WHERE status IN ('active', 'voting')
        ORDER BY id DESC
        LIMIT 1
      `
    );

    let subscriberCount = 0;
    try {
      const subscribersResult = await pool.query<SubscriberCountRow>(
        `SELECT COUNT(*)::text AS count FROM subscribers WHERE is_active = TRUE`
      );
      subscriberCount = Number.parseInt(subscribersResult.rows[0]?.count ?? '0', 10);
    } catch {
      subscriberCount = 0;
    }

    const epoch = epochResult.rows[0]
      ? {
          id: Number(epochResult.rows[0].id),
          phase: epochResult.rows[0].phase ?? epochResult.rows[0].status,
          weights: {
            recency: Number.parseFloat(epochResult.rows[0].recency_weight),
            engagement: Number.parseFloat(epochResult.rows[0].engagement_weight),
            bridging: Number.parseFloat(epochResult.rows[0].bridging_weight),
            sourceDiversity: Number.parseFloat(epochResult.rows[0].source_diversity_weight),
            relevance: Number.parseFloat(epochResult.rows[0].relevance_weight),
          },
        }
      : null;

    return {
      epoch,
      feedPrivateMode: /^(1|true)$/i.test(process.env.FEED_PRIVATE_MODE ?? 'false'),
      scoringRunning: null,
      subscriberCount,
    };
  } finally {
    await pool.end();
  }
}
