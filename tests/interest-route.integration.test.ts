import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Opt-in only: this suite owns a disposable database, never a production URL.
const databaseUrl = process.env.INTEREST_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('contact interest with real PostgreSQL', () => {
  let db: typeof import('../src/db/client.js').db;
  let healthDb: typeof import('../src/db/client.js').healthDb;
  let register: typeof import('../src/governance/routes/interest.js').registerInterestRoute;
  let rateConfig: typeof import('../src/feed/rate-limit-config.js').buildRouteRateLimitConfig;
  const payload = { email: 'Visitor@Example.test', interests: ['research'], contactConsent: true };
  beforeAll(async () => {
    if (!databaseUrl || !databaseUrl.startsWith('postgresql://postgres:synthetic-local-only@127.0.0.1:54389/')) {
      throw new TypeError('Use only the owned synthetic PostgreSQL fixture on loopback:54389');
    }
    process.env.DATABASE_URL = databaseUrl;
    ({ db, healthDb } = await import('../src/db/client.js'));
    ({ registerInterestRoute: register } = await import('../src/governance/routes/interest.js'));
    ({ buildRouteRateLimitConfig: rateConfig } = await import('../src/feed/rate-limit-config.js'));
    await db.query(readFileSync('src/db/migrations/045_contact_interest.sql', 'utf8'));
  });
  afterAll(async () => { await db?.end(); await healthDb?.end(); });

  it('persists email-only interest and preserves first submission under concurrent duplicates', async () => {
    const app = Fastify(); register(app);
    const first = await app.inject({ method: 'POST', url: '/api/interest', payload });
    expect(first.statusCode).toBe(200);
    const duplicates = await Promise.all(Array.from({ length: 5 }, () => app.inject({ method: 'POST', url: '/api/interest', payload: { ...payload, note: 'overwrite attempt' } })));
    for (const response of duplicates) expect(response.body).toBe(first.body);
    const rows = await db.query('SELECT email, handle, interests, note, consent_version FROM contact_interest');
    expect(rows.rows).toEqual([{ email: 'visitor@example.test', handle: null, interests: ['research'], note: null, consent_version: 'contact-interest-v1' }]);
    expect((await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([{ tablename: 'contact_interest' }]);
    await app.close();
  });
  it('accepts an optional normalized handle but rejects bad input and silently drops honeypots', async () => {
    const app = Fastify(); register(app);
    expect((await app.inject({ method: 'POST', url: '/api/interest', payload: { ...payload, email: 'second@example.test', handle: ' @Bird.Bsky.Social ' } })).statusCode).toBe(200);
    expect((await db.query("SELECT handle FROM contact_interest WHERE email='second@example.test'")).rows[0].handle).toBe('bird.bsky.social');
    for (const change of [{ email: 'bad' }, { handle: 'did:plc:no' }, { interests: [] }, { interests: ['vote-admin'] }, { interests: ['use', 'use'] }, { contactConsent: false }, { note: 'x'.repeat(501) }, { unexpected: true }]) {
      expect((await app.inject({ method: 'POST', url: '/api/interest', payload: { ...payload, ...change } })).statusCode).toBe(400);
    }
    const bot = await app.inject({ method: 'POST', url: '/api/interest', payload: { ...payload, email: 'bot@example.test', website: 'filled' } });
    expect(bot.statusCode).toBe(200);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM contact_interest')).rows[0].n).toBe(2);
    expect(bot.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'POST', url: '/api/interest', payload: { ...payload, note: 'x'.repeat(5000) } })).statusCode).toBe(413);
    await app.close();
  });
  it('enforces the separate 20-request limit without changing the login configuration', async () => {
    const cfg = rateConfig('/api/interest', 'POST', request => request.ip);
    const login = rateConfig('/api/governance/auth/login', 'POST', request => request.ip);
    expect(cfg).toEqual({ max: 20, timeWindow: 600000 });
    expect(login).toEqual({ max: 10, timeWindow: 60000 });
    const app = Fastify(); await app.register(rateLimit, { ...cfg!, global: true }); register(app);
    for (let i = 0; i < 20; i += 1) expect((await app.inject({ method: 'POST', url: '/api/interest', payload })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/interest', payload })).statusCode).toBe(429);
    await app.close();
  });
  it('fails visibly without disclosing contact values when storage fails', async () => {
    const app = Fastify(); register(app);
    await db.query('ALTER TABLE contact_interest RENAME TO contact_interest_unavailable');
    const response = await app.inject({ method: 'POST', url: '/api/interest', payload });
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain(payload.email);
    await db.query('ALTER TABLE contact_interest_unavailable RENAME TO contact_interest');
    await app.close();
  });
});
