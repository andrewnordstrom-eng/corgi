import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LIVE_FEED_POSTS,
  LIVE_METRICS_SNAPSHOT,
  LIVE_RANK_ONE_COMPONENTS,
  LIVE_RANK_ONE_EXPLANATION,
} from '../web-next/lib/live-metrics-snapshot';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_NEXT_ROOT = path.join(REPO_ROOT, 'web-next');
const DEMO_PAGE_FILE = path.join(WEB_NEXT_ROOT, 'app', 'demo', 'page.tsx');
const RECEIPT_PANEL_FILE = path.join(WEB_NEXT_ROOT, 'components', 'demo', 'receipt-panel.tsx');
const LIVE_METRICS_SNAPSHOT_FILE = path.join(WEB_NEXT_ROOT, 'lib', 'live-metrics-snapshot.ts');
const README_FILE = path.join(REPO_ROOT, 'README.md');
const DEV_JOURNAL_FILE = path.join(REPO_ROOT, 'docs', 'dev-journal.md');
const LAB_METRICS_PACKET_FILE = path.join(
  REPO_ROOT,
  'docs',
  'lab',
  '2026-07-07-recsys-live-metrics-packet.md',
);

const UI_FIXTURE_FILES = [
  path.join(REPO_ROOT, 'web-next', 'components', 'changelog-section.tsx'),
  path.join(REPO_ROOT, 'web-next', 'components', 'dashboard-preview.tsx'),
  path.join(REPO_ROOT, 'web-next', 'components', 'modality-preview.tsx'),
  LIVE_METRICS_SNAPSHOT_FILE,
];

const PUBLIC_RECEIPT_DOC_FILES = [
  README_FILE,
  DEV_JOURNAL_FILE,
  LAB_METRICS_PACKET_FILE,
];

const PUBLIC_RECEIPT_EXAMPLE_SECTION_FILES = [
  LAB_METRICS_PACKET_FILE,
];

const DOMAIN_HANDLE_PATTERN =
  /\b(?![a-z0-9.-]+\.(?:cjs|css|gif|ico|jpe?g|json|jsx|mjs|md|png|svg|tsx?|webp)\b)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z][a-z0-9-]{1,62})+\b/i;
const CODE_FILE_EXTENSIONS = new Set(['.ts', '.tsx']);
const IGNORED_DIRECTORY_NAMES = new Set(['.next', 'dist', 'node_modules', 'out']);

const FORBIDDEN_LIVE_RECEIPT_PATTERNS = [
  { name: 'AT Protocol post URI', pattern: /at:\/\/did:/i },
  { name: 'PLC DID', pattern: /did:plc:/i },
  { name: 'Bluesky handle', pattern: /[a-z0-9._-]+\.bsky\.social/i },
  { name: 'domain-style handle', pattern: DOMAIN_HANDLE_PATTERN },
];
const FULL_CONTENT_LIVE_RECEIPT_PATTERNS = FORBIDDEN_LIVE_RECEIPT_PATTERNS.filter(
  (forbiddenPattern) => forbiddenPattern.name !== 'domain-style handle',
);

const FORBIDDEN_PUBLIC_DOC_RECEIPT_PATTERNS = [
  { name: 'raw PLC DID', pattern: /did:plc:[a-z0-9]{20,}/i },
  { name: 'encoded PLC DID', pattern: /did%3Aplc%3A[a-z0-9]{20,}/i },
  { name: 'raw AT Protocol URI', pattern: /at:\/\/did:plc:[a-z0-9]+\/[a-z0-9.]+\/[a-z0-9._-]+/i },
  {
    name: 'encoded AT Protocol URI',
    pattern: /at%3A%2F%2Fdid%3Aplc%3A[a-z0-9]+%2F[a-z0-9.]+%2F[a-z0-9._-]+/i,
  },
  { name: 'Bluesky handle', pattern: /[a-z0-9._-]+\.bsky\.social/i },
];

