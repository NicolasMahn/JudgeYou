"""No network or Docker daemon is used by these tests."""

import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("monitor", ROOT / "ops/monitor.py")
monitor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(monitor)


def healthy():
    return {
        "host": {"available": True, "memoryAvailableFraction": 0.5, "diskUsedFraction": 0.5,
                 "cpuUsedFraction": 0.1},
        "container": {"available": True, "running": True, "state": "running", "id": "a" * 64,
                      "restartCount": 0, "oomKilled": False, "memoryEvents": {"oom": 0, "oom_kill": 0}},
        "app": {"available": True, "metrics": {"busy": 0, "apiRequests": 100, "api5xx": 0, "upstreamFailures": 0}, "usageFraction": 0.5},
        "public": {"available": True},
    }


def step(state, sample, now=100, delivered=False):
    updated, events = monitor.evolve(state, sample, now)
    if delivered:
        updated = monitor.record_delivery(updated, events, now)
    return updated, events


def events_for(events, name):
    return [event for event in events if event["condition"] == name]


class StateTests(unittest.TestCase):
    def test_availability_requires_two_failures_and_two_recoveries(self):
        for section, field in (("public", "available"), ("app", "available"), ("container", "running")):
            with self.subTest(section=section):
                bad, good = healthy(), healthy()
                bad[section][field] = False
                name = {"public": "public_unavailable", "app": "app_unavailable", "container": "container_unavailable"}[section]
                state, events = step({}, bad)
                self.assertFalse(events)
                original = copy.deepcopy(state)
                state, events = step(state, bad, 160, delivered=True)
                self.assertEqual([event["event"] for event in events_for(events, name)], ["alert"])
                self.assertFalse(original["conditions"][name]["active"], "evolve must not mutate its input")
                state, events = step(state, good, 220)
                self.assertFalse(events)
                state, events = step(state, good, 280, delivered=True)
                self.assertEqual([event["event"] for event in events_for(events, name)], ["recovery"])
                state, events = step(state, good, 340)
                self.assertFalse(events)

    def test_reminder_cooldown_and_bounded_streaks(self):
        sample = healthy()
        sample["app"]["metrics"]["busy"] = 3
        state, events = step({}, sample, 100, delivered=True)
        for now in (101, 159, 1899):
            state, events = step(state, sample, now)
            self.assertFalse(events)
        state, events = step(state, sample, 1900, delivered=True)
        self.assertEqual(events_for(events, "app_busy")[0]["event"], "reminder")
        for i in range(2000):
            state, _ = step(state, sample, 1901)
        self.assertEqual(state["conditions"]["app_busy"]["badChecks"], 1)
        self.assertLess(len(json.dumps(state)), monitor.MAX_JSON)
        self.assertEqual(set(state["conditions"]), set(monitor.CONDITIONS))

    def test_failed_alert_retries_after_incident_resolves_without_false_recovery(self):
        baseline, _ = step({}, healthy())
        for name in ("container_restart", "container_oom"):
            with self.subTest(name=name):
                incident = healthy()
                if name == "container_restart":
                    incident["container"]["restartCount"] = 1
                else:
                    incident["container"]["memoryEvents"]["oom_kill"] = 1
                state, events = step(baseline, incident, 160)
                self.assertEqual(events_for(events, name)[0]["event"], "alert")
                state, _ = step(state, incident, 220)
                state, events = step(state, incident, 280)
                event = events_for(events, name)[0]
                self.assertEqual(event["event"], "alert")
                self.assertTrue(event["resolved"])
                self.assertFalse(state["conditions"][name]["announced"])
                state = monitor.record_delivery(state, events, 280)
                state, events = step(state, incident, 340)
                self.assertFalse(events_for(events, name))
                self.assertFalse(state["conditions"][name]["pending"])
                self.assertFalse(state["conditions"][name]["announced"])

    def test_failed_reminder_and_recovery_retry(self):
        sample = healthy()
        sample["app"]["metrics"]["busy"] = 3
        state, _ = step({}, sample, 100, delivered=True)
        state, events = step(state, sample, 1900)
        self.assertEqual(events_for(events, "app_busy")[0]["event"], "reminder")
        state, events = step(state, sample, 1960)
        self.assertEqual(events_for(events, "app_busy")[0]["event"], "reminder")
        state, _ = step(state, healthy(), 2020)
        state, events = step(state, healthy(), 2080)
        self.assertEqual(events_for(events, "app_busy")[0]["event"], "recovery")
        state, events = step(state, healthy(), 2140)
        self.assertEqual(events_for(events, "app_busy")[0]["event"], "recovery")
        state = monitor.record_delivery(state, events, 2140)
        _, events = step(state, healthy(), 2200)
        self.assertFalse(events)

    def test_missing_metrics_do_not_recover_an_alert(self):
        sample = healthy()
        sample["app"]["metrics"]["busy"] = 3
        state, _ = step({}, sample, delivered=True)
        unknown = healthy()
        unknown["app"] = {"available": False}
        for now in (160, 220, 280):
            state, events = step(state, unknown, now)
            self.assertFalse(events_for(events, "app_busy"))
            self.assertTrue(state["conditions"]["app_busy"]["active"])

    def test_failed_recovery_waits_for_fresh_healthy_confirmation_after_a_relapse(self):
        bad = healthy()
        bad["public"]["available"] = False
        state, _ = step({}, bad)
        state, _ = step(state, bad, 160, delivered=True)
        state, _ = step(state, healthy(), 220)
        pending, events = step(state, healthy(), 280)
        self.assertEqual(events_for(events, "public_unavailable")[0]["event"], "recovery")
        for interruption in (bad, {**healthy(), "public": {}}):
            with self.subTest(interruption=interruption["public"]):
                state, events = step(pending, interruption, 340)
                self.assertFalse(events_for(events, "public_unavailable"))
                state, events = step(state, healthy(), 400)
                self.assertFalse(events_for(events, "public_unavailable"))
                _, events = step(state, healthy(), 460)
                self.assertEqual(events_for(events, "public_unavailable")[0]["event"], "recovery")

    def test_missing_cgroup_evidence_keeps_the_baseline_and_cannot_report_recovery(self):
        state, _ = step({}, healthy())
        incident = healthy()
        incident["container"]["memoryEvents"]["oom_kill"] = 1
        state, _ = step(state, incident, 160, delivered=True)
        missing = copy.deepcopy(incident)
        missing["container"]["memoryEvents"] = {}
        self.assertIsNone(monitor.classify(missing, incident)["container_oom"])
        for now in (220, 280):
            state, events = step(state, missing, now)
            self.assertFalse(events_for(events, "container_oom"))
            self.assertEqual(state["baseline"]["container"]["memoryEvents"]["oom_kill"], 1)
            self.assertIsNone(state["snapshot"]["container"]["memoryEvents"]["oom_kill"])
        increased = copy.deepcopy(incident)
        increased["container"]["memoryEvents"]["oom_kill"] = 2
        self.assertTrue(monitor.classify(increased, state["baseline"])["container_oom"])
        state, events = step(state, incident, 340)
        self.assertFalse(events_for(events, "container_oom"))
        _, events = step(state, incident, 400)
        self.assertEqual(events_for(events, "container_oom")[0]["event"], "recovery")

    def test_partial_allowance_data_proves_exhaustion_but_cannot_prove_recovery(self):
        raw = {"version": 1, "window": {"durationSec": 300, "totals": {"busy503": 0},
               "routes": {name: {"totalRequests": 0, "errors5xx": 0, "upstreamFailures": 0}
                          for name in ("decisions", "screenshots", "forget", "results")}},
               "usage": {"decisions": {"usedToday": 0, "perDay": 1000},
                         "screenshots": {"usedToday": 900, "perDay": 1000}}}
        sample = healthy()
        sample["app"] = monitor.adapt_health(raw)
        state, _ = step({}, sample, delivered=True)
        del raw["usage"]["screenshots"]
        sample["app"] = monitor.adapt_health(raw)
        self.assertIsNone(sample["app"]["usageFraction"])
        for now in (160, 220):
            state, events = step(state, sample, now)
            self.assertFalse(events_for(events, "quota_usage"))
        raw["usage"]["decisions"]["usedToday"] = 950
        self.assertEqual(monitor.adapt_health(raw)["usageFraction"], 0.95)
        raw["usage"]["decisions"].update(usedToday=0, perDay=0)
        sample["app"] = monitor.adapt_health(raw)
        self.assertEqual(sample["app"]["usageFraction"], 1)
        for now in (280, 340):
            state, events = step(state, sample, now)
            self.assertFalse(events_for(events, "quota_usage"))
            self.assertTrue(state["conditions"]["quota_usage"]["active"])

    def test_resource_thresholds_and_consecutive_counts(self):
        for metric, value, count, name in (
            ("memoryAvailableFraction", 0.149, 3, "host_memory"),
            ("diskUsedFraction", 0.90, 3, "host_disk"),
            ("cpuUsedFraction", 0.85, 5, "host_cpu"),
        ):
            with self.subTest(name=name):
                sample = healthy()
                sample["host"][metric] = value
                state = {}
                for i in range(count - 1):
                    state, events = step(state, sample, 100 + 60 * i)
                    self.assertFalse(events_for(events, name))
                state, events = step(state, sample, 100 + 60 * count, delivered=True)
                self.assertEqual(events_for(events, name)[0]["event"], "alert")
                state, events = step(state, sample, 160 + 60 * count)
                self.assertFalse(events_for(events, name))
        sample = healthy()
        sample["host"]["memoryAvailableFraction"] = 0.15
        self.assertFalse(monitor.classify(sample)["host_memory"])

    def test_a_good_or_unknown_check_breaks_the_resource_streak(self):
        low = healthy()
        low["host"]["memoryAvailableFraction"] = 0.1
        for interrupt in (healthy(), {"host": {"available": False}}):
            state, _ = step({}, low)
            state, _ = step(state, low)
            state, _ = step(state, interrupt)
            state, events = step(state, low)
            self.assertFalse(events_for(events, "host_memory"))
            self.assertEqual(state["conditions"]["host_memory"]["badChecks"], 1)

    def test_cpu_uses_deltas_and_resets_on_boot_or_counter_reset(self):
        old = {"total": 100, "idle": 50, "bootId": "a-b"}
        new = {"total": 200, "idle": 65, "bootId": "a-b"}
        self.assertEqual(monitor.cpu_fraction(new, old), 0.85)
        self.assertIsNone(monitor.cpu_fraction(new, {}))
        self.assertIsNone(monitor.cpu_fraction(new, {**old, "bootId": "b-c"}))
        self.assertIsNone(monitor.cpu_fraction(old, new))
        self.assertIsNone(monitor.cpu_fraction(new, new))
        state = {}
        for i in range(7):
            sample = healthy()
            sample["host"]["cpu"] = {"total": 100 + i * 100, "idle": 50 + i * 10, "bootId": "a-b"}
            state, events = step(state, sample, 100 + i * 60, delivered=True)
            if i == 0:
                self.assertIsNone(state["snapshot"]["host"]["cpuUsedFraction"])
            if i < 5:
                self.assertFalse(events_for(events, "host_cpu"))
            if i == 5:
                self.assertEqual(events_for(events, "host_cpu")[0]["event"], "alert")

    def test_container_transitions_baseline_replacement_and_counter_resets(self):
        baseline = healthy()
        baseline["container"].update(restartCount=5, oomKilled=True, memoryEvents={"oom": 10, "oom_kill": 4})
        state, events = step({}, baseline)
        self.assertFalse(events, "First sample is a baseline, including existing OOM state")
        reset = healthy()
        state, events = step(state, reset)
        self.assertFalse(events)
        incident = healthy()
        incident["container"]["restartCount"] = 1
        incident["container"]["memoryEvents"]["oom_kill"] = 1
        state, events = step(state, incident, delivered=True)
        self.assertTrue(events_for(events, "container_restart"))
        self.assertTrue(events_for(events, "container_oom"))
        _, events = step(state, incident, 160)
        self.assertFalse(events)
        changed = healthy()
        changed["container"]["id"] = "b" * 64
        self.assertTrue(monitor.classify(changed, baseline)["container_restart"])
        changed["container"]["oomKilled"] = False
        self.assertFalse(monitor.classify(changed, baseline)["container_oom"])

    def test_container_baseline_survives_failed_docker_collection(self):
        state, _ = step({}, healthy())
        outage = healthy()
        outage["container"] = {"available": False}
        state, _ = step(state, outage)
        self.assertFalse(state["snapshot"]["container"]["available"])
        self.assertTrue(state["baseline"]["container"]["available"])
        sample = healthy()
        sample["container"]["restartCount"] = 1
        _, events = step(state, sample)
        self.assertTrue(events_for(events, "container_restart"))

    def test_api_errors_upstream_failures_busy_and_quota_boundaries(self):
        sample = healthy()
        for count, requests, expected in ((2, 10, False), (3, 61, False), (3, 60, True), (3, 0, True)):
            sample["app"]["metrics"].update(api5xx=count, upstreamFailures=count, apiRequests=requests)
            conditions = monitor.classify(sample)
            self.assertEqual(conditions["api_errors"], expected)
            self.assertEqual(conditions["upstream_failures"], expected)
        sample["app"]["metrics"].update(api5xx=0, upstreamFailures=3, apiRequests=50, busy=3)
        sample["app"]["usageFraction"] = 0.9
        conditions = monitor.classify(sample)
        self.assertTrue(conditions["upstream_failures"])
        self.assertFalse(conditions["api_errors"])
        self.assertTrue(conditions["app_busy"])
        self.assertTrue(conditions["quota_usage"])
        sample["app"]["usageFraction"] = None
        self.assertIsNone(monitor.classify(sample)["quota_usage"])

    @unittest.skipUnless(shutil.which("node"), "Application contract check needs the project's development Node runtime")
    def test_adapter_consumes_real_telemetry_and_limiter_snapshots(self):
        script = """
        import {createTelemetry} from './server/telemetry.js';
        import {createLimiter} from './server/limits.js';
        import {EventEmitter} from 'node:events';
        const telemetry=createTelemetry();
        for(let i=0;i<20;i++) {
          const req=new EventEmitter();req.url='/api/decisions';
          const res=new EventEmitter();res.statusCode=i<3?429:200;
          telemetry.observe(req,res);
          if(i<3)telemetry.mark(res,'upstreamFailures');
          res.emit('finish');
        }
        const limiter=createLimiter({perDay:10,perIpPerHour:100});
        for(let i=0;i<9;i++)limiter.take('fixture');
        console.log(JSON.stringify({...telemetry.snapshot(),usage:{decisions:limiter.snapshot()}}));
        """
        actual = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", script], cwd=ROOT, timeout=10))
        app = monitor.adapt_health(actual)
        self.assertEqual(app["usageFraction"], 0.9)
        self.assertEqual(app["metrics"], {"busy": 0, "apiRequests": 20, "api5xx": 0, "upstreamFailures": 3})
        sample = healthy()
        sample["app"] = app
        state, events = step({}, sample, delivered=True)
        self.assertTrue(events_for(events, "upstream_failures"))
        self.assertFalse(events_for(events, "api_errors"))
        self.assertTrue(events_for(events, "quota_usage"))
        # A process restart/window expiry can reset aggregates to zero: no delta.
        for route in actual["window"]["routes"].values():
            route.update(totalRequests=0, errors5xx=0, upstreamFailures=0)
        actual["window"]["totals"]["busy503"] = 0
        actual["usage"] = {}
        sample["app"] = monitor.adapt_health(actual)
        state, _ = step(state, sample, 160)
        _, events = step(state, sample, 220)
        self.assertEqual(events_for(events, "upstream_failures")[0]["event"], "recovery")
        for invalid in ({}, {**actual, "version": 2}, {**actual, "window": {"durationSec": 60}}):
            with self.assertRaises(monitor.MonitorError):
                monitor.adapt_health(invalid)


class IOTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.state = self.directory / "state.json"
        self.config = self.directory / "config.json"
        self.secret = "private-do-not-log-credential"
        self.settings = {"webhook": {"url": "https://notify.invalid/" + self.secret, "bearer_token": self.secret}}
        self.write_private(self.config, self.settings)

    def write_private(self, path, data):
        path.write_text(json.dumps(data))
        path.chmod(0o600)

    def test_startup_requires_private_valid_config_and_one_destination(self):
        self.assertEqual(monitor.load_config(self.config), self.settings)
        self.config.chmod(0o640)
        with self.assertRaisesRegex(monitor.MonitorError, "^config_invalid$"):
            monitor.load_config(self.config)
        for invalid in ({}, {"webhook": {"url": "http://example.invalid"}}, {"webhook": {"url": "https://user:password@example.invalid"}},
                        {"smtp": {"mode": "plain"}}, {**self.settings, "smtp": {"host": "example.invalid"}},
                        {**self.settings, "app_port": True}):
            self.write_private(self.config, invalid)
            with self.assertRaisesRegex(monitor.MonitorError, "^config_invalid$"):
                monitor.load_config(self.config)
        self.config.unlink()
        with self.assertRaisesRegex(monitor.MonitorError, "^config_invalid$"):
            monitor.load_config(self.config)

    def test_delivery_failure_is_saved_retried_and_then_acknowledged(self):
        sample = healthy()
        sample["public"]["available"] = False
        with patch.object(monitor, "collect", return_value=sample), patch.object(monitor, "notify") as send:
            summary, code = monitor.run(self.settings, self.state)
            self.assertEqual((code, summary["delivery"]), (0, "not_due"))
            send.side_effect = monitor.MonitorError("notification_failed")
            summary, code = monitor.run(self.settings, self.state)
            self.assertEqual((code, summary["delivery"]), (1, "failed"))
            saved = monitor.read_json(self.state)
            self.assertFalse(saved["conditions"]["public_unavailable"]["announced"])
            self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o600)
            send.side_effect = None
            summary, code = monitor.run(self.settings, self.state)
            self.assertEqual((code, summary["delivery"]), (0, "delivered"))
            self.assertTrue(monitor.read_json(self.state)["conditions"]["public_unavailable"]["announced"])
            send.reset_mock()
            monitor.run(self.settings, self.state)
            send.assert_not_called()

    def test_failed_transient_incident_is_eventually_delivered_as_resolved(self):
        sample = healthy()
        with patch.object(monitor, "collect", side_effect=lambda _: copy.deepcopy(sample)), patch.object(monitor, "notify") as send:
            monitor.run(self.settings, self.state)
            sample["container"]["memoryEvents"]["oom_kill"] = 1
            send.side_effect = monitor.MonitorError("notification_failed")
            for _ in range(3):
                _, code = monitor.run(self.settings, self.state)
                self.assertEqual(code, 1)
            send.side_effect = None
            summary, code = monitor.run(self.settings, self.state)
            self.assertEqual((code, summary["delivery"]), (0, "delivered"))
            body = json.loads(send.call_args.args[1])
            event = events_for(body["events"], "container_oom")[0]
            self.assertEqual(event, {"condition": "container_oom", "event": "alert", "severity": "critical", "resolved": True})
            send.reset_mock()
            monitor.run(self.settings, self.state)
            send.assert_not_called()

    def test_cli_private_config_fixture_dry_run_is_local_and_does_not_send(self):
        fixture = self.directory / "fixture.json"
        sample = healthy()
        sample["chat"] = self.secret
        sample["public"]["url"] = "https://private.invalid/" + self.secret
        self.write_private(fixture, sample)
        args = [sys.executable, str(ROOT / "ops/monitor.py"), "--config", str(self.config), "--state", str(self.state), "--fixture", str(fixture), "--dry-run"]
        completed = subprocess.run(args, capture_output=True, text=True, timeout=5)
        self.assertEqual(completed.returncode, 0, completed.stdout)
        summary = json.loads(completed.stdout)
        self.assertEqual(summary["delivery"], "dry_run")
        self.assertNotIn(self.secret, completed.stdout + completed.stderr)
        self.assertFalse(self.state.exists())
        rejected = subprocess.run(args[:-1], capture_output=True, text=True, timeout=5)
        self.assertEqual(rejected.returncode, 1)
        self.assertEqual(json.loads(rejected.stdout)["error"], "fixture_requires_dry_run")

    def test_main_mock_delivery_and_diagnostic_are_explicit(self):
        output = io.StringIO()
        args = ["--config", str(self.config), "--state", str(self.state), "--test-notification"]
        with patch.object(monitor, "notify") as send, patch.object(monitor, "collect") as collect, contextlib.redirect_stdout(output):
            self.assertEqual(monitor.main(args + ["--dry-run"]), 0)
            send.assert_not_called()
            self.assertEqual(monitor.main(args), 0)
            send.assert_called_once()
            collect.assert_not_called()
            self.assertEqual(json.loads(send.call_args.args[1])["events"][0]["event"], "test")
        self.assertFalse(self.state.exists())
        self.assertNotIn(self.secret, output.getvalue())

    def test_cli_config_collect_delivery_failure_retry_and_safe_status(self):
        sample = healthy()
        sample["public"]["available"] = False
        args = ["--config", str(self.config), "--state", str(self.state)]
        output = io.StringIO()
        with patch.object(monitor, "collect", return_value=sample), patch.object(monitor, "http_open") as opened, contextlib.redirect_stdout(output):
            self.assertEqual(monitor.main(args), 0)
            opened.assert_not_called()
            opened.side_effect = TimeoutError(self.secret)
            self.assertEqual(monitor.main(args), 1)
            response = MagicMock()
            response.status = 202
            response.__enter__.return_value = response
            opened.side_effect = None
            opened.return_value = response
            self.assertEqual(monitor.main(args), 0)
            self.assertEqual(monitor.main(args), 0)
            self.assertEqual(opened.call_count, 2)
            body = json.loads(opened.call_args.args[0].data)
            self.assertEqual(events_for(body["events"], "public_unavailable")[0]["event"], "alert")
        summaries = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([summary["delivery"] for summary in summaries], ["not_due", "failed", "delivered", "not_due"])
        self.assertNotIn(self.secret, output.getvalue())

    def test_no_credentials_or_raw_exceptions_reach_payload_state_or_stdout(self):
        sample = healthy()
        sample["headers"] = {"Authorization": self.secret}
        sample["container"]["state"] = self.secret
        sample["container"]["id"] = self.secret
        sample["app"]["chat"] = self.secret
        sample["app"]["metrics"]["busy"] = self.secret
        sample["public"]["url"] = self.secret
        clean = monitor.safe_snapshot(sample)
        body = monitor.payload([], sample, 0)
        state, _ = monitor.evolve({}, sample, 0)
        self.assertNotIn(self.secret, json.dumps(state))
        self.assertNotIn(self.secret.encode(), body)
        self.assertEqual(clean["container"]["state"], "unknown")
        for operation in ("load_config", "notify"):
            with self.subTest(operation=operation):
                output = io.StringIO()
                with patch.object(monitor, operation, side_effect=RuntimeError(self.secret)), contextlib.redirect_stdout(output):
                    code = monitor.main(["--config", str(self.config), "--state", str(self.state), "--test-notification"])
                self.assertEqual(code, 1)
                self.assertNotIn(self.secret, output.getvalue())
                json.loads(output.getvalue())

    def test_json_and_payload_bounds(self):
        self.config.write_bytes(b" " * (monitor.MAX_JSON + 1))
        with self.assertRaises(monitor.MonitorError):
            monitor.read_json(self.config)
        sample = healthy()
        sample["untrusted"] = self.secret * 100000
        sample["host"]["memoryAvailableFraction"] = float("nan")
        sample["app"]["metrics"]["busy"] = 2**100
        events = [{"condition": name, "event": "alert", "severity": severity} for name, (_, severity) in monitor.CONDITIONS.items()]
        body = monitor.payload(events, sample, 0)
        self.assertLess(len(body), monitor.MAX_PAYLOAD)
        self.assertNotIn(self.secret.encode(), body)
        self.assertIsNone(json.loads(body)["health"]["host"]["memoryAvailableFraction"])
        with self.assertRaises(monitor.MonitorError):
            monitor.payload(events * 100, sample, 0)
        with self.assertRaises(monitor.MonitorError):
            monitor.command([sys.executable, "-c", "import sys;sys.stdout.write('a'*1000000)"], timeout=2)
        with self.assertRaises(monitor.MonitorError):
            monitor.command([sys.executable, "-c", "import time;time.sleep(10)"], timeout=0.05)

    def test_lock_prevents_overlapping_collectors(self):
        import fcntl
        lock_path = Path(str(self.state) + ".lock")
        with lock_path.open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(monitor, "collect") as collect, patch.object(monitor, "notify") as send:
                summary, code = monitor.run(self.settings, self.state)
                self.assertEqual((code, summary["status"]), (0, "already_running"))
                collect.assert_not_called()
                send.assert_not_called()

    def test_atomic_state_replacement_keeps_previous_state_on_failure(self):
        monitor.save_state(self.state, {"version": 1, "old": True})
        with patch.object(monitor.os, "replace", side_effect=OSError(self.secret)):
            with self.assertRaises(OSError):
                monitor.save_state(self.state, {"version": 1, "new": True})
        self.assertEqual(monitor.read_json(self.state), {"version": 1, "old": True})
        self.assertEqual(list(self.directory.glob(".monitor-*")), [])

    def test_webhook_delivers_json_and_refuses_redirects_without_logging_response(self):
        response = MagicMock()
        response.status = 204
        response.__enter__.return_value = response
        with patch.object(monitor, "http_open", return_value=response) as opened:
            monitor.notify(self.settings, b'{"version":1}')
            request = opened.call_args.args[0]
            self.assertEqual(request.method, "POST")
            self.assertEqual(request.get_header("Authorization"), "Bearer " + self.secret)
            self.assertEqual(request.data, b'{"version":1}')
            response.read.assert_not_called()
        with patch.object(monitor, "http_open", side_effect=urllib.error.HTTPError("https://private.invalid", 302, self.secret, {}, None)):
            with self.assertRaisesRegex(monitor.MonitorError, "^notification_failed$"):
                monitor.notify(self.settings, b"{}")
        self.assertIsNone(monitor.NoRedirect().redirect_request(None, None, 302, self.secret, {}, "https://other.invalid"))

    def test_smtp_ssl_and_starttls_authenticate_only_after_tls(self):
        smtp = {"host": "smtp.invalid", "sender": "monitor@example.invalid", "recipients": ["owner@example.invalid"], "username": "monitor", "password": self.secret}
        for mode in ("ssl", "starttls"):
            with self.subTest(mode=mode):
                settings = {"smtp": {**smtp, "mode": mode}}
                self.write_private(self.config, settings)
                self.assertEqual(monitor.load_config(self.config), settings)
                client = MagicMock()
                client.send_message.return_value = {}
                factory = MagicMock()
                factory.return_value.__enter__.return_value = client
                name = "SMTP_SSL" if mode == "ssl" else "SMTP"
                with patch.object(monitor.smtplib, name, factory):
                    monitor.notify(settings, b'{"version":1}')
                client.login.assert_called_once_with("monitor", self.secret)
                if mode == "ssl":
                    self.assertIn("context", factory.call_args.kwargs)
                else:
                    calls = [call[0] for call in client.method_calls]
                    self.assertLess(calls.index("starttls"), calls.index("login"))
                self.assertNotIn(self.secret, str(client.send_message.call_args.args[0]))
        client.send_message.return_value = {"owner@example.invalid": (550, self.secret)}
        with patch.object(monitor.smtplib, name, factory):
            with self.assertRaisesRegex(monitor.MonitorError, "^notification_failed$"):
                monitor.notify(settings, b"{}")

    def test_email_summary_explains_failure_recovery_and_delayed_incidents(self):
        events = [{"condition": "container_oom", "event": "alert", "severity": "critical", "resolved": False}]
        subject, text = monitor.notification_text(monitor.payload(events, healthy(), 0))
        self.assertIn("Critical", subject)
        self.assertIn("out-of-memory", subject)
        self.assertIn("Detected:", text)
        self.assertIn("No settings or services were changed automatically", text)
        events[0]["resolved"] = True
        subject, text = monitor.notification_text(monitor.payload(events, healthy(), 0))
        self.assertIn("Recovered", subject)
        self.assertIn("Recovered:", text)
        self.assertNotIn("Still active:", text)

    def test_public_probe_is_size_bounded_and_checks_expected_marker(self):
        for data, expected in ((b"<title>JudgeYou</title>", True), (b"unrelated page", False), (b"JudgeYou" + b"a" * monitor.MAX_PUBLIC, False)):
            with self.subTest(length=len(data)):
                response = io.BytesIO(data)
                response.status = 200
                with patch.object(monitor, "http_open", return_value=response) as opened:
                    self.assertEqual(monitor.collect_public("JudgeYou"), {"available": expected})
                    self.assertEqual(opened.call_args.args[0].full_url, "https://judge-you.de/")
        with patch.object(monitor, "http_open", side_effect=TimeoutError(self.secret)):
            self.assertEqual(monitor.collect_public("JudgeYou"), {"available": False})

    def test_docker_collector_uses_internal_token_default_port_and_safe_inspect(self):
        container = {**healthy()["container"], "pid": 1234}
        with patch.object(monitor, "collect_host", return_value=healthy()["host"]), patch.object(monitor, "collect_public", return_value={"available": True}), patch.object(monitor, "memory_events", return_value={"oom_kill": 1}) as memory, patch.object(monitor, "adapt_health", return_value=healthy()["app"]), patch.object(monitor, "command", side_effect=[json.dumps(container).encode(), b'{"version":1}']) as command:
            sample = monitor.collect({})
        memory.assert_called_once_with(1234)
        inspect, execute = [call.args[0] for call in command.call_args_list]
        self.assertEqual(inspect[:3], ["docker", "inspect", "--format"])
        self.assertNotIn(".Config", inspect[3])
        self.assertEqual(execute[:5], ["docker", "exec", "judgeyou", "node", "-e"])
        self.assertIn("process.env.ADMIN_TOKEN", execute[5])
        self.assertIn("127.0.0.1:8000/api/admin/health", execute[5])
        self.assertNotIn(self.secret, json.dumps(execute))
        self.assertNotIn("pid", sample["container"])
        self.assertTrue(sample["app"]["available"])

    def test_cgroup_reads_host_pid_and_ignores_inaccessible_files(self):
        with patch.object(Path, "read_text", side_effect=["0::/system.slice/docker-abc.scope\n", "oom 3\noom_kill 2\n"]) as read:
            self.assertEqual(monitor.memory_events(1234), {"oom": 3, "oom_kill": 2})
            self.assertEqual(read.call_count, 2)
        with patch.object(Path, "read_text", side_effect=PermissionError(self.secret)):
            self.assertEqual(monitor.memory_events(1234), {})
        with patch.object(Path, "read_text", return_value="0::/../../private\n"):
            self.assertEqual(monitor.memory_events(1234), {})


if __name__ == "__main__":
    unittest.main()
