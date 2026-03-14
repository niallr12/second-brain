import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import './App.css'
import { fetchConfig, fetchDashboard, runQuickAction, sendChat, updateConfig } from './api'
import type {
  ChatMessage,
  ConfigResponse,
  DashboardResponse,
  QuickActionRequest,
  RootNoteCard,
} from './types'

type LoadingState = 'boot' | 'config' | 'chat' | 'action' | null
type RootNoteName = 'TODAY.md' | 'WAITING.md' | 'INBOX.md'
type AppRoute = 'chat' | 'workspace'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

function App() {
  const [route, setRoute] = useState<AppRoute>(getRoute())
  const [config, setConfig] = useState<ConfigResponse | null>(null)
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null)
  const [notesPathInput, setNotesPathInput] = useState('')
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

  useEffect(() => {
    void boot()
  }, [])

  useEffect(() => {
    const onHashChange = () => {
      setRoute(getRoute())
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

  async function boot() {
    try {
      setLoadingState('boot')
      const [nextConfig, nextDashboard] = await Promise.all([
        fetchConfig(),
        fetchDashboard(),
      ])
      setConfig(nextConfig)
      setDashboard(nextDashboard)
      setNotesPathInput(nextConfig.notesPath)
      setError(null)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to load the app.')
    } finally {
      setLoadingState(null)
    }
  }

  async function handleSaveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    try {
      setLoadingState('config')
      const nextConfig = await updateConfig({ notesPath: notesPathInput })
      const nextDashboard = await fetchDashboard()
      setConfig(nextConfig)
      setDashboard(nextDashboard)
      setActionMessage('Notes workspace updated.')
      setError(null)
    } catch (caughtError) {
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
    const trimmedPrompt = prompt.trim()

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
    } catch (caughtError) {
      const message =
        caughtError instanceof Error ? caughtError.message : 'Unable to send the prompt.'
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
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : 'The requested action failed.',
      )
    } finally {
      setLoadingState(null)
    }
  }

  function navigate(nextRoute: AppRoute) {
    window.location.hash = nextRoute === 'workspace' ? '/workspace' : '/'
    setRoute(nextRoute)
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

  const warnings = config?.health.warnings ?? dashboard?.health.warnings ?? []
  const showInstallButton = installPromptEvent !== null && !isInstalled

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
            <button type="button" className="secondary-button" onClick={() => void boot()}>
              Refresh
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

          {!config?.copilot.ready || warnings.length > 0 ? (
            <div className="subtle-banner">
              <strong>{config?.copilot.ready ? 'Workspace note' : 'Copilot setup needed'}</strong>
              <p>{warnings[0] ?? config?.copilot.message ?? 'Loading workspace health.'}</p>
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
            />
            <div className="composer-footer">
              <span>Notes are updated automatically through constrained tools.</span>
              <button
                type="submit"
                className="primary-button"
                disabled={loadingState === 'chat'}
              >
                {loadingState === 'chat' ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        </div>

        <div className="minimal-meta">
          <span>{dashboard ? `${dashboard.documentCount} notes` : 'Loading notes'}</span>
          <span>{dashboard ? `${dashboard.chunkCount} chunks` : 'Loading chunks'}</span>
          <span>{dashboard ? `${dashboard.projectCount} projects` : 'Loading projects'}</span>
          <span>{config?.copilot.ready ? 'Copilot ready' : 'Copilot setup needed'}</span>
        </div>
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

function getRoute(): AppRoute {
  return window.location.hash === '#/workspace' ? 'workspace' : 'chat'
}

function isRunningStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('en-IE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

export default App
