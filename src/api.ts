import initialData from './data.json'

// Track client version for stale-write protection
let _clientVersion = ''

export const setClientVersion = (v: string) => { _clientVersion = v }
export const getClientVersion = () => _clientVersion

export const authFetch = async (url: string, options: RequestInit = {}) => {
  const sessionId = localStorage.getItem('dcc-session-id')
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
    ...(sessionId ? { 'x-session-id': sessionId } : {}),
    ...(_clientVersion ? { 'x-client-version': _clientVersion } : {}),
  }
  // Auto-add Content-Type for JSON bodies when not explicitly set
  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }
  // credentials: 'same-origin' is the default for same-origin fetches, but be explicit
  // so the HttpOnly session cookie set by /api/auth/login is always sent alongside the header.
  const res = await fetch(url, { credentials: 'same-origin', ...options, headers })
  if (res.status === 401 && !url.includes('/api/auth/')) {
    localStorage.removeItem('dcc-session-id')
    window.location.reload()
    throw new Error('Session expired — redirecting to login')
  }
  if (res.status === 409) {
    const data = await res.json().catch(() => ({}))
    if (data.error === 'Version mismatch') {
      window.location.reload()
      throw new Error('Version mismatch — reloading')
    }
    throw Object.assign(new Error(data.error || 'Conflict'), { status: 409 })
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
