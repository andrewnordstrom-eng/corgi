import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("rollback-committed.py")
SPEC = importlib.util.spec_from_file_location("rollback_committed", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load {SCRIPT}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RollbackHarnessTests(unittest.TestCase):
    def test_docker_timeout_is_finite_and_redacts_environment_values(self) -> None:
        timeout = subprocess.TimeoutExpired([MODULE.DOCKER, "run"], MODULE.DOCKER_TIMEOUT_SECONDS)
        with patch.object(MODULE.subprocess, "run", side_effect=timeout):
            with self.assertRaisesRegex(MODULE.DockerTimeoutError, "Docker operation timed out") as raised:
                MODULE.docker(["run", "--env", "DATABASE_URL=secret-value", MODULE.A_NAME], True)
        self.assertNotIn("secret-value", str(raised.exception))
        self.assertIn("<redacted>", str(raised.exception))

    def test_docker_passes_finite_timeout_to_inspect_stop_and_start(self) -> None:
        with patch.object(
            MODULE.subprocess,
            "run",
            return_value=subprocess.CompletedProcess([MODULE.DOCKER], 0, "", ""),
        ) as run:
            MODULE.docker(["container", "inspect", MODULE.A_NAME], True)
            MODULE.docker(["stop", MODULE.A_NAME], False)
            MODULE.docker(["start", MODULE.B_NAME], False)
        self.assertEqual(run.call_count, 3)
        for call in run.call_args_list:
            self.assertEqual(call.kwargs["timeout"], MODULE.DOCKER_TIMEOUT_SECONDS)

    def test_run_timeout_with_inspect_timeout_is_not_treated_as_absent(self) -> None:
        run_timeout = MODULE.DockerTimeoutError("Docker operation timed out: run")
        inspect_timeout = MODULE.DockerTimeoutError("Docker operation timed out: inspect")
        with patch.object(MODULE, "docker", side_effect=run_timeout):
            with patch.object(MODULE, "inspect_container", side_effect=inspect_timeout):
                with self.assertRaises(MODULE.DockerTimeoutError) as raised:
                    MODULE.run_candidate(["run", MODULE.A_NAME], "sha256:expected")
        self.assertIs(raised.exception, run_timeout)

        calls: list[list[str]] = []

        def failed_stop(arguments: list[str], check: bool) -> subprocess.CompletedProcess[str]:
            calls.append(arguments)
            raise inspect_timeout

        with patch.object(MODULE, "docker", side_effect=failed_stop), patch.object(
            MODULE, "inspect_container", return_value={"Image": "sha256:expected"}
        ):
            confirmed, errors = MODULE.recover(True, False, True, "sha256:expected")
        self.assertFalse(confirmed)
        self.assertTrue(any("known-good restore withheld" in error for error in errors))
        self.assertEqual(calls, [["stop", MODULE.A_NAME]])

    def test_recovery_stops_candidate_then_starts_known_good(self) -> None:
        calls: list[list[str]] = []

        def fake_docker(arguments: list[str], check: bool) -> subprocess.CompletedProcess[str]:
            calls.append(arguments)
            return subprocess.CompletedProcess(arguments, 0, "", "")

        with patch.object(MODULE, "docker", side_effect=fake_docker), patch.object(
            MODULE, "inspect_container", return_value={"Image": "sha256:expected"}
        ):
            confirmed, errors = MODULE.recover(True, False, True, "sha256:expected")
        self.assertTrue(confirmed)
        self.assertEqual(errors, [])
        self.assertEqual(calls, [["stop", MODULE.A_NAME], ["start", MODULE.B_NAME]])

    def test_recovery_does_not_start_known_good_when_candidate_stop_fails(self) -> None:
        calls: list[list[str]] = []

        def fake_docker(arguments: list[str], check: bool) -> subprocess.CompletedProcess[str]:
            calls.append(arguments)
            return subprocess.CompletedProcess(arguments, 1, "", "stop failed")

        with patch.object(MODULE, "docker", side_effect=fake_docker), patch.object(
            MODULE, "inspect_container", return_value={"Image": "sha256:expected"}
        ):
            confirmed, errors = MODULE.recover(True, False, True, "sha256:expected")
        self.assertFalse(confirmed)
        self.assertTrue(any("known-good restore withheld" in error for error in errors))
        self.assertEqual(calls, [["stop", MODULE.A_NAME]])

    def test_recovery_records_known_good_start_timeout(self) -> None:
        calls: list[list[str]] = []
        start_timeout = MODULE.DockerTimeoutError("Docker operation timed out: start")

        def fake_docker(arguments: list[str], check: bool) -> subprocess.CompletedProcess[str]:
            calls.append(arguments)
            if arguments == ["start", MODULE.B_NAME]:
                raise start_timeout
            return subprocess.CompletedProcess(arguments, 0, "", "")

        with patch.object(MODULE, "docker", side_effect=fake_docker), patch.object(
            MODULE, "inspect_container", return_value={"Image": "sha256:expected"}
        ):
            confirmed, errors = MODULE.recover(True, False, True, "sha256:expected")
        self.assertTrue(confirmed)
        self.assertTrue(any("restore known-good failed" in error for error in errors))
        self.assertEqual(calls, [["stop", MODULE.A_NAME], ["start", MODULE.B_NAME]])


if __name__ == "__main__":
    unittest.main()
