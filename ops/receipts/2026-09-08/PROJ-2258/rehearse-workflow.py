#!/usr/bin/env python3
"""Execute the actual workflow shell against a synthetic SSH transport on Linux."""

import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


TRANSPORT = '''#!/usr/bin/python3
import json, os, pathlib, stat, sys
args = sys.argv[1:]
token = args[-1]
assert args[-2] == 'corgi-operations@192.0.2.1'
assert token in {'epoch-status', 'disk-root', 'health-ready', 'feed-updated-at'}
credential = 'postgresql://corgi_operations:fixture@127.0.0.1:5433/bluesky_feed'
assert all(credential not in arg for arg in args)
if token != 'epoch-status':
    assert 'DATABASE_URL' not in os.environ
key = pathlib.Path(args[args.index('-i') + 1])
assert stat.S_IMODE(key.stat().st_mode) == 0o600
assert key.parent.stat().st_mode & 0o077 == 0
assert 'StrictHostKeyChecking=yes' in args
assert 'IdentityAgent=none' in args
assert 'UpdateHostKeys=no' in args
assert 'BatchMode=yes' in args
assert 'GlobalKnownHostsFile=/dev/null' in args
assert args[:2] == ['-F', '/dev/null']
known = [arg for arg in args if arg.startswith('UserKnownHostsFile=')]
assert len(known) == 1
host_key = pathlib.Path(known[0].split('=', 1)[1])
assert host_key.parent == key.parent
assert host_key.read_text() == 'fixture-host-key\\n'
stdin = sys.stdin.read()
assert stdin == (credential + '\\n' if token == 'epoch-status' else '')
with open(os.environ['CALL_LOG'], 'a') as output:
    output.write(json.dumps({'token': token, 'credential_in_argv': False}) + '\\n')
scenario = os.environ['SCENARIO']
if scenario == 'fail-' + token:
    sys.exit(73)
if token == 'epoch-status':
    print('{"epoch":null,"subscriberCount":0}')
elif token == 'disk-root':
    if scenario == 'disk-malformed':
        print('unparseable')
    else:
        print('Filesystem 1024-blocks Used Available Capacity Mounted on')
        print('/dev/fixture 100 20 80 ' + os.environ['DISK_CAPACITY'] + ' /')
elif token == 'health-ready':
    print('{"status":"ok"}')
else:
    print(os.environ['UPDATED'])
'''


