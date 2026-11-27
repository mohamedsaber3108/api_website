# Gateway overhead baseline (PERF-1)

`scripts/gateway-baseline.mjs` measures how much time Wasl adds to one chat completion call. The provider is a local stub, so no real provider is called and no money is spent. It sets no target and has no pass or fail: it exits 0 unless the run itself breaks.

## Run it (local only)

1. Add these to the file your local dev server reads (the same server you use for `scripts/smoke-test.mjs`), then start the server:

```
APP_ENV=development
INFERENCE_ENABLED=true
OPENROUTER_API_KEY=stub-key
SIGNUP_BONUS_USD=100
OPENROUTER_BASE_URL=http://127.0.0.1:8801/api/v1
```

`OPENROUTER_BASE_URL` is read only when `APP_ENV=development`. In production it is ignored and the gateway calls OpenRouter.

2. In another terminal:

```
node scripts/gateway-baseline.mjs --base http://127.0.0.1:8799 --n 200 --c 1,10 --delay 50 --out perf.md
```

| option | default | meaning |
|---|---|---|
| `--base` | `http://127.0.0.1:8799` | the local server |
| `--n` | 200 | calls per row |
| `--c` | `1,10` | concurrency levels |
| `--delay` | 50 | stub delay in ms, subtracted from the result |
| `--stub-port` | 8801 | port of the stub; must match `OPENROUTER_BASE_URL` |
| `--model` | `minimax/minimax-m3.1-flash` | model id; the stub puts it in its catalog |
| `--out` | none | also write the table to this file |

Each run signs up one test account (sign-up is limited to 10 per hour per IP) and creates a few API keys. Use a scratch state dir.

## What you get

Rows per concurrency: `health`, `invalid`, `chat`, `stream`. Columns: p50, p95, p99, max overhead in ms, errors, first byte (stream), requests per second. A second table splits the median: HTTP floor, then key check + rate limit + body check (`invalid` minus `health`), then catalog, credit hold, limits, provider call and settle (`chat` minus `invalid`). It is a difference of medians, not a trace.

## Limits

- Client, stub and server share one machine and its CPU. Numbers are for comparing runs on the same machine, not for production sizing.
- It uses the dev runtime, like production does today (see `OPS-2`), but not the production disk or network.
- The database is a local file, so remote D1 latency is not measured.
- The test for the percentile helper is `tests/perf-stats.test.ts`. The script itself is not covered by tests.
