See the later [concurrency investigation](concurrency.md) for 1,000–2,000-client
experiments, paced arrivals, and load-generator limitations. These figures are
not browser load-time or supported-user guarantees.

JudgeYou static-delivery follow-up, measured on 2026-10-26.

The two-second p95 goal at 300 concurrent fresh-load clients remains unproven.
This follow-up reduces static startup requests, adds a production asset build, and
keeps the existing single backend. No CDN account or additional host was created.
The original [performance report](performance.md) and raw results are retained.

The comparison uses the same Hetzner host, Node 22.23.4, one CPU, 512 MiB, no
external network access, and the same HTTP load generator for both versions.
Server and generator share a process. Each case has a 0.25-second warmup,
a two-second admission window and a drain period. Three old/new pairs run
alternately. This is a short synthetic burst, not a count of supported people.

The old server is `f666693`; the new page uses the audited build manifest.
Both static startup graphs include every CSS font subset, even ones a browser would skip,
and all twelve strip mascots. The new sprite combines those images into one
request without changing their original WebP bytes. HTML plus assets falls from
49 requests to 26. Dynamically selected languages, card and sample modules, and service-worker
registration stay outside this measured graph; a non-English browser also loads
its selected locale during startup. This is not every initial browser request.

`ready` is a separate diagnostic: HTML, startup JavaScript and CSS delivery only.
It excludes fonts, images, JavaScript execution, rendering, TLS and device/network
costs. It must not replace the full-page result when judging the two-second goal.

Full-page workflow p95, median of three runs; parentheses show the run range.
All measured workflows completed in all six runs. Completed pages/second includes
drain time, rather than comparing HTTP request rates across different graphs.

| Concurrent clients | Old p95, seconds | Built p95, seconds | Old → built pages/second |
| ---: | ---: | ---: | ---: |
| 1 | 0.069 (0.068–0.070) | 0.053 (0.051–0.053) | 27.17 → 43.79 |
| 10 | 0.328 (0.310–0.355) | 0.376 (0.213–0.394) | 38.28 → 56.27 |
| 32 | 0.756 (0.741–0.765) | 0.494 (0.472–0.534) | 43.78 → 75.50 |
| 100 | 3.434 (3.433–3.445) | 2.579 (2.566–2.704) | 39.88 → 69.22 |
| 300 | 8.521 (7.917–9.007) | 5.258 (4.992–5.270) | 37.68 → 69.17 |

At 300 clients, median p95 improves by 38.3%, from 8.521 to 5.258 seconds.
The historical 9.429-second result remains in the first report; the alternating
rerun is the fair comparison here. The ten-client p95 regresses from 0.328 to
0.376 seconds while throughput improves: this is not a uniform latency win.
The two-second full-page goal remains unmet.

The diagnostic `ready` median p95 is 0.095 seconds at 32 clients, 0.210 seconds
at 100, and 2.408 seconds at 300. The latter also misses two seconds, and none
of these numbers measures browser interactivity.

Full-page response bodies are 1,110,865 → 1,122,475 bytes/workflow, about 1%
larger. Fewer requests do not mean less total transfer in this all-font workload.
Returning visitors can reuse fingerprinted assets, but these fresh-client runs
do not use that browser cache.

Raw paired runs: [old 1](performance/r2/final-old-1.jsonl),
[new 1](performance/r2/final-new-1.jsonl), [old 2](performance/r2/final-old-2.jsonl),
[new 2](performance/r2/final-new-2.jsonl), [old 3](performance/r2/final-old-3.jsonl),
[new 3](performance/r2/final-new-3.jsonl).
The measured new snapshot is `6e62b8f`; subsequent compatibility work adds
startup asset retention and legacy paths without changing its startup manifest.

The actual browser's initial font bodies shrink from 345,304 to 294,448 bytes
(14.73%). Font requests increase from five to six. All eight desktop/mobile
comparisons across the four current languages matched in pixels and text bounds.
The complete all-subset font corpus grows because hero and body overlap; those
browser savings do not imply a smaller conservative benchmark graph. Future hero
copy changes need another appearance check; see [font reproduction](../fonts/README.md).

The build fingerprints JS, CSS, fonts and the specimen sprite, and precompresses
text assets with Brotli and gzip.
Hashed assets receive one-year immutable browser caching; HTML revalidates.
Production build dependencies stay out of the runtime image. Compatibility and
asset retention are described in the [deployment instructions](../README.md#deploy).

A separate Caddy static-serving prototype inside the same resource budget did
not materially improve the preliminary all-assets tail (about 5.6 seconds), so
it was not added to deployment. Increasing the listen backlog also did not
establish a two-second result. Static-handler micro-optimizations are not the
next supported step from the measured profiles.

Backend operating caps remain 32 active judgments and four active screenshot
requests per process, configurable at `/admin`. They bound admitted work; they
do not establish provider capacity. Existing model benchmarks use stubs, not
paid upstream load. People keeping the page open have no corresponding static
request cost. Multiple backend replicas still require shared quotas, settings,
and a shared journal/database strategy.

Reproduce after `npm ci && npm run build`, in a disposable constrained container:

```sh
NODE_ENV=production node scripts/benchmark.js --public-dir dist \
  --scenarios page,ready --duration 2 --warmup 0.25 --levels 1,10,32,100,300

NODE_ENV=production node scripts/benchmark.js --app /baseline/server/server.js \
  --scenarios page,ready --duration 2 --warmup 0.25 --levels 1,10,32,100,300
```

For the old case, leave `PUBLIC_DIR` unset. Do not benchmark the live production
listener or mount production data. The harness injects fake upstream calls and
disables external fetch. Container CPU and memory constraints must be applied
to the combined server and generator, not separately to each.
