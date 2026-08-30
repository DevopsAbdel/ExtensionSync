/**
 * ExtensionSync — CORS proxy (dependency-free Node server)
 * =========================================================
 *
 * Implements the same proxy contract as tools/cors-proxy-worker.js for users
 * who prefer to run the relay locally instead of on Cloudflare:
 *
 *     node cors-proxy-node.js [port]
 *
 * Then point ExtensionSync → Settings → "Web Store Proxy" at:
 *     http://localhost:8123/cors?url=
 * (or the corresponding public URL if you expose it). Chrome's Web Store is
 * HTTPS, so an HTTP localhost proxy is fine for local use.
 *
 * Accepted targets are Chrome Web Store detail pages (/detail/<id>) and
 * search pages (/search/<query>) — the two page types ExtensionSync reads.
 */

const http = require('http');
const https = require('https');

const TARGET_ORIGIN = 'https://chromewebstore.google.com';
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB cap
const PORT = Number(process.argv[2]) || 8123;

// Only proxy the Chrome Web Store's detail *and* search pages, so this relay
// cannot be abused as a generic scraping endpoint.
function isAllowedTarget(target) {
  return (
    target.startsWith(TARGET_ORIGIN + '/detail/') ||
    target.startsWith(TARGET_ORIGIN + '/search/')
  );
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function fetchWithRedirect(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'ExtensionSync' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(fetchWithRedirect(next, redirects + 1));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(); reject(new Error('too large')); } else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), type: res.headers['content-type'] }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.end();

  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end('Method not allowed');
  }

  const target = u.searchParams.get('url');
  if (!target || !isAllowedTarget(target)) {
    res.statusCode = 400;
    return res.end('Missing or disallowed url');
  }

  try {
    const data = await fetchWithRedirect(target);
    res.statusCode = data.status;
    if (data.type) res.setHeader('Content-Type', data.type);
    res.end(data.body);
  } catch {
    res.statusCode = 502;
    res.end('Proxy fetch failed');
  }
});

server.listen(PORT, () => console.log(`ExtensionSync CORS proxy on http://localhost:${PORT}/cors?url=`));
