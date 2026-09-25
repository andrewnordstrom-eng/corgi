"""Native image CMD/readiness qualification against disposable B-schema stores."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import time
from typing import Any
import uuid


POSTGRES_IMAGE = "postgres:16@sha256:a85daf0dbd5e79586e850e3fe4b21b796799828ad015ce2166aeb98cc24da61c"
REDIS_IMAGE = "redis:7-alpine@sha256:ca0acbb137c1dc3339c8b147a58fd6f42775d4599327b50e7b116c23de501af2"
SERVICE_CONFIGS = {
    POSTGRES_IMAGE: "sha256:1b3c642526f8d274b12bdcd93b90aeb7e68a1f59eb20613adb96ed561c01d98c",
    REDIS_IMAGE: "sha256:f84b0c4678011602b9b98c227a4dcd5468bf8b088b02fdd4165cb7758bad8058",
}
MAX_OUTPUT_BYTES = 2_000_000
LABEL = "corgi.runtime-smoke"


class QualificationError(RuntimeError):
    """A source, runtime or cleanup condition failed."""


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Smoke:
    def __init__(self, source: Path, output: Path, image: str, revision: str) -> None:
        self.source = source
        self.output = output
        self.image = image
        self.revision = revision
        self.owner = uuid.uuid4().hex
        self.prefix = "corgi-b-runtime-" + self.owner
        self.sequence = 0
        self.deadline = time.monotonic() + 480
        self.containers: dict[str, str] = {}
        self.network = ""
        self.commands: list[dict[str, Any]] = []
        self.receipt: dict[str, Any] = {"status": "RUNNING", "owner": self.owner,
            "source": str(source), "revision": revision, "image_id": image,
            "harness_sha256": sha256(Path(__file__)), "scope": "IMAGE_CMD_DEPENDENCY_READINESS_ONLY"}

    def command(self, args: list[str], timeout: int, env: dict[str, str] | None) -> str:
        self.sequence += 1
        log = self.output / f"command-{self.sequence:03d}.log"
        limit = min(timeout, max(0, self.deadline - time.monotonic()))
        if limit <= 0:
            raise QualificationError(f"Total fixture deadline exhausted before {args[:3]}")
        started = time.monotonic()
        primary_error: BaseException | None = None
        process_errors: list[str] = []
        code: int | None = None
        failure = ""
        with log.open("xb") as handle:
            process = subprocess.Popen(args, cwd=self.source, env=env, stdout=handle,
                stderr=subprocess.STDOUT, start_new_session=True)
            try:
                while process.poll() is None:
                    if time.monotonic() - started > limit:
                        failure = f"command exceeded {limit:.1f}s"
                        break
                    if log.stat().st_size > MAX_OUTPUT_BYTES:
                        failure = "command output exceeded bound"
                        break
                    time.sleep(0.05)
            except BaseException as error:
                primary_error = error
            finally:
                # The process group belongs exclusively to this invocation.
                # Signal-handler exceptions must not leave a CLI/migration alive.
                if primary_error is not None or failure or process.poll() is None:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        process_errors.append("Process group exited before termination observation")
                    except OSError as error:
                        process_errors.append(f"Process group termination failed: {error}")
                try:
                    code = process.wait(timeout=10)
                except (OSError, subprocess.SubprocessError) as error:
                    process_errors.append(f"Owned process reap failed: {error}")
        too_large = log.stat().st_size > MAX_OUTPUT_BYTES
        if too_large:
            with log.open("r+b") as handle:
                handle.truncate(MAX_OUTPUT_BYTES)
        self.commands.append({"argv": args, "exit": code, "failure": failure,
            "primary_error": str(primary_error) if primary_error else "",
            "process_cleanup_errors": process_errors, "output_truncated": too_large, "log": log.name, "sha256": sha256(log)})
        text = log.read_text(errors="replace")
        if primary_error is not None:
            raise primary_error
        if code != 0 or failure or too_large or process_errors:
            raise QualificationError(f"Command {args[:3]} failed exit={code}: {failure}; cleanup={process_errors}; log={log}")
        return text.strip()

    def docker(self, args: list[str], timeout: int) -> str:
        return self.command(["docker", *args], timeout, None)

    def inspect(self, kind: str, identity: str) -> dict[str, Any]:
        rows = json.loads(self.docker([kind, "inspect", identity], 15))
        if len(rows) != 1:
            raise QualificationError(f"Expected one {kind} identity: {identity}")
        return rows[0]

    def inventory(self) -> dict[str, list[str]]:
        return {
            "containers": sorted(self.docker(["container", "ls", "-a", "--no-trunc", "--format", "{{.ID}} {{.State}}"], 15).splitlines()),
            "networks": sorted(self.docker(["network", "ls", "--no-trunc", "--format", "{{.ID}}"], 15).splitlines()),
            "volumes": sorted(self.docker(["volume", "ls", "--format", "{{.Name}}"], 15).splitlines()),
            "images": sorted(set(self.docker(["image", "ls", "--no-trunc", "--quiet"], 15).splitlines())),
        }

    def source_manifest(self) -> dict[str, str]:
        if self.command(["git", "rev-parse", "HEAD"], 10, None) != self.revision:
            raise QualificationError("Source HEAD differs from expected immutable revision")
        self.command(["git", "diff", "--exit-code", "HEAD", "--"], 10, None)
        paths = self.command(["git", "ls-files", "-z"], 10, None).split("\0")
        return {name: sha256(self.source / name) for name in paths if name}

    def create(self, role: str, image: str, options: list[str], command: list[str]) -> str:
        name = self.prefix + "-" + role
        if self.docker(["container", "ls", "-aq", "--filter", "name=^/" + name + "$"], 15):
            raise QualificationError(f"Fixture container name already exists: {name}")
        identity = self.docker(["create", "--pull", "never", "--name", name,
            "--label", LABEL + "=" + self.owner, "--network", self.network,
            "--network-alias", role, *options, image, *command], 30)
        if not re.fullmatch(r"[0-9a-f]{64}", identity):
            raise QualificationError(f"Invalid created container ID for {role}")
        self.containers[role] = identity
        self.docker(["start", identity], 30)
        return identity

    def poll_command(self, args: list[str], expected: str) -> None:
        deadline = time.monotonic() + 60
        last_error = ""
        while time.monotonic() < deadline:
            try:
                if self.docker(args, 10) == expected:
                    return
                last_error = "unexpected successful output"
            except QualificationError as error:
                last_error = str(error)
            print(f"Waiting for fixture dependency: {last_error}", flush=True)
            time.sleep(1)
        raise QualificationError(f"Fixture dependency never became ready: {last_error}")

    def stable_process(self) -> tuple[int, int, str]:
        app = self.inspect("container", self.containers["app"])
        if not app["State"]["Running"]:
            raise QualificationError("Application stopped during readiness qualification")
        return app["State"]["Pid"], app["RestartCount"], app["State"]["StartedAt"]

    def health(self, status: int, body: str) -> None:
        script = "const r=await fetch('http://127.0.0.1:3000/health/ready',{signal:AbortSignal.timeout(7000)});console.log(JSON.stringify([r.status,(await r.json()).status]));"
        self.poll_command(["exec", self.containers["app"], "node", "--input-type=module", "-e", script], json.dumps([status, body], separators=(",", ":")))
        self.receipt.setdefault("health_transitions", []).append({"http_status": status, "body": body, "process": self.stable_process()})

    def run(self) -> None:
        self.receipt["source_before"] = self.source_manifest()
        if self.receipt["source_before"].get("tests/harness/route-b-runtime-image-smoke.py") != self.receipt["harness_sha256"]:
            raise QualificationError("Executed harness is not the candidate-tracked source")
        runtime = self.command(["node", "--input-type=module", "-e", "import assert from 'node:assert/strict';assert.equal(process.version,'v22.23.2');assert.equal(process.versions.modules,'127');assert.equal(process.arch,'x64');assert.equal(process.platform,'linux');console.log(JSON.stringify({node:process.version,abi:process.versions.modules,arch:process.arch}));"], 10, None)
        self.receipt["host_runtime"] = json.loads(runtime)
        self.receipt["before"] = self.inventory()
        image = self.inspect("image", self.image)
        if image["Id"] != self.image or image["Architecture"] != "amd64" or image["Os"] != "linux":
            raise QualificationError("Application image identity/platform mismatch")
        if image["Config"]["Labels"].get("org.opencontainers.image.revision") != self.revision:
            raise QualificationError("Application image source label mismatch")
        if image["Config"]["User"] != "appuser" or image["Config"]["Cmd"] != ["sh", "-c", "sh /app/scripts/check-legal-docs.sh /app/legal && exec node dist/index.js"]:
            raise QualificationError("Ordinary B application command/user changed")
        self.receipt["application_config"] = {key: image["Config"].get(key) for key in ["User", "Cmd", "Entrypoint", "Healthcheck"]}
        for reference, config_id in SERVICE_CONFIGS.items():
            self.docker(["pull", "--platform", "linux/amd64", reference], 120)
            store = self.inspect("image", reference)
            if store["Id"] != config_id or store["Architecture"] != "amd64" or store["Os"] != "linux":
                raise QualificationError(f"Pinned service image identity mismatch: {reference}")
        self.network = self.docker(["network", "create", "--internal", "--label", LABEL + "=" + self.owner, self.prefix], 30)
        if not self.inspect("network", self.network)["Internal"]:
            raise QualificationError("Fixture network is not internal")
        pg = self.create("postgres", SERVICE_CONFIGS[POSTGRES_IMAGE], ["--tmpfs", "/var/lib/postgresql/data:rw,nosuid,size=512m", "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=synthetic", "--env", "POSTGRES_PASSWORD=synthetic", "--env", "POSTGRES_DB=fixture"], [])
        for role in ["redis", "demo-redis"]:
            self.create(role, SERVICE_CONFIGS[REDIS_IMAGE], ["--tmpfs", "/data:rw,nosuid,size=32m"], ["redis-server", "--save", "", "--appendonly", "no"])
            self.poll_command(["exec", self.containers[role], "redis-cli", "PING"], "PONG")
        self.poll_command(["exec", pg, "pg_isready", "-U", "synthetic", "-d", "fixture", "-q"], "")
        port = self.inspect("container", pg)["NetworkSettings"]["Ports"]["5432/tcp"]
        if (not isinstance(port, list) or len(port) != 1 or not isinstance(port[0], dict)
                or port[0].get("HostIp") != "127.0.0.1"):
            raise QualificationError("PostgreSQL fixture port is not uniquely loopback-bound")
        host_port = port[0].get("HostPort")
        if not isinstance(host_port, str) or not host_port.isdecimal() or not 1 <= int(host_port) <= 65535:
            raise QualificationError("PostgreSQL fixture host port is missing or invalid")
        env = {"PATH": os.environ["PATH"], "NODE_ENV": "test", "DATABASE_URL": f"postgresql://synthetic:synthetic@127.0.0.1:{host_port}/fixture"}
        self.command(["node", "--import", "tsx", "scripts/migrate.ts"], 120, env)
        files = sorted((self.source / "src/db/migrations").glob("*.sql"))
        applied = self.docker(["exec", pg, "psql", "-U", "synthetic", "-d", "fixture", "-At", "-c", "SELECT filename FROM schema_migrations ORDER BY filename"], 15).splitlines()
        if sorted(applied) != [p.name for p in files] or len(files) != 34 or max(int(p.name.split("_")[0]) for p in files) != 34:
            raise QualificationError("Actual fixture schema differs from complete B34 migration set")
        self.receipt["migrations"] = {p.name: sha256(p) for p in files}
        environment = {"NODE_ENV": "production", "FEEDGEN_SERVICE_DID": "did:web:fixture.invalid", "FEEDGEN_PUBLISHER_DID": "did:plc:fixture", "FEEDGEN_HOSTNAME": "fixture.invalid", "FEEDGEN_PORT": "3000", "FEEDGEN_LISTENHOST": "0.0.0.0", "JETSTREAM_URL": "wss://fixture.invalid", "JETSTREAM_FALLBACK_URL": "wss://fallback.invalid", "JETSTREAM_COLLECTIONS": "app.bsky.feed.post", "DATABASE_URL": "postgresql://synthetic:synthetic@postgres:5432/fixture", "REDIS_URL": "redis://redis:6379", "DEMO_REDIS_URL": "redis://demo-redis:6379", "DEMO_RATE_LIMIT_HASH_SECRET": "synthetic-runtime-demo-salt-never-a-secret", "EXPORT_ANONYMIZATION_SALT": "synthetic-runtime-export-salt-never-a-secret", "BSKY_IDENTIFIER": "fixture.invalid", "BSKY_APP_PASSWORD": "synthetic-placeholder", "BOT_ENABLED": "false", "TOPIC_EMBEDDING_ENABLED": "false", "INGESTION_GATE_ENABLED": "false", "RATE_LIMIT_ENABLED": "true", "LOG_LEVEL": "info"}
        options = ["--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"]
        for key, value in environment.items():
            options.extend(["--env", key + "=" + value])
        self.create("app", self.image, options, [])
        self.health(200, "ready")
        demo_before = self.inspect("container", self.containers["demo-redis"])
        process = self.stable_process()
        time.sleep(5)
        if self.stable_process() != process:
            raise QualificationError("Application restarted during stability interval")
        startup_deadline = time.monotonic() + 60
        while True:
            logs = self.docker(["logs", "--tail", "2000", self.containers["app"]], 15)
            if "All startup checks passed" in logs and "All systems operational" in logs:
                break
            if time.monotonic() >= startup_deadline or self.stable_process() != process:
                raise QualificationError("Ordinary application startup did not complete without restart")
            time.sleep(1)
        self.docker(["stop", "--time", "10", self.containers["redis"]], 20)
        self.health(503, "not ready")
        if self.stable_process() != process:
            raise QualificationError("Application restarted during Redis outage")
        self.docker(["start", self.containers["redis"]], 20)
        self.health(200, "ready")
        if self.stable_process() != process:
            raise QualificationError("Application restarted during Redis recovery")
        self.poll_command(["exec", self.containers["demo-redis"], "redis-cli", "PING"], "PONG")
        demo_after = self.inspect("container", self.containers["demo-redis"])
        if demo_before["State"]["StartedAt"] != demo_after["State"]["StartedAt"] or demo_before["RestartCount"] != demo_after["RestartCount"]:
            raise QualificationError("Demo Redis restarted during main Redis failure segment")
        self.receipt["source_after"] = self.source_manifest()
        if self.receipt["source_before"] != self.receipt["source_after"]:
            raise QualificationError("Source changed during runtime qualification")

    def cleanup(self) -> list[str]:
        errors = []
        self.deadline = time.monotonic() + 120
        for kind in ["container", "network"]:
            try:
                identities = self.docker([kind, "ls", "--quiet", "--filter", "label=" + LABEL + "=" + self.owner, *(["--all"] if kind == "container" else [])], 15).splitlines()
            except (QualificationError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
                errors.append(f"{kind} ownership observation: {error}")
                continue
            for identity in identities:
                try:
                    item = self.inspect(kind, identity)
                    labels = item["Config"]["Labels"] if kind == "container" else item["Labels"]
                    expected_names = {"/" + self.prefix + "-" + role for role in ["postgres", "redis", "demo-redis", "app"]} if kind == "container" else {self.prefix}
                    if labels.get(LABEL) != self.owner or item["Name"] not in expected_names:
                        raise QualificationError(f"Refusing cleanup of foreign {kind}: {identity}")
                    self.docker([kind, "rm", *(["--force", "--volumes"] if kind == "container" else []), item["Id"]], 20)
                except (QualificationError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
                    errors.append(f"{kind} {identity}: {error}")
        try:
            after = self.inventory()
            self.receipt["after"] = after
            if "before" in self.receipt:
                for kind in ["containers", "networks", "volumes"]:
                    if after[kind] != self.receipt["before"][kind]:
                        errors.append(f"Inventory changed after cleanup: {kind}")
                allowed = set(self.receipt["before"]["images"]) | set(SERVICE_CONFIGS.values())
                if set(after["images"]) - allowed or set(self.receipt["before"]["images"]) - set(after["images"]):
                    errors.append("Unexpected image inventory change")
        except (QualificationError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            errors.append(f"Final inventory observation: {error}")
        return errors


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--expected-sha", required=True)
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    if output.is_relative_to(source) or not re.fullmatch(r"sha256:[0-9a-f]{64}", args.image_id) or not re.fullmatch(r"[0-9a-f]{40}", args.expected_sha):
        raise ValueError("Explicit immutable image/source identities and output outside checkout required")
    if platform.system() != "Linux" or platform.machine() not in {"x86_64", "AMD64"}:
        raise QualificationError("Native Linux x64 runner required; no Docker action attempted")
    output.mkdir(parents=True, exist_ok=False)
    smoke = Smoke(source, output, args.image_id, args.expected_sha)
    failure = "incomplete smoke run"
    def interrupted(signum: int, frame: object) -> None:
        raise QualificationError(f"Fixture interrupted by signal {signum}")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        smoke.run()
        failure = ""
    except (QualificationError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        failure = f"{type(error).__name__}: {error}"
    finally:
        cleanup_errors = smoke.cleanup()
        smoke.receipt.update({"status": "FAIL" if failure or cleanup_errors else "PASS_IMAGE_CMD_DEPENDENCY_READINESS_ONLY", "primary_error": failure, "cleanup_errors": cleanup_errors, "commands": smoke.commands, "owned_container_ids": smoke.containers, "owned_network_id": smoke.network})
        (output / "receipt.json").write_text(json.dumps(smoke.receipt, indent=2) + "\n")
        print(json.dumps({"status": smoke.receipt["status"], "receipt": str(output / "receipt.json"), "sha256": sha256(output / "receipt.json"), "primary_error": failure, "cleanup_errors": cleanup_errors}))
    if failure or cleanup_errors:
        raise QualificationError("Image startup qualification failed; see bounded receipt")


if __name__ == "__main__":
    main()
