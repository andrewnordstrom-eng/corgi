\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5s';
DO $guard$
BEGIN
  IF current_database() <> 'bluesky_feed' THEN
    RAISE EXCEPTION 'PROJ-2258 expected bluesky_feed database';
  END IF;
  IF (SELECT array_agg(rolname::text ORDER BY rolname) FROM pg_roles WHERE left(rolname, 3) <> 'pg_') IS DISTINCT FROM ARRAY['feed']::text[] THEN
    RAISE EXCEPTION 'PROJ-2258 role baseline changed; requalify affected principals';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='feed' AND rolsuper AND rolcanlogin) THEN
    RAISE EXCEPTION 'PROJ-2258 existing feed principal no longer matches inspected baseline';
  END IF;
  IF (SELECT array_agg(a.privilege_type ORDER BY a.privilege_type) FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() AND a.grantee=0) IS DISTINCT FROM ARRAY['CONNECT','TEMPORARY']::text[] THEN
    RAISE EXCEPTION 'PROJ-2258 PUBLIC database privileges differ from inspected baseline';
  END IF;
  IF (SELECT array_agg(a.privilege_type ORDER BY a.privilege_type) FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='public' AND a.grantee=0) IS DISTINCT FROM ARRAY['USAGE']::text[] THEN
    RAISE EXCEPTION 'PROJ-2258 PUBLIC schema privileges differ from inspected baseline';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema' AND a.grantee=0 AND a.privilege_type='CREATE') THEN
    RAISE EXCEPTION 'PROJ-2258 PUBLIC schema CREATE requires separate qualification';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a WHERE left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f','S') AND a.grantee=0) THEN
    RAISE EXCEPTION 'PROJ-2258 PUBLIC table grants require separate qualification';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND a.grantee=0 AND a.privilege_type='EXECUTE' AND p.prosecdef) THEN
    RAISE EXCEPTION 'PROJ-2258 PUBLIC security-definer routine requires separate qualification';
  END IF;
END
$guard$;
CREATE ROLE corgi_operations NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2;
REVOKE TEMPORARY ON DATABASE bluesky_feed FROM PUBLIC;
GRANT CONNECT ON DATABASE bluesky_feed TO corgi_operations;
GRANT USAGE ON SCHEMA public TO corgi_operations;
GRANT SELECT ON TABLE public.governance_epochs, public.subscribers TO corgi_operations;
ALTER ROLE corgi_operations SET statement_timeout = '5s';
ALTER ROLE corgi_operations SET lock_timeout = '2s';
ALTER ROLE corgi_operations SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE corgi_operations SET default_transaction_read_only = 'on';
COMMIT;
