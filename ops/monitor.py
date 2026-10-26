#!/usr/bin/env python3
"""One bounded, privacy-safe monitoring pass. Python stdlib and Docker CLI only.

classify(snapshot, previous_snapshot) and evolve(state, snapshot, now) are pure.
evolve returns (next_state, due_events); record_delivery acknowledges a successful
send. Never acknowledge a failed send: the next pass retries the current event.
"""

import argparse
import contextlib
import copy
import datetime
import email.message
import fcntl
import json
import math
import os
from pathlib import Path
import selectors
import signal
import smtplib
import ssl
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

MAX_JSON = 65536
MAX_PUBLIC = 2 * 1024 * 1024
MAX_PAYLOAD = 16384
REMINDER_SECONDS = 1800
CONDITIONS = {
    "container_unavailable": (2, "critical"),
    "app_unavailable": (2, "critical"),
    "public_unavailable": (2, "critical"),
    "host_unavailable": (2, "warning"),
    "host_memory": (3, "warning"),
    "host_disk": (3, "warning"),
    "host_cpu": (5, "warning"),
    "container_restart": (1, "warning"),
    "container_oom": (1, "critical"),
    "app_busy": (1, "warning"),
    "api_errors": (1, "warning"),
    "upstream_failures": (1, "warning"),
    "quota_usage": (1, "warning"),
}
DESCRIPTIONS = {
    "container_unavailable": "JudgeYou's container is unavailable",
    "app_unavailable": "JudgeYou's private health check failed",
    "public_unavailable": "The public website is unavailable",
    "host_unavailable": "Host resource checks failed",
    "host_memory": "The shared host is low on available memory",
    "host_disk": "The shared host's disk is nearly full",
    "host_cpu": "The shared host has sustained high CPU use",
    "container_restart": "JudgeYou's container restarted or was replaced",
    "container_oom": "JudgeYou reported an out-of-memory event",
    "app_busy": "Visitors are being refused because the model gateway is busy",
    "api_errors": "JudgeYou API requests are failing",
    "upstream_failures": "The model provider is rejecting or failing requests",
    "quota_usage": "JudgeYou's daily allowance is nearly used or requests are paused",
    "diagnostic": "Test notification",
}


class MonitorError(Exception):
    """Only fixed error codes reach logs; exception messages never do."""


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def fraction(value):
    return value if number(value) and 0 <= value <= 1 else None


