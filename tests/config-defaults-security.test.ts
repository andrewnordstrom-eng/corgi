import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import Fastify from 'fastify';
import { parseTrustProxyConfig } from '../src/feed/server.js';

vi.mock('../src/db/redis.js', () => ({
  redis: {},
}));

describe('security-oriented config defaults', () => {
  it('uses did:plc-only default issuer prefixes in config schema', () => {
    const source = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
    expect(source).toContain("FEED_JWT_ALLOWED_ISSUER_PREFIXES: z.string().default('did:plc:')");
  });

  it('enforces a non-default export anonymization salt in production', () => {
    const source = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
    expect(source).toContain('EXPORT_ANONYMIZATION_SALT must be explicitly set in production.');
    expect(source).toContain('EXPORT_ANONYMIZATION_SALT should be at least 32 characters in production.');
  });

  it('parses trustProxy configuration safely', () => {
    expect(parseTrustProxyConfig('false')).toBe(false);
    expect(parseTrustProxyConfig('true')).toBe(true);
    expect(parseTrustProxyConfig(' OFF ')).toBe(false);
    expect(parseTrustProxyConfig(' On ')).toBe(true);
    expect(parseTrustProxyConfig('   ')).toBe(false);
    expect(parseTrustProxyConfig('loopback')).toBe('loopback');
    expect(parseTrustProxyConfig(' 127.1 ')).toBe('127.1');
    expect(parseTrustProxyConfig('127.0.0.1,10.0.0.0/8')).toEqual(['127.0.0.1', '10.0.0.0/8']);
    expect(parseTrustProxyConfig(' loopback, , 10.0.0.0/8 ')).toEqual(['loopback', '10.0.0.0/8']);
  });

  it.each(['0', '1', '2', '01', ' 2 ', '999999999999999999999999999999999999'])(
    'rejects numeric TRUST_PROXY hop count %j with migration guidance',
    (value) => {
      expect(() => parseTrustProxyConfig(value)).toThrow(TypeError);
      expect(() => parseTrustProxyConfig(value)).toThrow(
        'TRUST_PROXY numeric hop counts are unsupported because they cannot validate the connecting proxy. ' +
        'Use an explicit trusted proxy IP/CIDR or "loopback" instead.',
      );
    },
  );

  it.each([
    ['loopback', '127.0.0.1'],
    ['127.0.0.1,10.0.0.0/8', '127.0.0.1'],
    ['127.0.0.1,10.0.0.0/8', '10.0.0.7'],
  ])(
    'honors forwarded headers with %j from trusted peer %j',
    async (value, trustedPeer) => {
      const app = Fastify({ trustProxy: parseTrustProxyConfig(value) });
      app.get('/', async (request) => ({
        ip: request.ip,
        host: request.host,
        protocol: request.protocol,
      }));
      const headers = {
        host: 'origin.example',
        'x-forwarded-for': '198.51.100.9',
        'x-forwarded-host': 'proxy.example',
        'x-forwarded-proto': 'https',
      };

      try {
        const untrusted = await app.inject({ url: '/', remoteAddress: '203.0.113.7', headers });
        expect(untrusted.statusCode).toBe(200);
        expect(untrusted.json()).toEqual({
          ip: '203.0.113.7', host: 'origin.example', protocol: 'http',
        });

        const trusted = await app.inject({ url: '/', remoteAddress: trustedPeer, headers });
        expect(trusted.statusCode).toBe(200);
        expect(trusted.json()).toEqual({
          ip: '198.51.100.9', host: 'proxy.example', protocol: 'https',
        });
      } finally {
        await app.close();
      }
    },
  );
});
