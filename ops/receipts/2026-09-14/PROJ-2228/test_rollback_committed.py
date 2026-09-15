import importlib.util
import json
import subprocess
import tempfile
from typing import Any
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

    def test_recovery_stops_candidate_then_starts_known_good(self) -> None:
        calls: list[list[str]] = []

        def fake_docker(arguments: list[str], check: bool) -> subprocess.CompletedProcess[str]:
            calls.append(arguments)
            return subprocess.CompletedProcess(arguments, 0, "", "")

        with patch.object(MODULE, "docker", side_effect=fake_docker), patch.object(
            MODULE, "inspect_container", return_value={"Id": "candidate-id", "Image": "sha256:expected"}
        ):
            confirmed, errors = MODULE.recover(MODULE.OWNED, False, True, "sha256:expected", "candidate-id")
        self.assertTrue(confirmed)
        self.assertEqual(errors, [])
        self.assertEqual(calls, [["stop", MODULE.A_NAME], ["start", MODULE.B_NAME]])

    def test_recovery_does_not_start_known_good_when_candidate_stop_fails(self) -> None:
        calls: list[list[str]] = []

        def fake_docker(arguments: list[str], check: bool) -> subprocess.CompletedProcess[str]:
            calls.append(arguments)
            return subprocess.CompletedProcess(arguments, 1, "", "stop failed")

        with patch.object(MODULE, "docker", side_effect=fake_docker), patch.object(
            MODULE, "inspect_container", return_value={"Id": "candidate-id", "Image": "sha256:expected"}
        ):
            confirmed, errors = MODULE.recover(MODULE.OWNED, False, True, "sha256:expected", "candidate-id")
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
            MODULE, "inspect_container", return_value={"Id": "candidate-id", "Image": "sha256:expected"}
        ):
            confirmed, errors = MODULE.recover(MODULE.OWNED, False, True, "sha256:expected", "candidate-id")
        self.assertTrue(confirmed)
        self.assertTrue(any("restore known-good failed" in error for error in errors))
        self.assertEqual(calls, [["stop", MODULE.A_NAME], ["start", MODULE.B_NAME]])

    def test_recovery_inspection_failure_withholds_cleanup_and_restore(self) -> None:
        with patch.object(MODULE, "inspect_container", side_effect=MODULE.DockerTimeoutError("Docker operation timed out: inspect")), patch.object(
            MODULE, "docker"
        ) as docker:
            confirmed, errors = MODULE.recover(MODULE.OWNED, False, True, "sha256:expected", "candidate-id")
        self.assertFalse(confirmed)
        self.assertTrue(any("identity unavailable" in error for error in errors))
        self.assertTrue(any("restore withheld" in error for error in errors))
        docker.assert_not_called()

    def test_recovery_records_known_good_start_nonzero(self) -> None:
        with patch.object(MODULE, "inspect_container", return_value={"Id": "candidate-id", "Image": "sha256:expected"}), patch.object(
            MODULE,
            "docker",
            side_effect=[
                subprocess.CompletedProcess(["stop"], 0, "", ""),
                subprocess.CompletedProcess(["start"], 1, "", "start failed"),
            ],
        ):
            confirmed, errors = MODULE.recover(MODULE.OWNED, False, True, "sha256:expected", "candidate-id")
        self.assertTrue(confirmed)
        self.assertTrue(any("restore known-good failed" in error for error in errors))

    def test_candidate_name_state_maps_absent_present_and_ambiguous(self) -> None:
        absent = subprocess.CompletedProcess([], 0, "", "")
        present = subprocess.CompletedProcess([], 0, "candidate-id\n", "")
        ambiguous = subprocess.CompletedProcess([], 0, "candidate-a\ncandidate-b\n", "")
        with patch.object(MODULE, "docker", side_effect=[absent, present, ambiguous]):
            self.assertEqual(MODULE.candidate_name_state(), MODULE.ABSENT)
            self.assertEqual(MODULE.candidate_name_state(), MODULE.PRESENT)
            self.assertEqual(MODULE.candidate_name_state(), MODULE.AMBIGUOUS)

    def test_ambiguous_or_foreign_candidate_withholds_cleanup_and_restore(self) -> None:
        for state in (MODULE.AMBIGUOUS, MODULE.FOREIGN):
            with self.subTest(state=state), patch.object(MODULE, "docker") as docker:
                confirmed, errors = MODULE.recover(state, False, True, "sha256:expected", "candidate-id")
            self.assertFalse(confirmed)
            self.assertTrue(any("restore withheld" in error for error in errors))
            docker.assert_not_called()

    def run_main_fixture(
        self,
        *,
        run_failure: Exception | None,
        run_stdout: str,
        presence_output: str,
        candidate_image: str,
        runtime_image_id: str,
        inspected_image: str | None,
        readiness_failure: Exception | None,
        disconnect_failure: Exception | None,
        stop_failure: Exception | None,
        start_failure: Exception | None,
        known_good_stop_failure: Exception | None,
        presence_failure: Exception | None,
        identity_container_id: str,
    ) -> tuple[int, dict[str, Any], list[list[str]]]:
        shared_members = {
            "corgi-2228-pg": "pg-id",
            "corgi-2228-redis": "redis-id",
            "corgi-2228-demo-redis": "demo-id",
        }
        before_members = {**shared_members, MODULE.B_NAME: MODULE.B_CONTAINER_ID}
        after_members = {**shared_members, MODULE.A_NAME: "candidate-container"}
        network_member_results = iter([before_members, after_members, shared_members])
        calls: list[list[str]] = []
        ps_calls = 0
        exec_calls = 0
        run_error = run_failure
        observed_image = inspected_image or candidate_image

        def fake_docker(arguments: list[str], check: bool) -> subprocess.CompletedProcess[str]:
            nonlocal exec_calls, ps_calls
            calls.append(arguments)
            if arguments[:2] == ["image", "inspect"]:
                return subprocess.CompletedProcess(arguments, 0, f"{candidate_image}\n", "")
            if arguments[:2] == ["ps", "-a"]:
                ps_calls += 1
                if ps_calls > 1 and presence_failure is not None:
                    raise presence_failure
                return subprocess.CompletedProcess(arguments, 0, "" if ps_calls == 1 else presence_output, "")
            if arguments == ["stop", MODULE.B_NAME]:
                if known_good_stop_failure is not None:
                    raise known_good_stop_failure
                return subprocess.CompletedProcess(arguments, 0, "", "")
            if arguments[:2] == ["run", "-d"]:
                if run_error is not None:
                    raise run_error
                return subprocess.CompletedProcess(arguments, 0, run_stdout, "")
            if arguments == ["network", "disconnect", MODULE.NETWORK_ID, MODULE.A_NAME]:
                if disconnect_failure is not None:
                    raise disconnect_failure
                return subprocess.CompletedProcess(arguments, 0, "", "")
            if arguments == ["stop", MODULE.A_NAME]:
                if stop_failure is not None:
                    raise stop_failure
                return subprocess.CompletedProcess(arguments, 0, "", "")
            if arguments == ["start", MODULE.B_NAME]:
                if start_failure is not None:
                    raise start_failure
                return subprocess.CompletedProcess(arguments, 0, "", "")
            if arguments[:1] == ["exec"]:
                exec_calls += 1
                status = 200 if exec_calls == 1 else 503
                return subprocess.CompletedProcess(
                    arguments,
                    0,
                    f'{{"kind":"http","status":{status},"body":"ready"}}\n',
                    "",
                )
            raise AssertionError(f"unexpected Docker operation: {arguments}")

        def fake_inspect(name: str) -> dict[str, Any]:
            if name == MODULE.B_NAME:
                return {"Id": MODULE.B_CONTAINER_ID, "Image": MODULE.B_IMAGE_ID}
            return {"Id": identity_container_id, "Image": observed_image}

        def fake_identity(name: str, expected_revision: str) -> dict[str, Any]:
            if name == MODULE.B_NAME:
                return {"container_id": MODULE.B_CONTAINER_ID, "image_id": MODULE.B_IMAGE_ID, "revision": MODULE.B_REVISION}
            return {"container_id": identity_container_id, "image_id": runtime_image_id, "revision": MODULE.A_REVISION}

        def fake_ready(name: str) -> dict[str, Any]:
            if readiness_failure is not None:
                raise readiness_failure
            return {"kind": "http", "status": 200}

        with tempfile.TemporaryDirectory() as directory:
            resources_path = Path(directory) / "smoke-resources.json"
            resources_path.write_text(json.dumps({"containers": shared_members}))
            with patch.object(MODULE, "OUT", Path(directory) / "receipt.json"), patch.object(
                MODULE, "SMOKE_RESOURCES", resources_path
            ), patch.object(
                MODULE, "docker_json", return_value=[{"Id": MODULE.NETWORK_ID, "Name": MODULE.NETWORK, "Internal": True}]
            ), patch.object(MODULE, "network_members", side_effect=lambda: next(network_member_results, shared_members)), patch.object(
                MODULE, "inspect_container", side_effect=fake_inspect
            ), patch.object(MODULE, "runtime_identity", side_effect=fake_identity), patch.object(
                MODULE, "migration_identity", return_value={"count": MODULE.EXPECTED_MIGRATIONS}
            ), patch.object(MODULE, "wait_for_readiness", side_effect=fake_ready), patch.object(
                MODULE, "docker", side_effect=fake_docker
            ):
                result = MODULE.main()
                receipt = json.loads((Path(directory) / "receipt.json").read_text())
        return result, receipt, calls

    def fixture_kwargs(self) -> dict[str, Any]:
        return {
            "run_failure": None,
            "run_stdout": "candidate-container\n",
            "presence_output": "",
            "candidate_image": "sha256:candidate",
            "runtime_image_id": "sha256:candidate",
            "inspected_image": None,
            "readiness_failure": None,
            "disconnect_failure": None,
            "stop_failure": None,
            "start_failure": None,
            "known_good_stop_failure": None,
            "presence_failure": None,
            "identity_container_id": "candidate-container",
        }

    def test_main_run_failure_absent_restores_but_preserves_primary_error(self) -> None:
        run_error = MODULE.DockerCommandError("Docker operation failed with exit 1: run")
        result, receipt, calls = self.run_main_fixture(**{**self.fixture_kwargs(), "run_failure": run_error})
        self.assertEqual(result, 1)
        self.assertEqual(receipt["error"]["message"], str(run_error))
        self.assertEqual(receipt["recovery"]["candidate_state"], MODULE.ABSENT)
        self.assertIn(["start", MODULE.B_NAME], calls)

    def test_main_empty_run_stdout_is_unverifiable_and_restores_b(self) -> None:
        result, receipt, calls = self.run_main_fixture(
            **{**self.fixture_kwargs(), "run_stdout": ""}
        )
        self.assertEqual(result, 1)
        self.assertIn("no container ID", receipt["error"]["message"])
        self.assertEqual(receipt["recovery"]["candidate_state"], MODULE.ABSENT)
        self.assertNotIn(["stop", MODULE.A_NAME], calls)
        self.assertIn(["start", MODULE.B_NAME], calls)

    def test_main_empty_run_stdout_classifies_present_candidate_safely(self) -> None:
        cases = (
            ("candidate-container\n", None, MODULE.OWNED, True),
            ("candidate-container\n", "sha256:foreign", MODULE.FOREIGN, False),
            ("candidate-a\ncandidate-b\n", None, MODULE.AMBIGUOUS, False),
        )
        for presence, inspected_image, expected_state, may_restore in cases:
            with self.subTest(presence=presence, inspected_image=inspected_image):
                result, receipt, calls = self.run_main_fixture(
                    **{
                        **self.fixture_kwargs(),
                        "run_stdout": "   \n",
                        "presence_output": presence,
                        "inspected_image": inspected_image,
                    }
                )
                self.assertEqual(result, 1)
                self.assertIn("no container ID", receipt["error"]["message"])
                self.assertEqual(receipt["recovery"]["candidate_state"], expected_state)
                self.assertNotIn(["network", "disconnect", MODULE.NETWORK_ID, MODULE.A_NAME], calls)
                if may_restore:
                    self.assertLess(calls.index(["stop", MODULE.A_NAME]), calls.index(["start", MODULE.B_NAME]))
                else:
                    self.assertNotIn(["stop", MODULE.A_NAME], calls)
                    self.assertNotIn(["start", MODULE.B_NAME], calls)

    def test_main_nominal_success_restores_known_good_and_records_pass(self) -> None:
        result, receipt, calls = self.run_main_fixture(**self.fixture_kwargs())
        self.assertEqual(result, 0)
        self.assertEqual(receipt["terminal"], "passed")
        self.assertEqual(receipt["recovery"]["candidate_state"], MODULE.OWNED)
        self.assertEqual(receipt["recovery"]["errors"], [])
        self.assertIn("known_good_restored", receipt["steps"])
        self.assertLess(calls.index(["stop", MODULE.A_NAME]), calls.index(["start", MODULE.B_NAME]))

    def test_main_rejects_independent_runtime_image_mismatch_before_fault(self) -> None:
        result, receipt, calls = self.run_main_fixture(
            **{**self.fixture_kwargs(), "runtime_image_id": "sha256:foreign"}
        )
        self.assertEqual(result, 1)
        self.assertEqual(
            receipt["error"]["message"],
            "Candidate runtime identity changed before fault injection",
        )
        self.assertEqual(receipt["recovery"]["candidate_state"], MODULE.FOREIGN)
        self.assertNotIn(["network", "disconnect", MODULE.NETWORK_ID, MODULE.A_NAME], calls)
        self.assertNotIn(["stop", MODULE.A_NAME], calls)
        self.assertNotIn(["start", MODULE.B_NAME], calls)

    def test_main_run_failure_present_expected_stops_candidate_then_restores_b(self) -> None:
        run_error = MODULE.DockerCommandError("Docker operation failed with exit 1: run")
        result, receipt, calls = self.run_main_fixture(
            **{**self.fixture_kwargs(), "run_failure": run_error, "presence_output": "candidate-container\n"}
        )
        self.assertEqual(result, 1)
        self.assertEqual(receipt["error"]["message"], str(run_error))
        self.assertEqual(receipt["recovery"]["candidate_state"], MODULE.OWNED)
        self.assertLess(calls.index(["stop", MODULE.A_NAME]), calls.index(["start", MODULE.B_NAME]))

    def test_main_run_failure_foreign_or_ambiguous_withholds_cleanup_and_restore(self) -> None:
        run_error = MODULE.DockerCommandError("Docker operation failed with exit 1: run")
        for presence in ("candidate-container\n", "candidate-a\ncandidate-b\n"):
            with self.subTest(presence=presence):
                wrong_image = "sha256:foreign" if presence.count("\n") == 1 else "sha256:candidate"
                result, receipt, calls = self.run_main_fixture(
                    **{
                        **self.fixture_kwargs(),
                        "run_failure": run_error,
                        "presence_output": presence,
                        "inspected_image": wrong_image if presence.count("\n") == 1 else None,
                    }
                )
                self.assertEqual(result, 1)
                self.assertEqual(receipt["error"]["message"], str(run_error))
                self.assertNotIn(["stop", MODULE.A_NAME], calls)
                self.assertNotIn(["start", MODULE.B_NAME], calls)

    def test_main_readiness_timeout_stops_candidate_before_restoring_b(self) -> None:
        readiness_error = RuntimeError("candidate readiness timed out")
        result, receipt, calls = self.run_main_fixture(
            **{**self.fixture_kwargs(), "readiness_failure": readiness_error}
        )
        self.assertEqual(result, 1)
        self.assertEqual(receipt["error"]["message"], str(readiness_error))
        self.assertLess(calls.index(["stop", MODULE.A_NAME]), calls.index(["start", MODULE.B_NAME]))

    def test_main_network_disconnect_failure_stops_candidate_before_restoring_b(self) -> None:
        disconnect_error = MODULE.DockerCommandError("Docker operation failed with exit 1: network disconnect")
        result, receipt, calls = self.run_main_fixture(
            **{**self.fixture_kwargs(), "disconnect_failure": disconnect_error}
        )
        self.assertEqual(result, 1)
        self.assertEqual(receipt["error"]["message"], str(disconnect_error))
        self.assertLess(calls.index(["stop", MODULE.A_NAME]), calls.index(["start", MODULE.B_NAME]))

    def test_main_rejects_mismatched_runtime_container_id_before_fault(self) -> None:
        identity_error = "Candidate runtime identity changed before fault injection"
        result, receipt, calls = self.run_main_fixture(
            **{**self.fixture_kwargs(), "identity_container_id": "unexpected-container"}
        )
        self.assertEqual(result, 1)
        self.assertEqual(receipt["error"]["message"], identity_error)
        self.assertNotIn(["network", "disconnect", MODULE.NETWORK_ID, MODULE.A_NAME], calls)
        self.assertEqual(receipt["recovery"]["candidate_state"], MODULE.FOREIGN)
        self.assertNotIn(["stop", MODULE.A_NAME], calls)
        self.assertNotIn(["start", MODULE.B_NAME], calls)

    def test_main_initial_known_good_stop_failure_preserves_error_and_does_not_run_a(self) -> None:
        stop_error = MODULE.DockerCommandError("Docker operation failed with exit 1: stop B")
        result, receipt, calls = self.run_main_fixture(
            **{**self.fixture_kwargs(), "known_good_stop_failure": stop_error}
        )
        self.assertEqual(result, 1)
        self.assertEqual(receipt["error"]["message"], str(stop_error))
        self.assertNotIn(["run", "-d"], [call[:2] for call in calls])

    def test_main_candidate_stop_failure_withholds_b_restore(self) -> None:
        for stop_error in (
            MODULE.DockerCommandError("Docker operation failed with exit 1: stop A"),
            MODULE.DockerTimeoutError("Docker operation timed out: stop A"),
        ):
            with self.subTest(stop_error=str(stop_error)):
                result, receipt, calls = self.run_main_fixture(
                    **{**self.fixture_kwargs(), "stop_failure": stop_error}
                )
                self.assertEqual(result, 1)
                self.assertEqual(receipt["error"]["message"], str(stop_error))
                self.assertNotIn(["start", MODULE.B_NAME], calls)
                self.assertTrue(receipt["recovery"]["errors"])

    def test_main_known_good_start_failure_and_timeout_preserve_primary_error(self) -> None:
        for start_error in (
            MODULE.DockerCommandError("Docker operation failed with exit 1: start B"),
            MODULE.DockerTimeoutError("Docker operation timed out: start B"),
        ):
            with self.subTest(start_error=str(start_error)):
                result, receipt, calls = self.run_main_fixture(
                    **{**self.fixture_kwargs(), "start_failure": start_error}
                )
                self.assertEqual(result, 1)
                self.assertEqual(receipt["error"]["message"], str(start_error))
                self.assertIn(["start", MODULE.B_NAME], calls)
                self.assertTrue(receipt["recovery"]["errors"])

    def test_main_run_timeout_with_presence_query_failure_withholds_restore(self) -> None:
        run_error = MODULE.DockerTimeoutError("Docker operation timed out: run")
        presence_error = MODULE.DockerTimeoutError("Docker operation timed out: presence")
        result, receipt, calls = self.run_main_fixture(
            **{**self.fixture_kwargs(), "run_failure": run_error, "presence_failure": presence_error}
        )
        self.assertEqual(result, 1)
        self.assertEqual(receipt["error"]["message"], str(run_error))
        self.assertEqual(receipt["recovery"]["candidate_state"], MODULE.AMBIGUOUS)
        self.assertNotIn(["start", MODULE.B_NAME], calls)

if __name__ == "__main__":
    unittest.main()
