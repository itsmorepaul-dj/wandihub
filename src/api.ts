import initialData from './data.json'

// Track client version for stale-write protection
let _clientVersion = ''

export const setClientVersion = (v: string) => { _clientVersion = v }
export const getClientVersion = () => _clientVersion

// Raised when the Hatch oauth2-proxy gateway has bounced an API call to the
// Okta login page (off-VPN, expired SSO). Callers that hold unsaved user input
// (e.g. the weekly update form) can catch this specifically to PRESERVE the
// draft and prompt for re-auth, instead of losing the text to a silent reload.
export class AuthExpiredError extends Error {
  constructor(message = 'Session expired') {
    super(message)
    this.name = 'AuthExpiredError'
  }
}

// Fire-and-forget so the whole app can react to an auth bounce in one place
// (App.tsx listens and shows a single "re-authenticate" prompt). We dispatch
// rather than reload directly so in-progress edits aren't blown away.
const signalAuthExpired = () => {
  window.dispatchEvent(new CustomEvent('dcc-auth-expired'))
}

export const authFetch = async (url: string, options: RequestInit = {}) => {
  const sessionId = localStorage.getItem('dcc-session-id')
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
    ...(sessionId ? { 'x-session-id': sessionId } : {}),
    ...(_clientVersion ? { 'x-client-version': _clientVersion } : {}),
    // Tell oauth2-proxy this is an AJAX/API call. The gateway returns a clean
    // 401 to these instead of a 302 → Okta HTML login page, so an expired SSO
    // session surfaces as a handleable status here rather than as a followed
    // redirect (200 HTML → JSON.parse throws) or a cross-origin "Failed to
    // fetch" TypeError. Both of those previously made saves/report-opens fail
    // silently off-VPN.
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  }
  // Auto-add Content-Type for JSON bodies when not explicitly set
  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }
  // credentials: 'same-origin' is the default for same-origin fetches, but be explicit
  // so the HttpOnly session cookie set by /api/auth/login is always sent alongside the header.
  let res: Response
  try {
    res = await fetch(url, { credentials: 'same-origin', ...options, headers })
  } catch (err) {
    // A network-level TypeError on an /api/ call is almost always the gateway
    // redirecting cross-origin to Okta (CORS-blocked) — i.e. the SSO session
    // died. Surface it as an auth bounce so callers preserve user input.
    if (url.includes('/api/') && !url.includes('/api/auth/')) {
      signalAuthExpired()
      throw new AuthExpiredError('Session expired — please re-authenticate')
    }
    throw err
  }
  // Defense-in-depth: even with the Accept header, if the gateway still managed
  // to send us through a redirect to an HTML login page, detect it. A followed
  // redirect, an opaque redirect, or an HTML content-type on an /api/ call all
  // mean we're looking at the login page, not our API.
  const isApi = url.includes('/api/') && !url.includes('/api/auth/')
  if (isApi) {
    const ct = res.headers.get('content-type') || ''
    const bouncedToLogin = res.type === 'opaqueredirect' || (res.redirected && ct.includes('text/html')) || (res.ok && ct.includes('text/html'))
    if (bouncedToLogin) {
      signalAuthExpired()
      throw new AuthExpiredError('Session expired — please re-authenticate')
    }
  }
  if (res.status === 401 && !url.includes('/api/auth/')) {
    // On Hatch (Okta gateway) a 401 means the gateway-level session expired —
    // preserve the user's work and let App.tsx prompt for re-auth. On the
    // legacy bcrypt host, the old reload-to-login behaviour still applies.
    signalAuthExpired()
    localStorage.removeItem('dcc-session-id')
    throw new AuthExpiredError('Session expired — please re-authenticate')
  }
  if (res.status === 409) {
    const data = await res.json().catch(() => ({}))
    if (data.error === 'Version mismatch') {
      window.location.reload()
      throw new Error('Version mismatch — reloading')
    }
    throw Object.assign(new Error(data.error || 'Conflict'), { status: 409 })
  }
  // Viewer-role write rejection: surface a single in-app banner instead of
  // letting each callsite alert() their own copy. We clone the response so
  // the original caller can still .json()/.text() it normally.
  if (res.status === 403) {
    const peek = res.clone()
    peek.json().then((data: any) => {
      if (typeof data?.error === 'string' && /read-only role/i.test(data.error)) {
        window.dispatchEvent(new CustomEvent('dcc-viewer-blocked'))
      }
    }).catch(() => {})
  }
  return res
}

export const defaultBrandOptions = initialData.brandOptions.sort()

export const loadDataFromAPI = async () => {
  try {
    const response = await authFetch('/api/data')
    const data = await response.json()
    return data
  } catch (error) {
    console.error('Error loading data from API:', error)
    return null
  }
}
