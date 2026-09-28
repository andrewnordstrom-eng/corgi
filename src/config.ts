import { z } from 'zod';
import dotenv from 'dotenv';

// Production receives its environment from the service manager, never the writable checkout.
const startupNodeEnv = process.env.NODE_ENV;
if (startupNodeEnv !== 'production') {
  dotenv.config();
  if (process.env.NODE_ENV === 'production') {
    throw new TypeError(
      'NODE_ENV=production must be set before startup by the service manager, not a working-directory .env file.',
    );
  }
}

const INSECURE_EXPORT_SALT_DEFAULT = 'dev-salt-not-for-prod';
const INSECURE_DEMO_RATE_LIMIT_HASH_SECRET_DEFAULT = 'dev-demo-rate-limit-secret-not-for-prod';

/**
 * Zod schema for boolean env vars that correctly handles the string "false".
 *
 * `z.coerce.boolean()` uses JavaScript's `Boolean()` constructor, which treats
 * ANY non-empty string as `true` — including `"false"`. This helper treats
 * `"true"` and `"1"` as true, everything else (including `"false"`, `"0"`, `""`) as false.
 */
function zodEnvBool(defaultValue: boolean) {
  return z.preprocess(
    (val) => {
      if (typeof val === 'boolean') return val;
      if (typeof val === 'string') return val.toLowerCase() === 'true' || val === '1';
      return defaultValue;
    },
    z.boolean().default(defaultValue),
  );
}

