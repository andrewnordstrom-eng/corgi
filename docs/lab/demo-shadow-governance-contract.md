# Corgi Shadow Demo Governance Contract

Version: `2026-07-11.shadow-demo.v4`

This contract powers the public `/demo` walkthrough without mutating production governance or the public Bluesky feed. The v3 `/api/demo/*` family remains temporarily available for active or cached clients; the reviewer UI uses `/api/demo/v4/*`.

## Reviewer Story

The sole v4 community is `community_gov`, displayed as **Community Governed Feed**. A read-only capture takes the ordered top 100 entries from production `feed:current` with publication scores, epoch, publication run ID, and update time. The approved v2 manifest is committed at `src/demo/community-gov-release-snapshot.json`; it freezes each post's own score-run lineage, raw components, topic vector, and URL-dedup inputs while copying no post text.

At session creation, Corgi validates the frozen inputs and hydrates public display metadata from Bluesky AppView. It does not reread mutable score decompositions. The eligible comparison set is copied into dedicated demo Redis and frozen for the session. Epoch 1 preserves the published order exactly. Later shadow epochs rerank the same eligible cohort, so movement is attributable to policy changes rather than corpus churn.

Required UI language:

- `Reviewer-safe snapshot of the live Community Governed Feed`
- `Captured <timestamp> · frozen for this session`
- `Shadow session · never changes the public feed`

The separate live-proof link opens the continuously updating Community Governed Feed on Bluesky. The guided snapshot is never described as continuously live after it is frozen.

## Endpoints

- `POST /api/demo/v4/sessions`
- `GET /api/demo/v4/sessions/:sessionId`
- `POST /api/demo/v4/sessions/:sessionId/votes`
- `POST /api/demo/v4/sessions/:sessionId/agents/run`
- `POST /api/demo/v4/sessions/:sessionId/epochs/advance`
- `GET /api/demo/v4/sessions/:sessionId/feed?epochId=&limit=`
- `GET /api/demo/v4/sessions/:sessionId/receipts?epochId=&postUri=`

Mutation bodies remain capped at 16 KiB. Session state remains capped at 1 MiB, idempotency records at 256 KiB, and anonymous active sessions at 50. Guided mode covers 5 guided shadow epochs; explicit free play is capped at 10 shadow epochs.

## Topics And Ballots

Each session returns the frozen production topic catalog and baseline topic policy. The reviewer ballot must submit the complete catalog. The server rejects missing, unknown, overlong, duplicate-at-serialization, out-of-range, or non-finite topic values. This makes all 26 currently active production topics functional without hardcoding the catalog into the browser.

The electorate is one reviewer plus 24 deterministic synthetic community voters, grouped into five transparent blocs:

- Freshness Watchers: 5
- Conversation Followers: 4
- Bridge Builders: 5
- Source Diversifiers: 5
- Relevance Stewards: 5

These are scripted deterministic voter archetypes, not LLM agents and not validated human-behavior models. They combine stable bloc preferences, prior-policy inertia, a bounded response to the reviewer proposal, and seeded epoch variation. Identical inputs replay exactly; prior shadow epochs create inspectable path dependence.

Aggregation uses the same side-effect-free production helper, labeled `trimmed_mean_no_trim_under_10`. With 25 ballots, two low and two high values are trimmed from each signal and topic component before averaging. `reviewerBallotShare=1/25` is ballot share, not causal influence, because scripted ballots respond partly to the proposal. The `direct_reviewer_ballot_removed` counterfactual removes the direct reviewer ballot while holding the 24 scripted ballots fixed.

## Content Rules (flag-gated)

Behind `DEMO_CONTENT_RULES_ENABLED` (default off), the ballot gains a third channel: exclude keywords. With the flag off, every payload is contract-identical to v4 and keyword ballots are rejected.

