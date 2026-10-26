JudgeYou burst and soak follow-up, 2026-10-26.

These tests repeat the independent HTTPS/HTTP2 workload from the
[previous investigation](concurrency.md), using release `d05c8b7`. They use an
isolated copy of Node 22.23.4 and Caddy 2.11.7, a dummy key, no production data,
no published ports and no external network. No paid model calls were made.
The load generator is k6 1.3.0. Each page establishes a fresh TCP/TLS connection
and downloads the same conservative 26-resource graph in six-asset batches.
TLS resumption is allowed. Browser execution, rendering and internet latency
are excluded.

The origin stack shares one CPU; the generator has another CPU and 1 GiB.
These are container quotas on the existing shared host, not exclusive CPUs.
Production has no matching Docker memory cap. Each case uses a fresh origin
and one warm-up page. There is only one completed run of each case.

| Workload | Origin memory budget | Successful pages | Successful-download p95 |
| --- | ---: | ---: | ---: |
| 300 page workflows starting within 128 ms | 512 MiB | 300/300 | 8.95 s |
| 1,000 page workflows starting within 399 ms | 512 MiB | 0/1,000 | None |
| 1,000 page workflows together | 1 GiB | Interrupted by host guard | Inconclusive |
| 1,000 arrivals/minute for three minutes | 512 MiB | 3,000/3,000 | 38 ms, loopback |

The 300-page case returned all 7,800 requests with HTTP 200 and HTTP/2, but
missed the test's five-second diagnostic threshold and the earlier two-second
goal. This is a different workload from the shared-process HTTP/1 benchmark;
the 8.95 s must not be presented as an application regression against its
roughly five-second result. Origin CPU use was close to its one-CPU quota.

The 1,000-page/512-MiB case reproduced the memory failure. Docker recorded
`OOMKilled=true`, and the kernel identified Node PID 1024422 in the exact
matching test cgroup as the victim. That identifies the killed process, not
which allocations caused the combined stack to exhaust its budget. There
were 1,939 HTTP 200s and 24,061 transport failures. No page finished
successfully, so no successful-load percentile exists. Final cgroup counters
disappeared with the cgroup and are **unavailable**, rather than zero.

The larger-budget burst was stopped when host `MemAvailable` fell to the
one-GiB safety reserve. It had started 1,000 workflows, but has no valid
completion result. Last sampled peaks were about 790 MiB for the origin and
524 MiB for the generator. The generator also runs on this host, so this does
not establish that real visitor traffic would exhaust the production host.
The 2,000-page case was skipped. No further high-memory burst was attempted.

The three-minute paced case returned all 78,000 requests with HTTP 200 and
HTTP/2, with no failed workflows, missed deadlines, dropped arrivals or OOM
events. Maximum successful-download duration was 78 ms. The origin's exact
peak was about 132 MiB. Sampled memory at the end of each minute was about
118, 131 and 131 MiB. Growth slowed substantially by minute three; this short
test cannot rule out a slow leak.

Process samples narrow the next investigation. In the interrupted 1-GiB
burst, Caddy's sampled RSS peak was about 480 MiB and Node's about 118 MiB.
The paced case sampled about 145 MiB and 73 MiB respectively. RSS and cgroup
usage are different measurements, samples can miss peaks, and peaks must not
be added to infer total use. Network buffers, shared pages and file-cache
accounting also matter. A targeted allocation profile is still needed before
prescribing a memory fix or attributing the limit failure to one component.

The result supports paced delivery at this tested rate and budget. It does
not support promising 1,000 instantaneous cold loads. Monitoring is the next
operational step: observe real failures and shared-host pressure before
buying a larger machine or moving JudgeYou. The [monitoring guide](monitoring.md)
defines initial warnings and the decisions they inform. A separate server
would isolate JudgeYou from the other application; the tests do not prove
that it is currently necessary. Neither a frontend framework nor a language
rewrite was compared here.

The experiment checked production container identities, restart counts,
health and both public home pages throughout. A failed health check or less
than one GiB of host available memory stopped the experiment. The first
sequence used 40.04 seconds before cleanup; the lower-memory soak continuation
used 182.59 seconds, within the combined six-minute runner budget. Only owned
containers were removed. Production remained healthy and unchanged.

[Configuration](performance/r4/experiment-config.json),
[completed and interrupted results](performance/r4/outcome.json),
[kernel OOM evidence](performance/r4/kernel-oom.txt),
[final health](performance/r4/final-health.json), and
[reproduction runner](performance/r4/run.py) are retained with compact
resource evidence in [the R4 directory](performance/r4/).
Large console and resource streams use deterministic gzip; the
[archive manifest](performance/r4/archive.json) records both compressed and
original hashes. Decompress those files before running the analyzer.
Full per-request streams are outside Git in
`/tmp/judgeyou-r4-evidence-YAwcdQsA/` and remotely at
`/tmp/judgeyou-r4-isolated-0W1TixAp/`; their hashes are recorded in the result
and archive manifests. No synthetic TLS private key is committed.
