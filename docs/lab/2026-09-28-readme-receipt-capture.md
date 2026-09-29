# 2026-09-28 README Receipt Capture

Status: PROJ-2285 README receipt evidence
Collected: 2026-09-28T23:09:44Z
Environment: live production, `https://feed.corgi.network`
Repo base: `origin/main` at `4deb5d702b67d293e16fef9ec23a1ef11e695346`
Admin scope: public endpoints only; no admin cookies, bearer tokens, database credentials, or export secrets used
Public redaction boundary: this tracked record keeps numeric receipt values, endpoint provenance, timestamps, and ranks. It redacts the raw DID, AT-URI, author handle, and post text of the example post.

This is the source for the "A real receipt" table in `README.md`. The README rounds these values to four decimal places, and weights to two.

## Receipt Commands

```bash
curl -sS 'https://feed.corgi.network/api/transparency/feed-snapshot?limit=5'
curl -sS 'https://feed.corgi.network/api/transparency/post/<redacted-production-receipt-uri>'
```

The example is the first ranked item in the feed snapshot, and the second command fetches its receipt.

## Receipt Fields

| Field | Value |
|---|---:|
| Epoch | `2` |
| Rank | `1` |
| Rank scope | `published_snapshot` |
| Publication snapshot | `7df4337f8d17928d75792388872036071eec2fd4839f44261162abfcec647dab` |
| Snapshot published at | `2026-09-28T23:08:41.211Z` |
| Published entries | `1000` |
| Scored at | `2026-09-28T23:03:02.805Z` |
| Classification method | `keyword` |
| Total score | `0.8631218833529014` |
| Pure-engagement rank | `41` |
| Community-governed rank | `1` |
| Governance difference | `+40` positions |

## Component Breakdown

| Component | Raw | Weight | Weighted |
|---|---:|---:|---:|
| Recency | `0.9163078048436797` | `0.25` | `0.22907695121091992` |
| Engagement | `0.8735990240375818` | `0.2` | `0.17471980480751637` |
| Bridging | `0.968251273344652` | `0.1` | `0.0968251273344652` |
| Source diversity | `1` | `0.1` | `0.1` |
| Relevance | `0.75` | `0.35` | `0.26249999999999996` |

Weighted values are reproduced exactly as the API returned them, including floating-point representation.

## Scope And Caveats

- The pure-engagement rank ranks only the entries of the published snapshot, ordered by engagement raw score. It does not rank every scored post. `feed-publication.ts` validates that `engagement_only_position` covers exactly `1..entries.length` of the published artifact.
- `Published entries` is the snapshot's `total_published_items`. It comes from the feed-snapshot response fetched at the same time. That response's first ranked item had `ranked_position` `1`, `engagement_only_position` `41`, `final_score` `0.8631218833529014`, and `publication_adjustment` `1`, which match this receipt.
- The live feed reranks continuously. These values describe this capture only; a later request will return a different #1 post.
