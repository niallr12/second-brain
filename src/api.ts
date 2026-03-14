import type {
  ActivityEntry,
  ChatResponse,
  ConfigResponse,
  DashboardResponse,
  QuickActionRequest,
  QuickActionResponse,
} from './types'

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      'Content-Type': 'application/json',
    },
    ...init,
  })

  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(error?.error ?? `Request failed with status ${response.status}`)
  }

  return (await response.json()) as T
}

export function fetchConfig() {
  return request<ConfigResponse>('/api/config')
}

export function updateConfig(payload: { notesPath: string }) {
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

export function sendChat(payload: { prompt: string; sessionId?: string }) {
  return request<ChatResponse>('/api/chat', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function runQuickAction(payload: QuickActionRequest) {
  return request<QuickActionResponse>('/api/actions', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
