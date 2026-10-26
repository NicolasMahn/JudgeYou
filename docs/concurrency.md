JudgeYou concurrency investigation, 2026-10-26.

The [burst and three-minute soak follow-up](concurrency-r4.md) adds process
memory evidence and a guarded higher-memory attempt. The
[monitoring guide](monitoring.md) describes failure and recovery alerts.

The earlier five-second figure is the p95 completion time of a synthetic
all-assets HTTP download. It is not browser rendering time, not the time spent
in the model, and not a count of supported people. The generator and server
shared one CPU. A further test with a separate server CPU still saturated the
Node HTTP generator. These results cannot establish an origin capacity ceiling.
The [earlier report](performance-r2.md) remains available with its original data.

This investigation uses application `d05c8b7`, the current release when the
snapshot was taken, and Node 22.23.4 on the same existing Hetzner ARM64 host.
No production listener was load-tested. No production data or credentials were
mounted into test containers. Upstream responses were fake. No application,
proxy, DNS, account, or infrastructure configuration was changed.

The conservative page graph has 26 resources and 1,123,280 response-body bytes.
It includes every CSS font subset, even unused ones. A workflow fetches HTML,
then six assets at a time, without executing JavaScript. Selected dynamic
locales and service-worker registration are excluded. The server cache is warm;
requests are unconditional GETs. The driver uses HTTP/1 and a shared pool capped
at 1,800 sockets, retaining at most 300 idle sockets across all virtual clients.
This differs from real browser connections to the live HTTPS/HTTP2 proxy.

All main runs share a combined **one CPU and 512 MiB**, with swap disabled and
external networking unavailable. Burst phases admit work for two seconds after
a 0.25-second warmup, then drain admitted workflows with a 15-second absolute
workflow deadline. Clients repeat workflows until admission closes. Paced runs
schedule one workflow per client across 60 seconds with no warmup. These are
short experiments, not sustained production guarantees.

| Synthetic full-page clients | p95 workflow | Failed workflows |
| ---: | ---: | ---: |
| 300, simultaneous closed-loop clients | 5.352 s | 0% |
| 1,000, simultaneous closed-loop clients | 14.323 s | 0% |
| 2,000, simultaneous closed-loop clients | At least 15 s, deadline reached | 54.25% |
| 1,000 one-shot workflows scheduled across 60 s | 0.019 s | 0% |

The paced run admitted and completed all 1,000 workflows, with at most three
active at once. This is about 16.7 arrivals/second. Its 19 ms p95 is a loopback
download result with a shared connection pool, not a user-visible page load.
Only 12 new sockets were assigned during the paced measurement; connections
were reused across virtual visitors. It therefore does not test 1,000 fresh
browser TCP/TLS sessions. Scheduling lateness was not separately instrumented.
All 1,000 scheduled workflows were admitted inside the minute, but the latency
clock begins at actual admission rather than the intended scheduled time.

Raw results: [burst](performance/r3/high-shared.jsonl),
[paced static delivery](performance/r3/ramp-1000.jsonl).

The new timing histograms show where the driver's time is observed. At 300
full-page clients, new-socket response-header p95 was 4.714 s (1,500 samples),
versus 0.373 s on reused sockets; body-read p95 was 0.3 ms. These are different
sample populations and percentiles cannot be added or subtracted. Response-header
latency includes socket assignment, connect, server admission and scheduling.
Small body-read time does not prove that bytes are free: earlier writes and
client CPU work also sit elsewhere in the pipeline. Under overload, timing
histograms omit events that never happen, so workflow failures and sample
counts must accompany their percentiles. Values above the 15-second histogram
range are censored; exact maxima remain in the raw files.

Separating Node server and generator into processes inside the same combined
one-CPU/512-MiB container did not improve full-page delivery: 300-client p95
was 6.885 s, and at 1,000 clients 16.9% of workflows hit the deadline. This
changes scheduling and adds probe overhead, so it is not an isolated language
comparison. The complete run consumed about 131.7 CPU-seconds; the instrumented
server process consumed about 40.2 CPU-seconds, with the remaining budget spent
on the generator and other test setup. No OOM kill occurred.

The separate diagnostic gave the server **one CPU/512 MiB** and the generator
**another CPU/512 MiB**, sharing an otherwise isolated network namespace. This
is a larger total budget and must not replace the original comparison. At
1,000 full-page clients, p95 was still 14.274 s, while the generator consumed
14.270 CPU-seconds over a 14.284-second measured phase. Its single CPU was
saturated. At 300 clients the diagnostic p95 was 4.782 s. These observations
show a generator bottleneck; they do not establish that the origin is unlimited
or rank Go against Node.