const README_ALLOWED_HANDLES = new Set(['corgi-network.bsky.social']);

const FORBIDDEN_PUBLIC_DOC_EXAMPLE_SECTION_PATTERNS = [
  { name: 'raw PLC DID', pattern: /did:plc:[a-z0-9]{20,}/i },
  { name: 'raw AT Protocol post URI', pattern: /at:\/\/did:plc:[a-z0-9]+\/app\.bsky\.feed\.post\/[a-z0-9]+/i },
  {
    name: 'encoded AT Protocol post URI',
    pattern: /at%3A%2F%2Fdid%3Aplc%3A[a-z0-9]+%2Fapp\.bsky\.feed\.post%2F[a-z0-9]+/i,
  },
  { name: 'Bluesky handle', pattern: /[a-z0-9._-]+\.bsky\.social/i },
];

interface PublicReceiptDocSection {
  readonly label: string;
  readonly content: string;
}

function readFixtureFile(fixtureFile: string): string {
  try {
    return readFileSync(fixtureFile, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read fixture ${path.relative(REPO_ROOT, fixtureFile)}: ${message}`);
  }
}

function extractStringLiterals(content: string): string[] {
  const literals: string[] = [];
  const literalPattern = /(["'`])((?:\\[\s\S]|(?!\1)[\s\S])*)\1/g;
  let match = literalPattern.exec(content);

  while (match !== null) {
    literals.push((match[2] ?? '').replace(/\$\{[^}]*\}/g, ''));
    match = literalPattern.exec(content);
  }

  return literals;
}

function sanitizeStringLiterals(literals: string[]): string[] {
  return literals
    .map((literal) => literal.replace(/https?:\/\/\S+/gi, ''))
    .filter((literal) => literal.length > 0);
}

function sanitizedReceiptScanContent(content: string): string {
  return sanitizeStringLiterals([content]).join('\n');
}

function extractBareJsxText(content: string): string[] {
  const textNodes: string[] = [];
  const textNodePattern = /<([A-Za-z][A-Za-z0-9.:_-]*)(?:\s[^<>]*)?>([^<>{}]*)<\/\1>/g;
  let match = textNodePattern.exec(content);

  while (match !== null) {
    const textNode = (match[2] ?? '').replace(/\s+/g, ' ').trim();
    if (textNode.length > 0) {
      textNodes.push(textNode);
    }
    match = textNodePattern.exec(content);
  }

  return textNodes;
}

function expectAnonymizedLiveReceiptContent(content: string, label: string): void {
  const sanitizedContent = sanitizedReceiptScanContent(content);
  const domainHandleScanContent = sanitizeStringLiterals([
    ...extractStringLiterals(content),
    ...extractBareJsxText(content),
  ]).join('\n');

  for (const forbiddenPattern of FULL_CONTENT_LIVE_RECEIPT_PATTERNS) {
    expect(
      sanitizedContent,
      `${label} contains ${forbiddenPattern.name}`,
    ).not.toMatch(forbiddenPattern.pattern);
  }

  expect(
    domainHandleScanContent,
    `${label} contains domain-style handle`,
  ).not.toMatch(DOMAIN_HANDLE_PATTERN);
}

function listCodeFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORY_NAMES.has(entry.name)) {
        files.push(...listCodeFiles(entryPath));
      }
      continue;
    }

    if (entry.isFile() && CODE_FILE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
}

function findLiveMetricsSnapshotFixtureFiles(): string[] {
  const importers = listCodeFiles(WEB_NEXT_ROOT).filter((codeFile) => {
    if (codeFile === LIVE_METRICS_SNAPSHOT_FILE) {
      return false;
    }

    return readFixtureFile(codeFile).includes('live-metrics-snapshot');
  });

  return [...importers, LIVE_METRICS_SNAPSHOT_FILE].sort();
}

