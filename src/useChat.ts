import { useState } from 'react'
import { ApiError, fetchDashboard, sendChat } from './api'
import type { ChatMessage, ChatToolCall, DashboardResponse } from './types'

type ChatPanelKey = 'recentActions' | 'currentTodos' | 'waiting'
type ChatPanelState = Record<ChatPanelKey, boolean>

interface UseChatOptions {
  onUnauthorized: (message: string) => Promise<void>
  setDashboard: (dashboard: DashboardResponse) => void
  setChatPanels: (updater: (current: ChatPanelState) => ChatPanelState) => void
  setError: (error: string | null) => void
  setActionMessage: (message: string | null) => void
}

export function useChat(options: UseChatOptions) {
  const { onUnauthorized, setDashboard, setChatPanels, setError, setActionMessage } = options

  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId, setSessionId] = useState<string>()
  const [chatBusy, setChatBusy] = useState(false)

  async function submitPrompt(inputPrompt: string) {
    const trimmedPrompt = inputPrompt.trim()

    if (!trimmedPrompt) {
      return
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmedPrompt,
    }

    setMessages((current) => [...current, userMessage])
    setPrompt('')
    setChatBusy(true)
    setActionMessage(null)
    setError(null)

    try {
      const response = await sendChat({ prompt: trimmedPrompt, sessionId })
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response.answer,
        toolCalls: response.toolCalls,
      }

      setSessionId(response.sessionId)
      setMessages((current) => [...current, assistantMessage])
      setDashboard(await fetchDashboard())
      setChatPanels((current) => ({
        ...current,
        ...getPanelsForToolCalls(response.toolCalls),
      }))
    } catch (caughtError) {
      if (caughtError instanceof ApiError && caughtError.status === 401) {
        await onUnauthorized('Authentication required. Enter the local access key to continue.')
        return
      }

      const message =
        caughtError instanceof Error ? caughtError.message : 'Unable to send the prompt.'
      setSessionId(undefined)
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: message,
          error: true,
        },
      ])
      setError(message)
    } finally {
      setChatBusy(false)
    }
  }

  function clearSession() {
    setMessages([])
    setSessionId(undefined)
  }

  return {
    prompt,
    setPrompt,
    messages,
    sessionId,
    chatBusy,
    submitPrompt,
    clearSession,
  }
}

function getPanelsForToolCalls(toolCalls: ChatToolCall[]): Partial<ChatPanelState> {
  const completedToolNames = toolCalls
    .filter((toolCall) => toolCall.status === 'completed')
    .map((toolCall) => toolCall.name)

  if (completedToolNames.length === 0) {
    return {}
  }

  const nextState: Partial<ChatPanelState> = {}
  const writeTools = new Set([
    'capture_root_item',
    'move_root_item',
    'mark_root_item_done',
    'promote_inbox_item',
    'defer_today_item',
    'update_root_item',
    'append_project_update',
    'add_project_next_step',
    'undo_last_change',
    'write_note',
    'append_note',
  ])

  if (completedToolNames.some((toolName) => writeTools.has(toolName))) {
    // recentActions panel is only opened by explicit user toggle
  }

  if (
    completedToolNames.some((toolName) =>
      ['capture_root_item', 'move_root_item', 'mark_root_item_done', 'promote_inbox_item', 'defer_today_item', 'update_root_item', 'undo_last_change'].includes(toolName),
    )
  ) {
    nextState.currentTodos = true
  }

  if (
    completedToolNames.some((toolName) =>
      ['move_root_item', 'defer_today_item', 'update_root_item', 'undo_last_change'].includes(toolName),
    )
  ) {
    nextState.waiting = true
  }

  return nextState
}
