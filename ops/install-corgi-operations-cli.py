#!/usr/bin/env python3
"""One-time, root-operated two-file CLI repair. No services or credentials touched."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
from typing import Mapping


LIVE = Path('/opt/bluesky-feed/cli/dist')
RECOVERY = Path('/var/lib/corgi-operations-cli-patch')
DEPLOY_RECEIPTS = Path('/opt/bluesky-feed/.git/corgi-deploy-receipts')
DEPLOY_UID = 1001
DEPLOY_GID = 1001
ORDER = ('direct.js.map', 'direct.js')
MANIFEST_DIGESTS = {
    'baseline-dist-manifest.json': '30f832d13a77ad036996ca693e076db1c1fef83f60069f6104768d0ce8927d82',
    'candidate-dist-manifest.json': '5415f5f025585c462aaaa8fdf9ffe7c7757899676c074c5dc7130e7256a7e657',
}


class InstallError(RuntimeError):
    """A baseline, integrity or recovery precondition was not satisfied."""


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def directory(path: Path, owners: set[int]) -> int:
    """Anchor every path component with O_NOFOLLOW, including parent directories."""
    if not path.is_absolute() or '..' in path.parts:
        raise InstallError(f'Expected an absolute path without parent traversal: {path}')
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[1:]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
            metadata = os.fstat(descriptor)
            if metadata.st_uid not in owners or stat.S_IMODE(metadata.st_mode) & 0o022:
                raise InstallError(f'Unsafe directory owner or write permissions: {path}')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def read_file(parent: int, name: str, owners: set[int], mode: int) -> bytes:
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1
                or metadata.st_uid not in owners or stat.S_IMODE(metadata.st_mode) != mode
                or (owners == {DEPLOY_UID} and metadata.st_gid != DEPLOY_GID)
                or metadata.st_size > 2_000_000):
            raise InstallError(f'Unsafe file type, links, owner, mode or size: {name}')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            return stream.read(2_000_001)
    finally:
        os.close(descriptor)


def temporary_name(name: str) -> str:
    return f'.{name}.proj2258'


def write_file(parent: int, name: str, data: bytes, uid: int, gid: int, mode: int) -> None:
    """Durable single-file replacement; retain interrupted temp files for recovery."""
    temporary = temporary_name(name)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=parent)
    try:
        with os.fdopen(descriptor, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
        os.fsync(descriptor)
        os.fchown(descriptor, uid, gid)
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
    os.fsync(parent)


def manifests(packet: int) -> tuple[dict[str, str], dict[str, str]]:
    decoded: list[dict[str, str]] = []
    for name, expected in MANIFEST_DIGESTS.items():
        data = read_file(packet, name, {0}, 0o644)
        if digest(data) != expected:
            raise InstallError(f'Independent manifest digest mismatch: {name}')
        decoded.append(json.loads(data))
    baseline, candidate = decoded
    if (len(baseline) != 42 or baseline.keys() != candidate.keys()
            or {name for name in baseline if baseline[name] != candidate[name]} != set(ORDER)):
        raise InstallError('Manifest contract must change exactly the two fixed files')
    return baseline, candidate


def snapshot(live: int, expected: Mapping[str, str]) -> dict[str, str]:
    result: dict[str, str] = {}
    expected_top = {name.split('/')[0] for name in expected}
    if set(os.listdir(live)) != expected_top:
        raise InstallError('Live CLI directory inventory changed')
    for name in sorted(expected_top):
        if name == 'commands':
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=live)
            try:
                metadata = os.fstat(child)
                if metadata.st_uid != DEPLOY_UID or stat.S_IMODE(metadata.st_mode) != 0o755:
                    raise InstallError('CLI commands directory owner or mode changed')
                expected_children = {key.split('/')[1] for key in expected if key.startswith('commands/')}
                if set(os.listdir(child)) != expected_children:
                    raise InstallError('CLI commands inventory changed')
                for filename in sorted(expected_children):
                    result[f'commands/{filename}'] = digest(read_file(child, filename, {DEPLOY_UID}, 0o644))
            finally:
                os.close(child)
        else:
            result[name] = digest(read_file(live, name, {DEPLOY_UID}, 0o644))
    return result


def require_snapshot(live: int, expected: Mapping[str, str]) -> None:
    observed = snapshot(live, expected)
    changed = [name for name in expected if observed[name] != expected[name]]
    if changed:
        raise InstallError(f'CLI digest mismatch: {", ".join(changed)}')


def recover_temporary(parent: int, name: str, allowed: set[str], live: bool) -> None:
    """Only unlink our fixed-name, single-link scratch file; never follow a link."""
    temporary = temporary_name(name)
    if temporary not in os.listdir(parent):
        return
    metadata = os.stat(temporary, dir_fd=parent, follow_symlinks=False)
    mode = stat.S_IMODE(metadata.st_mode)
    owners = {0, DEPLOY_UID} if live else {0}
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1
            or metadata.st_uid not in owners or mode not in {0o600, 0o644}):
        raise InstallError(f'Unsafe interrupted scratch file: {temporary}')
    data = read_file(parent, temporary, owners, mode)
    # A root-only scratch file may be partial after SIGKILL during its write.
    if not (metadata.st_uid == 0 and mode == 0o600) and digest(data) not in allowed:
        raise InstallError(f'Interrupted scratch digest mismatch: {temporary}')
    os.unlink(temporary, dir_fd=parent)
    os.fsync(parent)


def state(recovery: int) -> str:
    allowed = set(ORDER) | {'state'} | {temporary_name(name) for name in (*ORDER, 'state')}
    if not set(os.listdir(recovery)).issubset(allowed):
        raise InstallError('Unexpected recovery directory entries')
    if 'state' not in os.listdir(recovery):
        return 'preparing'
    value = read_file(recovery, 'state', {0}, 0o600).decode('ascii').strip()
    if value not in {'armed', 'installed', 'rolled_back'}:
        raise InstallError('Invalid recovery state; preserve evidence for operator review')
    return value


def set_state(recovery: int, value: str) -> None:
    recover_temporary(recovery, 'state', set(), False)
    write_file(recovery, 'state', f'{value}\n'.encode('ascii'), 0, 0, 0o600)


def apply(live: int, recovery: int, packet: int, baseline: dict[str, str], candidate: dict[str, str]) -> None:
    # Validate everything before arming rollback or replacing either live file.
    require_snapshot(live, baseline)
    artifacts = {name: read_file(packet, name, {0}, 0o644) for name in ORDER}
    if any(digest(artifacts[name]) != candidate[name] for name in ORDER):
        raise InstallError('Candidate artifact digest mismatch')
    for name in ORDER:
        write_file(recovery, name, read_file(live, name, {DEPLOY_UID}, 0o644), 0, 0, 0o600)
    if any(digest(read_file(recovery, name, {0}, 0o600)) != baseline[name] for name in ORDER):
        raise InstallError('Backup baseline changed before arming rollback')
    set_state(recovery, 'armed')
    require_snapshot(live, baseline)
    for name in ORDER:
        write_file(live, name, artifacts[name], DEPLOY_UID, DEPLOY_GID, 0o644)
    require_snapshot(live, candidate)
    set_state(recovery, 'installed')


def rollback(live: int, recovery: int, baseline: dict[str, str], candidate: dict[str, str]) -> str:
    previous = state(recovery)
    if previous in {'preparing', 'rolled_back'}:
        require_snapshot(live, baseline)
        return 'preparation_abandoned' if previous == 'preparing' else 'already_rolled_back'
    originals = {name: read_file(recovery, name, {0}, 0o600) for name in ORDER}
    if any(digest(originals[name]) != baseline[name] for name in ORDER):
        raise InstallError('Recovery backup digest mismatch')
    for name in ORDER:
        recover_temporary(live, name, {baseline[name], candidate[name]}, True)
    observed = snapshot(live, baseline)
    for name, value in observed.items():
        allowed = {baseline[name], candidate[name]} if name in ORDER else {baseline[name]}
        if value not in allowed:
            raise InstallError(f'Unexpected live drift blocks rollback: {name}')
    for name in ORDER:
        write_file(live, name, originals[name], DEPLOY_UID, DEPLOY_GID, 0o644)
    require_snapshot(live, baseline)
    set_state(recovery, 'rolled_back')
    return 'rolled_back'


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('apply', 'rollback', 'verify'))
    parser.add_argument('packet', type=Path, help='Protected root-owned packet with pinned manifests and two artifacts')
    args = parser.parse_args()
    if os.geteuid() != 0 or os.uname().sysname != 'Linux':
        raise InstallError('Requires a separately approved root invocation on Linux')
    os.umask(0o077)
    descriptors: list[int] = []
    try:
        packet = directory(args.packet, {0})
        descriptors.append(packet)
        baseline, candidate = manifests(packet)
        parent = directory(RECOVERY.parent, {0})
        descriptors.append(parent)
        lock = os.open('corgi-operations-cli-patch.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
                       0o600, dir_fd=parent)
        descriptors.append(lock)
        metadata = os.fstat(lock)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0
                or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) != 0o600):
            raise InstallError('Unsafe installation lock')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        deploy_parent = directory(DEPLOY_RECEIPTS, {0, DEPLOY_UID})
        descriptors.append(deploy_parent)
        # Share the existing workflow lock; do not bootstrap or replace it here.
        deploy_lock = os.open('production.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                              dir_fd=deploy_parent)
        descriptors.append(deploy_lock)
        metadata = os.fstat(deploy_lock)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != DEPLOY_UID
                or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) != 0o600):
            raise InstallError('Production deployment lock baseline changed')
        fcntl.flock(deploy_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        live = directory(LIVE, {0, DEPLOY_UID})
        descriptors.append(live)
        metadata = os.fstat(live)
        if metadata.st_uid != DEPLOY_UID or stat.S_IMODE(metadata.st_mode) != 0o755:
            raise InstallError('Live dist directory owner or mode changed')
        if args.action == 'apply':
            # No implicit retry over an earlier attempt, even a terminal one.
            require_snapshot(live, baseline)
            os.mkdir(RECOVERY.name, 0o700, dir_fd=parent)
            os.fsync(parent)
        recovery = directory(RECOVERY, {0})
        descriptors.append(recovery)
        if stat.S_IMODE(os.fstat(recovery).st_mode) != 0o700:
            raise InstallError('Recovery directory must be root-only mode 0700')
        if args.action == 'apply':
            apply(live, recovery, packet, baseline, candidate)
            outcome = 'installed'
        elif args.action == 'rollback':
            outcome = rollback(live, recovery, baseline, candidate)
        else:
            outcome = state(recovery)
            if outcome not in {'installed', 'rolled_back'}:
                raise InstallError(f'Unresolved installation state: {outcome}')
            if any(digest(read_file(recovery, name, {0}, 0o600)) != baseline[name] for name in ORDER):
                raise InstallError('Recovery backup digest mismatch')
            require_snapshot(live, candidate if outcome == 'installed' else baseline)
        # Detect replacement of the path to our anchored live directory.
        current = directory(LIVE, {0, DEPLOY_UID})
        try:
            if (os.fstat(current).st_dev, os.fstat(current).st_ino) != (os.fstat(live).st_dev, os.fstat(live).st_ino):
                raise InstallError('Live directory was replaced during operation; reconcile recovery evidence')
        finally:
            os.close(current)
        print(json.dumps({'status': outcome, 'changed_files': list(ORDER), 'service_restart': False}))
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


if __name__ == '__main__':
    main()
