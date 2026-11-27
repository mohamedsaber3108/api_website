export function percentile(values: number[], p: number): number;
export function overheads(totals: number[], delayMs: number): number[];
export function summarize(values: number[]): { p50: number; p95: number; p99: number; max: number };
