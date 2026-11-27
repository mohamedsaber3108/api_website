import { describe, expect, it } from 'vitest';
import { overheads, percentile, summarize } from '../scripts/perf-stats.mjs';

describe('perf-stats', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  it('uses nearest-rank percentiles', () => {
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile(hundred, 100)).toBe(100);
  });
  it('handles one value, unsorted input and empty input', () => {
    expect(percentile([5], 99)).toBe(5);
    const input = [9, 1, 5];
    expect(percentile(input, 50)).toBe(5);
    expect(input).toEqual([9, 1, 5]); // not changed
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });
  it('subtracts the delay and never goes below zero', () => {
    expect(overheads([60, 49, 80], 50)).toEqual([10, 0, 30]);
  });
  it('summarizes', () => {
    expect(summarize(hundred)).toEqual({ p50: 50, p95: 95, p99: 99, max: 100 });
  });
});
