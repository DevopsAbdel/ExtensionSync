/**
 * ExtensionSync — CORS proxy (Cloudflare Worker)
 * ================================================
 *
 * The Chrome Web Store sends `Cross-Origin-Resource-Policy: same-site` on its
 * detail pages, which Chrome enforces even for extension fetches with host
 * permissions. The ExtensionSync extension therefore cannot read the CWS page
 * directly and must route the request through a proxy that fetches it
 * server-side and returns the HTML with permissive CORS headers.
 *
 * This is a minimal, dependency-free Cloudflare Worker that implements the
 * proxy contract ExtensionSync expects:
 *
 *     GET /cors?url=<encoded Chrome Web Store detail page>
 *
 * It fetches the target page and responds with its HTML plus
 * `Access-Control-Allow-Origin: *` so the extension can read the response.
 *
 * --- Deployment (free) ---
 *   1. wrangler deploy  (or paste this file into a new Cloudflare Worker)
 *   2. The resulting URL looks like:  https://<name>.<account>.workers.dev
 *   3. In ExtensionSync → Settings → "Web Store Proxy", enter:
 *        https://<name>.<account>.workers.dev/cors?url=
 *
 * Security: only allow the Chromium Web Store origin and limit requested size
 * so this proxy cannot be abused as a generic scraping relay.
 */

const TARGET_ORIGIN = 'https://chromewebstore.google.com';
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB cap on fetched pages

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

export default {
  async fetch(request) {
    // Preflight for CORS-simple GET is trivial; still handle it.
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const { searchParams } = new URL(request.url);
    const target = searchParams.get('url');

    if (!target || !isAllowedTarget(target)) {
      return new Response('Missing or disallowed url', {
        status: 400,
        headers: CORS_HEADERS
      });
    }

    try {
      const res = await fetch(target, {
        headers: { 'User-Agent': request.headers.get('User-Agent') || '' }
      });
      const body = await res.arrayBuffer();
      if (body.byteLength > MAX_BYTES) {
        return new Response('Response too large', { status: 413, headers: CORS_HEADERS });
      }
      return new Response(body, {
        status: res.status,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': res.headers.get('Content-Type') || 'text/plain;charset=utf-8'
        }
      });
    } catch {
      return new Response('Proxy fetch failed', { status: 502, headers: CORS_HEADERS });
    }
  }
};