function relativeFixturePaths(fixtureFiles: string[]): string[] {
  return fixtureFiles.map((fixtureFile) => path.relative(REPO_ROOT, fixtureFile)).sort();
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMarkdownSection(content: string, heading: string): string {
  const headingPattern = new RegExp(`^## ${escapeRegExp(heading)}\\s*\\r?$`, 'm');
  const headingMatch = headingPattern.exec(content);

  if (headingMatch === null) {
    throw new Error(`Unable to find markdown section: ${heading}`);
  }

  const sectionStartIndex = headingMatch.index + headingMatch[0].length;
  const afterHeading = content.slice(sectionStartIndex);
  const remainingContent = afterHeading.startsWith('\r\n')
    ? afterHeading.slice(2)
    : afterHeading.startsWith('\n')
      ? afterHeading.slice(1)
      : afterHeading;
  const nextSectionMatch = /^## /m.exec(remainingContent);

  if (nextSectionMatch === null) {
    return remainingContent;
  }

  return remainingContent.slice(0, nextSectionMatch.index);
}

function extractMarkdownSectionByHeadingFragment(content: string, headingFragment: string): string {
  const headingPattern = new RegExp(`^## .*${escapeRegExp(headingFragment)}.*\\r?$`, 'm');
  const headingMatch = headingPattern.exec(content);

  if (headingMatch === null) {
    throw new Error(`Unable to find markdown section containing: ${headingFragment}`);
  }

  const heading = headingMatch[0].replace(/^##\s+/, '').trim();
  return extractMarkdownSection(content, heading);
}

function publicReceiptDocSections(): PublicReceiptDocSection[] {
  const readme = readFixtureFile(README_FILE);
  const devJournal = readFixtureFile(DEV_JOURNAL_FILE);
  const labMetricsPacket = readFixtureFile(LAB_METRICS_PACKET_FILE);

  return [
    {
      label: 'README.md live receipt example',
      content: extractMarkdownSection(readme, 'How it works'),
    },
    {
      label: 'docs/dev-journal.md PROJ-1433 entry',
      content: extractMarkdownSectionByHeadingFragment(devJournal, 'PROJ-1433 live metrics packet'),
    },
    {
      label: 'metrics packet receipt commands',
      content: extractMarkdownSection(labMetricsPacket, 'Receipt Commands'),
    },
    {
      label: 'metrics packet live production claims',
      content: extractMarkdownSection(labMetricsPacket, 'Live Production Claims'),
    },
    {
      label: 'metrics packet post explanation',
      content: extractMarkdownSection(labMetricsPacket, 'Post Explanation Example'),
    },
    {
      label: 'metrics packet copy guidance',
      content: extractMarkdownSection(labMetricsPacket, 'Copy Guidance'),
    },
  ];
}

describe('web-next demo receipt fixtures', () => {
  it('keeps the scanned fixture set exhaustive for live snapshot importers', () => {
    expect(relativeFixturePaths(UI_FIXTURE_FILES)).toEqual(
      relativeFixturePaths(findLiveMetricsSnapshotFixtureFiles()),
    );
  });

  it('keeps public UI fixtures anonymized while preserving numeric receipts', () => {
    for (const fixtureFile of UI_FIXTURE_FILES) {
      const content = readFixtureFile(fixtureFile);
      expectAnonymizedLiveReceiptContent(content, path.relative(REPO_ROOT, fixtureFile));
    }
  });

  it('keeps the primary public demo out of the redacted snapshot happy path', () => {
    const content = readFixtureFile(DEMO_PAGE_FILE);

    // The redacted-snapshot happy path must not return: no live snapshot import,
    // no anonymized-receipt placeholders, no redacted post text.
    expect(content).not.toContain('live-metrics-snapshot');
    expect(content).not.toMatch(/Anonymized receipt \d{3}/);
    expect(content).not.toMatch(/Post text redacted/i);

    // The guided shadow demo renders the honest disclosure, whose copy lives in
    // shadow-demo-copy.ts (single source, asserted below).
    expect(content).toContain('<DemoDisclosure');
    const copy = readFixtureFile(path.join(WEB_NEXT_ROOT, 'app', 'demo', 'shadow-demo-copy.ts'));
    expect(copy).toMatch(/isolated shadow governance namespace/i);
    expect(copy).toMatch(/not native bluesky/i);
    expect(copy).toMatch(/public Corgi feed/i);
  });

  it('renders every topic term included in the receipt formula', () => {
    const content = readFixtureFile(RECEIPT_PANEL_FILE);

    expect(content).toContain('const topicInputs = receipt.topicBreakdown');
    expect(content).not.toMatch(/topicBreakdown\.slice\(/);
  });

  it('keeps public PROJ-1433 receipt docs anonymized for the rank-one example', () => {
    expect(relativeFixturePaths(PUBLIC_RECEIPT_DOC_FILES)).toEqual([
      'README.md',
      'docs/dev-journal.md',
      'docs/lab/2026-07-07-recsys-live-metrics-packet.md',
    ]);

    for (const section of publicReceiptDocSections()) {
      for (const forbiddenPattern of FORBIDDEN_PUBLIC_DOC_RECEIPT_PATTERNS) {
        expect(
          section.content,
          `${section.label} contains ${forbiddenPattern.name}`,
        ).not.toMatch(forbiddenPattern.pattern);
      }
    }
  });

  it('keeps the whole README free of post identifiers outside the official account link', () => {
    const readme = readFixtureFile(README_FILE);

    // Fail loudly if the receipt moves, instead of scanning the wrong section.
    expect(extractMarkdownSection(readme, 'How it works')).toContain('### A real receipt');

    for (const forbiddenPattern of FORBIDDEN_PUBLIC_DOC_RECEIPT_PATTERNS) {
      if (forbiddenPattern.name === 'Bluesky handle') {
        continue;
      }
      expect(readme, `README.md contains ${forbiddenPattern.name}`).not.toMatch(forbiddenPattern.pattern);
    }

    // The README links Corgi's own account; any other handle is a leak.
    const handles = readme.match(/[a-z0-9._-]+\.bsky\.social/gi) ?? [];
    expect(
      handles.filter((handle) => !README_ALLOWED_HANDLES.has(handle.toLowerCase())),
    ).toEqual([]);
  });

  it('keeps the public post explanation section free of structural raw identifiers', () => {
    for (const fixtureFile of PUBLIC_RECEIPT_EXAMPLE_SECTION_FILES) {
      const content = readFixtureFile(fixtureFile);
      const section = extractMarkdownSection(content, 'Post Explanation Example');

      for (const forbiddenPattern of FORBIDDEN_PUBLIC_DOC_EXAMPLE_SECTION_PATTERNS) {
        expect(
          section,
          `${path.relative(REPO_ROOT, fixtureFile)} Post Explanation Example contains ${forbiddenPattern.name}`,
        ).not.toMatch(forbiddenPattern.pattern);
      }
    }
  });

  it('keeps the public post explanation sensitive fields explicitly redacted', () => {
    for (const fixtureFile of PUBLIC_RECEIPT_EXAMPLE_SECTION_FILES) {
      const content = readFixtureFile(fixtureFile);
      const section = extractMarkdownSection(content, 'Post Explanation Example');

      expect(section).toMatch(/- Post text: redacted from the public tracked packet/);
      expect(section).toMatch(/- Raw production URI: redacted from the public tracked packet/);
      expect(section).toMatch(/- Raw author DID and handle: redacted from the public tracked packet/);
    }
  });

  it('extracts multiline template literals for live identifier checks', () => {
    const content = [
      'const fixture = `',
      'Public copy line',
      'did:plc:multilineexample123',
      'author.bsky.social',
      '`;',
    ].join('\n');
    const stringLiterals = sanitizeStringLiterals(extractStringLiterals(content)).join('\n');

    expect(stringLiterals).toMatch(/did:plc:/i);
    expect(stringLiterals).toMatch(/[a-z0-9._-]+\.bsky\.social/i);
  });

  it('catches live identifiers outside string literals in fixture content', () => {
    const commentOnlyLeak = [
      '// did:plc:commentonlyleak1234567890',
      '/* author.bsky.social */',
    ].join('\n');

    expect(() => expectAnonymizedLiveReceiptContent(commentOnlyLeak, 'synthetic comment leak')).toThrow(
      /synthetic comment leak contains PLC DID/,
    );
  });

  it('catches domain-style handles in bare JSX text nodes', () => {
    expect(() =>
      expectAnonymizedLiveReceiptContent(
        '<div className="receipt-row">leaked-author.example.social</div>',
        'synthetic JSX text leak',
      )
    ).toThrow(/synthetic JSX text leak contains domain-style handle/);
  });

  it('extracts markdown sections with explicit edge behavior', () => {
    expect(() => extractMarkdownSection('## Other\nbody', 'Missing')).toThrow(
      'Unable to find markdown section: Missing',
    );
    expect(extractMarkdownSection('## First\nbody\n## Target\nfinal body', 'Target')).toBe('final body');
    expect(extractMarkdownSection('## Target\nlast section line 1\nlast section line 2\n', 'Target')).toBe(
      'last section line 1\nlast section line 2\n',
    );
    expect(extractMarkdownSection('## Empty\n## Next\nnext body', 'Empty')).toBe('');
    expect(extractMarkdownSection('## Target  \r\nbody\r\n## Next\r\nnext body', 'Target')).toBe('body\r\n');
  });

  it('proves forbidden receipt patterns catch synthetic live identifiers', () => {
    const samples = [
      { name: 'AT Protocol post URI', value: 'at://did:plc:example/app.bsky.feed.post/abc' },
      { name: 'PLC DID', value: 'did:plc:example1234567890' },
      { name: 'Bluesky handle', value: 'author.bsky.social' },
      { name: 'domain-style handle', value: 'author.example.social' },
    ];

    for (const sample of samples) {
      const forbiddenPattern = FORBIDDEN_LIVE_RECEIPT_PATTERNS.find(
        (pattern) => pattern.name === sample.name,
      );

      expect(forbiddenPattern, `Missing forbidden pattern fixture for ${sample.name}`).toBeDefined();
      expect(sample.value).toMatch(forbiddenPattern?.pattern ?? /$^/);
    }
  });

  it('distinguishes domain-style handles from benign dotted file literals', () => {
    expect('author.example.social').toMatch(DOMAIN_HANDLE_PATTERN);
    expect('styles.css').not.toMatch(DOMAIN_HANDLE_PATTERN);
    expect('page.tsx').not.toMatch(DOMAIN_HANDLE_PATTERN);
  });

  it('keeps rank-one score receipts internally consistent', () => {
    const componentTotal = LIVE_RANK_ONE_COMPONENTS.reduce(
      (total, component) => total + component.weighted,
      0,
    );

    expect(componentTotal).toBeCloseTo(LIVE_RANK_ONE_EXPLANATION.totalScore, 12);
    expect(LIVE_FEED_POSTS[0]?.score).toBe(LIVE_RANK_ONE_EXPLANATION.totalScore);
    expect(LIVE_METRICS_SNAPSHOT.scoredPosts).toBe(3348);
    expect(LIVE_METRICS_SNAPSHOT.uniqueAuthors).toBe(3007);
  });

  it('keeps snapshot authors as anonymized receipt labels', () => {
    const authorLabels = [
      LIVE_RANK_ONE_EXPLANATION.authorLabel,
      ...LIVE_FEED_POSTS.map((post) => post.author),
    ];

    for (const authorLabel of authorLabels) {
      expect(authorLabel).toMatch(/^Anonymized receipt \d{3}$/);
      expect(authorLabel).not.toMatch(DOMAIN_HANDLE_PATTERN);
    }
  });
});
