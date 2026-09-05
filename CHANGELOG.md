# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Public, rate-limited `/api/demo/*` shadow-governance sessions with production-sourced score components, deterministic synthetic voters, isolated Redis state, reranked feeds, and inspectable receipts.
- Product-grade `web-next` landing, how-it-works, and no-login shadow-demo flows with shared Corgi/Bluesky presentation patterns, responsive product pages, and inspectable multi-epoch ranking receipts.
- Topic scoring engine: winkNLP-based topic classification at ingestion time
- Community topic weight voting (boost/penalize topics via governance)
- Bluesky content label filtering (replaces keyword-based NSFW exclusion)
- Topic taxonomy with co-occurrence disambiguation
- Hardened PR CI workflow (`backend-verify`, `frontend-verify`, `report-scripts-verify`)
- Docs freshness automation (`npm run docs:verify`) with CI gate and scheduled GitHub workflow
- CodeQL scanning workflow and branch-protection-required check integration
- Offline report fixture data + pinned Python report requirements for reproducible script validation
- Roadmap, release policy, and issue triage policy docs
- Dedicated support guide (`SUPPORT.md`) and issue-template contact links for support/security routing

### Changed
- Updated vulnerable dependencies across shipped workspaces without adding audit exceptions. Numeric `TRUST_PROXY` hop counts now fail startup with migration guidance; use an explicit trusted proxy IP/CIDR or `loopback` before deploying this update.
- Relicensed the project from MIT to Apache-2.0. Releases through v1.2.0 remain available under MIT.
- Production governance now closes voting into an explicit results-review phase, applies approved signal weights, topic weights, and content rules together, and durably requests a full same-epoch rescore for the updated policy.
- Public `web-next` homepage refreshed around the reviewer-safe live snapshot, anonymized receipt copy, and demo-first CTA path.
- README command examples and tooling descriptions updated to match current CLI and MCP behavior
- PR template and contributing checklist now enforce changelog and security/audit validation gates
- PR template and contributor guide now enforce small, single-purpose PR scope and Linear-linked branch/PR conventions
- MCP/setup, stability, status, and system-overview docs updated to match current command syntax and tool counts

## [1.2.0] — 2026-03-09

### Added

- Embedding-based topic classification at ingestion (Tier-2 semantic classifier, all-MiniLM-L6-v2)
- Per-post classification-method tracking
- URL-based post deduplication

### Changed

- Topic relevance scoring gained an embedding-confidence multiplier

## [1.1.0] — 2026-03-06

### Added
- Admin CLI tool (`feed-cli`) with 7 command groups covering all admin operations
- MCP server with 23 admin tools via Streamable HTTP for programmatic management
- Research data export API: votes, scores, engagement, epochs, audit log (CSV/JSON)
- Deterministic DID anonymization for research exports (`EXPORT_ANONYMIZATION_SALT`)
- Weekly automated research export via GitHub Actions
- Daily governance health check workflow

### Changed
- CLI authenticates via same session system as dashboard (no VPS credentials required)
- MCP endpoint at `/mcp` with Bearer token auth (same admin DID allowlist)

## [1.0.0] — 2026-03-06

### Added
- Community governance with epoch-based weight voting
- Five scoring components: recency, engagement, bridging, source diversity, relevance
- Modular scoring component interface for pluggable algorithms
- Bluesky `acceptsInteractions` support (See More / See Less feedback buttons)
- Private feed access gating with approved participant management
- Admin dashboard: governance controls, feed health, interactions, announcements, audit log
- Interaction tracking: feed requests, scroll depth, engagement attribution
- OpenAPI documentation at `/docs` (Swagger UI)
- Pre-commit hooks (husky + lint-staged + TypeScript checking)
- Dependabot for automated dependency updates (npm + GitHub Actions)
- Shared API types between frontend and backend (`src/shared/`)
- Code generators for scoring components and routes
- Transparency endpoints: per-post explanations, counterfactuals, feed statistics
- Bot integration for governance epoch announcements
- Score decomposition: 15 numeric columns per post per epoch (raw, weight, weighted × 5)
- Append-only audit log with DB-enforced immutability
- Jetstream ingestion with cursor persistence and automatic reconnection
- Research consent flow with Terms of Service and Privacy Policy
- 185+ tests (unit, integration, stress) with CI enforcement
- Docker deployment with GitHub Actions CI/CD
