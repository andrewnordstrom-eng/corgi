export class InvalidRedisUrlError extends Error {
  constructor() {
    super('Redis URL is not parsable');
    this.name = 'InvalidRedisUrlError';
  }
}

function parseRedisUrl(redisUrl: string): URL {
  try {
    const parsed = new URL(redisUrl);
    if (
      (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:')
      || parsed.hostname.length === 0
    ) {
      throw new InvalidRedisUrlError();
    }
    return parsed;
  } catch (error) {
    if (error instanceof InvalidRedisUrlError) {
      throw error;
    }
    throw new InvalidRedisUrlError();
  }
}

function normalizeNumericIpv4(hostname: string): string {
  if (/^\d+$/u.test(hostname)) {
    const asInteger = Number(hostname);
    if (Number.isSafeInteger(asInteger) && asInteger >= 0 && asInteger <= 0xffffffff) {
      return [24, 16, 8, 0]
        .map((shift) => String((asInteger >>> shift) & 0xff))
        .join('.');
    }
  }

  return hostname
    .split('.')
    .map((octet) => (/^0[0-7]+$/u.test(octet) ? String(Number.parseInt(octet, 8)) : octet))
    .join('.');
}

function canonicalRedisHostname(hostname: string): string {
  // This guard compares URL text, not resolved addresses. Different hostnames
  // that resolve to the same Redis instance remain an operator responsibility.
  const normalized = normalizeNumericIpv4(
    hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.+$/gu, '')
  );
  if (
    normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || /^127(?:\.\d{1,3}){0,3}$/u.test(normalized)
  ) {
    return 'loopback';
  }
  return normalized;
}

function numericRedisOption(value: string, minimum: number, maximum: number): number {
  if (!/^[0-9]+$/u.test(value)) {
    throw new InvalidRedisUrlError();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new InvalidRedisUrlError();
  }
  return parsed;
}

function effectiveRedisTarget(redisUrl: string): { authority: string; database: number } {
  const parsed = parseRedisUrl(redisUrl);
  // A query-supplied socket path changes ioredis transport and cannot be
  // represented by a TCP authority comparison. Reject it, rather than guess.
  if (parsed.searchParams.has('path')) {
    throw new InvalidRedisUrlError();
  }
  // ioredis takes the final query value, but an explicit URL port/path wins.
  const portQuery = parsed.searchParams.getAll('port').at(-1);
  const databaseQuery = parsed.searchParams.getAll('db').at(-1);
  const port = numericRedisOption(parsed.port || (portQuery ?? '6379'), 1, 65535);
  const databasePath = parsed.pathname.replace(/^\//u, '');
  const database = numericRedisOption(databasePath || (databaseQuery ?? '0'), 0, 2147483647);
  return { authority: `${canonicalRedisHostname(parsed.hostname)}:${port}`, database };
}

export function redisInstanceAuthority(redisUrl: string): string {
  return effectiveRedisTarget(redisUrl).authority;
}

export function redisDatabaseIdentity(redisUrl: string): string {
  const target = effectiveRedisTarget(redisUrl);
  return `${target.authority}/${target.database}`;
}
