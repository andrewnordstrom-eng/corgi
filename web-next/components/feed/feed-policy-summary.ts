import type { PublicFeedSnapshot } from "@/lib/public-feed"
import { SIGNAL_KEYS, SIGNAL_LABELS } from "@/lib/signals"
import type { SignalKey } from "@/lib/signals"

export interface FeedPolicyWeight {
  readonly key: SignalKey
  readonly label: string
  readonly weight: number
  readonly percent: string
  // Share of the summed weights, for bar widths; robust to weights that do not sum to exactly 1.
  readonly share: number
}

export interface FeedPolicySummary {
  readonly epochId: number
  readonly weights: readonly FeedPolicyWeight[]
  readonly leadingLabels: readonly string[]
  readonly keywordOnly: boolean
}

export function formatPolicyPercent(weight: number): string {
  return `${Math.round(weight * 100)}%`
}

export function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? ""
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`
}

export function summarizeFeedPolicy(snapshot: PublicFeedSnapshot): FeedPolicySummary {
  const total = SIGNAL_KEYS.reduce((sum, key) => sum + Math.max(0, snapshot.active_weights[key]), 0)
  // Canonical signal order, matching every other stacked bar and legend on the site.
  const weights = SIGNAL_KEYS.map((key) => {
    const weight = snapshot.active_weights[key]
    return {
      key,
      label: SIGNAL_LABELS[key],
      weight,
      percent: formatPolicyPercent(weight),
      share: total > 0 ? Math.max(0, weight) / total : 0,
    }
  })
  const topWeight = Math.max(...weights.map((entry) => entry.weight))
  const leadingLabels = weights.filter((entry) => entry.weight === topWeight).map((entry) => entry.label)
  const methods = snapshot.items.flatMap((item) => (
    item.placement !== "withheld" && item.classification_method !== null ? [item.classification_method] : []
  ))
  return {
    epochId: snapshot.epoch_id,
    weights,
    leadingLabels,
    keywordOnly: methods.length > 0 && methods.every((method) => method === "keyword"),
  }
}