def main() -> None:
    if os.uname().sysname != 'Linux':
        raise RuntimeError('Linux GNU date and timeout are required for this rehearsal')
    workflow = Path('/fixture/daily-health.yml').read_text()
    match = re.search(r'^      - name: Check operations on VPS\n.*?^        run: \|\n(.*?)(?=^      - name:)', workflow, re.M | re.S)
    if match is None:
        raise ValueError('Cannot locate the actual operations workflow shell')
    shell = '\n'.join(line[10:] for line in match.group(1).splitlines())
    scenarios = ['success', 'empty-key', 'malformed-time', 'stale-time', 'future-time',
                 'disk-malformed', 'disk-critical', 'missing-secret']
    scenarios += ['disk-79', 'disk-80', 'disk-85', 'disk-89', 'age-1800', 'age-1801']
    scenarios += ['fail-' + token for token in ('epoch-status', 'disk-root', 'health-ready', 'feed-updated-at')]
    passed: list[str] = []
    for scenario in scenarios:
        with tempfile.TemporaryDirectory(prefix='proj2258-workflow-') as directory:
            root = Path(directory)
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            ssh = bin_dir / 'ssh'
            ssh.write_text(TRANSPORT)
            ssh.chmod(0o755)
            now_epoch = 1_800_000_000
            now = datetime.datetime.fromtimestamp(now_epoch, datetime.timezone.utc).isoformat()
            date = bin_dir / 'date'
            date.write_text('#!/bin/bash\nif [[ "$*" == "+%s" ]]; then printf "%s\\n" 1800000000; else exec /usr/bin/date "$@"; fi\n')
            date.chmod(0o755)
            updated = {'empty-key': '', 'malformed-time': 'not-a-timestamp',
                       'stale-time': '2001-01-01T00:00:00Z', 'future-time': '2099-01-01T00:00:00Z'}.get(scenario, now)
            if scenario in {'age-1800', 'age-1801'}:
                age = int(scenario.split('-')[1])
                updated = datetime.datetime.fromtimestamp(now_epoch - age, datetime.timezone.utc).isoformat()
            capacity = '90%' if scenario == 'disk-critical' else scenario.split('-')[1] + '%' if scenario in {'disk-79', 'disk-80', 'disk-85', 'disk-89'} else '20%'
            environment = dict(os.environ)
            environment.update({'PATH': f'{bin_dir}:/usr/bin:/bin', 'RUNNER_TEMP': directory,
                                'SCENARIO': scenario, 'UPDATED': updated, 'DISK_CAPACITY': capacity, 'CALL_LOG': str(root / 'calls'),
                                'DATABASE_URL': 'postgresql://corgi_operations:fixture@127.0.0.1:5433/bluesky_feed',
                                'VPS_HOST': '192.0.2.1', 'VPS_SSH_KEY': 'fixture-key',
                                'VPS_SSH_HOST_KEY': 'fixture-host-key'})
            if scenario == 'missing-secret':
                environment['VPS_SSH_KEY'] = ''
            result = subprocess.run(['bash', '-c', shell], env=environment, capture_output=True,
                                    text=True, timeout=10, check=False)
            expected_success = scenario in {'success', 'empty-key', 'disk-79', 'disk-80', 'disk-85', 'disk-89', 'age-1800'}
            if (result.returncode == 0) != expected_success:
                raise AssertionError(f'{scenario}: exit={result.returncode}; {result.stderr}; {result.stdout}')
            expected_error = {
                'missing-secret': '::error::Missing production-operations input',
                'disk-malformed': '::error::Invalid POSIX disk usage response',
                'disk-critical': '::error::VPS disk is at or above the critical 90% threshold',
                'malformed-time': '::error::Feed updated_at is not a valid timestamp',
                'future-time': '::error::Feed updated_at is outside the valid time range',
                'stale-time': '::error::Feed is more than 30 minutes stale',
                'age-1801': '::error::Feed is more than 30 minutes stale',
            }.get(scenario)
            if expected_error is not None and expected_error not in result.stdout:
                raise AssertionError(f'{scenario}: wrong failure reason: {result.stderr}; {result.stdout}')
            if 'Traceback' in result.stderr:
                raise AssertionError(f'{scenario}: synthetic transport failed: {result.stderr}')
            if scenario.startswith('fail-') and result.returncode != 73:
                raise AssertionError(f'{scenario}: did not propagate the intentional SSH exit')
            if scenario in {'disk-80', 'disk-85', 'disk-89'}:
                assert '::warning::VPS disk' in result.stdout
            elif scenario in {'disk-79', 'age-1800'}:
                assert '::warning::' not in result.stdout
            if any(root.glob('corgi-operations.*')):
                raise AssertionError(f'{scenario}: credential directory was not removed')
            if environment['DATABASE_URL'] in result.stdout + result.stderr:
                raise AssertionError(f'{scenario}: synthetic credential leaked to output')
            if expected_success:
                calls = [json.loads(line)['token'] for line in (root / 'calls').read_text().splitlines()]
                assert calls == ['epoch-status', 'disk-root', 'health-ready', 'feed-updated-at'], calls
            if scenario == 'empty-key':
                assert '::warning::' in result.stdout
            passed.append(scenario)
    print(json.dumps({'transport': 'synthetic SSH; actual workflow Bash/GNU date/timeout',
                      'production_touched': False, 'cases_passed': passed}, indent=2))


if __name__ == '__main__':
    main()
