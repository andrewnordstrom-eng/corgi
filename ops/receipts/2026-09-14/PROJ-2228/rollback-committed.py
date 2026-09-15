from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


DOCKER = "/Applications/Docker.app/Contents/Resources/bin/docker"
OUT = Path("/private/tmp/corgi-2228-validation/rollback-committed.json")
SMOKE_RESOURCES = Path("/private/tmp/corgi-2228-validation/smoke-resources.json")
NETWORK = "corgi-2228-runtime-smoke"
NETWORK_ID = "1d1fd54c5d476d1e8f8a2cbcac1ac0fee75d8023aa43947d95220d9857b96c25"
B_NAME = "corgi-2228-app-b"
B_CONTAINER_ID = "ac4fa11f2c4284f30086eb585bbd79cdd2366925b6f5e296c40022a22666b4ef"
B_IMAGE_ID = "sha256:64532fa96ce105f66bfd5bed951e17c1b71e9d70574c0e481d848258a4eecc72"
B_REVISION = "c880755d234d15d1df290cecea0ac0d3315e9571"
A_TAG = "corgi-2228:committed-a"
A_REVISION = "e4ff4bbdf04e07bd23956752ce08d61f99c4daa4"
A_NAME = "corgi-2228-app-a"
PG_NAME = "corgi-2228-pg"
EXPECTED_MIGRATIONS = 34
DOCKER_TIMEOUT_SECONDS = 30

SETTINGS = {
    "NODE_ENV": "production",
    "FEEDGEN_SERVICE_DID": "did:web:localhost",
    "FEEDGEN_PUBLISHER_DID": "did:web:localhost",
    "FEEDGEN_HOSTNAME": "localhost",
    "FEEDGEN_LISTENHOST": "0.0.0.0",
    "FEEDGEN_PORT": "3000",
    "JETSTREAM_URL": "ws://127.0.0.1:9/subscribe",
    "JETSTREAM_FALLBACK_URL": "ws://127.0.0.1:9/subscribe",
    "JETSTREAM_COLLECTIONS": "app.bsky.feed.post,app.bsky.feed.like",
    "DATABASE_URL": "postgresql://postgres@postgres:5432/community_feed",
    "REDIS_URL": "redis://redis:6379",
    "DEMO_REDIS_URL": "redis://demo-redis:6379",
    "DEMO_RATE_LIMIT_HASH_SECRET": "public-local-smoke-demo-value-0001",
    "EXPORT_ANONYMIZATION_SALT": "public-local-smoke-export-value-0001",
    "BSKY_IDENTIFIER": "",
    "BSKY_APP_PASSWORD": "",
    "BOT_ENABLED": "false",
    "TOPIC_EMBEDDING_ENABLED": "false",
    "INGESTION_GATE_ENABLED": "false",
}


class DockerTimeoutError(RuntimeError):
    pass


class DockerCommandError(RuntimeError):
    pass


def safe_operation(arguments: list[str]) -> str:
    sanitized: list[str] = []
    redact_next = False
    for argument in arguments:
        if redact_next:
            sanitized.append("<redacted>")
            redact_next = False
        elif argument == "--env":
            sanitized.append(argument)
            redact_next = True
        else:
            sanitized.append(argument)
    return " ".join(sanitized)


