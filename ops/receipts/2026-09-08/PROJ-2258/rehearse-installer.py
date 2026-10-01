#!/usr/bin/env python3
"""Run only inside a disposable root Linux container with /fixture input mount."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys


FIXTURE = Path('/fixture')
LIVE = Path('/opt/bluesky-feed/cli/dist')
RECOVERY = Path('/var/lib/corgi-operations-cli-patch')
PACKET = Path('/root/packet')
INSTALLER = Path('/root/install-corgi-operations-cli.py')
BASELINE = json.loads((FIXTURE / 'baseline-dist-manifest.json').read_text())
CANDIDATE = json.loads((FIXTURE / 'candidate-dist-manifest.json').read_text())
PASSED: list[str] = []


def reset() -> None:
    for target in (LIVE, RECOVERY, PACKET):
        if target.exists():
            shutil.rmtree(target)
    LIVE.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(FIXTURE / 'baseline', LIVE)
    for target in [LIVE, *LIVE.rglob('*')]:
        os.chown(target, 1001, 1001)
        target.chmod(0o755 if target.is_dir() else 0o644)
    deploy_receipts = Path('/opt/bluesky-feed/.git/corgi-deploy-receipts')
    deploy_receipts.mkdir(parents=True, exist_ok=True)
    deploy_lock = deploy_receipts / 'production.lock'
    deploy_lock.touch()
    os.chown(deploy_lock, 1001, 1001)
    deploy_lock.chmod(0o600)
    PACKET.mkdir(mode=0o700)
    for name in ('baseline-dist-manifest.json', 'candidate-dist-manifest.json', 'direct.js', 'direct.js.map'):
        shutil.copyfile(FIXTURE / name, PACKET / name)
        (PACKET / name).chmod(0o644)
    shutil.copyfile(FIXTURE / 'install-corgi-operations-cli.py', INSTALLER)
    INSTALLER.chmod(0o644)


def run(action: str, succeeds: bool) -> subprocess.CompletedProcess[str]:
    result = subprocess.run([sys.executable, str(INSTALLER), action, str(PACKET)],
                            capture_output=True, text=True, timeout=15, check=False)
    if (result.returncode == 0) != succeeds:
        raise AssertionError(f'{action} exit={result.returncode}: {result.stderr}')
    return result


def assert_manifest(expected: dict[str, str]) -> None:
    observed = {str(p.relative_to(LIVE)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in LIVE.rglob('*') if p.is_file()}
    if observed != expected:
        raise AssertionError('Independent full-directory manifest comparison failed')


def interrupted(action: str, target: str) -> None:
    # Invoke the real main with os.replace instrumented only to SIGKILL the
    # child after the chosen durable replacement. Recovery is the unmodified CLI.
    code = '''import importlib.util, os, signal, sys
spec = importlib.util.spec_from_file_location('installer', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original = os.replace
def crash(source, destination, **kwargs):
    original(source, destination, **kwargs)
    if destination == sys.argv[3]:
        os.kill(os.getpid(), signal.SIGKILL)
module.os.replace = crash
sys.argv = [sys.argv[1], sys.argv[2], sys.argv[4]]
module.main()
'''
    # Keep the trigger out of sys.argv, which main parses.
    code = code.replace('original = os.replace', 'target = sys.argv[3]\noriginal = os.replace')
    code = code.replace('destination == sys.argv[3]', 'destination == target')
    result = subprocess.run([sys.executable, '-c', code, str(INSTALLER), action, target, str(PACKET)],
                            capture_output=True, text=True, timeout=15, check=False)
    if result.returncode != -signal.SIGKILL:
        raise AssertionError(f'Crash injection failed: {result.returncode}: {result.stderr}')


def main() -> None:
    if os.geteuid() != 0 or not Path('/.dockerenv').exists():
        raise RuntimeError('Disposable root container required; never run this fixture on a host')
    reset()
    run('apply', True)
    assert_manifest(CANDIDATE)
    run('verify', True)
    run('apply', False)
    run('rollback', True)
    assert_manifest(BASELINE)
    run('rollback', True)
    PASSED.append('apply_verify_reject_reapply_rollback_idempotency')

    for trigger in ('state', 'direct.js.map', 'direct.js'):
        reset()
        # Backup names match live names, so these cases also exercise interruption
        # during preparation. A second hook below targets live replacements only.
        interrupted('apply', trigger)
        run('rollback', True)
        assert_manifest(BASELINE)
        PASSED.append(f'killed_during_preparation_{trigger}')

    for count in (1, 2):
        reset()
        code = '''import importlib.util, os, signal, sys
spec = importlib.util.spec_from_file_location('installer', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original = module.write_file
remaining = int(sys.argv[2])
def crash(parent, name, data, uid, gid, mode):
    global remaining
    original(parent, name, data, uid, gid, mode)
    if uid == 1001:
        remaining -= 1
        if remaining == 0:
            os.kill(os.getpid(), signal.SIGKILL)
module.write_file = crash
sys.argv = [sys.argv[1], 'apply', sys.argv[3]]
module.main()
'''
        result = subprocess.run([sys.executable, '-c', code, str(INSTALLER), str(count), str(PACKET)],
                                capture_output=True, text=True, timeout=15, check=False)
        assert result.returncode == -signal.SIGKILL, result.stderr
        run('verify', False)
        run('rollback', True)
        assert_manifest(BASELINE)
        PASSED.append(f'killed_after_{count}_live_replacements')

    reset()
    run('apply', True)
    interrupted('rollback', 'direct.js.map')
    run('rollback', True)
    assert_manifest(BASELINE)
    PASSED.append('killed_during_rollback')

    reset()
    run('apply', True)
    scratch = LIVE / '.direct.js.proj2258'
    scratch.write_bytes(b'partial')
    scratch.chmod(0o600)
    run('rollback', True)
    assert_manifest(BASELINE)
    PASSED.append('partial_root_scratch_recovery')

    for label, target in (('candidate', PACKET / 'direct.js'),
                          ('manifest', PACKET / 'baseline-dist-manifest.json'),
                          ('baseline', LIVE / 'index.js')):
        reset()
        target.write_bytes(target.read_bytes() + b'corruption')
        before = {str(p): p.read_bytes() for p in LIVE.rglob('*') if p.is_file()}
        run('apply', False)
        assert all(Path(name).read_bytes() == data for name, data in before.items())
        PASSED.append(f'reject_{label}_drift_before_replacement')

    reset()
    run('apply', True)
    (RECOVERY / 'direct.js').write_bytes(b'corrupt backup')
    run('rollback', False)
    assert_manifest(CANDIDATE)
    PASSED.append('reject_corrupt_backup_without_live_mutation')

    for target in (LIVE / 'direct.js', LIVE / 'commands', PACKET / 'direct.js'):
        reset()
        saved = Path('/root/symlink-target') / target.name
        saved.parent.mkdir(exist_ok=True)
        if saved.exists():
            if saved.is_dir():
                shutil.rmtree(saved)
            else:
                saved.unlink()
        target.rename(saved)
        target.symlink_to(saved)
        result = run('apply', False)
        assert 'inventory changed' not in result.stderr, result.stderr
        assert target.is_symlink()
        PASSED.append(f'reject_symlink_{target.parent.name}_{target.name}')

    reset()
    extra_link = Path('/root/extra-hardlink')
    os.link(LIVE / 'direct.js', extra_link)
    result = run('apply', False)
    assert 'Unsafe file type, links, owner, mode or size: direct.js' in result.stderr, result.stderr
    extra_link.unlink()
    assert_manifest(BASELINE)
    PASSED.append('reject_hardlink_without_inventory_change')

    reset()
    with open('/opt/bluesky-feed/.git/corgi-deploy-receipts/production.lock', 'rb') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        run('apply', False)
        assert_manifest(BASELINE)
    PASSED.append('reject_concurrent_production_deploy')

    reset()
    code = '''import fcntl, importlib.util, os, pathlib, shutil, sys
spec = importlib.util.spec_from_file_location('installer', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original = fcntl.flock
def complete_deploy(descriptor, operation):
    target = os.readlink('/proc/self/fd/' + str(descriptor))
    if target.endswith('/production.lock'):
        live = pathlib.Path('/opt/bluesky-feed/cli/dist')
        previous = live.with_name('dist.previous')
        live.rename(previous)
        shutil.copytree(previous, live)
        for path in [live, *live.rglob('*')]:
            os.chown(path, 1001, 1001)
    return original(descriptor, operation)
module.fcntl.flock = complete_deploy
sys.argv = [sys.argv[1], 'apply', sys.argv[2]]
module.main()
'''
    result = subprocess.run([sys.executable, '-c', code, str(INSTALLER), str(PACKET)],
                            capture_output=True, text=True, timeout=15, check=False)
    assert result.returncode == 0, result.stderr
    assert_manifest(CANDIDATE)
    previous = LIVE.with_name('dist.previous')
    assert {str(p.relative_to(previous)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in previous.rglob('*') if p.is_file()} == BASELINE
    shutil.rmtree(previous)
    PASSED.append('completed_deploy_before_lock_does_not_mutate_retired_directory')

    reset()
    os.chmod(PACKET, 0o777)
    run('apply', False)
    assert_manifest(BASELINE)
    PASSED.append('reject_writable_packet_ancestry')
    print(json.dumps({'production_touched': False, 'cases_passed': PASSED}, indent=2))


if __name__ == '__main__':
    main()