- The reviewer may propose up to 10 exclude keywords (production normalization: lowercase, trim, dedupe, 50-character cap). Synthetic voters never originate keywords; each voter deterministically echoes a reviewer proposal (seeded per keyword, per voter, with bloc-specific echo rates) and sustains previously adopted rules with inertia. Identical inputs replay exactly.
- Aggregation is the production support-threshold rule, not trimmed mean: a keyword is adopted when backed by at least 30 percent of the electorate (`ceil(0.3 x n)`, so 8 of 25). Every demo ballot is complete, so the denominator is the full 25-ballot electorate; production computes the same share over voters who cast a content ballot. The demo has no safety-net default rules because the frozen corpus is already reviewer-safe.
- Adopted rules apply at shadow rank time with the production matcher (`checkContentRules`: prefix matching, exclude precedence). Matching posts are withheld from the ranking, not reordered; the feed payload lists them under `withheldPosts` with the matching keyword and its support count. The frozen corpus itself never changes: rules shrink the eligible set, weights reorder the rest, and both effects stay attributable.
- Rank receipts on visible posts state the adopted rules, threshold, and electorate. Withheld posts have no rank receipt; the receipt endpoint returns an explicit error naming the rule and support.
- Suggested keywords are derived deterministically from the frozen corpus (frequency-bounded so a suggestion always withholds some posts but never most of the corpus).

## Ranking And Receipts

The demo reuses stored production raw score components, topic vectors, the production relevance formula, the relevance floor, trimmed-mean aggregation, and the publication-order adjustment represented by the approved feed snapshot. It does not rerun the scorer when a reviewer clicks.

Receipts distinguish:

```text
component score = sum(raw component * shadow signal weight)
published baseline adjustment = published score / component score
shadow publication adjustment = one application of the frozen URL-dedup policy
final ranking score = component score * publication adjustment
```

Epoch 1 reconstructs the historical publication adjustment only to explain the immutable published baseline. Later shadow epochs do not carry that historical multiplier forward: they apply the snapshot's frozen URL-dedup policy once to the newly computed component scores. Receipts return the component score, publication adjustment, final score, published baseline rank and score, shadow rank, production epoch/run, release-bundle digest, baseline-order digest, corpus ID, and source URI.

Topic receipts return every contributing term plus weighted sum, signal sum, confidence multiplier, base relevance, effective relevance, default-weight use, and confidence threshold. Rank and receipt annotations are Corgi UI, not native Bluesky UI.

The boundary is explicit: shadow epochs rerank only the frozen published comparison corpus. They do not rescan the firehose and do not claim to reproduce every candidate that could enter a newly scored production feed.

## Snapshot Gates

The capture command is read-only:

```bash
npm run demo:capture-community-gov -- \
  --manifest /tmp/community-gov-manifest.json \
  --report /tmp/community-gov-report.json \
  --review-sheet /tmp/community-gov-review.html
```

It always emits a machine-readable quality report. It emits the ordered URI manifest, digest, reviewed record CIDs, and local review sheet only when the live production cohort passes every objective gate. A failed capture deletes any stale manifest/review sheet at the requested paths and exits nonzero; it never substitutes fixture posts into a live review artifact. A release snapshot must have:

- at least 40 eligible and 12 displayable public posts;
- 100 percent score decomposition for eligible posts;
- at least 80 percent English-tagged content, with other languages labeled;
- top-author concentration at or below 10 percent;
- at least 20 percent rich-media coverage;
- zero public-view policy violations;
- a completed manual review with no unexplained unsafe result under built-in presets.

The runtime demo may fall back to its explicitly labeled mechanics fixture. The capture and approval commands never do: approval requires the matching passing report as well as acknowledgement that every review-sheet row was checked.

```bash
npm run demo:approve-community-gov -- \
  --manifest /tmp/community-gov-manifest.json \
  --report /tmp/community-gov-report.json \
  --output src/demo/community-gov-release-snapshot.json \
  --reviewed-at 2026-07-13T20:00:00Z \
  --review-acknowledged
```

### Approved 2026-07-11 Snapshot Receipt