The probes recorded zero listen overflows, listen drops and TCP timeout counter
increments in these ARM runs. Retransmits observed in a separate local x86
review are not established as the cause of the ARM result. Probe response
percentiles cover readiness, priming, warmup, measurement and drain, and count
premature closes; they must not be interpreted as successful measured-phase
client delivery latency.

Raw diagnostic evidence: [same-budget split](performance/r3/high-split.jsonl),
[split server samples](performance/r3/high-split.server.jsonl),
[separate CPU budgets](performance/r3/isolated-cpu.jsonl),
[separate-budget server samples](performance/r3/isolated-cpu.server.jsonl).

An independent k6 1.3.0 run used an isolated copy of Caddy 2.11.7 in front of
Node, with HTTP/2, TLS 1.3 and Brotli confirmed. Server/proxy together had one
CPU/512 MiB; the generator had another CPU/1 GiB. This larger combined budget
is not comparable to the original one-CPU rig. The full manifest graph and
six-asset batches were retained. Each workflow established a fresh TCP/TLS
connection, reusing it within the page; TLS session resumption was not disabled.
The official ARM64 binary checksum was verified. No host ports were published.

| Independent HTTPS/HTTP2 case | Successful workflows | Whole-download p95 |
| --- | ---: | ---: |
| 1,000 workflows starting within 0.420 s | 0/1,000 | No successful-delivery percentile |
| About 1,000/minute, scheduled arrivals | 1,001/1,001 | 45 ms, loopback only |

The burst crossed the origin stack's 512 MiB cgroup memory limit and caused
one child-process OOM kill. Only 2,059 of 26,000 attempted HTTP requests returned
200. Its roughly 13-second failed-workflow p95 must not be presented as a page
load time. Node remained running, so Docker's PID1 OOM flag alone would have
missed the child failure; the cgroup OOM counter establishes it. This test does
not isolate which component's allocations caused the stack to exceed its budget.

The paced result used a fresh restarted origin after the failed burst. It
completed 26,026 HTTP requests with status 200 and HTTP/2, zero dropped
iterations and zero workflow failures. The scheduler emitted one boundary
iteration, giving 1,001 workflows in a minute. Maximum workflow duration was
87 ms. Origin peak memory was about 134 MiB; the generator's sampled peak was
about 100 MiB, with no sampled CPU throttling. This is an encouraging delivery
result for that arrival pattern. It excludes internet latency, device speed,
HTML discovery, JavaScript execution and browser LCP. Only one valid measured
run of each independent case was performed; there is no 2,000-visitor HTTP2
capacity claim.

The 512 MiB budget is deliberately constrained, not the production memory cap.
Read-only inspection found no Docker CPU/memory ceiling on the live JudgeYou or
Caddy containers; they share the existing two-vCPU, roughly 4-GB host with the
other application. Neither the low-budget OOM nor the host's larger memory
establishes production burst capacity. A matching-budget staging acceptance
run is still needed before promising 1,000 simultaneous fresh visitors.

[Independent report](performance/r3/http2/REPORT.txt),
[results](performance/r3/http2/outcome.json),
[k6 workload](performance/r3/http2/load.js),
[proxy configuration](performance/r3/http2/Caddyfile), and
[resource samples](performance/r3/http2/paced.resources.jsonl) are archived.
Full per-request streams remain in the local evidence directory, with their
[checksums](performance/r3/http2/raw-streams.json). An initial paced attempt
against the burst-damaged origin was stopped and excluded; its stream is
retained separately. No synthetic private certificate or key is committed.

Model work has a different limit from page delivery. The actual dashboard
settings were 32 active judgments, four active screenshot requests, 20 requests
per IP per hour, and 1,000/day per endpoint, with a 30-second timeout. Shared
Wi-Fi shares the hourly allowance. Everyone judging once can consume an entire
default daily budget of 1,000; this is a spending policy, not a visitor ceiling.
The fake-model tests bypass allowances while leaving concurrency gates enabled.

| Model experiment | Successful | Busy (503) | Successful-response p95 |
| --- | ---: | ---: | ---: |
| 1,000 judgment attempts together, 500 ms fake model | 101 | 899 | 3.681 s |
| 1,000 tiny-image attempts together, 500 ms fake transcription | 8 | 992 | 1.286 s |
| 1,000 judgments scheduled over a minute, 500 ms fake model | 1,000 | 0 | 0.518 s |
| 1,000 judgments scheduled over a minute, 5 s fake model | 384 | 616 | 5.018 s |

