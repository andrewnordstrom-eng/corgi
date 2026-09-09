import json
from pathlib import Path
import subprocess
import time
import uuid

identity = uuid.uuid4().hex
name = 'proj2258-phaseb-acl-' + identity[:12]
label = 'org.corgi.proj2258-rehearsal=' + identity
image = 'sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
packet = Path(__file__).resolve().parent
repo = packet.parents[3]

def sql(source: str, succeeds: bool) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(['docker','exec','-i',name,'psql','-X','-w','-U','feed','-d','bluesky_feed','-v','ON_ERROR_STOP=1','-tA'],input=source,capture_output=True,text=True,timeout=15,check=False)
    if (result.returncode == 0) != succeeds:
        raise AssertionError(f'Unexpected SQL outcome: exit={result.returncode}, stderr={result.stderr}')
    return result

try:
    subprocess.run(['docker','run','-d','--name',name,'--label',label,'--network','none','--tmpfs','/var/lib/postgresql/data','-e','POSTGRES_USER=feed','-e','POSTGRES_DB=bluesky_feed','-e','POSTGRES_HOST_AUTH_METHOD=trust',image],check=True,capture_output=True,text=True,timeout=20)
    ready = False
    for attempt in range(30):
        result = subprocess.run(['docker','exec',name,'pg_isready','-U','feed','-d','bluesky_feed'],capture_output=True,timeout=3,check=False)
        pid1 = subprocess.run(['docker','exec',name,'cat','/proc/1/comm'],capture_output=True,text=True,timeout=3,check=True)
        if result.returncode == 0 and pid1.stdout.strip() == 'postgres':
            ready = True
            break
        time.sleep(0.5)
    if not ready:
        raise TimeoutError('Disposable PostgreSQL did not become ready')
    sql('CREATE TABLE governance_epochs(id integer); CREATE TABLE subscribers(id integer); CREATE TABLE restricted_fixture(id integer); INSERT INTO governance_epochs VALUES (1); INSERT INTO subscribers VALUES (2);',True)
    server_version = sql('SHOW server_version;',True).stdout.strip()
    apply = (repo/'ops/provision-corgi-operations-database.sql').read_text()
    rollback = (repo/'ops/rollback-corgi-operations-database.sql').read_text()
    sql('CREATE SCHEMA auxiliary; GRANT CREATE ON SCHEMA auxiliary TO PUBLIC;',True)
    sql(apply,False)
    sql('REVOKE CREATE ON SCHEMA auxiliary FROM PUBLIC; CREATE TABLE auxiliary.other_table(id int); GRANT SELECT ON auxiliary.other_table TO PUBLIC;',True)
    sql(apply,False)
    sql('REVOKE SELECT ON auxiliary.other_table FROM PUBLIC; CREATE SEQUENCE auxiliary.other_sequence; GRANT USAGE ON SEQUENCE auxiliary.other_sequence TO PUBLIC;',True)
    sql(apply,False)
    sql('REVOKE USAGE ON SEQUENCE auxiliary.other_sequence FROM PUBLIC;',True)
    sql(apply,True)
    role = sql("SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,rolconnlimit,has_database_privilege(oid,'bluesky_feed','TEMP') FROM pg_roles WHERE rolname='corgi_operations';",True).stdout.strip()
    assert role == 'f|f|f|f|f|f|f|2|f', role
    selected=sql('SET ROLE corgi_operations; SELECT id FROM governance_epochs; SELECT id FROM subscribers;',True).stdout
    assert '1\n2' in selected
    negatives = {
        'temporary_table':'CREATE TEMP TABLE forbidden_temp(id int)',
        'insert':'INSERT INTO governance_epochs VALUES (3)',
        'update':'UPDATE subscribers SET id=3',
        'delete':'DELETE FROM subscribers',
        'create_schema':'CREATE SCHEMA forbidden_schema',
        'create_table':'CREATE TABLE public.forbidden_table(id int)',
        'read_other_table':'SELECT * FROM restricted_fixture',
        'assume_feed':'SET ROLE feed',
    }
    for label, statement in negatives.items():
        result=sql('SET SESSION AUTHORIZATION corgi_operations; '+statement+';',False)
        if 'permission denied' not in result.stderr and 'must be' not in result.stderr:
            raise AssertionError(f'{label} rejected for unexpected reason: {result.stderr}')
    sql('CREATE TEMP TABLE feed_still_allowed(id int);',True)
    sql(apply,False)
    sql('ALTER ROLE corgi_operations LOGIN;',True)
    sql(rollback,False)
    sql('ALTER ROLE corgi_operations NOLOGIN;',True)
    sql(rollback,True)
    assert sql("SELECT count(*) FROM pg_roles WHERE rolname='corgi_operations';",True).stdout.strip()=='0'
    assert sql("SELECT has_database_privilege('feed','bluesky_feed','TEMP');",True).stdout.strip()=='t'
    public = sql("SELECT array_agg(a.privilege_type ORDER BY a.privilege_type) FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname='bluesky_feed' AND a.grantee=0;",True).stdout.strip()
    assert public=='{CONNECT,TEMPORARY}', public
    sql('CREATE ROLE pgcustom;',True)
    sql(apply,False)
    assert sql("SELECT count(*) FROM pg_roles WHERE rolname='corgi_operations';",True).stdout.strip()=='0'
    receipt={'image_id':image,'server_version':server_version,'network':'none','production_touched':False,'public_schema_table_sequence_drift_failed_closed':True,'positive_selects':2,'negative_cases_passed':list(negatives),'feed_temp_preserved':True,'repeat_apply_failed_closed':True,'rollback_role_removed':True,'rollback_public_privileges_restored':True,'changed_role_inventory_failed_closed':True,'login_enabled_rollback_failed_closed':True,'note':'NOLOGIN role tested with SET SESSION AUTHORIZATION; credential authentication remains separate.'}
    (packet/'database-rehearsal-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt,indent=2))
finally:
    owned = subprocess.run(['docker','ps','-aq','--filter','label='+label],check=True,capture_output=True,text=True,timeout=10).stdout.splitlines()
    if len(owned) > 1:
        raise AssertionError('Multiple containers have this unique rehearsal label; preserve them for inspection')
    if owned:
        subprocess.run(['docker','rm','-f',owned[0]],check=True,capture_output=True,text=True,timeout=15)
