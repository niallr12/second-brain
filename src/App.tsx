import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import './App.css'
import {
  ApiError,
  clearStoredAccessKey,
  fetchAuthStatus,
  fetchConfig,
  fetchDashboard,
  improveEmail,
  rebuildIndex,
  runQuickAction,
  sendChat,
  storeAccessKey,
  undoLastChange,
  updateConfig,
  verifyAccessKey,
} from './api'
import type {
  AuthStatus,
  ChatMessage,
  ChatToolCall,
  ConfigResponse,
  DashboardResponse,
  EmailAssistResponse,
  QuickActionRequest,
  RootNoteItem,
  RootNoteName,
  RootNoteCard,
} from './types'

type LoadingState = 'boot' | 'config' | 'chat' | 'action' | 'email' | null
type AppRoute = 'chat' | 'workspace' | 'email'
type ChatPanelKey = 'recentActions' | 'currentTodos' | 'waiting'
type ChatPanelState = Record<ChatPanelKey, boolean>
type RowFeedbackState = Record<string, string>
type EmailOutputFormat = 'short-reply' | 'full-reply' | 'bullet-summary' | 'reply-with-next-actions'

interface TaskEditorState {
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

const QUICK_WORKFLOWS = [
  {
    label: 'Prepare day',
    prompt: 'Prepare my day. Summarize Today, call out anything urgent in Waiting, and suggest the best order to tackle the work.',
  },
  {
    label: 'Waiting by person',
    prompt: 'Summarize my waiting items grouped by person and highlight anything I should follow up on today.',
  },
  {
    label: 'Stalled projects',
    prompt: 'Which projects look stalled based on my notes, and what should I do next on each one?',
  },
] as const

const CHAT_PANEL_STORAGE_KEY = 'second-brain.chat-panels'
const DEFAULT_CHAT_PANEL_STATE: ChatPanelState = {
  recentActions: false,
  currentTodos: false,
  waiting: false,
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

function App() {
  const [route, setRoute] = useState<AppRoute>(() => getRouteFromHash(window.location.hash))
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)
  const [accessKeyInput, setAccessKeyInput] = useState('')
  const [config, setConfig] = useState<ConfigResponse | null>(null)
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null)
  const [notesPathInput, setNotesPathInput] = useState('')
  const [trustedModeInput, setTrustedModeInput] = useState(false)
  const [localOnlyModeInput, setLocalOnlyModeInput] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId, setSessionId] = useState<string>()
  const [loadingState, setLoadingState] = useState<LoadingState>('boot')
  const [error, setError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [captureTarget, setCaptureTarget] = useState<RootNoteName>('INBOX.md')
  const [captureItem, setCaptureItem] = useState('')
  const [moveFrom, setMoveFrom] = useState<RootNoteName>('INBOX.md')
  const [moveTo, setMoveTo] = useState<RootNoteName>('TODAY.md')
  const [moveItem, setMoveItem] = useState('')
  const [completeTarget, setCompleteTarget] = useState<RootNoteName>('TODAY.md')
  const [completeItem, setCompleteItem] = useState('')
  const [projectName, setProjectName] = useState('')
  const [projectUpdate, setProjectUpdate] = useState('')
  const [nextStepProject, setNextStepProject] = useState('')
  const [nextStepItem, setNextStepItem] = useState('')
  const [installPromptEvent, setInstallPromptEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [isInstalled, setIsInstalled] = useState(isRunningStandalone())
  const [chatPanels, setChatPanels] = useState<ChatPanelState>(() => loadChatPanelState())
  const [pendingRowKeys, setPendingRowKeys] = useState<string[]>([])
  const [rowFeedback, setRowFeedback] = useState<RowFeedbackState>({})
  const [taskEditor, setTaskEditor] = useState<TaskEditorState | null>(null)
  const [emailSubject, setEmailSubject] = useState('')
  const [incomingEmail, setIncomingEmail] = useState('')
  const [emailGoal, setEmailGoal] = useState('Improve the structure, clarity, and content while keeping the intent.')
  const [emailOutputFormat, setEmailOutputFormat] = useState<EmailOutputFormat>('full-reply')
  const [emailDraft, setEmailDraft] = useState('')
  const [emailResult, setEmailResult] = useState<EmailAssistResponse | null>(null)
  const [quickAddTarget, setQuickAddTarget] = useState<RootNoteName | null>(null)
  const [quickAddText, setQuickAddText] = useState('')
  const [quickAddBusy, setQuickAddBusy] = useState(false)
  const [quickAddFeedback, setQuickAddFeedback] = useState<string | null>(null)
  const quickAddInputRef = useRef<HTMLInputElement>(null)
  const quickAddFeedbackTimer = useRef<number | null>(null)
  const rowFeedbackTimers = useRef(new Map<string, number>())

  useEffect(() => {
    if (!window.location.hash) {
      window.history.replaceState(null, '', '#/')
      setRoute('chat')
    }

    const onHashChange = () => {
      setRoute(getRouteFromHash(window.location.hash))
    }

    window.addEventListener('hashchange', onHashChange)
    return () => {
      window.removeEventListener('hashchange', onHashChange)
    }
  }, [])

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPromptEvent(event as BeforeInstallPromptEvent)
    }

    const handleAppInstalled = () => {
      setInstallPromptEvent(null)
      setIsInstalled(true)
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleAppInstalled)

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleAppInstalled)
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(CHAT_PANEL_STORAGE_KEY, JSON.stringify(chatPanels))
  }, [chatPanels])

  useEffect(() => {
    const timers = rowFeedbackTimers.current

    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer)
      }

      timers.clear()
    }
  }, [])

  const handleUnauthorized = useCallback(async (message: string) => {
    clearStoredAccessKey()
    const nextAuthStatus = await fetchAuthStatus().catch(() => null)
    setAuthStatus(nextAuthStatus)
    setConfig(null)
    setDashboard(null)
    setMessages([])
    setSessionId(undefined)
    setError(message)
  }, [])

  const boot = useCallback(async () => {
    try {
      setLoadingState('boot')
      const nextAuthStatus = await fetchAuthStatus()
      setAuthStatus(nextAuthStatus)

      if (!nextAuthStatus.authenticated) {
        setConfig(null)
        setDashboard(null)
        setMessages([])
        setSessionId(undefined)
        setError(null)
        return
      }

      const [nextConfig, nextDashboard] = await Promise.all([
        fetchConfig(),
        fetchDashboard(),
      ])
      setConfig(nextConfig)
      setDashboard(nextDashboard)
      setNotesPathInput(nextConfig.notesPath)
      setTrustedModeInput(nextConfig.trustedMode)
      setLocalOnlyModeInput(nextConfig.localOnlyMode)
      setError(null)
    } catch (caughtError) {
      if (caughtError instanceof ApiError && caughtError.status === 401) {
        await handleUnauthorized('Authentication required. Enter the local access key to continue.')
        return
      }

      setError(caughtError instanceof Error ? caughtError.message : 'Unable to load the app.')
    } finally {
      setLoadingState(null)
    }
  }, [handleUnauthorized])

  useEffect(() => {
    void boot()
  }, [boot])

  async function handleUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const accessKey = accessKeyInput.trim()

    if (!accessKey) {
      return
    }

    try {
      setLoadingState('config')
      const nextAuthStatus = await verifyAccessKey(accessKey)
      storeAccessKey(accessKey)
      setAuthStatus(nextAuthStatus)
      setAccessKeyInput('')
      await boot()
    } catch (caughtError) {
      clearStoredAccessKey()
      setError(
        caughtError instanceof Error ? caughtError.message : 'Unable to verify the access key.',
      )
    } finally {
      setLoadingState(null)
    }
  }

  async function handleLock() {
    clearStoredAccessKey()
    setAccessKeyInput('')
    await handleUnauthorized('The workspace has been locked locally.')
  }

  async function handleSaveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    try {
      setLoadingState('config')
      const trustedModeChanged = config?.trustedMode !== trustedModeInput
      const localOnlyModeChanged = config?.localOnlyMode !== localOnlyModeInput
      const nextConfig = await updateConfig({
        notesPath: notesPathInput,
        trustedMode: trustedModeInput,
        localOnlyMode: localOnlyModeInput,
      })
      const nextDashboard = await fetchDashboard()
      setConfig(nextConfig)
      setDashboard(nextDashboard)
      if (trustedModeChanged || localOnlyModeChanged) {
        setSessionId(undefined)
        setMessages([])
      }
      setActionMessage(
        `Notes workspace updated.${trustedModeChanged ? ` Trusted mode ${trustedModeInput ? 'enabled' : 'disabled'}.` : ''}${localOnlyModeChanged ? ` Local-only mode ${localOnlyModeInput ? 'enabled' : 'disabled'}.` : ''}`,
      )
      setError(null)
    } catch (caughtError) {
      if (caughtError instanceof ApiError && caughtError.status === 401) {
        await handleUnauthorized('Authentication required. Enter the local access key to continue.')
        return
      }

      setError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Unable to save the notes path.',
      )
    } finally {
      setLoadingState(null)
    }
  }

  async function handlePromptSubmission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await submitPrompt(prompt)
  }

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
    setLoadingState('chat')
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
        await handleUnauthorized('Authentication required. Enter the local access key to continue.')
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
      setLoadingState(null)
    }
  }

  async function handleQuickAction(action: QuickActionRequest, successMessage: string) {
    try {
      setLoadingState('action')
      setActionMessage(null)
      setError(null)
      const response = await runQuickAction(action)
      setDashboard(response.dashboard)
      setActionMessage(successMessage)
      setChatPanels((current) => ({
        ...current,
        ...getPanelsForAction(action),
      }))
    } catch (caughtError) {
      if (caughtError instanceof ApiError && caughtError.status === 401) {
        await handleUnauthorized('Authentication required. Enter the local access key to continue.')
        return
      }

      setError(
        caughtError instanceof Error ? caughtError.message : 'The requested action failed.',
      )
    } finally {
      setLoadingState(null)
    }
  }

  async function handleUndoChange() {
    try {
      setLoadingState('action')
      setActionMessage(null)
      setError(null)
      const response = await undoLastChange()
      setDashboard(response.dashboard)
      setActionMessage('Last change undone.')
      setChatPanels((current) => ({
        ...current,
        currentTodos: true,
        waiting: true,
      }))
    } catch (caughtError) {
      if (caughtError instanceof ApiError && caughtError.status === 401) {
        await handleUnauthorized('Authentication required. Enter the local access key to continue.')
        return
      }

      setError(
        caughtError instanceof Error ? caughtError.message : 'Unable to undo the last change.',
      )
    } finally {
      setLoadingState(null)
    }
  }

  async function handleRebuildIndex() {
    try {
      setLoadingState('action')
      setActionMessage(null)
      setError(null)
      const response = await rebuildIndex()
      setDashboard(response.dashboard)
      setActionMessage('Index rebuilt successfully.')
    } catch (caughtError) {
      if (caughtError instanceof ApiError && caughtError.status === 401) {
        await handleUnauthorized('Authentication required. Enter the local access key to continue.')
        return
      }

      setError(
        caughtError instanceof Error ? caughtError.message : 'Unable to rebuild the index.',
      )
    } finally {
      setLoadingState(null)
    }
  }

  function openQuickAdd(target: RootNoteName) {
    setQuickAddTarget(target)
    setQuickAddText('')
    setQuickAddFeedback(null)

    const panelKey: ChatPanelKey = target === 'WAITING.md' ? 'waiting' : 'currentTodos'
    setChatPanels((current) => ({
      ...current,
      [panelKey]: true,
    }))

    requestAnimationFrame(() => {
      quickAddInputRef.current?.focus()
    })
  }

  function closeQuickAdd() {
    setQuickAddTarget(null)
    setQuickAddText('')
    setQuickAddFeedback(null)

    if (quickAddFeedbackTimer.current) {
      window.clearTimeout(quickAddFeedbackTimer.current)
      quickAddFeedbackTimer.current = null
    }
  }

  async function handleQuickAddSubmit() {
    const text = quickAddText.trim()

    if (!text || !quickAddTarget || quickAddBusy) {
      return
    }

    setQuickAddBusy(true)
    setQuickAddFeedback(null)
    setError(null)

    try {
      const response = await runQuickAction({
        type: 'capture-root-item',
        target: quickAddTarget,
        item: text,
      })

      setDashboard(response.dashboard)
      setQuickAddText('')
      setQuickAddFeedback(`Added to ${labelForRootNote(quickAddTarget)}`)

      if (quickAddFeedbackTimer.current) {
        window.clearTimeout(quickAddFeedbackTimer.current)
      }

      quickAddFeedbackTimer.current = window.setTimeout(() => {
        setQuickAddFeedback(null)
        quickAddFeedbackTimer.current = null
      }, 2000)

      requestAnimationFrame(() => {
        quickAddInputRef.current?.focus()
      })
    } catch (caughtError) {
      if (caughtError instanceof ApiError && caughtError.status === 401) {
        await handleUnauthorized('Authentication required. Enter the local access key to continue.')
        return
      }

      setError(
        caughtError instanceof Error ? caughtError.message : 'Failed to add item.',
      )
    } finally {
      setQuickAddBusy(false)
    }
  }

  async function handleWorkflowPrompt(workflowPrompt: string) {
    if (config?.localOnlyMode) {
      setError('Local-only mode is enabled. Disable it in workspace settings to use chat workflows.')
      return
    }

    await submitPrompt(workflowPrompt)
  }

  function navigate(nextRoute: AppRoute) {
    const nextHash =
      nextRoute === 'workspace' ? '#/workspace' : nextRoute === 'email' ? '#/email' : '#/'

    if (window.location.hash === nextHash) {
      setRoute(nextRoute)
      return
    }

    setRoute(nextRoute)
    window.location.hash = nextHash
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return
    }

    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  async function handleInstall() {
    if (!installPromptEvent) {
      return
    }

    await installPromptEvent.prompt()
    const choice = await installPromptEvent.userChoice

    if (choice.outcome === 'accepted') {
      setInstallPromptEvent(null)
      setIsInstalled(true)
    }
  }

  function handlePanelToggle(panel: ChatPanelKey, open: boolean) {
    setChatPanels((current) => ({
      ...current,
      [panel]: open,
    }))
  }

  function openTaskEditor(noteName: RootNoteName, item: RootNoteItem) {
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

  function prefillFollowUpEmail(item: RootNoteItem) {
    const person = item.metadata.person?.trim()
    const context = item.metadata.context?.trim()
    const followUpOn = item.metadata.followUpOn?.trim()
    const due = item.metadata.due?.trim()
    const subjectSource = item.metadata.ticket?.trim() || item.text.trim()
    const draftLines = [
      person ? `Hi ${person},` : 'Hi,',
      '',
      `Just following up on ${item.text.trim().replace(/\.$/, '')}.`,
      context ? context : null,
      followUpOn ? `I had noted ${followUpOn} as a follow-up date.` : null,
      due ? `If possible, it would help to have an update by ${due}.` : null,
      '',
      'Thanks,',
    ].filter((line): line is string => Boolean(line))

    setEmailSubject(`Follow-up: ${subjectSource}`)
    setEmailGoal('Draft a concise follow-up email that is polite but clear about the ask.')
    setEmailOutputFormat('full-reply')
    setIncomingEmail(item.metadata.link ? `Reference link: ${item.metadata.link}` : '')
    setEmailDraft(draftLines.join('\n'))
    setEmailResult(null)
    setActionMessage('Email helper prefilled from waiting item.')
    navigate('email')
  }

  function closeTaskEditor() {
    setTaskEditor(null)
  }

  async function handleInlineQuickAction(
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
        await handleUnauthorized('Authentication required. Enter the local access key to continue.')
        return
      }

      setError(
        caughtError instanceof Error ? caughtError.message : 'The requested action failed.',
      )
    } finally {
      setPendingRowKeys((current) => current.filter((value) => value !== rowKey))
    }
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

  async function handleTaskEditorSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!taskEditor) {
      return
    }

    const nextItem = taskEditor.nextItem.trim()

    if (!nextItem) {
      return
    }

    const rowKey = taskEditor.rowKey

    await handleInlineQuickAction(
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

  async function handleEmailAssist(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (config?.localOnlyMode) {
      setError('Local-only mode is enabled. Disable it in workspace settings to use the email helper.')
      return
    }

    const draft = emailDraft.trim()

    if (!draft) {
      return
    }

    try {
      setLoadingState('email')
      setActionMessage(null)
      setError(null)
      const result = await improveEmail({
        subject: emailSubject.trim() || undefined,
        goal: emailGoal.trim() || undefined,
        incomingEmail: incomingEmail.trim() || undefined,
        outputFormat: emailOutputFormat,
        draft,
      })
      setEmailResult(result)
      setActionMessage('Email draft improved.')
    } catch (caughtError) {
      if (caughtError instanceof ApiError && caughtError.status === 401) {
        await handleUnauthorized('Authentication required. Enter the local access key to continue.')
        return
      }

      setError(
        caughtError instanceof Error ? caughtError.message : 'Unable to improve the email draft.',
      )
    } finally {
      setLoadingState(null)
    }
  }

  async function handleCopyEmailResult() {
    if (!emailResult) {
      return
    }

    const payload = [
      `Subject: ${emailResult.subject}`,
      '',
      emailResult.email,
      emailResult.nextActions?.length
        ? ['', 'Next actions:', ...emailResult.nextActions.map((action) => `- ${action}`)].join('\n')
        : null,
    ]
      .filter((value): value is string => value !== null)
      .join('\n')

    try {
      await navigator.clipboard.writeText(payload)
      setActionMessage('Improved email copied.')
      setError(null)
    } catch {
      setError('Unable to copy the improved email on this browser.')
    }
  }

  function renderQuickAddForm(panelTarget: 'currentTodos' | 'waiting') {
    const isCurrentPanel = panelTarget === 'currentTodos'
      ? quickAddTarget === 'TODAY.md' || quickAddTarget === 'INBOX.md'
      : quickAddTarget === 'WAITING.md'

    if (!isCurrentPanel || !quickAddTarget) {
      return null
    }

    return (
      <form
        className="quick-add-form"
        onSubmit={(event) => {
          event.preventDefault()
          void handleQuickAddSubmit()
        }}
      >
        <div className="quick-add-row">
          <input
            ref={quickAddInputRef}
            className="quick-add-input"
            value={quickAddText}
            onChange={(event) => setQuickAddText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                closeQuickAdd()
              }
            }}
            placeholder={`Add to ${labelForRootNote(quickAddTarget)}…`}
            disabled={quickAddBusy}
            autoFocus
          />
          {panelTarget === 'currentTodos' ? (
            <div className="quick-add-toggle">
              <button
                type="button"
                className={`quick-add-tab${quickAddTarget === 'TODAY.md' ? ' quick-add-tab-active' : ''}`}
                onClick={() => {
                  setQuickAddTarget('TODAY.md')
                  requestAnimationFrame(() => quickAddInputRef.current?.focus())
                }}
              >
                Today
              </button>
              <button
                type="button"
                className={`quick-add-tab${quickAddTarget === 'INBOX.md' ? ' quick-add-tab-active' : ''}`}
                onClick={() => {
                  setQuickAddTarget('INBOX.md')
                  requestAnimationFrame(() => quickAddInputRef.current?.focus())
                }}
              >
                Inbox
              </button>
            </div>
          ) : null}
          <button
            type="submit"
            className="mini-action-button"
            disabled={quickAddBusy || !quickAddText.trim()}
          >
            {quickAddBusy ? 'Adding…' : 'Add'}
          </button>
          <button
            type="button"
            className="mini-action-button mini-action-button-secondary"
            onClick={closeQuickAdd}
          >
            Close
          </button>
        </div>
        {quickAddFeedback ? (
          <span className="quick-add-feedback">{quickAddFeedback}</span>
        ) : null}
      </form>
    )
  }

  function renderTaskEditorForm() {
    if (!taskEditor) {
      return null
    }

    return (
      <form className="task-editor" onSubmit={handleTaskEditorSubmit}>
        <label className="field">
          <span>Task</span>
          <input
            value={taskEditor.nextItem}
            onChange={(event) =>
              setTaskEditor((current) =>
                current
                  ? { ...current, nextItem: event.target.value }
                  : current,
              )
            }
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Person</span>
            <input
              value={taskEditor.person}
              onChange={(event) =>
                setTaskEditor((current) =>
                  current
                    ? { ...current, person: event.target.value }
                    : current,
                )
              }
              placeholder="Sarah"
            />
          </label>
          <label className="field">
            <span>Ticket</span>
            <input
              value={taskEditor.ticket}
              onChange={(event) =>
                setTaskEditor((current) =>
                  current
                    ? { ...current, ticket: event.target.value }
                    : current,
                )
              }
              placeholder="ABC-123"
            />
          </label>
        </div>
        <label className="field">
          <span>Link</span>
          <input
            value={taskEditor.link}
            onChange={(event) =>
              setTaskEditor((current) =>
                current
                  ? { ...current, link: event.target.value }
                  : current,
              )
            }
            placeholder="https://example.com/thread-or-ticket"
          />
        </label>
        <label className="field">
          <span>Context</span>
          <textarea
            value={taskEditor.context}
            onChange={(event) =>
              setTaskEditor((current) =>
                current
                  ? { ...current, context: event.target.value }
                  : current,
              )
            }
            rows={2}
            placeholder="Waiting on a reply to the 15 March email"
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Due</span>
            <input
              type="date"
              value={taskEditor.due}
              onChange={(event) =>
                setTaskEditor((current) =>
                  current
                    ? { ...current, due: event.target.value }
                    : current,
                )
              }
            />
          </label>
          <label className="field">
            <span>Follow up</span>
            <input
              type="date"
              value={taskEditor.followUpOn}
              onChange={(event) =>
                setTaskEditor((current) =>
                  current
                    ? { ...current, followUpOn: event.target.value }
                    : current,
                )
              }
            />
          </label>
        </div>
        <label className="field">
          <span>Move to</span>
          <select
            value={taskEditor.moveTo}
            onChange={(event) =>
              setTaskEditor((current) =>
                current
                  ? {
                      ...current,
                      moveTo: event.target.value as RootNoteName,
                    }
                  : current,
              )
            }
          >
            <option value="TODAY.md">Today</option>
            <option value="WAITING.md">Waiting</option>
            <option value="INBOX.md">Inbox</option>
          </select>
        </label>
        <div className="task-editor-actions">
          <button type="submit" className="mini-action-button">
            Save
          </button>
          <button
            type="button"
            className="mini-action-button mini-action-button-secondary"
            onClick={closeTaskEditor}
          >
            Cancel
          </button>
        </div>
      </form>
    )
  }

  const warnings = config?.health.warnings ?? dashboard?.health.warnings ?? []
  const showInstallButton = installPromptEvent !== null && !isInstalled
  const recentActions = dashboard?.recentActivity.slice(0, 6) ?? []
  const lastUndo = dashboard?.lastUndo ?? null
  const rootNotes = dashboard?.rootNotes ?? []
  const actionableNotes = rootNotes.filter(
    (note) =>
      note.fileName === 'TODAY.md' ||
      note.fileName === 'INBOX.md',
  )
  const waitingNote = rootNotes.find((note) => note.fileName === 'WAITING.md')
  const localOnlyModeEnabled = config?.localOnlyMode ?? false

  if (!authStatus?.authenticated) {
    return (
      <main className="minimal-shell auth-shell">
        <header className="topbar minimal-topbar">
          <div>
            <p className="eyebrow">Second Brain</p>
            <h1 className="topbar-title">Unlock</h1>
          </div>
        </header>

        <section className="panel auth-panel">
          <div className="minimal-intro">
            <h2>Enter the local access key.</h2>
            <p>{authStatus?.prompt ?? 'Checking authentication status.'}</p>
          </div>

          <form className="stack-form" onSubmit={handleUnlock}>
            <label className="field">
              <span>Access key</span>
              <input
                type="password"
                value={accessKeyInput}
                onChange={(event) => setAccessKeyInput(event.target.value)}
                placeholder="Paste the local access key"
                autoComplete="current-password"
              />
            </label>
            <button type="submit" className="primary-button" disabled={loadingState === 'config'}>
              {loadingState === 'config' ? 'Unlocking…' : 'Unlock'}
            </button>
          </form>

          {error ? <div className="error-banner">{error}</div> : null}
        </section>
      </main>
    )
  }

  if (route === 'workspace') {
    return (
      <main className="shell workspace-shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">Second Brain</p>
            <h1 className="topbar-title">Workspace</h1>
          </div>
          <div className="route-actions">
            {showInstallButton ? (
              <button type="button" className="secondary-button" onClick={() => void handleInstall()}>
                Install App
              </button>
            ) : null}
            <button type="button" className="secondary-button" onClick={() => void handleLock()}>
              Lock
            </button>
            <button type="button" className="secondary-button" onClick={() => void boot()}>
              Refresh
            </button>
            <button type="button" className="secondary-button" onClick={() => navigate('email')}>
              Email Helper
            </button>
            <button type="button" className="primary-button compact-button" onClick={() => navigate('chat')}>
              Back to Chat
            </button>
          </div>
        </header>

        <section className="content-grid">
          <aside className="sidebar">
            <form className="panel" onSubmit={handleSaveConfig}>
              <div className="panel-heading">
                <h2>Workspace</h2>
                <span>{loadingState === 'config' ? 'Saving…' : 'Configurable'}</span>
              </div>
              <label className="field">
                <span>Notes root</span>
                <input
                  value={notesPathInput}
                  onChange={(event) => setNotesPathInput(event.target.value)}
                  placeholder="~/Desktop/Notes"
                />
              </label>
              <label className="toggle-field">
                <input
                  type="checkbox"
                  checked={trustedModeInput}
                  onChange={(event) => setTrustedModeInput(event.target.checked)}
                />
                <div>
                  <span>Trusted mode</span>
                  <p>
                    Lets chat use full-file note reads and writes. Keep this off for the safer default.
                  </p>
                </div>
              </label>
              <label className="toggle-field">
                <input
                  type="checkbox"
                  checked={localOnlyModeInput}
                  onChange={(event) => setLocalOnlyModeInput(event.target.checked)}
                />
                <div>
                  <span>Local-only mode</span>
                  <p>
                    Disable Copilot-backed chat and email helper while keeping local note indexing and quick actions available.
                  </p>
                </div>
              </label>
              <button type="submit" className="primary-button">
                Save path
              </button>
              <p className="panel-copy">
                Root notes and the `projects/` folder are bootstrapped automatically if they
                are missing.
              </p>
              {config ? (
                <div className="health-block">
                  <p className="microcopy">{config.copilot.message}</p>
                  <ul className="warning-list">
                    {warnings.length === 0 ? (
                      <li>Workspace health looks good.</li>
                    ) : (
                      warnings.map((warning) => <li key={warning}>{warning}</li>)
                    )}
                  </ul>
                </div>
              ) : null}
            </form>

            <div className="panel">
              <div className="panel-heading">
                <h2>Quick Capture</h2>
                <span>{loadingState === 'action' ? 'Working…' : '1-click write'}</span>
              </div>
              <form
                className="stack-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  const item = captureItem.trim()
                  if (!item) {
                    return
                  }

                  void handleQuickAction(
                    { type: 'capture-root-item', target: captureTarget, item },
                    `Captured item in ${labelForRootNote(captureTarget)}.`,
                  )
                  setCaptureItem('')
                }}
              >
                <label className="field">
                  <span>List</span>
                  <select value={captureTarget} onChange={(event) => setCaptureTarget(event.target.value as RootNoteName)}>
                    <option value="TODAY.md">Today</option>
                    <option value="WAITING.md">Waiting</option>
                    <option value="INBOX.md">Inbox</option>
                  </select>
                </label>
                <label className="field">
                  <span>Item</span>
                  <input
                    value={captureItem}
                    onChange={(event) => setCaptureItem(event.target.value)}
                    placeholder="Capture a task or reminder"
                  />
                </label>
                <button type="submit" className="primary-button compact-button">
                  Add item
                </button>
              </form>
            </div>

            <div className="panel">
              <div className="panel-heading">
                <h2>Triage</h2>
                <span>Move or complete</span>
              </div>
              <form
                className="stack-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  const item = moveItem.trim()
                  if (!item) {
                    return
                  }

                  void handleQuickAction(
                    { type: 'move-root-item', from: moveFrom, to: moveTo, item },
                    `Moved item from ${labelForRootNote(moveFrom)} to ${labelForRootNote(moveTo)}.`,
                  )
                  setMoveItem('')
                }}
              >
                <div className="field-row">
                  <label className="field">
                    <span>From</span>
                    <select value={moveFrom} onChange={(event) => setMoveFrom(event.target.value as RootNoteName)}>
                      <option value="TODAY.md">Today</option>
                      <option value="WAITING.md">Waiting</option>
                      <option value="INBOX.md">Inbox</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>To</span>
                    <select value={moveTo} onChange={(event) => setMoveTo(event.target.value as RootNoteName)}>
                      <option value="TODAY.md">Today</option>
                      <option value="WAITING.md">Waiting</option>
                      <option value="INBOX.md">Inbox</option>
                    </select>
                  </label>
                </div>
                <label className="field">
                  <span>Item</span>
                  <input
                    value={moveItem}
                    onChange={(event) => setMoveItem(event.target.value)}
                    placeholder="Task text to move"
                  />
                </label>
                <button type="submit" className="primary-button compact-button">
                  Move item
                </button>
              </form>

              <form
                className="stack-form split-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  const item = completeItem.trim()
                  if (!item) {
                    return
                  }

                  void handleQuickAction(
                    { type: 'mark-root-item-done', target: completeTarget, item },
                    `Marked item done in ${labelForRootNote(completeTarget)}.`,
                  )
                  setCompleteItem('')
                }}
              >
                <label className="field">
                  <span>Complete in</span>
                  <select value={completeTarget} onChange={(event) => setCompleteTarget(event.target.value as RootNoteName)}>
                    <option value="TODAY.md">Today</option>
                    <option value="WAITING.md">Waiting</option>
                    <option value="INBOX.md">Inbox</option>
                  </select>
                </label>
                <label className="field">
                  <span>Item</span>
                  <input
                    value={completeItem}
                    onChange={(event) => setCompleteItem(event.target.value)}
                    placeholder="Task text to mark complete"
                  />
                </label>
                <div className="action-row">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      const item = moveItem.trim()
                      if (!item) {
                        return
                      }

                      void handleQuickAction(
                        { type: 'promote-inbox-item', item },
                        'Promoted inbox item to Today.',
                      )
                      setMoveItem('')
                    }}
                  >
                    Inbox to Today
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      const item = completeItem.trim()
                      if (!item) {
                        return
                      }

                      void handleQuickAction(
                        { type: 'defer-today-item', item },
                        'Deferred Today item to Waiting.',
                      )
                      setCompleteItem('')
                    }}
                  >
                    Today to Waiting
                  </button>
                  <button type="submit" className="primary-button compact-button">
                    Complete
                  </button>
                </div>
              </form>
            </div>

            <div className="panel">
              <div className="panel-heading">
                <h2>Project Ops</h2>
                <span>Fast updates</span>
              </div>
              <form
                className="stack-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  const project = projectName.trim()
                  const update = projectUpdate.trim()
                  if (!project || !update) {
                    return
                  }

                  void handleQuickAction(
                    { type: 'append-project-update', project, update },
                    `Added project update for ${project}.`,
                  )
                  setProjectUpdate('')
                }}
              >
                <label className="field">
                  <span>Project</span>
                  <input
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                    placeholder="acme-modernisation"
                  />
                </label>
                <label className="field">
                  <span>Status update</span>
                  <textarea
                    value={projectUpdate}
                    onChange={(event) => setProjectUpdate(event.target.value)}
                    rows={4}
                    placeholder="Record a concise dated update"
                  />
                </label>
                <button type="submit" className="primary-button compact-button">
                  Add update
                </button>
              </form>

              <form
                className="stack-form split-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  const project = nextStepProject.trim()
                  const item = nextStepItem.trim()
                  if (!project || !item) {
                    return
                  }

                  void handleQuickAction(
                    { type: 'add-project-next-step', project, item },
                    `Added next step for ${project}.`,
                  )
                  setNextStepItem('')
                }}
              >
                <label className="field">
                  <span>Project</span>
                  <input
                    value={nextStepProject}
                    onChange={(event) => setNextStepProject(event.target.value)}
                    placeholder="new-alb"
                  />
                </label>
                <label className="field">
                  <span>Next step</span>
                  <input
                    value={nextStepItem}
                    onChange={(event) => setNextStepItem(event.target.value)}
                    placeholder="Confirm listener rules with platform team"
                  />
                </label>
                <button type="submit" className="primary-button compact-button">
                  Add next step
                </button>
              </form>
            </div>
          </aside>

          <section className="chat-column">
            <div className="panel activity-panel">
              <div className="panel-heading">
                <h2>Recent Activity</h2>
                <span>{dashboard?.recentActivity.length ?? 0} entries</span>
              </div>
              {lastUndo ? (
                <div className="undo-banner">
                  <div>
                    <strong>{lastUndo.title}</strong>
                    <p>{lastUndo.detail}</p>
                  </div>
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => void handleUndoChange()}
                    disabled={loadingState === 'action'}
                  >
                    Undo last change
                  </button>
                </div>
              ) : null}
              <div className="activity-list">
                {dashboard?.recentActivity.length ? (
                  dashboard.recentActivity.map((entry) => (
                    <article key={entry.id} className="activity-card">
                      <header>
                        <strong>{entry.title}</strong>
                        <span>{formatTime(entry.timestamp)}</span>
                      </header>
                      <p>{entry.detail}</p>
                      <footer>{entry.paths.join(', ') || 'Workspace configuration'}</footer>
                    </article>
                  ))
                ) : (
                  <p className="empty-copy">No recent edits yet.</p>
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel-heading">
                <h2>Root Notes</h2>
                <span>{dashboard?.lastIndexedAt ? formatTime(dashboard.lastIndexedAt) : '—'}</span>
              </div>
              <div className="note-stack">
                {dashboard?.rootNotes.map((note) => (
                  <RootNoteCardView key={note.fileName} note={note} />
                ))}
              </div>
            </div>

            <div className="panel">
              <div className="panel-heading">
                <h2>Projects</h2>
                <span>{dashboard?.projects.length ?? 0}</span>
              </div>
              <div className="project-list">
                {dashboard?.projects.map((project) => (
                  <article key={project.name} className="project-card">
                    <header>
                      <h3>{project.name}</h3>
                      <span>{project.fileCount} files</span>
                    </header>
                    <p>{project.highlights[0] ?? 'No highlights yet.'}</p>
                    {project.aliases.length > 0 ? (
                      <footer className="project-aliases">Aliases: {project.aliases.join(', ')}</footer>
                    ) : null}
                  </article>
                ))}
              </div>
            </div>
          </section>
        </section>

        {actionMessage ? <div className="success-banner">{actionMessage}</div> : null}
        {error ? <div className="error-banner">{error}</div> : null}
      </main>
    )
  }

  if (route === 'email') {
    return (
      <main className="minimal-shell email-shell">
        <header className="topbar minimal-topbar">
          <div>
            <p className="eyebrow">Second Brain</p>
            <h1 className="topbar-title">Email Helper</h1>
          </div>
          <div className="route-actions">
            {showInstallButton ? (
              <button type="button" className="secondary-button" onClick={() => void handleInstall()}>
                Install App
              </button>
            ) : null}
            <button type="button" className="secondary-button" onClick={() => void handleLock()}>
              Lock
            </button>
            <button type="button" className="secondary-button" onClick={() => navigate('workspace')}>
              Workspace View
            </button>
            <button type="button" className="primary-button compact-button" onClick={() => navigate('chat')}>
              Back to Chat
            </button>
          </div>
        </header>

        <section className="email-route-layout">
          <div className="panel email-route-panel">
            <div className="minimal-intro email-route-intro">
              <h2>Improve rough replies without touching your notes.</h2>
              <p>
                Paste the email you received for context if needed, then paste your draft reply.
                The helper will tighten structure, clarity, and content while keeping your intent.
              </p>
            </div>

            {!config?.copilot.ready || localOnlyModeEnabled ? (
              <div className="subtle-banner">
                <strong>{localOnlyModeEnabled ? 'Local-only mode enabled' : 'Copilot setup needed'}</strong>
                <p>
                  {localOnlyModeEnabled
                    ? 'Disable local-only mode in workspace settings to use the email helper.'
                    : config?.copilot.message ?? 'Loading Copilot status.'}
                </p>
              </div>
            ) : null}

            <form className="email-helper email-route-form" onSubmit={handleEmailAssist}>
              <div className="field-row">
                <label className="field">
                  <span>Subject</span>
                  <input
                    value={emailSubject}
                    onChange={(event) => setEmailSubject(event.target.value)}
                    placeholder="Optional outgoing subject"
                  />
                </label>
                <label className="field">
                  <span>Rewrite goal</span>
                  <select
                    value={emailGoal}
                    onChange={(event) => setEmailGoal(event.target.value)}
                  >
                    <option value="Improve the structure, clarity, and content while keeping the intent.">
                      Improve structure and content
                    </option>
                    <option value="Make this clearer and more concise while keeping the intent.">
                      Clearer and shorter
                    </option>
                    <option value="Make this more direct and executive-friendly while keeping it polite.">
                      More direct
                    </option>
                    <option value="Make this warmer and more collaborative while keeping it professional.">
                      Warmer
                    </option>
                    <option value="Tighten this note into a crisp action-oriented email.">
                      Action-oriented
                    </option>
                  </select>
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  <span>Output</span>
                  <select
                    value={emailOutputFormat}
                    onChange={(event) => setEmailOutputFormat(event.target.value as EmailOutputFormat)}
                  >
                    <option value="short-reply">Short reply</option>
                    <option value="full-reply">Fuller reply</option>
                    <option value="bullet-summary">Bullet summary</option>
                    <option value="reply-with-next-actions">Reply and next actions</option>
                  </select>
                </label>
              </div>

              <label className="field">
                <span>Incoming email</span>
                <textarea
                  value={incomingEmail}
                  onChange={(event) => setIncomingEmail(event.target.value)}
                  rows={6}
                  placeholder="Optional. Paste the email you are replying to so the model has the right context."
                />
              </label>

              <label className="field">
                <span>Your draft reply</span>
                <textarea
                  value={emailDraft}
                  onChange={(event) => setEmailDraft(event.target.value)}
                  rows={9}
                  placeholder="Paste the rough draft here."
                />
              </label>

              <div className="email-helper-actions">
                <button type="submit" className="primary-button compact-button" disabled={loadingState === 'email' || localOnlyModeEnabled}>
                  {loadingState === 'email' ? 'Improving…' : 'Improve email'}
                </button>
                {emailResult ? (
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => void handleCopyEmailResult()}
                  >
                    Copy result
                  </button>
                ) : null}
              </div>
            </form>
          </div>

          <div className="panel email-route-panel">
            <div className="panel-heading">
              <h2>Improved Draft</h2>
              <span>{emailResult ? 'Ready to copy' : 'Waiting for input'}</span>
            </div>
            {emailResult ? (
              <div className="email-result">
                <div className="email-result-block">
                  <span className="email-result-label">Suggested subject</span>
                  <p>{emailResult.subject}</p>
                </div>
                <div className="email-result-block">
                  <span className="email-result-label">Improved email</span>
                  <pre>{emailResult.email}</pre>
                </div>
                <div className="email-result-block">
                  <span className="email-result-label">What changed</span>
                  <p>{emailResult.notes}</p>
                </div>
                {emailResult.nextActions?.length ? (
                  <div className="email-result-block">
                    <span className="email-result-label">Next actions</span>
                    <ul className="email-next-actions">
                      {emailResult.nextActions.map((action) => (
                        <li key={action}>{action}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="empty-copy email-helper-copy">
                Keep this route focused on drafting. It uses Copilot for rewrite quality but does not read or update your notes.
              </p>
            )}
          </div>
        </section>

        {actionMessage ? <div className="success-banner">{actionMessage}</div> : null}
        {error ? <div className="error-banner">{error}</div> : null}
      </main>
    )
  }

  return (
    <main className="minimal-shell">
      <header className="topbar minimal-topbar">
        <div>
          <p className="eyebrow">Second Brain</p>
          <h1 className="topbar-title">Chat</h1>
        </div>
        <div className="route-actions">
          {showInstallButton ? (
            <button type="button" className="secondary-button" onClick={() => void handleInstall()}>
              Install App
            </button>
          ) : null}
          <button type="button" className="secondary-button" onClick={() => void handleLock()}>
            Lock
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void handleRebuildIndex()}
            disabled={loadingState === 'action'}
          >
            {loadingState === 'action' ? 'Rebuilding…' : 'Rebuild Index'}
          </button>
          <button type="button" className="secondary-button" onClick={() => navigate('email')}>
            Email Helper
          </button>
          <button type="button" className="secondary-button" onClick={() => navigate('workspace')}>
            Workspace View
          </button>
        </div>
      </header>

      <section className="minimal-chat-wrap">
        <div className="panel minimal-chat-panel">
          <div className="minimal-intro">
            <h2>Ask for updates, triage, or answers.</h2>
            <p>
              Use chat for the fast path. The assistant can update project notes, add tasks,
              move items between lists, and answer questions from your notes.
            </p>
          </div>

          {!config?.copilot.ready || warnings.length > 0 || localOnlyModeEnabled ? (
            <div className="subtle-banner">
              <strong>
                {localOnlyModeEnabled
                  ? 'Local-only mode enabled'
                  : config?.copilot.ready ? 'Workspace note' : 'Copilot setup needed'}
              </strong>
              <p>
                {localOnlyModeEnabled
                  ? 'Chat is disabled while local-only mode is on. Quick actions and notes views still work.'
                  : warnings[0] ?? config?.copilot.message ?? 'Loading workspace health.'}
              </p>
            </div>
          ) : null}

          {messages.length > 0 ? (
            <div className="messages minimal-messages">
              {messages.map((message) => (
                <article
                  key={message.id}
                  className={`message message-${message.role} ${message.error ? 'message-error' : ''}`}
                >
                  <div className="message-meta">
                    <span>{message.role === 'user' ? 'You' : 'Assistant'}</span>
                  </div>
                  <pre>{message.content}</pre>
                  {message.toolCalls?.length ? (
                    <div className="tool-trace">
                      {message.toolCalls.map((toolCall, index) => (
                        <div key={`${message.id}-${toolCall.name}-${index}`} className="tool-call">
                          <strong>{toolCall.name}</strong>
                          <span>{toolCall.status}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          ) : null}

          <form className="composer minimal-composer" onSubmit={handlePromptSubmission}>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handlePromptKeyDown}
              placeholder="Ask what to work on today, add a task, update a project, or ask a general question."
              rows={3}
              disabled={localOnlyModeEnabled}
            />
            <div className="composer-footer">
              <span>Notes are updated automatically through constrained tools.</span>
              <button
                type="submit"
                className="primary-button"
                disabled={loadingState === 'chat' || localOnlyModeEnabled}
              >
                {loadingState === 'chat' ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
          <div className="workflow-row">
            {QUICK_WORKFLOWS.map((workflow) => (
              <button
                key={workflow.label}
                type="button"
                className="workflow-chip"
                onClick={() => void handleWorkflowPrompt(workflow.prompt)}
                disabled={loadingState === 'chat' || localOnlyModeEnabled}
              >
                {workflow.label}
              </button>
            ))}
          </div>
        </div>

        <div className="minimal-meta">
          <span>{dashboard ? `${dashboard.documentCount} notes` : 'Loading notes'}</span>
          <span>{dashboard ? `${dashboard.chunkCount} chunks` : 'Loading chunks'}</span>
          <span>{dashboard ? `${dashboard.projectCount} projects` : 'Loading projects'}</span>
          <span>{config?.trustedMode ? 'Trusted mode on' : 'Trusted mode off'}</span>
          <span>{localOnlyModeEnabled ? 'Local-only mode on' : 'Remote features on'}</span>
          <span>{config?.copilot.ready ? 'Copilot ready' : 'Copilot setup needed'}</span>
        </div>

        <section className="bottom-panels">
          <details
            className="expandable-panel"
            open={chatPanels.recentActions}
            onToggle={(event) => handlePanelToggle('recentActions', event.currentTarget.open)}
          >
            <summary>
              <span>Recent Actions</span>
              <span>{recentActions.length} items</span>
            </summary>
            <div className="expandable-body">
              {lastUndo ? (
                <div className="undo-inline">
                  <div>
                    <strong>{lastUndo.title}</strong>
                    <p>{lastUndo.detail}</p>
                  </div>
                  <button
                    type="button"
                    className="mini-action-button mini-action-button-secondary"
                    onClick={() => void handleUndoChange()}
                    disabled={loadingState === 'action'}
                  >
                    Undo
                  </button>
                </div>
              ) : null}
              {recentActions.length > 0 ? (
                <div className="compact-activity-list">
                  {recentActions.map((entry) => (
                    <article key={entry.id} className="compact-entry">
                      <header>
                        <strong>{entry.title}</strong>
                        <span>{formatTime(entry.timestamp)}</span>
                      </header>
                      <p>{entry.detail}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="empty-copy">No actions recorded yet.</p>
              )}
            </div>
          </details>

          <details
            className="expandable-panel"
            open={chatPanels.currentTodos}
            onToggle={(event) => handlePanelToggle('currentTodos', event.currentTarget.open)}
          >
            <summary>
              <span>Current To Dos</span>
              <span className="summary-actions">
                <button
                  type="button"
                  className="panel-add-button"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    if (quickAddTarget === 'TODAY.md' || quickAddTarget === 'INBOX.md') {
                      closeQuickAdd()
                    } else {
                      openQuickAdd('TODAY.md')
                    }
                  }}
                >
                  +
                </button>
                {actionableNotes.reduce((count, note) => count + note.items.length, 0)} items
              </span>
            </summary>
            <div className="expandable-body">
              {renderQuickAddForm('currentTodos')}
              {actionableNotes.length > 0 ? (
                <div className="compact-note-list">
                  {actionableNotes.map((note) => (
                    <article key={note.fileName} className="compact-entry">
                      <header>
                        <strong>{note.label}</strong>
                        <span>{note.items.length} items</span>
                      </header>
                      {note.items.length > 0 ? (
                        <div className="compact-task-list">
                          {note.items.map((item) => {
                            const rowKey = getTaskRowKey(note.fileName, item.text)
                            const isPending = pendingRowKeys.includes(rowKey)
                            const feedback = rowFeedback[rowKey]
                            const isEditing = taskEditor?.rowKey === rowKey

                            return (
                              <div key={`${note.fileName}-${item.text}`} className="compact-task-row">
                                <div className="task-content">
                                  <span>{item.text}</span>
                                  {renderTaskMetadata(item)}
                                </div>
                                <div className="mini-action-row">
                                  <button
                                    type="button"
                                    className="mini-action-button mini-action-button-secondary"
                                    disabled={isPending}
                                    onClick={() => openTaskEditor(note.fileName, item)}
                                  >
                                    {isEditing ? 'Editing…' : 'Update'}
                                  </button>
                                  {note.fileName === 'INBOX.md' ? (
                                    <button
                                      type="button"
                                      className="mini-action-button mini-action-button-secondary"
                                      disabled={isPending}
                                      onClick={() => {
                                        void handleInlineQuickAction(
                                          {
                                            type: 'promote-inbox-item',
                                            item: item.text,
                                          },
                                          'Promoted inbox item to Today.',
                                          rowKey,
                                          'Moved',
                                        )
                                      }}
                                    >
                                      {isPending ? 'Working…' : 'Move to Today'}
                                    </button>
                                  ) : null}
                                  {note.fileName === 'TODAY.md' ? (
                                    <button
                                      type="button"
                                      className="mini-action-button mini-action-button-secondary"
                                      disabled={isPending}
                                      onClick={() => {
                                        void handleInlineQuickAction(
                                          {
                                            type: 'defer-today-item',
                                            item: item.text,
                                          },
                                          'Moved Today item to Waiting.',
                                          rowKey,
                                          'Deferred',
                                        )
                                      }}
                                    >
                                      {isPending ? 'Working…' : 'Move to Waiting'}
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    className="mini-action-button"
                                    disabled={isPending}
                                    onClick={() => {
                                      void handleInlineQuickAction(
                                        {
                                          type: 'mark-root-item-done',
                                          target: note.fileName,
                                          item: item.text,
                                        },
                                        `Marked item done in ${note.label}.`,
                                        rowKey,
                                        'Done',
                                      )
                                    }}
                                  >
                                    {isPending ? 'Working…' : 'Done'}
                                  </button>
                                  {feedback ? <span className="mini-status">{feedback}</span> : null}
                                </div>
                                {isEditing ? renderTaskEditorForm() : null}
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <p>No open items.</p>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <p className="empty-copy">No captured items yet.</p>
              )}
            </div>
          </details>

          <details
            className="expandable-panel"
            open={chatPanels.waiting}
            onToggle={(event) => handlePanelToggle('waiting', event.currentTarget.open)}
          >
            <summary>
              <span>Waiting</span>
              <span className="summary-actions">
                <button
                  type="button"
                  className="panel-add-button"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    if (quickAddTarget === 'WAITING.md') {
                      closeQuickAdd()
                    } else {
                      openQuickAdd('WAITING.md')
                    }
                  }}
                >
                  +
                </button>
                {waitingNote?.items.length ?? 0} items
              </span>
            </summary>
            <div className="expandable-body">
              {renderQuickAddForm('waiting')}
              {waitingNote?.items.length ? (
                <div className="compact-note-list">
                  <article className="compact-entry">
                    <header>
                      <strong>Waiting</strong>
                      <span>{waitingNote.items.length} items</span>
                    </header>
                    <div className="compact-task-list">
                      {waitingNote.items.map((item) => {
                        const rowKey = getTaskRowKey('WAITING.md', item.text)
                        const isPending = pendingRowKeys.includes(rowKey)
                        const feedback = rowFeedback[rowKey]
                        const isEditing = taskEditor?.rowKey === rowKey

                        return (
                          <div key={`waiting-panel-${item.text}`} className="compact-task-row">
                            <div className="task-content">
                              <span>{item.text}</span>
                              {renderTaskMetadata(item)}
                            </div>
                            <div className="mini-action-row">
                              <button
                                type="button"
                                className="mini-action-button mini-action-button-secondary"
                                disabled={isPending}
                                onClick={() => openTaskEditor('WAITING.md', item)}
                              >
                                {isEditing ? 'Editing…' : 'Update'}
                              </button>
                              <button
                                type="button"
                                className="mini-action-button mini-action-button-secondary"
                                disabled={isPending || localOnlyModeEnabled}
                                onClick={() => prefillFollowUpEmail(item)}
                              >
                                Draft follow-up
                              </button>
                              <button
                                type="button"
                                className="mini-action-button mini-action-button-secondary"
                                disabled={isPending}
                                onClick={() => {
                                  void handleInlineQuickAction(
                                    {
                                      type: 'move-root-item',
                                      from: 'WAITING.md',
                                      to: 'TODAY.md',
                                      item: item.text,
                                    },
                                    'Moved waiting item to Today.',
                                    rowKey,
                                    'Moved',
                                  )
                                }}
                              >
                                {isPending ? 'Working…' : 'Move to Today'}
                              </button>
                              <button
                                type="button"
                                className="mini-action-button"
                                disabled={isPending}
                                onClick={() => {
                                  void handleInlineQuickAction(
                                    {
                                      type: 'mark-root-item-done',
                                      target: 'WAITING.md',
                                      item: item.text,
                                    },
                                    'Marked waiting item done.',
                                    rowKey,
                                    'Done',
                                  )
                                }}
                              >
                                {isPending ? 'Working…' : 'Done'}
                              </button>
                              {feedback ? <span className="mini-status">{feedback}</span> : null}
                            </div>
                            {isEditing ? renderTaskEditorForm() : null}
                          </div>
                        )
                      })}
                    </div>
                  </article>
                </div>
              ) : (
                <p className="empty-copy">No waiting items right now.</p>
              )}
            </div>
          </details>

        </section>
      </section>

      {actionMessage ? <div className="success-banner">{actionMessage}</div> : null}
      {error ? <div className="error-banner">{error}</div> : null}
    </main>
  )
}

function RootNoteCardView(props: { note: RootNoteCard }) {
  return (
    <article className="root-note-card">
      <header>
        <h3>{props.note.label}</h3>
        <span>{props.note.taskCount} tasks</span>
      </header>
      <p>{props.note.preview}</p>
      <footer>
        <span>{props.note.path}</span>
        <span>{props.note.updatedAt ? formatTime(props.note.updatedAt) : 'No edits yet'}</span>
      </footer>
    </article>
  )
}

function labelForRootNote(note: RootNoteName) {
  if (note === 'TODAY.md') {
    return 'Today'
  }

  if (note === 'WAITING.md') {
    return 'Waiting'
  }

  return 'Inbox'
}

function renderTaskMetadata(item: RootNoteItem) {
  const metadataBits = [
    item.metadata.ticket ? `Ticket: ${item.metadata.ticket}` : null,
    item.metadata.person ? `Person: ${item.metadata.person}` : null,
    item.metadata.due ? `Due: ${item.metadata.due}` : null,
    item.metadata.followUpOn ? `Follow up: ${item.metadata.followUpOn}` : null,
    item.metadata.context ? item.metadata.context : null,
    item.metadata.link ? item.metadata.link : null,
  ].filter((value): value is string => value !== null)

  if (metadataBits.length === 0) {
    return null
  }

  return <p className="task-metadata">{metadataBits.join(' • ')}</p>
}

function getRouteFromHash(hash: string): AppRoute {
  if (hash === '#/workspace') {
    return 'workspace'
  }

  if (hash === '#/email') {
    return 'email'
  }

  return 'chat'
}

function isRunningStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
}

function getTaskRowKey(noteName: RootNoteName, itemText: string) {
  return `${noteName}:${itemText.trim().toLowerCase()}`
}

function loadChatPanelState(): ChatPanelState {
  const raw = window.localStorage.getItem(CHAT_PANEL_STORAGE_KEY)

  if (!raw) {
    return DEFAULT_CHAT_PANEL_STATE
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ChatPanelState>
    return {
      recentActions: parsed.recentActions ?? DEFAULT_CHAT_PANEL_STATE.recentActions,
      currentTodos: parsed.currentTodos ?? DEFAULT_CHAT_PANEL_STATE.currentTodos,
      waiting: parsed.waiting ?? DEFAULT_CHAT_PANEL_STATE.waiting,
    }
  } catch {
    return DEFAULT_CHAT_PANEL_STATE
  }
}

function getPanelsForAction(action: QuickActionRequest): Partial<ChatPanelState> {
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

function formatTime(value: string) {
  return new Intl.DateTimeFormat('en-IE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

export default App
