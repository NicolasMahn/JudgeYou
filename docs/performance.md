This is the historical first-pass report. See the [static-delivery follow-up](performance-r2.md)
for the later build and repeated same-host comparison.

JudgeYou performance and capacity, measured on 2026-10-26 (Europe/Berlin).
Baseline: `7be5fb17f5ed`. Raw results include UTC timestamps and the exact
workload configuration: [baseline](performance/baseline.jsonl),
[updated production configuration](performance/production.jsonl),
[eight-person judgments](performance/group.jsonl).

There is no single concurrent-user ceiling. People keeping a page open create
little server work. Fresh page downloads, judgments, and screenshot uploads
have different costs. These measurements establish a starting operating range,
not a guaranteed maximum or a long-running production capacity test.

| Work | Current setting or measured behavior |
| --- | --- |
| People opening the page together | 32 synthetic cold-load clients: p95 0.88 s; 100: 3.58 s; 300: 9.43 s. All updated workflows completed. |
| Active judgments | Configured cap: 32 per process. With a 500 ms fake model and real sealed journal, 32 clients completed without refusals, p95 0.82 s. |
| Active screenshot requests | Configured cap: 4 per process, including uploads. Tested with a tiny synthetic image; full-size image/provider capacity is unmeasured. |
| Requests per visitor | 20/hour for each model endpoint. A visitor is an IP, so people sharing Wi-Fi share this allowance. |
| Requests across all visitors | 1,000/day for each model endpoint. A screenshot workflow can consume both allowances. |
| Excess model concurrency | Immediate 503 + Retry-After; no waiting queue and no allowance consumed. |
| Expired allowance | 429 + Retry-After. Failed upstream attempts consume an allowance. |

A conservative starting target from this test is roughly 30 simultaneous fresh
page loads if the aim is a p95 under one second **in this workload**. A burst of
100–300 can finish, but page delivery becomes slow. Do not interpret this as a
cap on 30 people browsing the site, or extrapolate it to thousands of active
users. Network speed, device speed, traffic mix, provider capacity, and the
other application sharing the machine matter.

The test ran on the actual Hetzner host (2 ARM vCPUs, approximately 4 GB RAM),
in a disposable container constrained to **1 CPU and 512 MB RAM**. It had no
external network access, no production database, and no production API key.
Server and load generator shared one Node v22.23.4 process. The container's
observed peak RSS across the updated suite was about 150 MB. Production
traffic did not reach the test listener; production data and configuration
were not mounted in it.

Each level ran a 0.25 s warmup and a 2 s admission window, followed by draining
outstanding requests. These are closed-loop clients continuously opening
another page after the previous one finishes, without human think time.
A page workflow downloads HTML plus its static import/CSS/font graph and all
12 mascots, six asset requests at a time. This deliberately fetches all declared
font subsets, including ones a real browser may skip. It does not execute JS,
run TLS, emulate mobile networking, or request later lazy imports. Assets were
primed in the server before timing. The baseline loads 58 requests per
workflow; the updated version loads 49. This measures warm-server delivery to
fresh clients, not first-request compression startup.

| Concurrent cold-load clients | Baseline p95 workflow | Updated p95 workflow | Baseline failed workflows | Updated failed workflows |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 0.095 s | 0.070 s | 0% | 0% |
| 10 | 0.792 s | 0.340 s | 0% | 0% |
| 32 | 1.532 s | 0.877 s | 0% | 0% |
| 100 | 4.665 s | 3.578 s | 0% | 0% |
| 300 | 15.000 s (timeout) | 9.429 s | 35.7% | 0% |

Conditional asset requests in the updated version returned 304 with no body;
300 such clients had p95 166 ms per asset, versus 304 ms and full-body 200s
before. This is per-asset latency, not a repeat-page loading time.

The judgment workload sends a 64 KiB request with 16 questions for two people
and a 3 KiB structured response. It scrubs, encrypts, and writes every admitted
judgment into disposable SQLite WAL storage, then verifies decryption. A
second fixture covers eight people and 57 questions in an approximately 82 KiB
request. Both upstream paths use a fixed 500 ms fake model delay. Hourly/daily
quotas are bypassed during load testing; concurrency gates are active. At
100–300 model clients, 503 refusals are expected and reported separately from
successful response latency. These synthetic refusal loops do not honor
Retry-After and are intentionally harsher than normal browser traffic.

Actual production history before these changes contained only 10 successful
judgments: model round-trip mean 491 ms, range 242–694 ms. That small sample
cannot establish upstream capacity. The authenticated OpenRouter key metadata
reports a paid key and no per-key credit cap; its legacy rate_limit field is
deprecated and does not establish a concurrency limit. Provider availability,
credits and in-flight budgets still apply, as described in
[OpenRouter's official limits documentation](https://openrouter.ai/docs/api_reference/limits).
No paid model load test was run.

Browser checks on local loopback Chromium, English, 1440×900, found:

- Initial HTML/CSS/JS transfer: 213,165 → 56,735 bytes, about 73% less. This
  excludes images and fonts; it is not a 73% reduction of the whole page.
- Startup JavaScript modules: 22 → 17. Unused locales, sample answers and
  share-card code now load on demand.
- Cold font transfer: 438,828 → 346,804 bytes, by sharing byte-identical font
  URLs. Screenshots before and after the font change matched exactly.
- A repeat load transferred about 6 KiB of HTML/CSS/JS validation overhead;
  fonts came from browser cache.
- A stored sample verdict appeared in roughly 20–50 ms, instead of the
  previous artificial 1.4–5 s delay. Real judgments no longer wait for a
  minimum 1.8 s animation.
- A 50,000-message fixture parsed in 121 ms versus 221 ms in the local
  comparison. This remains main-thread work; edits over 100,000 characters
  are coalesced over 150 ms so rapid edits do not repeatedly parse the export.

The private `/admin` page changes allowances, concurrent requests and timeout
without restarting. Settings persist on the data volume. Allowance counters
are still process-local and reset on restart. Do not add backend replicas yet:
that would multiply the budgets and create divergent settings and journals.

For larger traffic, put static delivery behind a CDN first, fingerprint asset
URLs so updates can use long immutable browser caching, and then measure the
actual visitor mix. Before multiple backend replicas, move admission/budget
counters and settings into shared storage and use a database strategy shared
by all instances. Only introduce workers for journal/parse work if profiling
shows it is the next bottleneck. Keep the design simple and measure the change.

Reproduce on a disposable checkout with Node 22+:

```sh
NODE_ENV=production npm run benchmark -- --duration 2 --warmup 0.25 \
  --levels 1,10,32,100,300 --model-latency 500 --journal sealed

APP_MODULE=/path/to/baseline/server/server.js NODE_ENV=production \
  npm run benchmark -- --duration 2 --warmup 0.25 \
  --levels 1,10,32,100,300 --model-latency 500 --journal sealed

NODE_ENV=production npm run benchmark -- --duration 2 --warmup 0.25 \
  --levels 4,32 --scenarios model,screenshots --model-latency 500 \
  --subjects 8 --body-bytes 82452 --journal sealed
```

Use `node scripts/benchmark.js --help` for budgets and fixture options. The
harness disables external fetch, injects fake models and creates/deletes its
own temporary database. Short burst measurements should be followed by longer
staging and provider tests before advertising production concurrency guarantees.
