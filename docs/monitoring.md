JudgeYou monitoring and upgrade decisions, 2026-10-26.

The monitor is deliberately separate from the web process. A failed or
memory-starved JudgeYou process must not be responsible for sending its own
failure alert. It reads only aggregate operational information, never chats,
names, screenshots, request headers or journal rows. It does not call a model.

Every minute, the host monitor checks the public HTTPS page, the JudgeYou
container, its cgroup OOM counters, host available memory, CPU and disk space.
The private `GET /api/admin/health` endpoint supplies five-minute request,
failure, capacity and allowance summaries. It requires the existing admin
token and disables caching. The collector uses that token inside the container;
it does not put the value into command arguments or notification payloads.

Health counters live only in memory. They reset on a new process, identified by
a fresh `bootId`. Route names and counters have a fixed bound; arbitrary URLs,
client addresses, exception messages and individual request samples are not
retained. Successful API latency is a histogram upper bound, not an exact
percentile. Requests that disconnect before completion are counted separately
from completed HTTP responses.

Availability and user-facing failures deserve attention before CPU alone. The
initial resource thresholds are warnings for investigation, not commands to
buy a bigger server. Repeated failures produce reminders, and recovery produces
a separate message. Notification delivery failures remain pending for retry.
The monitor never changes settings, restarts services, upgrades a machine or
moves data automatically.

The initial checks are:

| Condition | Alert after |
| --- | --- |
| Public page, container or private health unavailable | Two consecutive checks |
| Container restart or an increase in cgroup OOM events | One observed transition, after the first baseline |
| Host available memory below 15% | Three consecutive checks |
| Host filesystem at least 90% full | Three consecutive checks |
| Host CPU at least 85% busy | Five consecutive checks |
| Busy model responses | At least three in the five-minute window |
| API or provider failures | At least three and at least 5% of API attempts in the five-minute window |
| Daily allowance used or paused | At least 90% of either endpoint's allowance, or an allowance set to zero |

Recovery normally requires two healthy checks. Repeated active incidents get
a reminder every 30 minutes. Container replacement during a planned deployment
is also visible as a restart; that warning alone is not an outage.
Missing evidence cannot establish recovery. A failed notification remains
pending even if a brief incident clears before delivery returns; that alert
then explicitly says it has already resolved. Email subjects distinguish
critical incidents, warnings, recovery and test delivery.

The notification destination is intentionally not a public dashboard setting.
Keep its credentials in a root-owned mode-0600 JSON file at
`/etc/judgeyou-monitor/config.json`. A single HTTPS webhook receives the
versioned JSON alert batch. Optional `webhook.bearer_token` authenticates it;
redirects are rejected. Alternatively replace `webhook` with:

```json
{
  "smtp": {
    "host": "smtp.example.invalid",
    "port": 587,
    "mode": "starttls",
    "sender": "monitor@example.invalid",
    "recipients": ["owner@example.invalid"],
    "username": "monitor@example.invalid",
    "password": "replace privately"
  }
}
```

SMTP also supports `mode: "ssl"` and port 465. TLS certificate verification is
required. Do not put delivery credentials in Git, command arguments or chat.
Exactly one destination is configured. The example domains are placeholders;
copying the example does not activate working notifications.

After deploying the matching application and choosing a real destination:

```sh
sudo install -d -m 0700 /etc/judgeyou-monitor
sudo install -m 0600 ops/monitor.example.json /etc/judgeyou-monitor/config.json
sudoedit /etc/judgeyou-monitor/config.json
sudo python3 ops/monitor.py --dry-run
sudo python3 ops/monitor.py --test-notification
# Confirm receipt before enabling recurring delivery.
sudo install -m 0644 ops/judgeyou-monitor.service ops/judgeyou-monitor.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now judgeyou-monitor.timer
sudo systemctl start judgeyou-monitor.service
sudo journalctl -u judgeyou-monitor.service -n 10 --no-pager
```

The service runs the script at `/opt/judgeyou/ops/monitor.py`. Python 3 and the
Docker CLI are the only host dependencies. Docker and host cgroup access require
root; the unit restricts filesystem writes to `/var/lib/judgeyou-monitor`.
Its state is atomic, mode 0600, and locked against overlapping runs. A dry run
does not send notifications or advance state. Test delivery is explicitly
separate from a healthy scrape. Stop recurring checks with
`sudo systemctl disable --now judgeyou-monitor.timer`; this leaves the app and
its journal untouched.

Run `npm run test:monitor` for the Python regression tests and `npm test` for
the application tests. Delivery tests use fakes and do not send real messages.
The [validation record](monitoring-validation.json) also records a real host
collector dry run against a disposable container running the new private health
endpoint. A Docker-name shim directed the collector to that container; no
production container was stopped or replaced. All four collectors answered,
the container was removed, and no notification was sent. Real destination
receipt remains a separate activation check.

The host monitor cannot report a completely unreachable host or an outage of
its own network. A separate external uptime check and an independent delivery
channel are still required for that failure mode. Running another container on
the same host does not provide that independence. A synthetic HTTPS check also
does not establish browser rendering speed or upstream model health.

Use these signals to decide the next action:

| Signal | Check before changing the server |
| --- | --- |
| Busy judgment or screenshot responses | Endpoint concurrency, actual model duration and provider allowance; a bigger machine does not raise these limits. |
| Daily allowance nearing exhaustion | Expected paid usage and the budget in `/admin`; this is a spending policy. |
| API timeouts or upstream failures with host headroom | Provider response times and availability, plus request size. |
| OOM events or sustained low host memory | Which process grew, concurrent connections and responses, and pressure from the other application. |
| Sustained CPU pressure with failed or slow requests | Attribute CPU to JudgeYou, Caddy and the other application; compare against representative load. |
| Public page down while the app answers locally | Proxy, TLS, DNS and network path. |
| Increasing disk use | Journal growth and asset retention; preserve kept chats and backups before changing storage. |

Moving JudgeYou to its own server gives it an independent resource budget and
reduces the effect of failures in the other application. Increasing the shared
server is simpler operationally, but retains that coupling. Neither option
establishes a visitor capacity without repeating the workload at the intended
budget. Migration must preserve the journal, sealing key relationship, private
settings and old public assets. A DNS cutover needs explicit approval and a
rollback plan. No new server or account is provisioned by this change.

See the [concurrency investigation](concurrency.md) for the distinction between
simultaneous cold-page bursts, visitors arriving over a minute and simultaneous
paid model work. Alert thresholds are initial operational choices, not a
claim of supported user counts.
