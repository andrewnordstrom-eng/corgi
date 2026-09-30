import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyStaticExportResponseHeaders,
  discoverStaticExportHtmlPaths,
  staticExportDocumentRedirect,
} from '../src/feed/static-export-headers.js';

const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const HTML_SCRIPT_POLICY = "script-src 'self' 'unsafe-inline'";
const HTML_FRAME_POLICY = "frame-src 'self' https://www.youtube-nocookie.com";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe('static-export response headers', () => {
  it('recovers document payload navigation without redirecting RSC or unrelated requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corgi-document-recovery-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'feed'));
    await writeFile(join(root, 'index.html'), '<title>Home</title>');
    await writeFile(join(root, 'index.txt'), 'home payload');
    await writeFile(join(root, 'feed', 'index.html'), '<title>Feed</title>');
    await writeFile(join(root, 'feed', 'index.txt'), 'feed payload');
    await writeFile(join(root, 'robots.txt'), 'User-agent: *');
    const paths = discoverStaticExportHtmlPaths(root);
    const app = Fastify({ logger: false });
    await app.register(fastifyStatic, { root, wildcard: false });
    app.addHook('onRequest', async (request, reply) => {
      const destination = staticExportDocumentRedirect(request, paths);
      if (destination !== undefined) {
        return reply.header('cache-control', 'no-store').redirect(destination);
      }
    });
    const documentHeaders = {
      accept: HTML_ACCEPT,
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
    };
    try {
      for (const method of ['GET', 'HEAD'] as const) {
        const response = await app.inject({ method, url: '/feed/index.txt?filter=a%20b', headers: documentHeaders });
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe('/feed/?filter=a%20b');
        expect(response.headers['cache-control']).toBe('no-store');
      }
      const home = await app.inject({ url: '/index.txt', headers: documentHeaders });
      expect(home.headers.location).toBe('/');
      const recovered = await app.inject({ url: '/feed/', headers: documentHeaders });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.body).toContain('<title>Feed</title>');
      for (const headers of [
        { accept: '*/*', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', rsc: '1' },
        { ...documentHeaders, rsc: '1' },
        { ...documentHeaders, 'sec-fetch-dest': 'empty' },
        { ...documentHeaders, 'sec-fetch-mode': 'cors' },
        { ...documentHeaders, accept: 'text/html;q=0' },
        { accept: HTML_ACCEPT },
      ]) {
        const response = await app.inject({ url: '/feed/index.txt?_rsc=test', headers });
        expect(response.statusCode).toBe(200);
        expect(response.headers.location).toBeUndefined();
        expect(response.body).toBe('feed payload');
      }
      for (const url of ['/robots.txt', '/missing/index.txt', '/api/index.txt', '//outside.example/index.txt']) {
        const response = await app.inject({ url, headers: documentHeaders });
        expect(response.headers.location).toBeUndefined();
      }
      const post = await app.inject({ method: 'POST', url: '/feed/index.txt', headers: documentHeaders });
      expect(post.headers.location).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('preserves the HTML CSP and cache policy on conditional 304 responses', async () => {
    const webDistDir = await mkdtemp(join(tmpdir(), 'corgi-static-export-'));
    temporaryDirectories.push(webDistDir);
    await writeFile(
      join(webDistDir, 'index.html'),
      '<!doctype html><html><body><main>Corgi</main><script>self.__next_f=[]</script></body></html>',
      'utf8',
    );
    await mkdir(join(webDistDir, '_next', 'static'), { recursive: true });
    await mkdir(join(webDistDir, 'demo'), { recursive: true });
    await writeFile(join(webDistDir, 'demo', 'index.html'), '<!doctype html><title>Demo</title>', 'utf8');
    await writeFile(join(webDistDir, '_next', 'static', 'app.js'), 'console.log("Corgi");', 'utf8');
    await writeFile(join(webDistDir, 'data.json'), '{"name":"Corgi"}', 'utf8');
    await writeFile(join(webDistDir, 'manifest'), 'not an HTML document', 'utf8');

    const htmlDocumentPaths = discoverStaticExportHtmlPaths(webDistDir);
    expect([...htmlDocumentPaths].sort()).toEqual([
      '/',
      '/demo',
      '/demo/',
      '/demo/index.html',
      '/index.html',
    ]);

    const app = Fastify({ logger: false });
    await app.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
        },
      },
    });
    await app.register(fastifyStatic, {
      root: webDistDir,
      prefix: '/',
      wildcard: false,
    });
    app.addHook('onSend', async (request, reply) => {
      applyStaticExportResponseHeaders(request, reply, htmlDocumentPaths);
    });
    await app.ready();

    try {
      const initial = await app.inject({
        method: 'GET',
        url: '/',
        headers: { accept: HTML_ACCEPT },
      });

      expect(initial.statusCode).toBe(200);
      expect(initial.headers['content-security-policy']).toContain(HTML_SCRIPT_POLICY);
      expect(initial.headers['content-security-policy']).toContain(HTML_FRAME_POLICY);
      expect(initial.headers['cache-control']).toBe('no-cache');
      expect(initial.headers.etag).toBeTypeOf('string');

      const conditional = await app.inject({
        method: 'GET',
        url: '/',
        headers: {
          accept: HTML_ACCEPT,
          'if-none-match': initial.headers.etag as string,
        },
      });

      expect(conditional.statusCode).toBe(304);
      expect(conditional.headers['content-security-policy']).toContain(HTML_SCRIPT_POLICY);
      expect(conditional.headers['content-security-policy']).toContain(HTML_FRAME_POLICY);
      expect(conditional.headers['cache-control']).toBe('no-cache');

      const staticAsset = await app.inject({
        method: 'GET',
        url: '/_next/static/app.js',
      });
      expect(staticAsset.statusCode).toBe(200);
      expect(staticAsset.headers.etag).toBeTypeOf('string');

      const revalidatedStaticAsset = await app.inject({
        method: 'GET',
        url: '/_next/static/app.js',
        headers: {
          accept: HTML_ACCEPT,
          'if-none-match': staticAsset.headers.etag as string,
        },
      });
      expect(revalidatedStaticAsset.statusCode).toBe(304);
      expect(revalidatedStaticAsset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(revalidatedStaticAsset.headers['content-security-policy']).not.toContain(HTML_SCRIPT_POLICY);

      const jsonAsset = await app.inject({
        method: 'GET',
        url: '/data.json',
      });
      expect(jsonAsset.statusCode).toBe(200);
      expect(jsonAsset.headers.etag).toBeTypeOf('string');

      for (const accept of [undefined, HTML_ACCEPT]) {
        const headers: Record<string, string> = {
          'if-none-match': jsonAsset.headers.etag as string,
        };
        if (accept !== undefined) {
          headers.accept = accept;
        }
        const revalidatedJsonAsset = await app.inject({
          method: 'GET',
          url: '/data.json',
          headers,
        });
        expect(revalidatedJsonAsset.statusCode).toBe(304);
        expect(revalidatedJsonAsset.headers['cache-control']).not.toBe('no-cache');
        expect(revalidatedJsonAsset.headers['content-security-policy']).not.toContain(HTML_SCRIPT_POLICY);
      }

      const extensionlessAsset = await app.inject({
        method: 'GET',
        url: '/manifest',
      });
      expect(extensionlessAsset.statusCode).toBe(200);
      expect(extensionlessAsset.headers.etag).toBeTypeOf('string');
      for (const accept of [HTML_ACCEPT, 'text/html;q=0,*/*;q=1']) {
        const revalidatedExtensionlessAsset = await app.inject({
          method: 'GET',
          url: '/manifest',
          headers: {
            accept,
            'if-none-match': extensionlessAsset.headers.etag as string,
          },
        });
        expect(revalidatedExtensionlessAsset.statusCode).toBe(304);
        expect(revalidatedExtensionlessAsset.headers['cache-control']).not.toBe('no-cache');
        expect(revalidatedExtensionlessAsset.headers['content-security-policy']).not.toContain(HTML_SCRIPT_POLICY);
      }
    } finally {
      await app.close();
    }
  });
});
