import { useEffect, useRef, useState } from 'react'
import { ApiError, runQuickAction } from './api'
import type { DashboardResponse, QuickActionRequest, RootNoteItem, RootNoteName } from './types'

type ChatPanelKey = 'recentActions' | 'currentTodos' | 'waiting'
type ChatPanelState = Record<ChatPanelKey, boolean>
type RowFeedbackState = Record<string, string>

export interface TaskEditorState {
  rowKey: string
  noteName: RootNoteName
  originalText: string
  nextItem: string
  ticket: string
  link: string
  person: string
  context: string
  due: string
  followUpOn: string
  moveTo: RootNoteName
}

interface UseTaskEditorOptions {
  onUnauthorized: (message: string) => Promise<void>
  setDashboard: (dashboard: DashboardResponse) => void
  setError: (error: string | null) => void
  setActionMessage: (message: string | null) => void
  setChatPanels: (updater: (current: ChatPanelState) => ChatPanelState) => void
}

export function useTaskEditor(options: UseTaskEditorOptions) {
  const { onUnauthorized, setDashboard, setError, setActionMessage, setChatPanels } = options

  const [taskEditor, setTaskEditor] = useState<TaskEditorState | null>(null)
  const [pendingRowKeys, setPendingRowKeys] = useState<string[]>([])
  const [rowFeedback, setRowFeedback] = useState<RowFeedbackState>({})
  const rowFeedbackTimers = useRef(new Map<string, number>())

  useEffect(() => {
    const timers = rowFeedbackTimers.current

    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer)
      }

      timers.clear()
    }
  }, [])

  function openEditor(noteName: RootNoteName, item: RootNoteItem) {
    setTaskEditor({
      rowKey: getTaskRowKey(noteName, item.text),
      noteName,
      originalText: item.text,
      nextItem: item.text,
      ticket: item.metadata.ticket ?? '',
      link: item.metadata.link ?? '',
      person: item.metadata.person ?? '',
      context: item.metadata.context ?? '',
      due: item.metadata.due ?? '',
      followUpOn: item.metadata.followUpOn ?? '',
      moveTo: noteName,
    })
  }

  function closeEditor() {
    setTaskEditor(null)
  }

  function updateField<K extends keyof TaskEditorState>(field: K, value: TaskEditorState[K]) {
    setTaskEditor((current) =>
      current ? { ...current, [field]: value } : current,
    )
  }

  async function inlineQuickAction(
    action: QuickActionRequest,
    successMessage: string,
    rowKey: string,
    feedbackLabel: string,
  ) {
    setPendingRowKeys((current) =>
      current.includes(rowKey) ? current : [...current, rowKey],
    )
    setActionMessage(null)
    setError(null)

    try {
      const response = await runQuickAction(action)
      setDashboard(response.dashboard)
      setActionMessage(successMessage)
      setChatPanels((current) => ({
        ...current,
        ...getPanelsForAction(action),
      }))
      queueRowFeedback(rowKey, feedbackLabel)
    } catch (caughtError) {
      if (caughtError instanceof ApiError && caughtError.status === 401) {
        await onUnauthorized('Authentication required. Enter the local access key to continue.')
        return
      }

      setError(
        caughtError instanceof Error ? caughtError.message : 'The requested action failed.',
      )
    } finally {
      setPendingRowKeys((current) => current.filter((value) => value !== rowKey))
    }
  }

  async function submitEditor() {
    if (!taskEditor || pendingRowKeys.includes(taskEditor.rowKey)) {
      return
    }

    const nextItem = taskEditor.nextItem.trim()

    if (!nextItem) {
      return
    }

    const rowKey = taskEditor.rowKey

    await inlineQuickAction(
      {
        type: 'update-root-item',
        target: taskEditor.noteName,
        item: taskEditor.originalText,
        nextItem,
        ticket: taskEditor.ticket,
        link: taskEditor.link,
        person: taskEditor.person,
        context: taskEditor.context,
        due: taskEditor.due,
        followUpOn: taskEditor.followUpOn,
        moveTo: taskEditor.moveTo === taskEditor.noteName ? undefined : taskEditor.moveTo,
      },
      taskEditor.moveTo === taskEditor.noteName
        ? `Updated item in ${labelForRootNote(taskEditor.noteName)}.`
        : `Updated item and moved it to ${labelForRootNote(taskEditor.moveTo)}.`,
      rowKey,
      'Updated',
    )

    setTaskEditor(null)
  }

  function queueRowFeedback(rowKey: string, label: string) {
    const existingTimer = rowFeedbackTimers.current.get(rowKey)

    if (existingTimer) {
      window.clearTimeout(existingTimer)
    }

    setRowFeedback((current) => ({
      ...current,
      [rowKey]: label,
    }))

    const timer = window.setTimeout(() => {
      setRowFeedback((current) => {
        const next = { ...current }
        delete next[rowKey]
        return next
      })
      rowFeedbackTimers.current.delete(rowKey)
    }, 2200)

    rowFeedbackTimers.current.set(rowKey, timer)
  }

  return {
    taskEditor,
    setTaskEditor,
    pendingRowKeys,
    rowFeedback,
    openEditor,
    closeEditor,
    updateField,
    inlineQuickAction,
    submitEditor,
  }
}

export function getTaskRowKey(noteName: string, text: string) {
  return `${noteName}::${text}`
}

export function labelForRootNote(note: RootNoteName) {
  if (note === 'TODAY.md') return 'Today'
  if (note === 'WAITING.md') return 'Waiting'
  return 'Inbox'
}

export function getPanelsForAction(action: QuickActionRequest): Partial<ChatPanelState> {
  const nextState: Partial<ChatPanelState> = {}

  if (action.type === 'capture-root-item') {
    if (action.target === 'WAITING.md') {
      nextState.waiting = true
    } else {
      nextState.currentTodos = true
    }

    return nextState
  }

  if (action.type === 'move-root-item') {
    if (action.from === 'WAITING.md' || action.to === 'WAITING.md') {
      nextState.waiting = true
    }

    if (
      action.from === 'TODAY.md' ||
      action.from === 'INBOX.md' ||
      action.to === 'TODAY.md' ||
      action.to === 'INBOX.md'
    ) {
      nextState.currentTodos = true
    }

    return nextState
  }

  if (action.type === 'promote-inbox-item') {
    return {
      ...nextState,
      currentTodos: true,
    }
  }

  if (action.type === 'defer-today-item') {
    return {
      ...nextState,
      currentTodos: true,
      waiting: true,
    }
  }

  if (action.type === 'mark-root-item-done') {
    if (action.target === 'WAITING.md') {
      nextState.waiting = true
    } else {
      nextState.currentTodos = true
    }

    return nextState
  }

  if (action.type === 'update-root-item') {
    const destinationNote = action.moveTo ?? action.target

    if (
      action.target === 'WAITING.md' ||
      destinationNote === 'WAITING.md'
    ) {
      nextState.waiting = true
    }

    if (
      action.target === 'TODAY.md' ||
      action.target === 'INBOX.md' ||
      destinationNote === 'TODAY.md' ||
      destinationNote === 'INBOX.md'
    ) {
      nextState.currentTodos = true
    }

    return nextState
  }

  if (action.type === 'undo-last-change') {
    return {
      ...nextState,
      currentTodos: true,
      waiting: true,
    }
  }

  return nextState
}
