\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5s';
DO $guard$
BEGIN
  IF current_database() <> 'bluesky_feed' THEN
    RAISE EXCEPTION 'PROJ-2258 expected bluesky_feed database';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='corgi_operations' AND rolcanlogin) THEN
    RAISE EXCEPTION 'PROJ-2258 first disable operations LOGIN in a separately approved committed transaction';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename='corgi_operations') THEN
    RAISE EXCEPTION 'PROJ-2258 operations sessions still active; quiesce callers before rollback';
  END IF;
  IF (SELECT array_agg(rolname::text ORDER BY rolname) FROM pg_roles WHERE left(rolname, 3) <> 'pg_') IS DISTINCT FROM ARRAY['corgi_operations','feed']::text[] THEN
    RAISE EXCEPTION 'PROJ-2258 role baseline changed; requalify rollback';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='feed' AND rolsuper AND rolcanlogin) THEN
    RAISE EXCEPTION 'PROJ-2258 feed role baseline changed; requalify rollback';
  END IF;
  IF (SELECT array_agg(a.privilege_type ORDER BY a.privilege_type) FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() AND a.grantee=0) IS DISTINCT FROM ARRAY['CONNECT']::text[] THEN
    RAISE EXCEPTION 'PROJ-2258 PUBLIC database privileges changed after apply';
  END IF;
END
$guard$;
REVOKE SELECT ON TABLE public.governance_epochs,public.subscribers FROM corgi_operations;
REVOKE USAGE ON SCHEMA public FROM corgi_operations;
REVOKE CONNECT ON DATABASE bluesky_feed FROM corgi_operations;
DROP ROLE corgi_operations;
GRANT TEMPORARY ON DATABASE bluesky_feed TO PUBLIC;
COMMIT;
