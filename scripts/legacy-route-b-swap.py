#!/usr/bin/env python3
"""Bounded same-filesystem install swap with a durable, separately resumable rollback journal."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from email.message import Message
from pathlib import Path
from types import FrameType
from typing import Any, BinaryIO, Iterator


class SwapError(RuntimeError):
    """A swap precondition, lifecycle operation, or recovery step failed."""


# The verified unit allows 35s to stop and 90s to start; the driver adds 5s
# for the systemctl client handshake while keeping both waits bounded.
SERVICE_STOP_TIMEOUT_SECONDS = 40.0
SERVICE_START_TIMEOUT_SECONDS = 95.0


def validate_transaction_parent(path: Path) -> None:
    try:
        info = os.lstat(path)
        canonical = path.resolve(strict=True)
    except OSError as error:
        raise SwapError("transaction parent is unavailable or cannot be resolved") from error
    if not stat.S_ISDIR(info.st_mode) or path.is_symlink() or canonical != path:
        raise SwapError("transaction parent must be a real, canonical directory")
    if info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise SwapError("transaction parent must be owned by the transaction user and not group/world writable")


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def transaction_lock(path: Path) -> Iterator[None]:
    validate_transaction_parent(path.parent)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise SwapError("transaction lock must be a private, single-link regular file")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    except BlockingIOError as error:
        raise SwapError("another Route B swap/recovery process holds the transaction lock") from error
    finally:
        os.close(descriptor)


def write_journal(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    raw = (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(os.dup(descriptor), "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(descriptor)
    os.replace(temporary, path)
    fsync_directory(path.parent)


def read_journal(path: Path) -> dict[str, Any]:
    try:
        info = os.lstat(path)
    except OSError as error:
        raise SwapError(f"journal is unavailable: {path}") from error
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise SwapError("journal must be a private, single-link regular file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SwapError("journal is unreadable or malformed; retain all trees for operator inspection") from error
    required = {"schema", "phase", "install", "candidate", "preserved", "quarantine", "unit", "health_url", "timeout_seconds", "old_sha256", "candidate_sha256", "old_identity", "candidate_identity", "expected_revision", "baseline_health", "transaction"}
    if not isinstance(value, dict) or set(value) != required or value.get("schema") != "corgi-legacy-swap/v1":
        raise SwapError("journal schema/fields do not match; retain all trees for operator inspection")
    if not isinstance(value["phase"], str) or value["phase"] not in {"intent", "stopped", "old_preserved", "candidate_installed", "candidate_started", "recovering", "rolled_back", "committed"}:
        raise SwapError("journal phase is unknown; retain all trees for operator inspection")
    validate_journal(path, value)
    return value


def unique_json_fields(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


def validate_journal(path: Path, value: dict[str, Any]) -> None:
    transaction = value["transaction"]
    if not isinstance(transaction, str) or re.fullmatch(r"[0-9a-f]{32}", transaction) is None:
        raise SwapError("journal transaction id is malformed")
    paths: dict[str, Path] = {}
    for key in ("install", "candidate", "preserved", "quarantine"):
        raw = value[key]
        if not isinstance(raw, str) or not Path(raw).is_absolute():
            raise SwapError("journal paths must be absolute")
        paths[key] = Path(raw)
    if any(item.parent != path.parent for item in paths.values()) or len(set(paths.values())) != len(paths):
        raise SwapError("journal trees must remain siblings on the same filesystem")
    install_name = paths["install"].name
    if paths["install"] == paths["candidate"]:
        raise SwapError("journal install and candidate paths are ambiguous")
    if paths["preserved"].name != f".{install_name}.route-b-old-{transaction}" or paths["quarantine"].name != f".{install_name}.route-b-failed-{transaction}":
        raise SwapError("journal recovery tree names do not match transaction id")
    if not isinstance(value["unit"], str) or re.fullmatch(r"[A-Za-z0-9_.@:-]+\.service", value["unit"]) is None:
        raise SwapError("journal service identity is malformed")
    if not isinstance(value["health_url"], str):
        raise SwapError("journal health URL must be a string")
    validate_health_url(value["health_url"])
    if not isinstance(value["timeout_seconds"], int) or not 1 <= value["timeout_seconds"] <= 300:
        raise SwapError("journal health timeout is outside its bound")
    for key in ("old_sha256", "candidate_sha256"):
        if not isinstance(value[key], str) or re.fullmatch(r"[0-9a-f]{64}", value[key]) is None:
            raise SwapError("journal tree digest is malformed")
    for key in ("old_identity", "candidate_identity"):
        identity = value[key]
        if not isinstance(identity, dict) or set(identity) != {"device", "inode"} or any(not isinstance(identity[field], int) or identity[field] < 0 for field in ("device", "inode")):
            raise SwapError("journal tree device/inode identity is malformed")
    revision = value["expected_revision"]
    if not isinstance(revision, str) or re.fullmatch(r"[0-9a-f]{40}", revision) is None:
        raise SwapError("journal expected release revision is malformed")
    baseline = value["baseline_health"]
    if not isinstance(baseline, dict) or not set(baseline).issubset({"status", "revision"}) or baseline.get("status") != "ok":
        raise SwapError("journal legacy baseline health contract is malformed")
    if "revision" in baseline and baseline["revision"] is not None and (not isinstance(baseline["revision"], str) or re.fullmatch(r"[0-9a-f]{40}", baseline["revision"]) is None):
        raise SwapError("journal legacy health revision is malformed")
    validate_transaction_parent(path.parent)


def tree_digest(root: Path) -> str:
    if not root.is_dir() or root.is_symlink():
        raise SwapError(f"tree root must be a real directory: {root}")
    digest = hashlib.sha256()
    root_info = os.lstat(root)
    digest.update(f"root:{stat.S_IMODE(root_info.st_mode):o}:{root_info.st_uid}:{root_info.st_gid}:{root_info.st_mtime_ns}\0".encode())
    def walk(directory: Path, relative: str) -> None:
        for item in sorted(directory.iterdir(), key=lambda entry: entry.name):
            child_rel = f"{relative}/{item.name}" if relative else item.name
            info = os.lstat(item)
            mode = info.st_mode
            digest.update(child_rel.encode("utf-8", errors="strict") + b"\0")
            digest.update(f"{stat.S_IMODE(mode):o}:{info.st_uid}:{info.st_gid}:".encode())
            if stat.S_ISDIR(mode):
                digest.update(b"dir\0")
                walk(item, child_rel)
            elif stat.S_ISREG(mode):
                digest.update(b"file\0")
                with item.open("rb") as stream:
                    while block := stream.read(1024 * 1024):
                        digest.update(block)
            elif stat.S_ISLNK(mode):
                digest.update(b"link\0" + os.readlink(item).encode("utf-8", errors="strict"))
            else:
                raise SwapError(f"unsupported special file in install tree: {child_rel}")
            digest.update(b"\0")
    walk(root, "")
    return digest.hexdigest()


def directory_identity(path: Path) -> dict[str, int]:
    try:
        info = os.lstat(path)
    except OSError as error:
        raise SwapError(f"tree identity path is unavailable: {path}") from error
    if not stat.S_ISDIR(info.st_mode):
        raise SwapError(f"tree identity path is not a real directory: {path}")
    return {"device": info.st_dev, "inode": info.st_ino}


def checked_identity(path: Path, expected: dict[str, int], label: str) -> None:
    if directory_identity(path) != expected:
        raise SwapError(f"{label} directory was replaced; retain all trees for operator inspection")


def run_systemctl(*arguments: str, timeout: float) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(["systemctl", *arguments], check=False, text=True, capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SwapError(f"systemctl {arguments[0]} failed or timed out") from error


def require_systemctl(*arguments: str, timeout: float) -> None:
    result = run_systemctl(*arguments, timeout=timeout)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()[:500]
        raise SwapError(f"systemctl {arguments[0]} exited {result.returncode}: {detail}")


def service_stopped(unit: str) -> bool:
    properties: dict[str, str] = {}
    for name in ("ActiveState", "SubState", "ControlGroup"):
        result = run_systemctl("show", f"--property={name}", "--value", unit, timeout=20.0)
        if result.returncode != 0:
            raise SwapError(f"cannot verify service {name} after stop")
        properties[name] = result.stdout.strip()
    state = properties["ActiveState"]
    substate = properties["SubState"]
    if state not in {"inactive", "failed"} or substate not in {"dead", "failed"}:
        return False
    group = properties["ControlGroup"]
    if not group:
        # systemd may clear ControlGroup after collecting an empty cgroup.
        # Accept this only alongside the terminal unit state checked above.
        return True
    if not group.startswith("/") or ".." in Path(group).parts:
        raise SwapError("systemd returned an invalid service cgroup")
    cgroup_directory = Path("/sys/fs/cgroup") / group.lstrip("/")
    if not cgroup_directory.exists():
        return True
    if cgroup_directory.is_symlink() or not cgroup_directory.is_dir():
        raise SwapError("service cgroup path is not a real directory")
    for current, directories, files in os.walk(cgroup_directory, followlinks=False):
        directory = Path(current)
        if any((directory / name).is_symlink() for name in directories):
            raise SwapError("service cgroup contains an unexpected symlinked child")
        if "cgroup.events" in files:
            events = (directory / "cgroup.events").read_text(encoding="ascii").splitlines()
            populated = [line.split() for line in events if line.startswith("populated ")]
            if len(populated) != 1 or len(populated[0]) != 2 or populated[0][1] not in {"0", "1"}:
                raise SwapError("cannot parse service cgroup populated state")
            if populated[0][1] == "1":
                return False
        if "cgroup.procs" in files:
            pids = (directory / "cgroup.procs").read_text(encoding="ascii").strip()
            if pids:
                return False
    return True


def stop_service(unit: str, timeout: float) -> None:
    require_systemctl("stop", unit, timeout=timeout)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if service_stopped(unit):
            return
        time.sleep(0.1)
    raise SwapError("service stop timed out or left processes in its cgroup")


def start_service(unit: str, timeout: float) -> None:
    require_systemctl("start", unit, timeout=timeout)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = run_systemctl("is-active", unit, timeout=20.0)
        if result.returncode == 0 and result.stdout.strip() == "active":
            return
        time.sleep(0.1)
    raise SwapError("service did not become active before startup deadline")


def validate_health_url(url: str) -> None:
    try:
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port
    except ValueError as error:
        raise SwapError("health URL is malformed") from error
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"}
            or parsed.username is not None or parsed.password is not None
            or parsed.fragment or port is None or not 1 <= port <= 65535):
        raise SwapError("health URL must use an explicit loopback HTTP port without credentials or fragment")


class RejectHealthRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request: urllib.request.Request, response: BinaryIO, code: int,
                         message: str, headers: Message, new_url: str) -> None:
        raise urllib.error.HTTPError(request.full_url, code, "health redirect rejected", headers, response)


@contextmanager
def health_deadline(seconds: float) -> Iterator[None]:
    # This CLI runs on the main thread. An absolute timer also bounds trickled
    # headers/body bytes, which urllib's socket inactivity timeout cannot do.
    if signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0):
        raise SwapError("cannot share an existing process alarm with the health deadline")
    previous_handler = signal.getsignal(signal.SIGALRM)

    def expire(_signum: int, _frame: FrameType | None) -> None:
        raise SwapError("absolute health deadline exceeded")

    signal.signal(signal.SIGALRM, expire)
    try:
        signal.setitimer(signal.ITIMER_REAL, seconds)
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0.0)
        signal.signal(signal.SIGALRM, previous_handler)


def check_health(url: str, deadline_seconds: float, expected_revision: str | None, expected_body: dict[str, object] | None) -> dict[str, object]:
    validate_health_url(url)
    deadline = time.monotonic() + deadline_seconds
    last_error = "no response"
    with health_deadline(deadline_seconds):
        while time.monotonic() < deadline:
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "route-b-local-health/1"}, method="GET")
                with urllib.request.build_opener(urllib.request.ProxyHandler({}), RejectHealthRedirect()).open(request, timeout=min(2.0, max(0.1, deadline - time.monotonic()))) as response:
                    if response.status != 200:
                        last_error = f"HTTP {response.status}"
                    else:
                        try:
                            raw = response.read(8193)
                            if len(raw) > 8192:
                                raise ValueError("health body exceeds 8192 bytes")
                            payload = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_json_fields)
                        except (UnicodeError, json.JSONDecodeError, ValueError, RecursionError):
                            last_error = "invalid JSON body"
                        else:
                            if not isinstance(payload, dict) or not set(payload).issubset({"status", "revision"}) or payload.get("status") != "ok":
                                last_error = "unexpected health body"
                            else:
                                revision = payload.get("revision")
                                if revision is not None and (not isinstance(revision, str) or re.fullmatch(r"[0-9a-f]{40}", revision) is None):
                                    last_error = "invalid health revision"
                                elif expected_revision is not None and payload != {"status": "ok", "revision": expected_revision}:
                                    last_error = "candidate release identity mismatch"
                                elif expected_body is not None and payload != expected_body:
                                    last_error = "legacy baseline health mismatch"
                                else:
                                    return payload
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                last_error = type(error).__name__
            time.sleep(min(0.2, max(0.0, deadline - time.monotonic())))
    raise SwapError(f"health check exceeded {deadline_seconds:g}s ({last_error})")

def checked_paths(install: Path, candidate: Path, journal: Path, unit: str, health_url: str, timeout: int, expected_revision: str) -> dict[str, Any]:
    install = install.absolute()
    candidate = candidate.absolute()
    journal = journal.absolute()
    validate_transaction_parent(install.parent)
    if not re.fullmatch(r"[A-Za-z0-9_.@:-]+\.service", unit):
        raise SwapError("unit must be an explicit systemd service name")
    if re.fullmatch(r"[0-9a-f]{40}", expected_revision) is None:
        raise SwapError("expected candidate release revision must be a lowercase full 40-character SHA")
    validate_health_url(health_url)
    if not 1 <= timeout <= 300:
        raise SwapError("health timeout must be between 1 and 300 seconds")
    if install.parent != candidate.parent or install.parent != journal.parent:
        raise SwapError("install, candidate, and journal must be siblings on one filesystem")
    if install == candidate or install == journal or candidate == journal:
        raise SwapError("install, candidate, and journal paths must be distinct")
    if install.name in {"", ".", ".."} or candidate.name in {"", ".", ".."}:
        raise SwapError("invalid tree path")
    for path in (install, candidate, journal):
        if path.is_symlink():
            raise SwapError(f"symlink path is not allowed: {path}")
    if not install.is_dir() or not candidate.is_dir():
        raise SwapError("install and candidate must be existing directories")
    if os.stat(install).st_dev != os.stat(candidate).st_dev or os.stat(install.parent).st_dev != os.stat(candidate.parent).st_dev:
        raise SwapError("install and candidate must be on the same filesystem")
    transaction = uuid.uuid4().hex
    preserved = install.with_name(f".{install.name}.route-b-old-{transaction}")
    quarantine = install.with_name(f".{install.name}.route-b-failed-{transaction}")
    if preserved.exists() or quarantine.exists():
        raise SwapError("generated transaction tree already exists")
    baseline_health = check_health(health_url, float(timeout), None, None)
    return {"schema": "corgi-legacy-swap/v1", "phase": "intent", "install": str(install), "candidate": str(candidate), "preserved": str(preserved), "quarantine": str(quarantine), "unit": unit, "health_url": health_url, "timeout_seconds": timeout, "old_sha256": tree_digest(install), "candidate_sha256": tree_digest(candidate), "old_identity": directory_identity(install), "candidate_identity": directory_identity(candidate), "expected_revision": expected_revision, "baseline_health": baseline_health, "transaction": transaction}


def checked_tree(path: Path, expected: str, label: str) -> None:
    if not path.exists():
        raise SwapError(f"{label} tree is missing; retain all transaction state for operator inspection")
    if tree_digest(path) != expected:
        raise SwapError(f"{label} tree identity changed; retain all trees for operator inspection")


def install_lock_path(install: Path) -> Path:
    parent = install.parent
    validate_transaction_parent(parent)
    if install.name in {"", ".", ".."}:
        raise SwapError("install path has an invalid directory name")
    return parent / f".{install.name}.route-b.lock"


def recover_locked(journal_path: Path, allow_committed: bool, locked_install: Path) -> None:
    entry = read_journal(journal_path)
    if Path(entry["install"]) != locked_install:
        raise SwapError("journal install path changed while acquiring the install lock; no recovery action taken")
    install = Path(entry["install"])
    preserved = Path(entry["preserved"])
    quarantine = Path(entry["quarantine"])
    unit = str(entry["unit"])
    old_hash = str(entry["old_sha256"])
    if entry["phase"] == "rolled_back":
        raise SwapError("transaction is already rolled back; no recovery action taken")
    if entry["phase"] == "committed" and not allow_committed:
        raise SwapError("transaction is committed; use explicit rollback after verifying scoring and feature behavior")
    write_journal(journal_path, {**entry, "phase": "recovering"})
    stop_service(unit, SERVICE_STOP_TIMEOUT_SECONDS)
    restored_preserved = preserved.exists()
    if restored_preserved:
        checked_identity(preserved, entry["old_identity"], "preserved old install")
        checked_tree(preserved, old_hash, "preserved old install")
        if install.exists():
            checked_identity(install, entry["candidate_identity"], "candidate install")
            if quarantine.exists():
                raise SwapError("quarantine path already exists; retain trees for operator inspection")
            os.rename(install, quarantine)
            checked_identity(quarantine, entry["candidate_identity"], "quarantined candidate")
            fsync_directory(install.parent)
        os.rename(preserved, install)
        fsync_directory(install.parent)
    elif not install.exists():
        raise SwapError("both install and preserved old copy are missing; operator recovery required")
    else:
        checked_identity(install, entry["old_identity"], "install")
    if quarantine.exists():
        checked_identity(quarantine, entry["candidate_identity"], "quarantined candidate")
    if restored_preserved:
        checked_tree(install, old_hash, "restored old install")
    start_service(unit, SERVICE_START_TIMEOUT_SECONDS)
    check_health(str(entry["health_url"]), float(entry["timeout_seconds"]), None, entry["baseline_health"])
    write_journal(journal_path, {**entry, "phase": "rolled_back"})


def recover(journal_path: Path, allow_committed: bool) -> None:
    initial_entry = read_journal(journal_path)
    install = Path(initial_entry["install"])
    lock_path = install_lock_path(install)
    with transaction_lock(lock_path):
        recover_locked(journal_path, allow_committed, install)


def apply(entry: dict[str, Any], journal_path: Path) -> None:
    install = Path(entry["install"])
    candidate = Path(entry["candidate"])
    preserved = Path(entry["preserved"])
    stop_service(str(entry["unit"]), SERVICE_STOP_TIMEOUT_SECONDS)
    checked_identity(install, entry["old_identity"], "old install")
    # The running old app may write before shutdown; bind its stopped tree.
    entry["old_sha256"] = tree_digest(install)
    entry["phase"] = "stopped"
    write_journal(journal_path, entry)
    checked_identity(candidate, entry["candidate_identity"], "candidate")
    if tree_digest(install) != entry["old_sha256"] or tree_digest(candidate) != entry["candidate_sha256"]:
        raise SwapError("install or candidate changed before stopped-service rename")
    os.rename(install, preserved)
    fsync_directory(install.parent)
    entry["phase"] = "old_preserved"
    write_journal(journal_path, entry)
    os.rename(candidate, install)
    fsync_directory(install.parent)
    entry["phase"] = "candidate_installed"
    write_journal(journal_path, entry)
    start_service(str(entry["unit"]), SERVICE_START_TIMEOUT_SECONDS)
    entry["phase"] = "candidate_started"
    write_journal(journal_path, entry)
    check_health(str(entry["health_url"]), float(entry["timeout_seconds"]), str(entry["expected_revision"]), None)
    entry["phase"] = "committed"
    write_journal(journal_path, entry)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="operation", required=True)
    start = subparsers.add_parser("apply")
    start.add_argument("--install", type=Path, required=True)
    start.add_argument("--candidate", type=Path, required=True)
    start.add_argument("--journal", type=Path, required=True)
    start.add_argument("--unit", required=True)
    start.add_argument("--health-url", required=True)
    start.add_argument("--health-timeout", type=int, default=30)
    start.add_argument("--expected-revision", required=True)
    resume = subparsers.add_parser("recover")
    resume.add_argument("--journal", type=Path, required=True)
    rollback = subparsers.add_parser("rollback")
    rollback.add_argument("--journal", type=Path, required=True)
    arguments = parser.parse_args()
    if arguments.operation in {"recover", "rollback"}:
        journal_path = arguments.journal.absolute()
        recover(journal_path, allow_committed=arguments.operation == "rollback")
        print("legacy install restored and baseline health verified")
        return 0
    install_path = arguments.install.absolute()
    lock_path = install_lock_path(install_path)
    journal_path = arguments.journal.absolute()
    with transaction_lock(lock_path):
        entry = checked_paths(install_path, arguments.candidate, journal_path, arguments.unit, arguments.health_url, arguments.health_timeout, arguments.expected_revision)
        if journal_path.exists():
            raise SwapError("journal already exists; use recover only after inspecting transaction status")
        write_journal(journal_path, entry)
        try:
            apply(entry, journal_path)
        except (Exception, KeyboardInterrupt) as error:
            try:
                recover_locked(journal_path, allow_committed=False, locked_install=install_path)
            except (Exception, KeyboardInterrupt) as recovery_error:
                print(f"swap failed and bounded rollback failed ({type(recovery_error).__name__}); durable journal and trees retained for operator recovery", file=sys.stderr)
            else:
                print("swap failed; original install restored and baseline health verified", file=sys.stderr)
            raise
    print(f"swap committed; preserved old install: {entry['preserved']}")
    return 0


if __name__ == "__main__":
    def interrupt(_signum: int, _frame: FrameType | None) -> None:
        raise KeyboardInterrupt()

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGHUP, interrupt)
    try:
        raise SystemExit(main())
    except SwapError as error:
        print(f"route-b-swap: {error}", file=sys.stderr)
        raise SystemExit(2) from error
