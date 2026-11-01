"""Bounded CDP recovery and profile-preserving restart, shared by every Linux computer."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import tempfile

CALL_SECONDS = 5.0
TIMEOUT_MESSAGE = "Page browser timed out and could not recover. Call browser_restart before continuing."


@contextmanager
def budget(client, seconds):
    before = client.deadline
    end = time.time() + seconds
    client.deadline = min(before, end) if before is not None else end
    try:
        yield
    finally:
        client.deadline = before


def responsive(client, session):
    try:
        with budget(client, 2.0):
            result = client.call("Runtime.evaluate", {"expression": "1+1", "returnByValue": True},
                                 session_id=session, timeout_s=2.0)
            return result.get("result", {}).get("value") == 2
    except Exception:
        return False


def fresh_page(api, client, failed_session=None):
    # Browser-level commands still answer when a renderer is stuck. Replace only a tab whose
    # responsiveness probe failed, after the new tab is ready, so future calls cannot select it again.
    with budget(client, CALL_SECONDS):
        failed_target = None
        if failed_session:
            failed_target = client.call("Target.getTargetInfo", session_id=failed_session)["targetInfo"]["targetId"]
        target = client.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        session = client.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        client.call("Target.activateTarget", {"targetId": target})
        client.call("Page.enable", session_id=session)
        api["ensure_world"](client, session)
        if failed_target and failed_target != target:
            if not client.call("Target.closeTarget", {"targetId": failed_target}).get("success"):
                raise RuntimeError("The unresponsive tab could not close")
        return session


def run_operation(api, client, command, args):
    session = None
    for attempt in range(2):
        client.last_timeout = None
        acting = False
        try:
            if session is None:
                with budget(client, CALL_SECONDS):
                    session = api["attach_page"](client)
            if command == "navigate":
                with budget(client, 20.0):
                    result = api["navigate"](client, session, str(args.get("url") or ""))
            elif command == "snapshot":
                with budget(client, CALL_SECONDS):
                    result = api["snapshot"](client, session)
            elif command == "act":
                actions = args.get("actions")
                if not isinstance(actions, list):
                    raise RuntimeError("actions must be an array")
                acting = True
                result = api["act"](client, session, actions)
            else:
                result = {"ok": False, "error": f"unknown command: {command}", "fallback": "computer_act"}
            if result.get("ok") or client.last_timeout is None:
                return result
        except Exception as error:
            if not isinstance(error, TimeoutError) and client.last_timeout is None:
                raise
            result = {"ok": False, "uncertain": acting}
        # A timed out mutation may have reached Chromium; recovery must never replay it or
        # discard its completed count. Refs from the old document cannot be used in a fresh tab.
        result["error"] = TIMEOUT_MESSAGE
        result["fallback"] = "computer_act"
        if attempt or acting:
            return result
        failed_session = client.last_timeout or session
        alive = responsive(client, failed_session) if failed_session else False
        try:
            if not alive:
                session = fresh_page(api, client, failed_session)
            elif session is None:
                # Attachment failed before selection; a fresh tab gives it an unambiguous target.
                session = fresh_page(api, client)
        except Exception:
            return {"ok": False, "uncertain": False, "error": TIMEOUT_MESSAGE, "fallback": "computer_act"}
    raise AssertionError("unreachable")


def browser_process(port):
    """Only the browser process owning this screen's debugger, never a renderer or another screen."""
    found = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / "cmdline").read_bytes().rstrip(b"\0").decode().split("\0")
            exe = os.readlink(entry / "exe")
            if (f"--remote-debugging-port={port}" not in args
                    or any(arg.startswith("--type=") for arg in args)
                    or Path(exe).name not in ("chrome", "chromium", "chromium-browser", "brave")):
                continue
            profiles = [arg.split("=", 1)[1] for arg in args if arg.startswith("--user-data-dir=")]
            if "--user-data-dir" in args:
                profiles.append(args[args.index("--user-data-dir") + 1])
            if len(profiles) == 1 and os.path.isabs(profiles[0]):
                found.append((int(entry.name), exe, args[1:]))
        except (OSError, ValueError, IndexError, UnicodeError):
            continue
    if len(found) != 1:
        raise RuntimeError("Page browser process could not be identified. No browser was restarted.")
    return found[0]


def process_running(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
    except FileNotFoundError:
        return False


def browser_environment(pid):
    # The live process already has the correct display, session bus and HOME. In particular,
    # Docker's helper may preload libnss_wrapper while Chromium must run without it.
    raw = Path(f"/proc/{pid}/environ").read_bytes()
    return dict(item.decode().split("=", 1) for item in raw.split(b"\0") if b"=" in item)


def clean_exit_state(args):
    # As in rakazo-browser, retain session cookies after a forced stop by clearing only the
    # crash markers. Never delete locks or cookie databases, or copy another screen's profile.
    profile = next((arg.split("=", 1)[1] for arg in args if arg.startswith("--user-data-dir=")), None)
    if profile is None:
        profile = args[args.index("--user-data-dir") + 1]
    for path in Path(profile).glob("*/Preferences"):
        value = json.loads(path.read_text())
        state = value.get("profile")
        if not isinstance(state, dict):
            continue
        state["exit_type"] = "Normal"
        state["exited_cleanly"] = True
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as output:
            temporary = Path(output.name)
            try:
                json.dump(value, output)
                output.close()
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)


def restart_browser(port, wait_for_cdp, make_client=None):
    pid, executable, args = browser_process(port)
    env = browser_environment(pid)
    # Browser.close flushes cookies. A stuck browser may need signals, after the bounded close.
    if make_client is not None:
        client = None
        try:
            client = make_client()
            client.connect()
            client.call("Browser.close", timeout_s=2.0)
        except Exception:
            pass
        finally:
            if client is not None:
                client.close()
        until = time.monotonic() + 2.0
        while process_running(pid) and time.monotonic() < until:
            time.sleep(0.05)
    if process_running(pid):
        os.kill(pid, signal.SIGTERM)
    until = time.monotonic() + 3.0
    while process_running(pid) and time.monotonic() < until:
        time.sleep(0.05)
    if process_running(pid):
        os.kill(pid, signal.SIGKILL)
        until = time.monotonic() + 1.0
        while process_running(pid) and time.monotonic() < until:
            time.sleep(0.05)
    if process_running(pid):
        raise RuntimeError("Page browser could not stop. No replacement browser was started.")
    clean_exit_state(args)
    # Keep the executable, exact profile and isolation flags of the owned browser.
    subprocess.Popen([executable, *args], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)
    wait_for_cdp(port)
    return {"ok": True, "url": "about:blank", "title": ""}
