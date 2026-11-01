"""Deterministic CDP and process doubles: no Chromium, network, signals or credentials."""
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import signal
import tempfile
import unittest
from unittest.mock import Mock, patch

import rakazo_page_browser_recovery as recovery


class RecoveryTest(unittest.TestCase):
    def fixture(self):
        client = Mock(deadline=None, last_timeout=None)
        calls = []

        def call(method, params=None, **kwargs):
            calls.append((method, params, kwargs))
            if method == "Target.closeTarget":
                return {"success": True}
            if method == "Target.getTargetInfo":
                return {"targetInfo": {"targetId": "dead"}}
            if method == "Runtime.evaluate":
                raise TimeoutError("dead renderer")
            return {"targetId": "fresh"} if method == "Target.createTarget" else {"sessionId": "new"}

        client.call.side_effect = call
        api = {"attach_page": Mock(return_value="old"), "ensure_world": Mock(),
               "snapshot": Mock(side_effect=[TimeoutError("hung"), {"ok": True, "url": "about:blank"}]),
               "navigate": Mock(side_effect=[TimeoutError("hung"), {"ok": True, "url": "https://example.test"}]),
               "act": Mock(return_value={"ok": True, "completed": 1})}
        return api, client, calls

    def test_timeout_creates_and_activates_fresh_tab_then_retries_once(self):
        for command in ("snapshot", "navigate"):
            with self.subTest(command=command):
                api, client, calls = self.fixture()
                result = recovery.run_operation(api, client, command, {"url": "https://example.test"})
                self.assertTrue(result["ok"])
                self.assertEqual(api[command].call_args_list[1].args[1], "new")
                self.assertEqual([c[0] for c in calls], ["Runtime.evaluate", "Target.getTargetInfo", "Target.createTarget",
                                 "Target.attachToTarget", "Target.activateTarget", "Page.enable", "Target.closeTarget"])
                self.assertEqual(calls[0][1], {"expression": "1+1", "returnByValue": True})
                self.assertEqual(calls[0][2]["timeout_s"], 2.0)
                self.assertEqual(calls[-1][1], {"targetId": "dead"})
                self.assertIsNone(client.deadline)

    def test_second_failure_is_clean_and_does_not_retry_again(self):
        api, client, calls = self.fixture()
        api["snapshot"].side_effect = TimeoutError("private CDP detail")
        result = recovery.run_operation(api, client, "snapshot", {})
        self.assertEqual(result, {"ok": False, "uncertain": False, "error": recovery.TIMEOUT_MESSAGE,
                                  "fallback": "computer_act"})
        self.assertEqual(api["snapshot"].call_count, 2)
        self.assertEqual(sum(c[0] == "Target.createTarget" for c in calls), 1)
        self.assertNotIn("private", json.dumps(result))

    def test_responsive_tab_is_retried_without_creating_another(self):
        api, client, calls = self.fixture()
        client.call.side_effect = lambda *a, **kw: {"result": {"value": 2}}
        self.assertTrue(recovery.run_operation(api, client, "snapshot", {})["ok"])
        self.assertEqual(api["snapshot"].call_args_list[1].args[1], "old")

    def test_attach_timeout_recovers_but_an_ambiguous_tab_does_not(self):
        api, client, calls = self.fixture()
        api["attach_page"].side_effect = TimeoutError("attach")
        api["snapshot"].side_effect = None
        api["snapshot"].return_value = {"ok": True}
        self.assertTrue(recovery.run_operation(api, client, "snapshot", {})["ok"])
        self.assertEqual(api["attach_page"].call_count, 1)
        api, client, calls = self.fixture()
        api["attach_page"].side_effect = RuntimeError("ambiguous")
        with self.assertRaisesRegex(RuntimeError, "ambiguous"):
            recovery.run_operation(api, client, "snapshot", {})
        self.assertEqual(calls, [])

    def test_no_mutation_is_replayed_or_partial_progress_lost(self):
        api, client, calls = self.fixture()
        def act(*args):
            client.last_timeout = "old"
            return {"ok": False, "completed": 1, "uncertain": True, "error": "CDP timeout"}
        api["act"].side_effect = act
        result = recovery.run_operation(api, client, "act", {"actions": [{"kind": "click"}]})
        self.assertEqual((result["completed"], result["uncertain"]), (1, True))
        self.assertIn("browser_restart", result["error"])
        self.assertEqual(api["act"].call_count, 1)
        self.assertEqual(calls, [])

    def test_recovery_failure_is_clean(self):
        api, client, calls = self.fixture()
        client.call.side_effect = TimeoutError("debugger hung")
        result = recovery.run_operation(api, client, "snapshot", {})
        self.assertEqual(result["error"], recovery.TIMEOUT_MESSAGE)
        self.assertEqual(api["snapshot"].call_count, 1)

    def test_restart_reuses_exact_profile_and_flags_and_waits_for_exit(self):
        args = ["--user-data-dir=/tmp/fake profile", "--remote-debugging-port=9242", "--no-sandbox"]
        with patch.object(recovery, "browser_process", return_value=(123, "/fake/chrome", args)), \
             patch.object(recovery, "process_running", side_effect=[True, True, False, False, False]), \
             patch.object(recovery, "browser_environment", return_value={"DISPLAY": ":21"}), \
             patch.object(recovery, "clean_exit_state"), \
             patch.object(recovery.os, "kill") as kill, patch.object(recovery.time, "sleep"), \
             patch.object(recovery.subprocess, "Popen") as start:
            ready = Mock()
            self.assertTrue(recovery.restart_browser(9242, ready)["ok"])
            kill.assert_called_once_with(123, signal.SIGTERM)
            self.assertEqual(start.call_args.args[0], ["/fake/chrome", *args])
            self.assertTrue(start.call_args.kwargs["start_new_session"])
            self.assertEqual(start.call_args.kwargs["env"], {"DISPLAY": ":21"})
            ready.assert_called_once_with(9242)

    def test_restart_does_not_start_if_old_browser_cannot_stop(self):
        with patch.object(recovery, "browser_process", return_value=(123, "/fake/chrome", [])), \
             patch.object(recovery, "process_running", return_value=True), \
             patch.object(recovery, "browser_environment", return_value={}), \
             patch.object(recovery.os, "kill") as kill, \
             patch.object(recovery.time, "monotonic", side_effect=[0, 4, 4, 6]), \
             patch.object(recovery.subprocess, "Popen") as start:
            with self.assertRaisesRegex(RuntimeError, "could not stop"):
                recovery.restart_browser(9242, Mock())
            self.assertEqual(kill.call_args_list[-1].args, (123, signal.SIGKILL))
            start.assert_not_called()

    def test_restart_closes_cdp_before_signals_and_keeps_cookie_files(self):
        with tempfile.TemporaryDirectory() as temp:
            profile = Path(temp)
            default = profile / "Default"
            default.mkdir()
            cookies = default / "Cookies"
            cookies.write_bytes(b"fake-cookie-database")
            preferences = default / "Preferences"
            preferences.write_text(json.dumps({"profile": {"exit_type": "Crashed", "exited_cleanly": False},
                                               "other": "keep"}))
            args = [f"--user-data-dir={profile}", "--remote-debugging-port=9242"]
            client = Mock()
            with patch.object(recovery, "browser_process", return_value=(123, "/fake/chrome", args)), \
                 patch.object(recovery, "browser_environment", return_value={}), \
                 patch.object(recovery, "process_running", return_value=False), \
                 patch.object(recovery.os, "kill") as kill, \
                 patch.object(recovery.subprocess, "Popen") as start:
                recovery.restart_browser(9242, Mock(), lambda: client)
                client.call.assert_called_once_with("Browser.close", timeout_s=2.0)
                client.close.assert_called_once()
                kill.assert_not_called()
                self.assertEqual(start.call_args.args[0][1:], args)
            self.assertEqual(cookies.read_bytes(), b"fake-cookie-database")
            self.assertEqual(json.loads(preferences.read_text()),
                             {"profile": {"exit_type": "Normal", "exited_cleanly": True}, "other": "keep"})

    def test_operation_budgets_are_short_and_navigation_keeps_a_longer_budget(self):
        for command, seconds in (("snapshot", 5), ("navigate", 20)):
            api, client, calls = self.fixture()
            def operation(*args):
                self.assertAlmostEqual(client.deadline, 100 + seconds)
                return {"ok": True}
            api[command].side_effect = operation
            with patch.object(recovery.time, "time", return_value=100):
                recovery.run_operation(api, client, command, {})
            self.assertIsNone(client.deadline)

    def test_real_cdp_calls_default_to_five_seconds_and_forget_timed_out_requests(self):
        loader = importlib.machinery.SourceFileLoader("recovery_helper", str(Path(__file__).with_name("rakazo-page-browser")))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        helper = importlib.util.module_from_spec(spec)
        loader.exec_module(helper)
        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        client._sock = Mock()
        client._send_frame = Mock()
        # Begin at zero, pass the while guard once, time out the read, then end at five.
        client._read_frame = Mock(side_effect=TimeoutError("socket"))
        with patch.object(helper.time, "time", side_effect=[0, 0, 0, 5]):
            with self.assertRaises(TimeoutError):
                client.call("Runtime.evaluate", session_id="dead")
        self.assertEqual(client._sock.settimeout.call_args_list[0].args, (5.0,))
        self.assertEqual(client.last_timeout, "dead")
        self.assertEqual(client._pending, {})

    def test_cli_closes_a_connection_that_times_out_before_attachment(self):
        loader = importlib.machinery.SourceFileLoader("recovery_helper", str(Path(__file__).with_name("rakazo-page-browser")))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        helper = importlib.util.module_from_spec(spec)
        loader.exec_module(helper)
        client = Mock()
        client.connect.side_effect = TimeoutError("private connection detail")
        with patch.object(helper, "wait_for_cdp"), patch.object(helper, "discover_ws_url", return_value="ws://127.0.0.1:9222/test"), \
             patch.object(helper, "CdpClient", return_value=client), patch("builtins.print") as printed:
            self.assertEqual(helper.run(["helper", "snapshot", "{}"]), 0)
        client.close.assert_called_once()
        result = json.loads(printed.call_args.args[0])
        self.assertEqual(result["error"], recovery.TIMEOUT_MESSAGE)
        self.assertFalse(result["uncertain"])

    def test_failure_to_close_dead_target_requires_restart_instead_of_reselecting_it(self):
        api, client, calls = self.fixture()
        original = client.call.side_effect
        client.call.side_effect = lambda method, *a, **kw: {"success": False} if method == "Target.closeTarget" else original(method, *a, **kw)
        result = recovery.run_operation(api, client, "snapshot", {})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], recovery.TIMEOUT_MESSAGE)
        self.assertEqual(api["snapshot"].call_count, 1)

    def test_restart_selects_only_assigned_debugger_browser_not_renderer(self):
        with tempfile.TemporaryDirectory() as temp:
            proc = Path(temp)
            for pid, args in ((1, ["--remote-debugging-port=9242", "--user-data-dir=/tmp/fake profile"]),
                              (2, ["--remote-debugging-port=9243", "--user-data-dir=/tmp/other"]),
                              (3, ["--remote-debugging-port=9242", "--user-data-dir=/tmp/fake", "--type=renderer"])):
                entry = proc / str(pid)
                entry.mkdir()
                (entry / "cmdline").write_bytes(b"chrome\0" + b"\0".join(a.encode() for a in args) + b"\0")
                (entry / "exe").symlink_to("/fake/chrome")
            with patch.object(recovery.Path, "iterdir", return_value=iter(proc.iterdir())):
                self.assertEqual(recovery.browser_process(9242),
                                 (1, "/fake/chrome", ["--remote-debugging-port=9242", "--user-data-dir=/tmp/fake profile"]))
            with patch.object(recovery.Path, "iterdir", return_value=iter([])):
                with self.assertRaisesRegex(RuntimeError, "No browser was restarted"):
                    recovery.browser_process(9242)


if __name__ == "__main__":
    unittest.main()