Busy responses are deliberate admission refusals, not process crashes. They
are not counted as successful throughput. Successful judgment attempts scrubbed,
encrypted and wrote representative 64 KiB requests into disposable SQLite;
sealing and row counts were verified. Screenshot inputs were tiny synthetic
images and do not establish full-sized screenshot capacity.

For planning, average active work is approximately arrival rate multiplied by
average service duration. At 1,000 judgment attempts/minute, 500 ms means about
8.3 calls in flight; two seconds means 33.3, and five seconds means 83.3. The
32-call cap fits the first arithmetic example but not the latter two, before
adding headroom. Raising it requires provider and cost validation, not merely
a faster programming language. The generator's peak-active workflow count
includes fast refusals and is not a measurement of admitted model concurrency.

A read-only aggregate of 21 stored successful production timings had mean
429 ms, p95 684 ms and range 242–694 ms for the model round-trip. No chat bodies
were inspected. This small historical sample excludes upload, journaling and
rendering and does not establish provider concurrency or future latency.
No paid upstream load test was performed.

Raw model results: [instant burst](performance/r3/model-burst.jsonl),
[500 ms paced model](performance/r3/model-paced.jsonl),
[five-second paced model](performance/r3/model-paced-slow.jsonl).

Keep the current JavaScript application while measuring the actual limiting
layer. A frontend framework would not remove the measured HTTP workload, and
this test does not execute frontend JavaScript at all. Go is a backend language,
not a frontend framework; a Go rewrite has not been benchmarked here. The earlier
Caddy prototype sharing CPU with the generator cannot settle that comparison.
The existing HTTPS proxy, Caddy, is itself written in Go.

Before promising an instantaneous 1,000-visitor burst, profile the combined
proxy/backend memory failure and evaluate bounded proxy upstream concurrency
and direct static delivery through Caddy or a CDN. Keep model requests on the
existing tested gateway. This is a targeted delivery and resource-budget change,
not evidence for a full application rewrite.

The next useful product measurement is real-browser Largest Contentful Paint
and interaction responsiveness across devices and networks, together with
HTTP2 arrival-rate testing. Google's recommended LCP target is at most 2.5 s
for 75% of visits; an asset-workflow p95 is a different metric. The next delivery
changes to evaluate are smaller strip thumbnails and serving static assets
through the existing Caddy file server or a CDN. Existing hashes and immutable
cache headers support that route. Resizing images needs appearance checks;
the current sprite preserves the original image bytes.

A CDN rollout must keep API/admin responses out of public caches and preserve
verified client IP forwarding. The current backend takes the last forwarded
address; adding a proxy without configuring the trust chain could make many
visitors share an allowance. No CDN account, DNS change, replica, worker or
second application runtime was introduced. Backend replicas still require
shared allowances, admission/settings and journal storage.

The investigation used a Codex test/review agent and an independent Claude
Fable architecture review through the subscription. No OpenRouter consultant
or paid API load was used. Review suggestions were checked against the ARM
measurements rather than treating local x86 behavior as portable capacity.

Reproduce the main experiment with Node 22+, a disposable current-release
checkout with `npm ci && npm run build`, and the extended harness:

```sh
NODE_ENV=production node scripts/benchmark.js --public-dir dist \
  --scenarios page,ready --levels 300,1000,2000 --duration 2 --warmup 0.25 \
  --timing true

NODE_ENV=production node scripts/benchmark.js --public-dir dist \
  --scenarios page --levels 1000 --duration 60 --warmup 0 --ramp 60 \
  --iterations-per-client 1 --timing true

NODE_ENV=production node scripts/benchmark.js --public-dir dist \
  --scenarios model --levels 1000 --duration 60 --warmup 0 --ramp 60 \
  --iterations-per-client 1 --model-latency 500 --journal sealed --timing true
```

These commands alone do not enforce resources. The recorded main containers
use `--cpus 1 --memory 512m --memory-swap 512m --network none`. Split server
and generator share that same container. The separate-CPU diagnostic instead
uses two such containers in one isolated network namespace. Source version,
image digest, settings and harness checksum are in [provenance](performance/r3/provenance.json).
Archived [probe](performance/r3/probe-server.mjs) and [runner](performance/r3/run-case.sh)
expect a disposable benchmark root containing the source checkout as `source/`;
copy the probe there as `judgeyou-r3-probe-server.mjs`. Never mount production
data or credentials. No production listener should be used for this workload.

Primary references: [load models](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/),
[Node event-loop work](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop),
[optimizing LCP](https://web.dev/articles/optimize-lcp),
[Caddy architecture](https://caddyserver.com/docs/architecture),
[CDN origin cache controls](https://developers.cloudflare.com/cache/concepts/cache-control/).
