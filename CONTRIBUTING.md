# Contributing

Thanks for your interest in Corgi. Outside contributions go through GitHub:

- **Bugs and ideas:** open a [GitHub issue](https://github.com/andrewnordstrom-eng/corgi/issues) first, so we can agree on the change before you write code.
- **New scoring components:** start with the [component guide](docs/contributing-scoring-components.md).
- **Security problems:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).

Maintainers also track work in an internal tracker. You don't need access to it; a GitHub issue is enough.

## Development Setup

Local setup is manual. You need Node.js 22.19 or newer, Docker Compose, and a Bluesky account for the feed identity values marked REQUIRED in `.env.example`. The sandbox demo also needs its own Redis instance; see the [sandbox contract](docs/lab/demo-shadow-governance-contract.md).

1. Install dependencies:
```bash
npm install
npm --prefix web-next install
npm --prefix web install
```
2. Configure environment:
```bash
cp .env.example .env
```
3. Start services:
```bash
docker compose up -d
```
4. Run migrations:
```bash
npm run migrate
```

## Useful Commands

- Build backend: `npm run build`
- Run backend tests: `npm test -- --run`
- Build canonical frontend: `npm --prefix web-next run build`
- Run canonical frontend dev server: `npm --prefix web-next run dev`
- Build legacy frontend: `npm --prefix web run build`
- Full local gate: `npm run verify`
- Docs freshness gate: `npm run docs:verify`

## Project Structure

- `src/ingestion/`: Jetstream ingestion
- `src/scoring/`: scoring components + pipeline
- `src/governance/`: voting, aggregation, epoch lifecycle
- `src/feed/`: feed generator routes
- `src/admin/`: admin routes and status
- `src/transparency/`: public transparency APIs
- `web-next/`: canonical Next.js product frontend
- `web/`: legacy React/Vite compatibility frontend

## Contribution Guidelines

- Contributions are accepted under Apache-2.0 under the inbound-license terms in Apache License 2.0 §5.
- Keep core governance invariants intact (decomposed scores, epoch tagging, soft deletes)
- Add or update tests for behavior changes
- Avoid adding external API calls in feed serving paths
- Keep changes scoped and easy to review
- Follow issue label policy in [`docs/ISSUE_TRIAGE.md`](docs/ISSUE_TRIAGE.md)
- Follow release/changelog policy in [`RELEASING.md`](RELEASING.md)

## PR Guidelines (Required)

### PR Granularity

- One PR must represent one logical change.
- Target reviewable diffs (about 50-300 meaningful lines) whenever possible.
- Each PR must be independently mergeable with green checks on `main`.
- Do not bundle unrelated work (feature + refactor, bug fix + dependency cleanup, etc.).

### Branch Naming

- Include the issue number in branch names.
- Pattern example: `issue-42-add-vote-normalization`
- Maintainers use their internal tracker ID instead (for example `dev/PROJ-42-add-vote-normalization`).

### PR Title and Description

- Use imperative, descriptive titles.
- PR description must include:
  - what this PR does
  - why this is needed (link the issue)
  - testing performed
  - reviewer focus areas
- Include an auto-close keyword for the issue (for example: `Fixes #42`).

### CodeRabbit Review-Fix Loop

- Expect CodeRabbit auto-review on each PR.
- Address findings by pushing follow-up commits to the same branch.
- If you disagree with a finding, respond with rationale in the PR thread instead of dismissing silently.
- Iterate until findings are resolved and checks remain green.

### Sensitive Changes

- Security-sensitive changes (auth, input validation, data access) should be isolated in dedicated PRs.
- Never put exploit details in a public issue or PR; report vulnerabilities through [SECURITY.md](SECURITY.md).

## Adding A Votable Weight

1. Update backend parameter config in `src/config/votable-params.ts`.
2. Add any required schema/migration changes for new vote columns.
3. Wire scoring/aggregation consumers that depend on the new field.
4. Update the canonical frontend parameter config and any legacy compatibility config.
5. Run full verification (`npm run verify`).

## Pull Request Checklist

- `npm run verify` passes
- `python3 -m py_compile scripts/generate-report.py scripts/generate-report-pdf.py scripts/report_utils.py` passes
- `MPLCONFIGDIR=/tmp python3 scripts/generate-report.py --csv tests/fixtures/report/report-sample.csv --epoch-json tests/fixtures/report/epoch-sample.json --dry-run` passes
- `MPLCONFIGDIR=/tmp python3 scripts/generate-report-pdf.py --csv tests/fixtures/report/report-sample.csv --epoch-json tests/fixtures/report/epoch-sample.json --dry-run` passes
- `node scripts/audit-allowlist.mjs --workspace=root --audit-level=moderate` passes
- `(cd cli && node ../scripts/audit-allowlist.mjs --workspace=cli --audit-level=moderate)` passes
- `(cd web && node ../scripts/audit-allowlist.mjs --workspace=web --audit-level=moderate)` passes
- `(cd web-next && node ../scripts/audit-allowlist.mjs --workspace=web-next --audit-level=moderate)` passes
- `npm run docs:verify` passes
- `CHANGELOG.md` updated for user/operator-visible changes
- Migrations included for schema changes
- Notes included for operational or rollout impact
