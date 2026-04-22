import type {
  ActivityEntry,
  AuthStatus,
  ChatResponse,
  ConfigResponse,
  DashboardResponse,
  DayPlanResponse,
  EmailAssistResponse,
  HistoryEntry,
  NoteContextResponse,
  NoteContentResponse,
  QuickActionRequest,
  QuickActionResponse,
  SearchResponse,
  TicketDraftResponse,
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
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 120_000)

  headers.set('Content-Type', 'application/json')

  if (accessKey) {
    headers.set('x-second-brain-key', accessKey)
  }

  try {
    const response = await fetch(input, {
      ...init,
      headers,
      signal: init?.signal ?? controller.signal,
    })

    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { error?: string } | null
      throw new ApiError(
        error?.error ?? `Request failed with status ${response.status}`,
        response.status,
      )
    }

    return (await response.json()) as T
  } catch (caughtError) {
    if (caughtError instanceof DOMException && caughtError.name === 'AbortError') {
      throw new ApiError('The request timed out. Please try again.', 408)
    }

    throw caughtError
  } finally {
    window.clearTimeout(timeout)
  }
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

export function rebuildIndex() {
  return request<QuickActionResponse>('/api/reindex', {
    method: 'POST',
  })
}

export function runQuickAction(payload: QuickActionRequest) {
  return request<QuickActionResponse>('/api/actions', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function fetchWeeklyLog() {
  return request<{ content: string }>('/api/weekly')
}

export function searchNotes(query: string, limit?: number) {
  const params = new URLSearchParams({ q: query })
  if (limit !== undefined) {
    params.set('limit', String(limit))
  }
  return request<SearchResponse>(`/api/search?${params.toString()}`)
}

export function fetchNoteContent(notePath: string) {
  const params = new URLSearchParams({ path: notePath })
  return request<NoteContentResponse>(`/api/notes/read?${params.toString()}`)
}

export function fetchNoteContext(notePath: string) {
  const params = new URLSearchParams({ path: notePath })
  return request<NoteContextResponse>(`/api/notes/context?${params.toString()}`)
}

export function generateDayPlan(payload?: { focus?: string }) {
  return request<DayPlanResponse>('/api/day-plan', {
    method: 'POST',
    body: JSON.stringify(payload ?? {}),
  })
}

export function draftTicket(payload: {
  task: string
  project?: string
  notePath?: string
  extraContext?: string
}) {
  return request<TicketDraftResponse>('/api/ticket-draft', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
