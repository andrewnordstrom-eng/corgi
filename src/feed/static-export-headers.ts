import type { FastifyReply, FastifyRequest } from 'fastify';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const STATIC_EXPORT_HTML_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "frame-src 'self' https://www.youtube-nocookie.com",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data: https:",
  "connect-src 'self' https: wss:",
  "form-action 'self'",
  "script-src-attr 'none'",
  "upgrade-insecure-requests",
].join('; ');

function acceptsHtml(request: FastifyRequest): boolean {
  return request.headers.accept?.split(',').some((mediaRange) => {
    const [rawType, ...rawParameters] = mediaRange.split(';');
    if (rawType?.trim().toLowerCase() !== 'text/html') return false;
    const qualityParameter = rawParameters
      .map((parameter) => parameter.trim().toLowerCase())
      .find((parameter) => parameter.startsWith('q='));
    if (qualityParameter === undefined) return true;
    const quality = Number(qualityParameter.slice(2));
    return Number.isFinite(quality) && quality > 0 && quality <= 1;
  }) ?? false;
}

function targetsHtmlDocument(request: FastifyRequest, htmlDocumentPaths: ReadonlySet<string>): boolean {
  const pathname = request.url.split('?', 1)[0] ?? '';
  return htmlDocumentPaths.has(pathname);
}

export function discoverStaticExportHtmlPaths(root: string): ReadonlySet<string> {
  const routes = new Set<string>();
  visitStaticExportDirectory(root, '', routes);
  return routes;
}

export function staticExportDocumentRedirect(
  request: FastifyRequest,
  htmlDocumentPaths: ReadonlySet<string>,
): string | undefined {
  if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;
  if (request.headers['sec-fetch-dest'] !== 'document'
    || request.headers['sec-fetch-mode'] !== 'navigate'
    || request.headers.rsc !== undefined
    || !acceptsHtml(request)) return undefined;

  const queryStart = request.url.indexOf('?');
  const pathname = queryStart === -1 ? request.url : request.url.slice(0, queryStart);
  if (!pathname.endsWith('/index.txt') || pathname.startsWith('//')) return undefined;
  // Decode only for disk-path lookup; never redirect ambiguous path separators.
  if (/%2f|%5c/i.test(pathname)) return undefined;
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
  if (!decodedPathname.startsWith('/')
    || /[\\?#\u0000-\u001f\u007f]/.test(decodedPathname)
    || path.posix.normalize(decodedPathname) !== decodedPathname) return undefined;
  const documentPath = `${decodedPathname.slice(0, -'index.txt'.length)}index.html`;
  if (!htmlDocumentPaths.has(documentPath)) return undefined;

  const query = queryStart === -1 ? '' : request.url.slice(queryStart);
  return `${pathname.slice(0, -'index.txt'.length)}${query}`;
}

function visitStaticExportDirectory(root: string, relativeDirectory: string, routes: Set<string>): void {
  const absoluteDirectory = path.join(root, relativeDirectory);
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      visitStaticExportDirectory(root, relativePath, routes);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
    const webPath = `/${relativePath.split(path.sep).join('/')}`;
    routes.add(webPath);
    if (webPath === '/index.html') {
      routes.add('/');
    } else if (webPath.endsWith('/index.html')) {
      const route = webPath.slice(0, -'/index.html'.length);
      routes.add(route);
      routes.add(`${route}/`);
    }
  }
}

export function applyStaticExportResponseHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  htmlDocumentPaths: ReadonlySet<string>,
): void {
  if (request.url.startsWith('/_next/static/')) {
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    return;
  }

  const contentType = reply.getHeader('content-type');
  const isHtmlResponse = typeof contentType === 'string' && contentType.startsWith('text/html');
  const isRevalidatedHtml = reply.statusCode === 304
    && acceptsHtml(request)
    && targetsHtmlDocument(request, htmlDocumentPaths);
  if (isHtmlResponse || isRevalidatedHtml) {
    reply.header('cache-control', 'no-cache');
    reply.header('content-security-policy', STATIC_EXPORT_HTML_CSP);
  }
}
