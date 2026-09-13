'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * The dependency rule, as a test rather than as a convention nobody remembers.
 *
 *     handlers ──▶ use_cases ──▶ domain
 *         │            │
 *         │            └──▶ (ports: repositories, messenger, messages, clock)
 *         └──▶ adapters ──▶ platform
 *
 * It is the same rule the Fog gateway follows and that the thesis already
 * defends as a strength of that layer ("no file in core/ imports
 * infrastructure/"). Having the Cloud layer satisfy it too is what turns that
 * argument from a claim about one repository into a claim about the
 * architecture — so it is worth a few lines of test to keep true.
 */

const SRC = __dirname;

function sourceFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      // Production files only. A test is allowed to reach for a real adapter as
      // a stand-in for a port — that is not a production dependency.
      if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) return [];
      return [full];
    });
}

/**
 * The file with its comments removed.
 *
 * The textual checks below ask questions about code ("is a client constructed
 * here?"), and several files legitimately *discuss* the rule in a comment. Only
 * line comments that begin a line are stripped, so a `//` inside a URL literal
 * survives.
 */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function requiresOf(code) {
  return [...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]);
}

/** Where a relative require lands, as a path under src/. */
function resolved(file, request) {
  if (!request.startsWith('.')) return request;
  return path.relative(SRC, path.resolve(path.dirname(file), request));
}

const FILES = sourceFiles(SRC).map((file) => {
  const code = codeOf(fs.readFileSync(file, 'utf8'));
  return {
    relative: path.relative(SRC, file),
    layer: path.relative(SRC, file).split(path.sep)[0],
    requires: requiresOf(code).map((request) => ({ request, target: resolved(file, request) })),
    code,
  };
});

const inLayer = (layer) => FILES.filter((file) => file.layer === layer);

describe('the source tree is the one the design describes', () => {
  test('every production file lives in one of the five layers', () => {
    const layers = new Set(FILES.map((file) => file.layer));
    expect([...layers].sort()).toEqual(['adapters', 'domain', 'handlers', 'platform', 'use_cases']);
  });

  test('there are exactly three entry points, the ones Terraform names', () => {
    expect(inLayer('handlers').map((file) => file.relative).sort()).toEqual([
      path.join('handlers', 'associate-tag.js'),
      path.join('handlers', 'tag-scan.js'),
      path.join('handlers', 'webhook.js'),
    ]);
  });
});

describe('domain and use_cases know nothing about infrastructure', () => {
  for (const layer of ['domain', 'use_cases']) {
    test(`${layer}/ imports no adapter, no platform module and no AWS SDK`, () => {
      const offenders = [];
      for (const file of inLayer(layer)) {
        for (const { request, target } of file.requires) {
          const forbidden =
            request.startsWith('@aws-sdk/') ||
            target.startsWith('adapters') ||
            target.startsWith('platform');
          if (forbidden) offenders.push(`${file.relative} → ${request}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    test(`${layer}/ never reads the environment`, () => {
      const offenders = inLayer(layer)
        .filter((file) => file.code.includes('process.env'))
        .map((file) => file.relative);
      expect(offenders).toEqual([]);
    });
  }

  test('domain/ does not depend on use_cases either — it is the innermost layer', () => {
    const offenders = inLayer('domain')
      .flatMap((file) => file.requires.map(({ target }) => ({ file: file.relative, target })))
      .filter(({ target }) => target.startsWith('use_cases'));
    expect(offenders).toEqual([]);
  });
});

describe('adapters serve the use cases, not the other way round', () => {
  test('no adapter imports a use case', () => {
    const offenders = inLayer('adapters')
      .flatMap((file) => file.requires.map(({ target }) => ({ file: file.relative, target })))
      .filter(({ target }) => target.startsWith('use_cases'));
    expect(offenders).toEqual([]);
  });

  test('no platform module imports anything above it', () => {
    const offenders = inLayer('platform')
      .flatMap((file) => file.requires.map(({ target }) => ({ file: file.relative, target })))
      .filter(({ target }) => /^(domain|use_cases|adapters|handlers)/.test(target));
    expect(offenders).toEqual([]);
  });
});

describe('only the handlers compose', () => {
  test('AWS clients are constructed in handlers and nowhere else', () => {
    // This is what makes each handler a composition root in fact and not just
    // in the comment at the top of it.
    const offenders = FILES.filter(
      (file) => file.layer !== 'handlers' && /new\s+(DynamoDBClient|SSMClient)\s*\(/.test(file.code),
    ).map((file) => file.relative);
    expect(offenders).toEqual([]);
  });

  test('process.env is read in the handlers and in platform/config.js, nowhere else', () => {
    const allowed = new Set([path.join('platform', 'config.js')]);
    const offenders = FILES.filter(
      (file) =>
        file.layer !== 'handlers' &&
        !allowed.has(file.relative) &&
        file.code.includes('process.env'),
    ).map((file) => file.relative);
    expect(offenders).toEqual([]);
  });

  test('no handler imports another handler', () => {
    const offenders = inLayer('handlers')
      .flatMap((file) => file.requires.map(({ target }) => ({ file: file.relative, target })))
      .filter(({ target }) => target.startsWith('handlers'));
    expect(offenders).toEqual([]);
  });
});

describe('the deployment package carries no dependencies', () => {
  test('nothing requires a package that is not the runtime or the AWS SDK', () => {
    // CONTRACT.md §1: the zip is a file list with no node_modules, and the
    // nodejs20.x runtime provides AWS SDK v3. Any other runtime dependency
    // breaks the deployment at the first invoke, not at apply time.
    const offenders = [];
    for (const file of FILES) {
      for (const { request } of file.requires) {
        const ok =
          request.startsWith('.') ||
          request.startsWith('node:') ||
          request.startsWith('@aws-sdk/');
        if (!ok) offenders.push(`${file.relative} → ${request}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