- Manifest: 100 ordered production URIs, epoch 2, publication run `96698b9f-8933-4d54-b011-0c861ce898b3`.
- Release-bundle digest: `b4d0eb29dd456c881e118ebe53051bb75c3b5f810ac8e9de7badcd09913d49b5`; this binds the ordered entries, reviewed CIDs, per-post frozen score lineage and ranking inputs, provenance, frozen signal/topic policies, publication policy, and review metadata.
- Baseline-order digest: `4fcc78007cf74389074df54aa809e70836e921f5d7573720dbb4a48478bb4be1`; this separately fingerprints the ordered rank/URI cohort and remains stable when only publication scores or frozen inputs change.
- Production score receipt: 100/100 source entries carry complete five-component decompositions and their own score-run IDs.
- Eligibility: 74 public posts passed current AppView visibility and deterministic reviewer-safety gates; 26 source positions were withheld. Hidden records expose no text, identity, media, quote, or source URL.
- Language: 85.1 percent English-tagged. The remaining tags were 7 undetermined, 1 Catalan, 1 German, 1 Spanish, 1 French, and 1 Japanese; non-English posts remain labeled in the UI.
- Media: 40.5 percent of displayable posts include an image, external card, or quoted-post summary.
- Authorship: 68 unique authors; top-author concentration 2.7 percent.
- Manual review: every one of the 74 displayable posts was inspected and bound to its immutable record CID. The CID-binding recapture retained 73 source-identical records and introduced one benign replacement, which was reviewed before approval. Two unsafe display/text results identified by the prior full review remain deterministically excluded.
- Reviewed at: `2026-07-12T06:02:16.144Z`.

## Bluesky Public View

AppView hydration supports image galleries with alt text/aspect ratios, external cards, quoted-post summaries, record-with-media combinations, and non-autoplay video posters. `!no-unauthenticated`, `!hide`, takedown, adult-only, malformed, deleted, unavailable, missing-text, reviewer-safety language results, CID changes, and records withheld at review time are withheld. Recursive labels and the reviewed CID are evaluated before text, identity, nested quote, or media fields are exposed. Feed and withheld rows, receipts, and generated keyword suggestions revalidate current public display eligibility on each response, including shared-corpus reuse and idempotent mutation replay. Current AppView metadata and positive local deletion/denial evidence control disclosure; lookup failures withhold content. Route B reads the retained legacy posts table: a retained row must be uniquely live and match the reviewed CID; deleted, changed-CID or ambiguous retained state withholds display. An absent retained row is not treated as deletion when exact approved snapshot provenance and fresh matching-CID AppView visibility are established. No lifecycle-version table or missing-table fallback is used. This observes those authorities at request time and does not promise instantaneous global propagation.

Frozen cohort membership, scores, rank slots, policy-rule inputs, provenance and movement remain unchanged by display validation. Ranking is computed first; a currently ineligible post becomes a content-free hidden slot without compacting ranks. Historical corpus-health counts describe capture eligibility, not a fresh display count. Historical user-entered ballots remain unchanged; only generated keyword suggestions use current permitted display. Synthetic fixture mode stays explicit and offline. Demo responses use `Cache-Control: no-store`.

Every public row has separate **Inspect ranking** and **Open on Bluesky** actions. Hidden rows expose no text, identity, thumbnail, quote, or source URL.

## Isolation And Recovery

Demo state is Redis-only under `demo:session:*`, duplicate-creation-nonce mappings under `demo:session-nonce:*`, `demo:sessions:*`, `demo:corpus:*`, versioned shared-corpus keys under `demo:corpus:current:v4:*`, `demo:idempotency:*`, `demo:lock:*`, `demo:staging:*`, and `demo:rate-limit:*`. It uses the dedicated localhost-only demo Redis on port 6381 with 64 MB, `noeviction`, no persistence, and a 96 MB container limit.

Reusing a creation nonce returns an explicit, non-retryable HTTP 409 conflict and never reveals an existing session ID. Recovery uses only an already-known session ID; it does not make creation-nonce replay safe.

The demo never writes `governance_votes`, `governance_epochs`, `governance_audit_log`, `feed:current`, production snapshots, or research exports. Session mutations use a 15-second ownership token and an ownership-checked atomic Redis commit. Ambiguous client failures reconcile with `GET session`.

## Release Stop

PROJ-1753's CSP/304 blank-page defect is a hard prerequisite. v4 must not deploy until fresh-load and revalidation smoke tests pass. Commit, merge, and deploy remain separate approval gates.