export const ConfigSchema = z.object({
  // Identity
  FEEDGEN_SERVICE_DID: z.string().startsWith('did:'),
  FEEDGEN_PUBLISHER_DID: z.string().startsWith('did:'),
  FEEDGEN_HOSTNAME: z.string().min(1),

  // Server
  FEEDGEN_PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  FEEDGEN_LISTENHOST: z.string().default('0.0.0.0'),

  // Jetstream
  JETSTREAM_URL: z.string().url(),
  JETSTREAM_FALLBACK_URL: z.string().url(),
  JETSTREAM_COLLECTIONS: z.string(),

  // Database
  DATABASE_URL: z.string().startsWith('postgresql://'),

  // Redis
  REDIS_URL: z.string().startsWith('redis://'),
  DEMO_REDIS_URL: z.string().startsWith('redis://').default('redis://127.0.0.1:6381'),
  DEMO_RATE_LIMIT_HASH_SECRET: z.string().min(16).default(INSECURE_DEMO_RATE_LIMIT_HASH_SECRET_DEFAULT),
  DEMO_CONTENT_RULES_ENABLED: zodEnvBool(false),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),

  // Feed requester JWT verification
  FEED_JWT_AUDIENCE: z.string().default(''),
  FEED_JWT_ALLOWED_ISSUER_PREFIXES: z.string().default('did:plc:'),
  FEED_JWT_MAX_FUTURE_SKEW_SECONDS: z.coerce.number().default(300),

  // Scoring
  SCORING_INTERVAL_CRON: z.string().default('*/5 * * * *'),
  SCORING_INTERVAL_MS: z.coerce.number().default(300_000), // 5 minutes in milliseconds
  SCORING_WINDOW_HOURS: z.coerce.number().default(72),
  SCORING_FULL_RESCORE_INTERVAL: z.coerce.number().int().min(1).default(6),
  SCORING_CANDIDATE_LIMIT: z.coerce.number().min(100).default(5_000),
  SCORING_TIMEOUT_MS: z.coerce.number().min(30_000).default(240_000),
  /**
   * Max posts scored concurrently in the pipeline loop (PROJ-917). Each in-flight
   * post holds at most ONE DB connection at a time (components run sequentially
   * per post, bridging's engager+follow queries are sequential, and the two
   * writes are sequential), so peak scoring connections ≈ this value. Keep
   * SCORING_CONCURRENCY + JETSTREAM_MAX_CONCURRENT well under DB_POOL_MAX
   * (default 8 + 20 = 28 < 50) so ingestion and HTTP serving keep pool headroom.
   */
  SCORING_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
  FEED_MAX_POSTS: z.coerce.number().int().min(1).default(1000),
  /**
   * Dual-write post score decomposition into the long-table post_score_components
   * (migration 021) in addition to the wide columns in post_scores. Default on once
   * shipped; turned off only for incident response. Removed entirely in PROJ-819 (P5)
   * after the wide columns are dropped. See PROJ-814 for the packet that introduced
   * this flag.
  */
  SCORE_LONGTABLE_DUALWRITE_ENABLED: zodEnvBool(true),
  /**
   * Read post-score decomposition from post_score_components (long table) instead
   * of the 15 wide columns in post_scores. PROJ-817 (P4) wired every consumer
   * (transparency, admin, governance, debug, export, Python report generators)
   * through storage-agnostic helpers that branch on this flag and produce the
   * same response shape on both paths. Default is `true` post-flip — parity
   * is contract-tested in tests/score-reader-parity.test.ts (6 helpers ×
   * wide vs long). Rollback in incident response = set this env var to false.
   * Removed entirely in PROJ-819 (P5).
   */
  SCORE_LONGTABLE_READ_ENABLED: zodEnvBool(true),

  // Topic embedding classifier
  /** Enable semantic embedding classifier at ingestion time. */
  TOPIC_EMBEDDING_ENABLED: zodEnvBool(false),
  /** Minimum cosine similarity threshold for topic assignment (0.0-1.0). */
  TOPIC_EMBEDDING_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.35),

  // Governance
  GOVERNANCE_MIN_VOTES: z.coerce.number().default(5),
  GOVERNANCE_PERIOD_HOURS: z.coerce.number().default(168),
  /**
   * Dual-write governance epoch and vote weights into the long-table side tables
   * (governance_epoch_weights / governance_vote_weights from migration 022) in
   * addition to the wide weight columns. Default on once shipped; turned off
   * only for incident response. Removed entirely in PROJ-819 (P5) after the
   * wide columns are dropped. See PROJ-815 for the packet that introduced this
   * flag.
   */
  GOVERNANCE_LONGTABLE_DUALWRITE_ENABLED: zodEnvBool(true),
  /**
   * Read governance epoch weights and aggregation input from the long-table
   * side tables (governance_epoch_weights / governance_vote_weights) instead
   * of the 5 wide weight columns. PROJ-817 (P4) wired admin status, admin
   * governance, admin epochs, governance routes, scheduler, debug, and the
   * research exports through storage-agnostic helpers that branch on this
   * flag and produce identical responses on both paths. Default is `true`
   * post-flip — parity is contract-tested in
   * tests/score-reader-parity.test.ts. Rollback in incident response =
   * set this env var to false. See PROJ-815 for the packet that introduced
   * this flag.
   */
  GOVERNANCE_LONGTABLE_READ_ENABLED: zodEnvBool(true),

  // Bluesky API
  BSKY_IDENTIFIER: z.string(),
  BSKY_APP_PASSWORD: z.string(),

  // Optional
  POLIS_CONVERSATION_ID: z.string().optional().default(''),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ALLOWED_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.string().default('loopback'),
  GOVERNANCE_SESSION_COOKIE_NAME: z.string().default('governance_session'),
  GOVERNANCE_SESSION_COOKIE_SAME_SITE: z
    .enum(['strict', 'lax', 'none'])
    .default('lax'),

  // API rate limiting
  RATE_LIMIT_ENABLED: zodEnvBool(true),
  // Independent demo buckets; defaults preserve the previous shared limits.
  RATE_LIMIT_DEMO_CREATE_MAX: z.coerce.number().int().positive().max(1000).default(10),
  RATE_LIMIT_DEMO_MUTATION_MAX: z.coerce.number().int().positive().max(1000).default(20),
  RATE_LIMIT_DEMO_READ_MAX: z.coerce.number().int().positive().max(1000).default(60),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().default(200),
  RATE_LIMIT_GLOBAL_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().default(10),
  RATE_LIMIT_LOGIN_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_VOTE_MAX: z.coerce.number().default(20),
  RATE_LIMIT_VOTE_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_ADMIN_MAX: z.coerce.number().default(30),
  RATE_LIMIT_ADMIN_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_ADMIN_CRITICAL_MAX: z.coerce.number().default(10),
  RATE_LIMIT_ADMIN_CRITICAL_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_INTERACTIONS_MAX: z.coerce.number().default(60),
  RATE_LIMIT_INTERACTIONS_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_PROMOTION_READY_MAX: z.coerce.number().default(60),
  RATE_LIMIT_PROMOTION_READY_WINDOW_MS: z.coerce.number().default(60_000),

  // Content filtering
  FILTER_NSFW_LABELS: zodEnvBool(true),

  // Ingestion gate: reject posts below community relevance threshold
  INGESTION_GATE_ENABLED: zodEnvBool(true),
  INGESTION_MIN_RELEVANCE: z.coerce.number().min(0).max(1).default(0.10),
  INGESTION_MIN_TEXT_FOR_MEDIA: z.coerce.number().min(0).default(10),

  // Jetstream throughput tuning
  /** Max concurrent DB operations for event processing. Keep below DB_POOL_MAX to leave headroom for HTTP handlers. */
  JETSTREAM_MAX_CONCURRENT: z.coerce.number().min(1).default(20),
  /** Max pending events in backpressure queue before triggering reconnect. */
  JETSTREAM_MAX_PENDING: z.coerce.number().min(100).default(10_000),

  // Database pool tuning
  /** Max connections in the PostgreSQL connection pool. */
  DB_POOL_MAX: z.coerce.number().min(5).default(50),
  /**
   * Statement timeout in milliseconds (prevents runaway queries). 60s, not 30s:
   * the heaviest legitimate query in the system — the incremental scoring
   * candidate UNION (src/scoring/pipeline.ts) — scans the full 72h firehose
   * window and runs ~20-30s at current volume even after partition pruning. The
   * dedicated health-check pool keeps its own tight 5s timeout (src/db/client.ts),
   * so readiness is unaffected by this higher app-query cap.
   */
  DB_STATEMENT_TIMEOUT: z.coerce.number().min(1000).default(60_000),

  // Feed output: minimum relevance score to appear in feed
  FEED_MIN_RELEVANCE: z.coerce.number().min(0).max(1).default(0.15),

  // Private feed mode (research gating)
  FEED_PRIVATE_MODE: zodEnvBool(false),

  // Login allowlist (pilot gating): when true, only admins (BOT_ADMIN_DIDS)
  // and approved_participants may complete login. Waitlist intake and all
  // public read surfaces are unaffected.
  LOGIN_ALLOWLIST_ENABLED: zodEnvBool(false),

  // URL deduplication: penalize reshares of the same external link
  /** Enable URL-based reshare deduplication in feed output. */
  FEED_DEDUP_ENABLED: zodEnvBool(true),
  /** Minimum original text length (chars) to skip dedup penalty. Posts with this much text are treated as original commentary. */
  FEED_DEDUP_MIN_TEXT: z.coerce.number().min(0).default(200),

  // Bot (optional)
  BOT_ENABLED: zodEnvBool(false),
  BOT_HANDLE: z.string().optional(),
  BOT_APP_PASSWORD: z.string().optional(),
  BOT_ADMIN_DIDS: z.string().optional().default(''),
  BOT_PIN_TTL_HOURS: z.coerce.number().default(24),

  // Disk monitoring thresholds (percentage)
  DISK_WARNING_PERCENT: z.coerce.number().min(50).max(100).default(80),
  DISK_CRITICAL_PERCENT: z.coerce.number().min(50).max(100).default(90),
  DISK_EMERGENCY_PERCENT: z.coerce.number().min(50).max(100).default(95),

  // Partition retention (PROJ-917): src/maintenance/partition-manager.ts drops
  // whole daily partitions once their upper bound falls this many days behind
  // CURRENT_DATE. Must stay in sync with the window baked into migrations
  // 026-029 (created_at index/partition rebuild) — those migrations create
  // the initial partitions spanning [today - (retention + 2d), today + 2d];
  // changing these values does not retroactively resize existing partitions.
  /** Retention window (days) for raw event tables: likes, reposts, follows. */
  RAW_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).default(14),
  /** Retention window (days) for content+score tables: posts, post_scores, post_score_components. */
  SCORED_DATA_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),

  // Research export
  EXPORT_ANONYMIZATION_SALT: z.string().min(16).default(INSECURE_EXPORT_SALT_DEFAULT),
}).superRefine((cfg, ctx) => {
  // Validate disk threshold ordering
  if (cfg.DISK_WARNING_PERCENT >= cfg.DISK_CRITICAL_PERCENT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DISK_WARNING_PERCENT'],
      message: `DISK_WARNING_PERCENT (${cfg.DISK_WARNING_PERCENT}) must be less than DISK_CRITICAL_PERCENT (${cfg.DISK_CRITICAL_PERCENT})`,
    });
  }
  if (cfg.DISK_CRITICAL_PERCENT >= cfg.DISK_EMERGENCY_PERCENT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DISK_CRITICAL_PERCENT'],
      message: `DISK_CRITICAL_PERCENT (${cfg.DISK_CRITICAL_PERCENT}) must be less than DISK_EMERGENCY_PERCENT (${cfg.DISK_EMERGENCY_PERCENT})`,
    });
  }

  if (cfg.NODE_ENV !== 'production') {
    return;
  }

  if (cfg.EXPORT_ANONYMIZATION_SALT === INSECURE_EXPORT_SALT_DEFAULT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EXPORT_ANONYMIZATION_SALT'],
      message: 'EXPORT_ANONYMIZATION_SALT must be explicitly set in production.',
    });
  }

  if (cfg.EXPORT_ANONYMIZATION_SALT.length < 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EXPORT_ANONYMIZATION_SALT'],
      message: 'EXPORT_ANONYMIZATION_SALT should be at least 32 characters in production.',
    });
  }

  if (!cfg.RATE_LIMIT_ENABLED) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['RATE_LIMIT_ENABLED'],
      message: 'RATE_LIMIT_ENABLED must remain enabled in production.',
    });
  }

  if (redisInstanceAuthority(cfg.DEMO_REDIS_URL) === redisInstanceAuthority(cfg.REDIS_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DEMO_REDIS_URL'],
      message: 'DEMO_REDIS_URL must not equal REDIS_URL in production; demo state must remain isolated.',
    });
  }

  if (cfg.DEMO_RATE_LIMIT_HASH_SECRET === INSECURE_DEMO_RATE_LIMIT_HASH_SECRET_DEFAULT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DEMO_RATE_LIMIT_HASH_SECRET'],
      message: 'DEMO_RATE_LIMIT_HASH_SECRET must be explicitly set in production.',
    });
  }

  if (cfg.DEMO_RATE_LIMIT_HASH_SECRET.length < 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DEMO_RATE_LIMIT_HASH_SECRET'],
      message: 'DEMO_RATE_LIMIT_HASH_SECRET should be at least 32 characters in production.',
    });
  }
});

export type Config = z.infer<typeof ConfigSchema>;

export const config = ConfigSchema.parse(process.env);

function redisInstanceAuthority(value: string): string {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    const canonicalHost = new Set(['localhost', '127.0.0.1', '::1', '[::1]']).has(hostname)
      ? 'loopback'
      : hostname;
    return `${canonicalHost}:${parsed.port || '6379'}`;
  } catch {
    return value;
  }
}