def docker(arguments: list[str], check: bool) -> subprocess.CompletedProcess[str]:
    operation = safe_operation(arguments)
    try:
        return subprocess.run(
            [DOCKER, *arguments],
            capture_output=True,
            text=True,
            check=check,
            timeout=DOCKER_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise DockerTimeoutError(f"Docker operation timed out: {operation}") from error
    except subprocess.CalledProcessError as error:
        raise DockerCommandError(f"Docker operation failed with exit {error.returncode}: {operation}") from error


def docker_json(arguments: list[str]) -> Any:
    result = docker(arguments, True)
    return json.loads(result.stdout)


def timestamp() -> float:
    return time.time()


def record_step(record: dict[str, Any], name: str, value: Any) -> None:
    record.setdefault("steps", {})[name] = {"time": timestamp(), "result": value}
    OUT.write_text(json.dumps(record, indent=2) + "\n")


def inspect_container(name: str) -> dict[str, Any]:
    containers = docker_json(["container", "inspect", name])
    if not isinstance(containers, list) or len(containers) != 1:
        raise RuntimeError(f"Expected one container inspection for {name}")
    value = containers[0]
    if not isinstance(value, dict):
        raise RuntimeError(f"Malformed container inspection for {name}")
    return value


def assert_candidate_name_absent() -> None:
    result = docker(
        ["ps", "-a", "--filter", f"name=^{A_NAME}$", "--format", "{{.ID}}"],
        True,
    )
    if result.stdout.strip():
        raise RuntimeError(f"Candidate container name already exists: {A_NAME}")


def run_candidate(run_arguments: list[str], expected_image_id: str) -> str:
    try:
        return docker(run_arguments, True).stdout.strip()
    except Exception as run_error:
        try:
            ambiguous_candidate = inspect_container(A_NAME)
        except Exception as inspect_error:
            raise run_error from inspect_error
        if ambiguous_candidate.get("Image") != expected_image_id:
            raise RuntimeError(
                "Candidate run failed and the named container is not the expected immutable image"
            ) from run_error
        raise run_error


def exec_text(name: str, arguments: list[str]) -> str:
    result = docker(["exec", name, *arguments], True)
    return result.stdout.strip()


def app_probe(name: str, endpoint: str, timeout_ms: int) -> dict[str, Any]:
    script = (
        "const endpoint = process.argv[1];"
        "try {"
        f" const response = await fetch(endpoint, {{ signal: AbortSignal.timeout({timeout_ms}) }});"
        " const body = await response.text();"
        " console.log(JSON.stringify({kind:'http',status:response.status,body}));"
        "} catch (error) {"
        " console.log(JSON.stringify({kind:error?.name === 'TimeoutError' ? 'timeout' : 'transport',"
        "error:String(error)}));"
        "}"
    )
    result = docker(["exec", name, "node", "--input-type=module", "-e", script, endpoint], False)
    output = result.stdout.strip().splitlines()
    if not output:
        raise RuntimeError(f"Probe produced no output for {name} {endpoint}: {result.stderr.strip()}")
    value = json.loads(output[-1])
    if not isinstance(value, dict):
        raise RuntimeError(f"Malformed probe output for {name} {endpoint}")
    return value


def wait_for_readiness(name: str) -> dict[str, Any]:
    deadline = time.monotonic() + 45
    last_probe: dict[str, Any] = {}
    while time.monotonic() < deadline:
        last_probe = app_probe(name, "http://127.0.0.1:3000/health/ready", 10_000)
        if last_probe.get("kind") == "http" and last_probe.get("status") == 200:
            return last_probe
        time.sleep(1)
    raise RuntimeError(f"{name} did not become ready within 45 seconds: {last_probe}")


def runtime_identity(name: str, expected_revision: str) -> dict[str, Any]:
    inspection = inspect_container(name)
    image_id = inspection.get("Image")
    native_uid = exec_text(name, ["id", "-u"])
    if native_uid != "1001":
        raise RuntimeError(f"{name} native UID mismatch: expected 1001, got {native_uid}")
    node_version = exec_text(name, ["node", "-p", "process.version"])
    if node_version != "v22.23.2":
        raise ValueError(f"{name} Node version mismatch: {node_version}")
    node_abi = exec_text(name, ["node", "-p", "process.versions.modules"])
    if node_abi != "127":
        raise RuntimeError(f"{name} Node ABI mismatch: expected 127, got {node_abi}")
    native_imports = exec_text(
        name,
        [
            "node",
            "--input-type=module",
            "-e",
            "await import('sharp'); await import('onnxruntime-node'); console.log('ok');",
        ],
    )
    if native_imports != "ok":
        raise RuntimeError(f"{name} native import probe failed: {native_imports}")
    readiness_probe = wait_for_readiness(name)
    health_probe = app_probe(name, "http://127.0.0.1:3000/health", 10_000)
    if health_probe.get("kind") != "http":
        raise RuntimeError(f"Health transport failure for {name}: {health_probe}")
    health_body = json.loads(str(health_probe.get("body", "{}")))
    revision = health_body.get("revision")
    if revision != expected_revision:
        raise RuntimeError(f"{name} revision mismatch: expected {expected_revision}, got {revision}")
    if readiness_probe.get("kind") != "http" or readiness_probe.get("status") != 200:
        raise RuntimeError(f"{name} readiness failure: {readiness_probe}")
    return {
        "container_id": inspection.get("Id"),
        "image_id": image_id,
        "native_uid": native_uid,
        "node_abi": node_abi,
        "native_imports": native_imports,
        "health": health_probe,
        "revision": revision,
        "readiness": readiness_probe,
    }


def migration_identity() -> dict[str, Any]:
    raw = exec_text(PG_NAME, ["psql", "-U", "postgres", "-d", "community_feed", "-Atc", "SELECT count(*),max(filename) FROM schema_migrations"])
    fields = raw.split("|")
    if len(fields) != 2 or not fields[0].isdigit():
        raise RuntimeError(f"Malformed migration identity: {raw!r}")
    count = int(fields[0])
    if count != EXPECTED_MIGRATIONS:
        raise RuntimeError(f"Expected {EXPECTED_MIGRATIONS} migrations, got {count}")
    return {"count": count, "max_filename": fields[1]}


def network_members() -> dict[str, str]:
    network = docker_json(["network", "inspect", NETWORK_ID])[0]
    return {
        str(details.get("Name", "")).lstrip("/"): str(container_id)
        for container_id, details in network.get("Containers", {}).items()
        if isinstance(details, dict) and details.get("Name")
    }


def recover(
    candidate_running: bool,
    candidate_stop_confirmed: bool,
    known_good_stopped: bool,
    expected_image_id: str,
) -> tuple[bool, list[str]]:
    recovery_errors: list[str] = []
    if candidate_running and not candidate_stop_confirmed:
        try:
            candidate = inspect_container(A_NAME)
        except Exception as error:
            recovery_errors.append(f"candidate identity unavailable; cleanup withheld: {type(error).__name__}: {error}")
        else:
            if candidate.get("Image") != expected_image_id:
                recovery_errors.append("candidate identity mismatch; cleanup withheld")
            else:
                try:
                    stopped = docker(["stop", A_NAME], False)
                except Exception as error:
                    recovery_errors.append(f"stop candidate recovery failed: {type(error).__name__}: {error}")
                else:
                    if stopped.returncode == 0:
                        candidate_stop_confirmed = True
                    else:
                        recovery_errors.append("stop candidate recovery failed: docker stop returned nonzero")
    if known_good_stopped:
        if not candidate_stop_confirmed:
            recovery_errors.append("known-good restore withheld because candidate stop was not confirmed")
        else:
            try:
                started = docker(["start", B_NAME], False)
            except Exception as error:
                recovery_errors.append(f"restore known-good failed: {type(error).__name__}: {error}")
            else:
                if started.returncode != 0:
                    recovery_errors.append("restore known-good failed: docker start returned nonzero")
    return candidate_stop_confirmed, recovery_errors


def main() -> int:
    record: dict[str, Any] = {
        "scope": "bounded local retained-image rollback rehearsal",
        "network": {"name": NETWORK, "expected_id": NETWORK_ID},
        "candidate": {"tag": A_TAG, "expected_revision": A_REVISION, "name": A_NAME},
        "known_good": {"name": B_NAME, "expected_revision": B_REVISION, "expected_image_id": B_IMAGE_ID},
        "terminal": "unresolved",
    }
    b_stopped = False
    a_started = False
    a_stop_confirmed = False
    exit_code = 0
    try:
        smoke_resources = json.loads(SMOKE_RESOURCES.read_text())
        expected_shared_members = {
            str(name): str(container_id)
            for name, container_id in smoke_resources["containers"].items()
        }
        network = docker_json(["network", "inspect", NETWORK_ID])[0]
        if network.get("Id") != NETWORK_ID or network.get("Name") != NETWORK or network.get("Internal") is not True:
            raise RuntimeError(f"Disposable internal network identity mismatch: {network}")
        members = network_members()
        expected_before_stop = {**expected_shared_members, B_NAME: B_CONTAINER_ID}
        if members != expected_before_stop:
            raise RuntimeError(f"Known-good B is not an expected member of the disposable network: {members}")
        record_step(record, "network_verified", {"id": network["Id"], "name": network["Name"], "internal": network["Internal"], "members": members})

        b_inspection = inspect_container(B_NAME)
        if b_inspection.get("Id") != B_CONTAINER_ID or b_inspection.get("Image") != B_IMAGE_ID:
            raise RuntimeError(f"Known-good B identity mismatch: id={b_inspection.get('Id')} image={b_inspection.get('Image')}")
        b_identity = runtime_identity(B_NAME, B_REVISION)
        b_migrations = migration_identity()
        record_step(record, "known_good_retained", {"identity": b_identity, "migrations": b_migrations})

        a_image_id = docker(["image", "inspect", A_TAG, "--format", "{{.Id}}"], True).stdout.strip()
        if not a_image_id.startswith("sha256:"):
            raise RuntimeError(f"Candidate image did not resolve to an immutable ID: {a_image_id!r}")
        record["candidate"]["image_id"] = a_image_id
        record_step(record, "candidate_image_resolved", {"tag": A_TAG, "image_id": a_image_id})

        assert_candidate_name_absent()
        docker(["stop", B_NAME], True)
        b_stopped = True
        a_started = True
        run_arguments = ["run", "-d", "--name", A_NAME, "--network", NETWORK]
        for key, value in SETTINGS.items():
            run_arguments.extend(["--env", f"{key}={value}"])
        run_arguments.append(a_image_id)
        a_container_id = run_candidate(run_arguments, a_image_id)
        startup_readiness = wait_for_readiness(A_NAME)
        a_identity = runtime_identity(A_NAME, A_REVISION)
        a_identity["container_id"] = a_container_id
        a_identity["startup_readiness"] = startup_readiness
        a_identity["migrations"] = migration_identity()
        a_identity["network_members"] = network_members()
        expected_with_a = {**expected_shared_members, A_NAME: a_container_id}
        if a_identity["network_members"] not in (expected_with_a, {**expected_with_a, B_NAME: B_CONTAINER_ID}):
            raise RuntimeError(f"Candidate network identity mismatch: {a_identity['network_members']}")
        record_step(record, "candidate_verified_before_fault", a_identity)

        docker(["network", "disconnect", NETWORK_ID, A_NAME], True)
        disconnected_members = network_members()
        if disconnected_members not in (expected_shared_members, {**expected_shared_members, B_NAME: B_CONTAINER_ID}) or A_NAME in disconnected_members:
            raise RuntimeError(f"Candidate-only network fault was not isolated: {disconnected_members}")
        record_step(record, "candidate_disconnected_only", {"network_id": NETWORK_ID, "container": A_NAME, "remaining_members": disconnected_members})
        deadline = time.monotonic() + 60
        failures: list[dict[str, Any]] = []
        while time.monotonic() < deadline:
            probe = app_probe(A_NAME, "http://127.0.0.1:3000/health/ready", 10_000)
            failures.append({"time": timestamp(), **probe})
            if probe.get("kind") != "http" or probe.get("status") != 200:
                break
            time.sleep(1)
        else:
            raise RuntimeError("Candidate readiness remained HTTP 200 for the bounded 60-second fault window")
        record_step(record, "candidate_failure_observed", {"bounded_seconds": 60, "probes": failures})

        docker(["stop", A_NAME], True)
        a_stop_confirmed = True
        a_started = False
        docker(["start", B_NAME], True)
        b_stopped = False
        restored_identity = runtime_identity(B_NAME, B_REVISION)
        restored_identity["image_id"] = inspect_container(B_NAME).get("Image")
        if restored_identity["image_id"] != B_IMAGE_ID:
            raise RuntimeError(f"Restored B image mismatch: {restored_identity['image_id']}")
        restored_identity["migrations"] = migration_identity()
        record_step(record, "known_good_restored", restored_identity)
        record["terminal"] = "passed"
    except Exception as error:
        record["terminal"] = "failed"
        record["error"] = {"type": type(error).__name__, "message": str(error)}
        exit_code = 1
    finally:
        a_stop_confirmed, recovery_errors = recover(a_started, a_stop_confirmed, b_stopped, a_image_id if "a_image_id" in locals() else "")
        if recovery_errors:
            record["terminal"] = "failed"
            record["recovery_errors"] = recovery_errors
            exit_code = 1
        OUT.write_text(json.dumps(record, indent=2) + "\n")
        if record.get("terminal") != "passed":
            print(json.dumps(record), file=sys.stderr)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
