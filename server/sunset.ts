import type { Request, Response, NextFunction } from 'express'

// When `WANDIHUB_SUNSET_REDIRECT_TO` is set (e.g. on the legacy Railway
// deployment), every browser GET serves a "we've moved" announcement that
// links to the same path on the new host. API and SSE routes are exempt so
// existing data flows keep working for any stale clients still talking to
// Railway.
//
// On the new home (Hatch / designhub), the env var is unset and this
// middleware is a no-op.

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const isHtmlRequest = (req: Request): boolean => {
  const accept = (req.headers['accept'] || '').toString()
  // Browsers send Accept: text/html,...; non-browser clients usually don't.
  // Fall back to the "no Accept header at all" case being treated as HTML so
  // a typed-in URL still works.
  return accept.includes('text/html') || accept === '' || accept === '*/*'
}

const renderAnnouncement = (newUrl: string, host: string): string => {
  const safeNew = escapeHtml(newUrl)
  const safeHost = escapeHtml(host)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>WandiHub has moved — Design Hub</title>
  <link rel="canonical" href="${safeNew}" />
  <style>
    :root {
      --bg: #0b0c10;
      --card: #16181d;
      --text: #f4f5f7;
      --muted: #9aa0aa;
      --accent: #2563eb;
      --border: #2a2d35;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; height: 100%; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      line-height: 1.5;
    }
    .card {
      max-width: 560px;
      width: 100%;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 2.25rem 2rem;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
    }
    .logo { display: flex; justify-content: center; margin-top: 2.5rem; }
    h1 {
      margin: 0 0 0.35rem;
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .subtitle {
      color: var(--muted);
      font-size: 0.95rem;
      margin: 0 0 1.5rem;
    }
    .url-row {
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.85rem 1rem;
      margin-bottom: 1.25rem;
      text-align: left;
    }
    .url-label {
      font-size: 0.65rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin-bottom: 0.25rem;
    }
    .url-value {
      font-size: 0.85rem;
      word-break: break-all;
    }
    .url-value.old { color: var(--muted); text-decoration: line-through; }
    .url-value.new a { color: var(--accent); text-decoration: none; font-weight: 500; }
    .url-value.new a:hover { text-decoration: underline; }
    .go-now {
      display: inline-block;
      margin-top: 0.5rem;
      background: var(--accent);
      color: white;
      text-decoration: none;
      font-weight: 600;
      font-size: 0.875rem;
      padding: 0.6rem 1.1rem;
      border-radius: 8px;
      transition: background 0.15s;
    }
    .go-now:hover { background: #1d4ed8; }
    .footnote {
      margin-top: 1.25rem;
      font-size: 0.78rem;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>WandiHub has moved</h1>
    <p class="subtitle">We're now <strong>Design Hub</strong>, hosted on the Dow Jones internal platform. Sign in with your DJ Okta account.</p>

    <div class="url-row">
      <div class="url-label">Old address</div>
      <div class="url-value old">${safeHost}</div>
    </div>
    <div class="url-row">
      <div class="url-label">New address</div>
      <div class="url-value new"><a href="${safeNew}">${safeNew}</a></div>
    </div>

    <a class="go-now" href="${safeNew}">Go to Design Hub →</a>

    <div class="footnote">Update your bookmarks. The old wandihub.up.railway.app URL will be retired soon.</div>

    <div class="logo">
      <svg width="24" height="24" viewBox="-2 -12 161 160" aria-hidden="true">
        <path d="M89 0C126.555 0 157 30.4446 157 68C157 105.555 126.555 136 89 136H0V128H4C11.1797 128 17 122.18 17 115V21C17 13.8203 11.1797 8 4 8H0V0H89Z" fill="#2563eb"/>
        <path d="M54.5 23.5C63.3366 23.5 70.5 30.6634 70.5 39.5C70.5 46.404 66.1271 52.2864 60 54.5293V63.002C69.5637 63.006 77.1091 63.0294 83.0303 63.1768C90.0446 63.3513 95.1835 63.7011 98.8428 64.5205C102.567 65.3546 105.93 66.9393 107.697 70.501C108.476 72.0694 108.757 73.6776 108.882 75.0469C109.004 76.3914 109 77.8643 109 79.1963V81.7979C115.388 83.8975 120 89.9097 120 97C120 105.837 112.837 113 104 113C95.1634 113 88 105.837 88 97C88 89.9097 92.6123 83.8975 99 81.7979V79.1963C99 77.7294 98.9956 76.7525 98.9229 75.9541C98.889 75.5823 98.8458 75.331 98.8057 75.1621C98.7894 75.0938 98.7741 75.0443 98.7627 75.0098C98.564 74.8702 98.0048 74.5801 96.6572 74.2783C94.0665 73.6983 89.8299 73.3492 82.7822 73.1738C76.9875 73.0297 69.5632 73.0061 60 73.002V82.1641C65.8635 84.5377 70 90.2854 70 97C70 105.837 62.8366 113 54 113C45.1634 113 38 105.837 38 97C38 90.2854 42.1365 84.5377 48 82.1641V54.123C42.4029 51.6314 38.5 46.022 38.5 39.5C38.5 30.6634 45.6634 23.5 54.5 23.5Z" fill="#fff"/>
      </svg>
    </div>
  </div>

  <script>
    // Preserve any URL hash (SPA deep links like #/reviews?review=abc) that
    // never reached the server, by appending it to the destination link.
    (function () {
      var newBase = ${JSON.stringify(newUrl)};
      var hash = window.location.hash || '';
      var target = newBase + hash;
      try {
        var link = document.querySelector('.url-value.new a');
        if (link) { link.setAttribute('href', target); link.textContent = target; }
        var goNow = document.querySelector('.go-now');
        if (goNow) goNow.setAttribute('href', target);
      } catch (e) {}
    })();
  </script>
</body>
</html>`
}

export const sunsetMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const target = process.env.WANDIHUB_SUNSET_REDIRECT_TO
  if (!target) return next()

  // Only intercept browser GETs. APIs, SSE, the announcement page's own
  // assets, and anything non-GET pass through unchanged so legacy clients
  // and health checks still function.
  if (req.method !== 'GET') return next()
  if (req.path.startsWith('/api/')) return next()
  if (!isHtmlRequest(req)) return next()

  // Build the new URL: same path + query on the new host. Preserves deep
  // links into /review/:id, /p/:slug. SPA hash routes are also preserved
  // by inline JS that appends window.location.hash to the visible link.
  const base = target.replace(/\/+$/, '')
  const newUrl = base + req.originalUrl

  const oldHost = (req.headers['x-forwarded-host'] || req.headers['host'] || 'wandihub.up.railway.app').toString()

  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.status(200).send(renderAnnouncement(newUrl, `https://${oldHost}${req.originalUrl}`))
}
