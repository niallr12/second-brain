import { useRef, useState } from 'react'
import { ApiError, runQuickAction } from './api'
import type { DashboardResponse, RootNoteName } from './types'

type ChatPanelKey = 'recentActions' | 'currentTodos' | 'waiting'
type ChatPanelState = Record<ChatPanelKey, boolean>

interface UseQuickAddOptions {
  onUnauthorized: (message: string) => Promise<void>
  setDashboard: (dashboard: DashboardResponse) => void
  setError: (error: string | null) => void
  setChatPanels: (updater: (current: ChatPanelState) => ChatPanelState) => void
}

export function useQuickAdd(options: UseQuickAddOptions) {
  const { onUnauthorized, setDashboard, setError, setChatPanels } = options

  const [target, setTarget] = useState<RootNoteName | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const feedbackTimer = useRef<number | null>(null)

  function open(noteTarget: RootNoteName) {
    setTarget(noteTarget)
    setText('')
    setFeedback(null)

    const panelKey: ChatPanelKey = noteTarget === 'WAITING.md' ? 'waiting' : 'currentTodos'
    setChatPanels((current) => ({
      ...current,
      [panelKey]: true,
    }))

    requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
  }

  function close() {
    setTarget(null)
    setText('')
    setFeedback(null)

    if (feedbackTimer.current) {
      window.clearTimeout(feedbackTimer.current)
      feedbackTimer.current = null
    }
  }

  async function submit() {
    const trimmed = text.trim()

    if (!trimmed || !target || busy) {
      return
    }

    setBusy(true)
    setFeedback(null)
    setError(null)

    try {
      const response = await runQuickAction({
        type: 'capture-root-item',
        target,
        item: trimmed,
      })

      setDashboard(response.dashboard)
      setText('')
      setFeedback(`Added to ${labelForRootNote(target)}`)

      if (feedbackTimer.current) {
        window.clearTimeout(feedbackTimer.current)
      }

      feedbackTimer.current = window.setTimeout(() => {
        setFeedback(null)
        feedbackTimer.current = null
      }, 2000)

      requestAnimationFrame(() => {
        inputRef.current?.focus()
      })
    } catch (caughtError) {
      if (caughtError instanceof ApiError && caughtError.status === 401) {
        await onUnauthorized('Authentication required. Enter the local access key to continue.')
        return
      }

      setError(
        caughtError instanceof Error ? caughtError.message : 'Failed to add item.',
      )
    } finally {
      setBusy(false)
    }
  }

  return {
    target,
    setTarget,
    text,
    setText,
    busy,
    feedback,
    inputRef,
    open,
    close,
    submit,
  }
}

function labelForRootNote(note: RootNoteName) {
  if (note === 'TODAY.md') return 'Today'
  if (note === 'WAITING.md') return 'Waiting'
  return 'Inbox'
}