def counter(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 2**53 - 1 else None


def boolean(value):
    return value if isinstance(value, bool) else None


def obj(value):
    return value if isinstance(value, dict) else {}


def identifier(value):
    # Docker IDs and Linux boot IDs, never arbitrary strings from app responses.
    return value if isinstance(value, str) and 1 <= len(value) <= 64 and all(c in "0123456789abcdef-" for c in value) else None


def safe_snapshot(raw):
    """Allowlist at every boundary, including fixtures and restored state."""
    raw = obj(raw)
    host, container, app, public = (obj(raw.get(key)) for key in ("host", "container", "app", "public"))
    cpu, events, metrics = obj(host.get("cpu")), obj(container.get("memoryEvents")), obj(app.get("metrics"))
    state = container.get("state")
    return {
        "version": 1,
        "host": {
            "available": boolean(host.get("available")),
            "memoryAvailableFraction": fraction(host.get("memoryAvailableFraction")),
            "diskUsedFraction": fraction(host.get("diskUsedFraction")),
            "cpuUsedFraction": fraction(host.get("cpuUsedFraction")),
            "cpu": {"total": counter(cpu.get("total")), "idle": counter(cpu.get("idle")), "bootId": identifier(cpu.get("bootId"))},
        },
        "container": {
            "available": boolean(container.get("available")),
            "running": boolean(container.get("running")),
            "state": state if state in ("created", "running", "paused", "restarting", "removing", "exited", "dead", "unknown") else "unknown",
            "id": identifier(container.get("id")),
            "restartCount": counter(container.get("restartCount")),
            "oomKilled": boolean(container.get("oomKilled")),
            "memoryEvents": {name: counter(events.get(name)) for name in ("oom", "oom_kill")},
        },
        "app": {
            "available": boolean(app.get("available")),
            "metrics": {key: counter(metrics.get(key)) for key in ("busy", "apiRequests", "api5xx", "upstreamFailures")},
            "usageFraction": fraction(app.get("usageFraction")),
        },
        "public": {"available": boolean(public.get("available"))},
    }


def cpu_fraction(current, previous):
    if not current.get("bootId") or current.get("bootId") != previous.get("bootId"):
        return None
    values = [current.get("total"), previous.get("total"), current.get("idle"), previous.get("idle")]
    if any(counter(value) is None for value in values):
        return None
    total, idle = values[0] - values[1], values[2] - values[3]
    return (total - idle) / total if total > 0 and 0 <= idle <= total else None


def classify(snapshot, previous_snapshot=None):
    """Map sanitized measurements to bad/healthy/unknown underlying conditions."""
    sample, before = safe_snapshot(snapshot), safe_snapshot(previous_snapshot)
    host, container, app = sample["host"], sample["container"], sample["app"]
    old = before["container"]
    metrics = app["metrics"]
    cpu = cpu_fraction(host["cpu"], before["host"]["cpu"])
    if cpu is None:
        cpu = host["cpuUsedFraction"]
    baseline = old["available"] is True and old["id"] is not None
    observed = container["available"] is True and container["id"] is not None
    restarted = None
    oom = None
    if baseline and observed:
        replaced = container["id"] != old["id"]
        if replaced:
            restarted = True
        elif container["restartCount"] is not None and old["restartCount"] is not None:
            restarted = container["restartCount"] > old["restartCount"]
        counters_known = all(container["memoryEvents"][name] is not None and
                             (replaced or old["memoryEvents"][name] is not None)
                             for name in ("oom", "oom_kill"))
        increases = not replaced and any(container["memoryEvents"][name] is not None and
                                         old["memoryEvents"][name] is not None and
                                         container["memoryEvents"][name] > old["memoryEvents"][name]
                                         for name in ("oom", "oom_kill"))
        if increases or (container["oomKilled"] is True and old["oomKilled"] is False):
            oom = True
        elif counters_known and container["oomKilled"] is not None and old["oomKilled"] is not None:
            oom = False
    def unavailable(value):
        return None if value is None else not value
    def threshold(value, limit, below=False):
        return None if value is None else value < limit if below else value >= limit
    api_errors = None
    if metrics["api5xx"] is not None and metrics["apiRequests"] is not None:
        api_errors = metrics["api5xx"] >= 3 and metrics["api5xx"] >= metrics["apiRequests"] * 0.05
    upstream_failures = None
    if metrics["upstreamFailures"] is not None and metrics["apiRequests"] is not None:
        upstream_failures = metrics["upstreamFailures"] >= 3 and metrics["upstreamFailures"] >= metrics["apiRequests"] * 0.05
    return {
        "container_unavailable": unavailable(container["available"] is True and container["running"] is True),
        "app_unavailable": unavailable(app["available"]),
        "public_unavailable": unavailable(sample["public"]["available"]),
        "host_unavailable": unavailable(host["available"]),
        "host_memory": threshold(host["memoryAvailableFraction"], 0.15, below=True),
        "host_disk": threshold(host["diskUsedFraction"], 0.90),
        "host_cpu": threshold(cpu, 0.85),
        "container_restart": restarted,
        "container_oom": oom,
        "app_busy": threshold(metrics["busy"], 3),
        "api_errors": api_errors,
        "upstream_failures": upstream_failures,
        "quota_usage": threshold(app["usageFraction"], 0.90),
    }


def evolve(state, snapshot, now):
    """Bounded hysteresis and delivery bookkeeping, with no I/O or wall clock."""
    state = obj(state)
    sample = safe_snapshot(snapshot)
    before = safe_snapshot(state.get("baseline", state.get("snapshot")))
    sample["host"]["cpuUsedFraction"] = cpu_fraction(sample["host"]["cpu"], before["host"]["cpu"]) if sample["host"]["cpu"]["total"] is not None else sample["host"]["cpuUsedFraction"]
    observed = classify(sample, before)
    result = {"version": 1, "conditions": {}, "snapshot": sample}
    due = []
    for name, (raise_after, severity) in CONDITIONS.items():
        old = obj(obj(state.get("conditions")).get(name))
        row = {
            "badChecks": min(counter(old.get("badChecks")) or 0, raise_after),
            "goodChecks": min(counter(old.get("goodChecks")) or 0, 2),
            "active": old.get("active") is True,
            "announced": old.get("announced") is True,
            "pending": old.get("pending") is True,
            "lastDelivered": old.get("lastDelivered") if number(old.get("lastDelivered")) else None,
        }
        bad = observed[name]
        if bad is True:
            row["badChecks"] = min(raise_after, row["badChecks"] + 1)
            row["goodChecks"] = 0
            if row["badChecks"] >= raise_after or row["announced"] or row["pending"]:
                row["active"] = True
                if not row["announced"]:
                    row["pending"] = True
        elif bad is False:
            row["badChecks"] = 0
            row["goodChecks"] = min(2, row["goodChecks"] + 1)
            if row["goodChecks"] >= 2:
                row["active"] = False
        else:
            row["badChecks"] = row["goodChecks"] = 0
        event = None
        if row["pending"]:
            event = "alert"
        elif row["active"]:
            if not row["announced"]:
                event = "alert"
            elif row["lastDelivered"] is None or now - row["lastDelivered"] >= REMINDER_SECONDS:
                event = "reminder"
        elif row["announced"] and bad is False and row["goodChecks"] >= 2:
            event = "recovery"
        if event:
            due.append({"condition": name, "event": event, "severity": severity,
                        "resolved": not row["active"] and bad is False and row["goodChecks"] >= 2})
        result["conditions"][name] = row
    # Preserve valid baselines across failed collection without presenting stale
    # baseline values as the current health snapshot.
    container_baseline = copy.deepcopy(before["container"])
    current = sample["container"]
    if current["available"] is True and current["id"] is not None:
        container_baseline = copy.deepcopy(current)
        if current["id"] == before["container"]["id"]:
            for key in ("restartCount", "oomKilled"):
                if current[key] is None:
                    container_baseline[key] = before["container"][key]
            for key in ("oom", "oom_kill"):
                if current["memoryEvents"][key] is None:
                    container_baseline["memoryEvents"][key] = before["container"]["memoryEvents"][key]
    result["baseline"] = {
        "container": container_baseline,
        "host": {"cpu": sample["host"]["cpu"] if sample["host"]["cpu"]["total"] is not None else before["host"]["cpu"]},
    }
    return result, due


def record_delivery(state, events, now):
    result = copy.deepcopy(state)
    for event in events:
        row = result["conditions"][event["condition"]]
        row["pending"] = False
        row["announced"] = event["event"] != "recovery" and not event.get("resolved", False)
        row["lastDelivered"] = now if row["announced"] else None
    return result


def adapt_health(raw):
    """Version-1 endpoint adapter. Only aggregate numeric fields cross it.

    Route counters are already rolling five-minute values, not cumulative
    counters: do not subtract successive windows or retain arbitrary app keys.
    """
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise MonitorError("health_contract_invalid")
    window = obj(raw.get("window"))
    totals, routes = obj(window.get("totals")), obj(window.get("routes"))
    if window.get("durationSec") != 300 or counter(totals.get("busy503")) is None:
        raise MonitorError("health_contract_invalid")
    api = [obj(routes.get(name)) for name in ("decisions", "screenshots", "forget", "results")]
    if any(counter(row.get(key)) is None for row in api for key in ("totalRequests", "errors5xx", "upstreamFailures")):
        raise MonitorError("health_contract_invalid")
    ratios = []
    for name in ("decisions", "screenshots"):
        usage = obj(obj(raw.get("usage")).get(name))
        used, limit = counter(usage.get("usedToday")), counter(usage.get("perDay"))
        if used is not None and limit is not None:
            # Zero pauses every model request; it cannot establish recovery.
            ratios.append(min(1, used / limit) if limit else 1)
    return {"available": True, "metrics": {"busy": totals["busy503"],
            "apiRequests": sum(row["totalRequests"] for row in api),
            "api5xx": sum(row["errors5xx"] for row in api),
            "upstreamFailures": sum(row["upstreamFailures"] for row in api)},
            "usageFraction": max(ratios) if ratios and (len(ratios) == 2 or max(ratios) >= 0.9) else None}


def read_json(path, private=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or (private and (info.st_mode & 0o077 or info.st_uid != os.geteuid())):
            raise MonitorError("private_file_required")
        data = stream.read(MAX_JSON + 1)
    if len(data) > MAX_JSON:
        raise MonitorError("json_too_large")
    return json.loads(data)


def load_config(path):
    try:
        config = read_json(path, private=True)
        if not isinstance(config, dict) or sum(bool(config.get(key)) for key in ("webhook", "smtp")) != 1:
            raise ValueError()
        port = config.get("app_port", 8000)
        if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
            raise ValueError()
        if not isinstance(config.get("public_marker", "JudgeYou"), str) or not 1 <= len(config.get("public_marker", "JudgeYou")) <= 256:
            raise ValueError()
        if config.get("webhook"):
            webhook = config["webhook"]
            url = urllib.parse.urlsplit(webhook["url"])
            if url.scheme != "https" or not url.hostname or url.username or url.password or url.fragment:
                raise ValueError()
            if "bearer_token" in webhook and not clean_text(webhook["bearer_token"]):
                raise ValueError()
        else:
            smtp = config["smtp"]
            if smtp.get("mode") not in ("ssl", "starttls"):
                raise ValueError()
            for key in ("host", "sender"):
                if not clean_text(smtp.get(key)):
                    raise ValueError()
            if not isinstance(smtp.get("recipients"), list) or not 1 <= len(smtp["recipients"]) <= 10 or not all(clean_text(value) for value in smtp["recipients"]):
                raise ValueError()
            if "port" in smtp and (not isinstance(smtp["port"], int) or isinstance(smtp["port"], bool) or not 1 <= smtp["port"] <= 65535):
                raise ValueError()
            if bool(smtp.get("username")) != bool(smtp.get("password")):
                raise ValueError()
            if smtp.get("username") and not (clean_text(smtp["username"]) and isinstance(smtp["password"], str)):
                raise ValueError()
        return config
    except Exception:
        raise MonitorError("config_invalid") from None


def clean_text(value):
    return isinstance(value, str) and 0 < len(value) <= 2048 and not any(ord(c) < 32 or ord(c) == 127 for c in value)


@contextlib.contextmanager
def deadline(seconds):
    def expired(_signum, _frame):
        raise TimeoutError()
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def command(arguments, timeout=5):
    """Bound output while reading; stderr and raw subprocess errors are discarded."""
    process = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            end, output = time.monotonic() + timeout, bytearray()
            while True:
                remaining = end - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise MonitorError("command_failed")
                chunk = os.read(process.stdout.fileno(), min(8192, MAX_JSON + 1 - len(output)))
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > MAX_JSON:
                    raise MonitorError("command_failed")
            if process.wait(timeout=max(0.01, end - time.monotonic())) != 0:
                raise MonitorError("command_failed")
            return bytes(output)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        process.stdout.close()


def memory_events(pid):
    try:
        for line in Path(f"/proc/{pid}/cgroup").read_text().splitlines():
            if line.startswith("0::"):
                relative = line[3:].lstrip("/")
                if ".." in Path(relative).parts:
                    return {}
                path = Path("/sys/fs/cgroup") / relative / "memory.events"
                values = dict(row.split() for row in path.read_text().splitlines())
                return {name: int(values[name]) for name in ("oom", "oom_kill")}
    except (OSError, ValueError, KeyError):
        pass
    return {}


def collect_host():
    host = {"available": False}
    try:
        values = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
        host["memoryAvailableFraction"] = int(values["MemAvailable"].split()[0]) / int(values["MemTotal"].split()[0])
        disk = os.statvfs("/")
        host["diskUsedFraction"] = (disk.f_blocks - disk.f_bfree) / (disk.f_blocks - disk.f_bfree + disk.f_bavail)
        ticks = list(map(int, Path("/proc/stat").read_text().splitlines()[0].split()[1:9]))
        host["cpu"] = {"total": sum(ticks), "idle": ticks[3] + ticks[4], "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip()}
        host["available"] = True
    except (OSError, ValueError, KeyError, ZeroDivisionError, IndexError):
        pass
    return host


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Even a same-origin redirect is an unexpected result for these fixed URLs.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_open(request):
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=10)


def collect_public(marker):
    try:
        with deadline(10), http_open(urllib.request.Request("https://judge-you.de/", headers={"User-Agent": "JudgeYou-monitor/1"})) as response:
            if response.status != 200:
                return {"available": False}
            data = bytearray()
            while True:
                chunk = response.read(min(65536, MAX_PUBLIC + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > MAX_PUBLIC:
                    return {"available": False}
            return {"available": marker.encode("utf-8") in data}
    except Exception:
        return {"available": False}


def collect(config):
    sample = {"host": collect_host(), "container": {"available": False}, "app": {"available": False}}
    try:
        template = '{"available":true,"running":{{json .State.Running}},"state":{{json .State.Status}},"id":{{json .Id}},"restartCount":{{json .RestartCount}},"oomKilled":{{json .State.OOMKilled}},"pid":{{json .State.Pid}}}'
        container = json.loads(command(["docker", "inspect", "--format", template, "judgeyou"]))
        pid = counter(container.pop("pid", None))
        if pid:
            container["memoryEvents"] = memory_events(pid)
        sample["container"] = container
        if container.get("running"):
            # The bearer token is read only inside the container. It never enters
            # host argv, Docker inspect output, a snapshot, or a failure message.
            port = config.get("app_port", 8000)
            script = f"""(async()=>{{try{{
              if(!process.env.ADMIN_TOKEN)process.exit(1);
              const r=await fetch('http://127.0.0.1:{port}/api/admin/health',{{headers:{{Authorization:'Bearer '+process.env.ADMIN_TOKEN}},signal:AbortSignal.timeout(8000),redirect:'error'}});
              if(!r.ok)process.exit(1);
              const chunks=[];let n=0;for await(const c of r.body){{n+=c.length;if(n>65536)process.exit(1);chunks.push(c)}}
              process.stdout.write(Buffer.concat(chunks).toString());
            }}catch{{process.exit(1)}}}})()"""
            sample["app"] = adapt_health(json.loads(command(["docker", "exec", "judgeyou", "node", "-e", script], timeout=10)))
    except Exception:
        pass
    sample["public"] = collect_public(config.get("public_marker", "JudgeYou"))
    return safe_snapshot(sample)


def payload(events, snapshot, now):
    if len(events) > len(CONDITIONS):
        raise MonitorError("payload_too_large")
    for item in events:
        if (item.get("condition") not in (*CONDITIONS, "diagnostic") or
                item.get("event") not in ("alert", "reminder", "recovery", "test") or
                item.get("severity") not in ("warning", "critical", "info")):
            raise MonitorError("payload_invalid")
    body = {"version": 1, "at": datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat(),
            "events": [{"condition": item["condition"], "event": item["event"], "severity": item["severity"],
                        "resolved": item.get("resolved") is True} for item in events],
            "health": safe_snapshot(snapshot)}
    encoded = json.dumps(body, allow_nan=False, separators=(",", ":")).encode()
    if len(encoded) > MAX_PAYLOAD:
        raise MonitorError("payload_too_large")
    return encoded


def notification_text(body):
    data = json.loads(body)
    events = data.get("events", [])
    if not events:
        return "JudgeYou monitor", body.decode("utf-8")
    resolved = all(event.get("resolved") or event.get("event") == "recovery" for event in events)
    level = "Recovered" if resolved else "Critical" if any(event.get("severity") == "critical" for event in events) else "Warning"
    if all(event.get("event") == "test" for event in events):
        level = "Test"
    first = DESCRIPTIONS[events[0]["condition"]]
    extra = f" (+{len(events) - 1} more)" if len(events) > 1 else ""
    subject = f"[JudgeYou] {level}: {first}{extra}"
    lines = [f"Time: {data.get('at', '')}", ""]
    for event in events:
        state = "Recovered" if event.get("resolved") or event["event"] == "recovery" else "Still active" if event["event"] == "reminder" else "Detected"
        lines.append(f"{state}: {DESCRIPTIONS[event['condition']]}.")
    lines.extend(["", "Check https://judge-you.de/admin and the host before changing limits or server size.", "No settings or services were changed automatically.", "", "Aggregate diagnostics:", body.decode("utf-8")])
    return subject, "\n".join(lines)


def notify(config, body):
    try:
        with deadline(10):
            if config.get("webhook"):
                webhook = config["webhook"]
                headers = {"Content-Type": "application/json", "User-Agent": "JudgeYou-monitor/1"}
                if webhook.get("bearer_token"):
                    headers["Authorization"] = "Bearer " + webhook["bearer_token"]
                request = urllib.request.Request(webhook["url"], data=body, headers=headers, method="POST")
                with http_open(request) as response:
                    if not 200 <= response.status < 300:
                        raise MonitorError("notification_failed")
            else:
                smtp = config["smtp"]
                message = email.message.EmailMessage()
                message["From"], message["To"] = smtp["sender"], ", ".join(smtp["recipients"])
                message["Subject"], text = notification_text(body)
                message.set_content(text)
                context = ssl.create_default_context()
                factory = smtplib.SMTP_SSL if smtp["mode"] == "ssl" else smtplib.SMTP
                options = {"timeout": 10}
                if smtp["mode"] == "ssl":
                    options["context"] = context
                with factory(smtp["host"], smtp.get("port", 465 if smtp["mode"] == "ssl" else 587), **options) as client:
                    if smtp["mode"] == "starttls":
                        client.ehlo()
                        client.starttls(context=context)
                        client.ehlo()
                    if smtp.get("username"):
                        client.login(smtp["username"], smtp["password"])
                    if client.send_message(message):
                        raise MonitorError("notification_failed")
    except Exception:
        raise MonitorError("notification_failed") from None


def save_state(path, state):
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix=".monitor-", dir=path.parent)
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(state, stream, allow_nan=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def run(config, state_path, *, dry_run=False, fixture=None, test_notification=False):
    if fixture and (not dry_run or test_notification):
        raise MonitorError("fixture_requires_dry_run")
    state_path = Path(state_path)
    state_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(str(state_path) + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "already_running", "delivery": "skipped"}, 0
        now = time.time()
        if test_notification:
            events = [{"condition": "diagnostic", "event": "test", "severity": "info"}]
            if not dry_run:
                notify(config, payload(events, {}, now))
            return {"status": "diagnostic", "delivery": "dry_run" if dry_run else "delivered"}, 0
        try:
            state = read_json(state_path, private=True)
            if not isinstance(state, dict) or state.get("version") != 1:
                raise MonitorError("state_invalid")
        except FileNotFoundError:
            state = {}
        snapshot = safe_snapshot(read_json(fixture)) if fixture else collect(config)
        next_state, events = evolve(state, snapshot, now)
        snapshot = next_state["snapshot"]
        delivery, code = "dry_run" if dry_run else "not_due", 0
        if events and not dry_run:
            try:
                notify(config, payload(events, snapshot, now))
                next_state = record_delivery(next_state, events, now)
                delivery = "delivered"
            except MonitorError:
                delivery, code = "failed", 1
        if not dry_run:
            save_state(state_path, next_state)
        active = [name for name, row in next_state["conditions"].items() if row["active"]]
        status = "critical" if any(CONDITIONS[name][1] == "critical" for name in active) else "warning" if active else "ok"
        summary = {"status": status, "delivery": delivery, "conditions": active, "health": snapshot}
        if code:
            summary["error"] = "notification_failed"
        return summary, code


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/judgeyou-monitor/config.json")
    parser.add_argument("--state", default="/var/lib/judgeyou-monitor/state.json")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--test-notification", action="store_true")
    parser.add_argument("--fixture", help="Local sanitized snapshot JSON; requires --dry-run")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        summary, code = run(config, args.state, dry_run=args.dry_run, fixture=args.fixture, test_notification=args.test_notification)
    except Exception as error:
        allowed = {"config_invalid", "private_file_required", "json_too_large", "fixture_requires_dry_run", "state_invalid", "notification_failed", "payload_too_large"}
        code = 1
        summary = {"status": "error", "error": str(error) if isinstance(error, MonitorError) and str(error) in allowed else "monitor_failed"}
    print(json.dumps(summary, allow_nan=False, separators=(",", ":")))
    return code


if __name__ == "__main__":
    sys.exit(main())
