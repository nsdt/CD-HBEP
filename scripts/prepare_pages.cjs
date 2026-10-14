'use strict';

// Add hosted-only analytics without editing the reproducible app source.
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const appDir = path.join(repoRoot, 'app');

function analyticsMarkup(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{32}$/i.test(token)) {
    throw new Error('CLOUDFLARE_WEB_ANALYTICS_TOKEN must be the 32-character Web Analytics site token.');
  }
  return `
<!-- Hosted-only Cloudflare Web Analytics; app/index.html is unchanged. -->
<footer id="web-analytics-notice" style="padding:12px 22px;border-top:1px solid var(--line);color:var(--muted);font-size:13px">
  <details>
    <summary>Privacy and usage analytics</summary>
    <div class="details-body">
      <p>This hosted version uses Cloudflare Web Analytics to measure page visits and loading performance without analytics cookies. Cloudflare receives page and referral information, browser and device information, and performance metrics.</p>
      <p>Entered data and interpolation results stay in your browser and are not sent to the analytics service. The downloadable app contains no analytics code.</p>
      <p><a href="https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/" target="_blank" rel="noopener noreferrer">About Cloudflare Web Analytics</a></p>
    </div>
  </details>
</footer>
<script id="cloudflare-web-analytics-loader">
(() => {
  // Also disable analytics if someone saves this hosted HTML and opens it locally.
  if (location.origin !== 'https://nsdt.github.io' ||
      !(location.pathname === '/CD-HBEP' || location.pathname.startsWith('/CD-HBEP/')) ||
      document.getElementById('cloudflare-web-analytics-beacon')) return;
  const beacon = document.createElement('script');
  beacon.id = 'cloudflare-web-analytics-beacon';
  beacon.async = true;
  beacon.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  // Controls and recalculations on this one-page app are not additional page views.
  beacon.setAttribute('data-cf-beacon', JSON.stringify({ token: '${token}', spa: false }));
  document.body.appendChild(beacon);
})();
</script>
`;
}

function preparePages({ token, outputDir = path.join(repoRoot, 'build', 'pages') }) {
  const markup = analyticsMarkup(token);
  const source = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');
  if ((source.match(/<\/body\s*>/gi) || []).length !== 1) {
    throw new Error('Expected exactly one closing body tag in app/index.html.');
  }
  if (fs.existsSync(outputDir)) {
    throw new Error('The Pages output directory already exists; use a fresh build directory.');
  }
  fs.mkdirSync(outputDir, { recursive: true });
  fs.cpSync(appDir, outputDir, { recursive: true });
  const hosted = source.replace(/<\/body\s*>/i, closingTag => markup + closingTag);
  fs.writeFileSync(path.join(outputDir, 'index.html'), hosted, 'utf8');
  return outputDir;
}

if (require.main === module) {
  try {
    const outputDir = preparePages({ token: process.env.CLOUDFLARE_WEB_ANALYTICS_TOKEN });
    console.log(`Prepared GitHub Pages app in ${outputDir}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { analyticsMarkup, preparePages };
