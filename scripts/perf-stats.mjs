// Pure helpers for scripts/gateway-baseline.mjs (PERF-1).

/** Nearest-rank percentile (p in 0..100). Does not change the input. Empty input gives NaN. */
export function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** Time spent by Wasl itself: total latency minus the stub's delay, never below 0. */
export function overheads(totals, delayMs) {
  return totals.map(t => Math.max(0, t - delayMs));
}

export function summarize(values) {
  return { p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99), max: percentile(values, 100) };
}
