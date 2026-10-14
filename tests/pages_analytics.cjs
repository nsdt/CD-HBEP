'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { analyticsMarkup, preparePages } = require('../scripts/prepare_pages.cjs');

const token = '0123456789abcdef0123456789abcdef'; // Test-only token; never deployed.
const markup = analyticsMarkup(token);
const loader = markup.match(/<script id="cloudflare-web-analytics-loader">([\s\S]*?)<\/script>/)[1];

function browserAt(url, alreadyLoaded = false) {
  const added = [];
  const context = vm.createContext({
    location: new URL(url),
    document: {
      getElementById: () => alreadyLoaded || added.length > 0 ? {} : null,
      createElement: tag => {
        assert.equal(tag, 'script');
        return { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
      },
      body: { appendChild: element => added.push(element) }
    }
  });
  vm.runInContext(loader, context);
  return { added, context };
}

for (const url of [
  'https://nsdt.github.io/CD-HBEP/',
  'https://nsdt.github.io/CD-HBEP/index.html',
  'https://nsdt.github.io/CD-HBEP'
]) {
  const { added, context } = browserAt(url);
  assert.equal(added.length, 1);
  assert.equal(added[0].src, 'https://static.cloudflareinsights.com/beacon.min.js');
  assert.equal(added[0].async, true);
  assert.deepEqual(JSON.parse(added[0].attributes['data-cf-beacon']), { token, spa: false });
  vm.runInContext(loader, context);
  assert.equal(added.length, 1, 'Do not inject the beacon twice.');
}

for (const url of [
  'file:///tmp/CD-HBEP/index.html',
  'http://localhost:8000/CD-HBEP/',
  'http://nsdt.github.io/CD-HBEP/',
  'https://example.org/CD-HBEP/',
  'https://nsdt.github.io/another-project/',
  'https://nsdt.github.io/CD-HBEP-copy/'
]) {
  assert.equal(browserAt(url).added.length, 0, `Analytics must remain disabled at ${url}`);
}
assert.equal(browserAt('https://nsdt.github.io/CD-HBEP/', true).added.length, 0);

const appPath = path.resolve(__dirname, '../app/index.html');
const source = fs.readFileSync(appPath);
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-hbep-pages-'));
try {
  const outputDir = path.join(temporaryDir, 'pages');
  for (const invalid of [undefined, '', 'not-a-token', token + "'></script>"]) {
    assert.throws(() => preparePages({ token: invalid, outputDir }), /Web Analytics site token/);
    assert.equal(fs.existsSync(outputDir), false);
  }
  preparePages({ token, outputDir });
  const hosted = fs.readFileSync(path.join(outputDir, 'index.html'), 'utf8');
  assert.ok(hosted.includes(markup));
  assert.equal(hosted.replace(markup, ''), source.toString('utf8'));
  assert.deepEqual(fs.readFileSync(appPath), source, 'The canonical source must remain byte-identical.');
  assert.deepEqual(fs.readFileSync(path.join(outputDir, 'README.md')),
    fs.readFileSync(path.resolve(__dirname, '../app/README.md')));
  assert.throws(() => preparePages({ token, outputDir }), /already exists/);
} finally {
  fs.rmSync(temporaryDir, { recursive: true, force: true });
}

console.log('Pages analytics checks passed: token validation, hosted-only loading, no duplicate beacon, unchanged source.');
