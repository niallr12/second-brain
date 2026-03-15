import type {
  ActivityEntry,
  AuthStatus,
  ChatResponse,
  ConfigResponse,
  DashboardResponse,
  EmailAssistResponse,
  HistoryEntry,
  QuickActionRequest,
  QuickActionResponse,
} from './types'

const ACCESS_KEY_STORAGE_KEY = 'second-brain.access-key'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function getStoredAccessKey() {
  return window.localStorage.getItem(ACCESS_KEY_STORAGE_KEY)?.trim() ?? ''
}

export function storeAccessKey(accessKey: string) {
  window.localStorage.setItem(ACCESS_KEY_STORAGE_KEY, accessKey.trim())
}

export function clearStoredAccessKey() {
  window.localStorage.removeItem(ACCESS_KEY_STORAGE_KEY)
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const accessKey = getStoredAccessKey()
  const headers = new Headers(init?.headers)

  headers.set('Content-Type', 'application/json')

  if (accessKey) {
    headers.set('x-second-brain-key', accessKey)
  }

  const response = await fetch(input, {
    ...init,
    headers,
  })

  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(
      error?.error ?? `Request failed with status ${response.status}`,
      response.status,
    )
  }

  return (await response.json()) as T
}

export function fetchAuthStatus() {
  return request<AuthStatus>('/api/auth/status')
}

export function verifyAccessKey(accessKey: string) {
  return request<AuthStatus>('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ accessKey }),
  })
}

export function fetchConfig() {
  return request<ConfigResponse>('/api/config')
}

export function updateConfig(payload: { notesPath: string; trustedMode?: boolean; localOnlyMode?: boolean }) {
  return request<ConfigResponse>('/api/config', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function fetchDashboard() {
  return request<DashboardResponse>('/api/dashboard')
}

export function fetchActivity() {
  return request<{ items: ActivityEntry[] }>('/api/activity')
}

export function fetchHistory() {
  return request<{ items: HistoryEntry[]; lastUndo: HistoryEntry | null }>('/api/history')
}

export function sendChat(payload: { prompt: string; sessionId?: string }) {
  return request<ChatResponse>('/api/chat', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function improveEmail(payload: {
  draft: string
  subject?: string
  goal?: string
  incomingEmail?: string
  outputFormat?: 'short-reply' | 'full-reply' | 'bullet-summary' | 'reply-with-next-actions'
}) {
  return request<EmailAssistResponse>('/api/email', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function undoLastChange() {
  return request<QuickActionResponse>('/api/undo', {
    method: 'POST',
  })
}

export function runQuickAction(payload: QuickActionRequest) {
  return request<QuickActionResponse>('/api/actions', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
