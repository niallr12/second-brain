import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ApiError,
  fetchNoteContent,
  fetchNoteContext,
  fetchNoteTree,
  saveNoteContent,
} from './api'
import type { NoteContextResponse, NoteTreeNode } from './types'

const FAVORITES_STORAGE_KEY = 'second-brain.note-favorites'
const RECENTS_STORAGE_KEY = 'second-brain.note-recents'

type BrowserMode = 'rendered' | 'markdown' | 'edit'

interface NotesBrowserProps {
  onUnauthorized: (message: string) => Promise<void>
  setActionMessage: (message: string | null) => void
  setError: (message: string | null) => void
}

export function NotesBrowser(props: NotesBrowserProps) {
  const { onUnauthorized, setActionMessage, setError } = props
  const [treeNodes, setTreeNodes] = useState<NoteTreeNode[]>([])
  const [treeLoading, setTreeLoading] = useState(true)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [treeQuery, setTreeQuery] = useState('')
  const [expandedFolders, setExpandedFolders] = useState<string[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [noteContent, setNoteContent] = useState('')
  const [noteContext, setNoteContext] = useState<NoteContextResponse | null>(null)
  const [noteLoading, setNoteLoading] = useState(false)
  const [noteError, setNoteError] = useState<string | null>(null)
  const [browserMode, setBrowserMode] = useState<BrowserMode>('rendered')
  const [draftContent, setDraftContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [favorites, setFavorites] = useState<string[]>(() => loadStoredPaths(FAVORITES_STORAGE_KEY))
  const [recents, setRecents] = useState<string[]>(() => loadStoredPaths(RECENTS_STORAGE_KEY))

  const visibleTreeNodes = useMemo(
    () => filterNoteTree(treeNodes, treeQuery.trim().toLowerCase()),
    [treeNodes, treeQuery],
  )
  const allFileNodes = useMemo(() => flattenNoteFiles(treeNodes), [treeNodes])
  const noteLookup = useMemo(
    () => new Map(allFileNodes.map((node) => [node.path, node])),
    [allFileNodes],
  )
  const selectedNode = selectedPath ? noteLookup.get(selectedPath) ?? null : null
  const favoriteNodes = favorites
    .map((path) => noteLookup.get(path))
    .filter((node): node is NoteTreeNode => Boolean(node))
  const recentNodes = recents
    .map((path) => noteLookup.get(path))
    .filter((node): node is NoteTreeNode => {
      if (!node) {
        return false
      }

      return !favorites.includes(node.path)
    })

  useEffect(() => {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites))
  }, [favorites])

  useEffect(() => {
    window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(recents))
  }, [recents])

  const openNote = useCallback(async (path: string, options?: { force?: boolean }) => {
    if (
      !options?.force &&
      browserMode === 'edit' &&
      selectedPath &&
      selectedPath !== path &&
      draftContent !== noteContent &&
      !window.confirm('Discard unsaved changes and open another note?')
    ) {
      return
    }

    setSelectedPath(path)
    setNoteLoading(true)
    setNoteError(null)

    try {
      const [contentResponse, contextResponse] = await Promise.all([
        fetchNoteContent(path),
        fetchNoteContext(path).catch(() => null),
      ])
      setSelectedPath(contentResponse.path)
      setNoteContent(contentResponse.content)
      setDraftContent(contentResponse.content)
      setNoteContext(contextResponse)
      setRecents((current) => [contentResponse.path, ...current.filter((value) => value !== contentResponse.path)].slice(0, 8))
      setExpandedFolders((current) => [...new Set([...current, ...getAncestorFolderPaths(contentResponse.path)])])
      if (browserMode === 'edit') {
        setBrowserMode('rendered')
      }
    } catch (caughtError) {
      if (caughtError instanceof ApiError && caughtError.status === 401) {
        await onUnauthorized('Authentication required. Enter the local access key to continue.')
        return
      }

      setNoteError(caughtError instanceof Error ? caughtError.message : 'Unable to open note.')
    } finally {
      setNoteLoading(false)
    }
  }, [browserMode, draftContent, noteContent, onUnauthorized, selectedPath])

  const loadTree = useCallback(async (preferredPath?: string) => {
    setTreeLoading(true)
    setTreeError(null)

    try {
      const response = await fetchNoteTree()
      setTreeNodes(response.nodes)

      const nextPaths = flattenNoteFiles(response.nodes).map((node) => node.path)
      const nextSelectedPath = pickInitialNotePath(
        nextPaths,
        preferredPath ?? selectedPath,
        favorites,
        recents,
      )

      setExpandedFolders((current) => {
        const merged = new Set([
          ...current,
          ...response.nodes.filter((node) => node.type === 'folder').map((node) => node.path),
          ...getAncestorFolderPaths(nextSelectedPath),
        ])
        return [...merged]
      })

      if (nextSelectedPath && nextSelectedPath !== selectedPath) {
        await openNote(nextSelectedPath, { force: true })
      }
    } catch (caughtError) {
      if (caughtError instanceof ApiError && caughtError.status === 401) {
        await onUnauthorized('Authentication required. Enter the local access key to continue.')
        return
      }

      setTreeError(caughtError instanceof Error ? caughtError.message : 'Unable to load note tree.')
    } finally {
      setTreeLoading(false)
    }
  }, [favorites, onUnauthorized, openNote, recents, selectedPath])

  useEffect(() => {
    void loadTree()
    // loadTree intentionally captures current browser state; initial tree boot should run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleSave() {
    if (!selectedPath) {
      return
    }

    try {
      setSaving(true)
      setError(null)
      setActionMessage(null)
      await saveNoteContent({
        path: selectedPath,
        content: draftContent,
      })
      setNoteContent(draftContent)
      setActionMessage(`Saved ${selectedPath}.`)
      setBrowserMode('rendered')
      await loadTree(selectedPath)
      const nextContext = await fetchNoteContext(selectedPath).catch(() => null)
      setNoteContext(nextContext)
    } catch (caughtError) {
      if (caughtError instanceof ApiError && caughtError.status === 401) {
        await onUnauthorized('Authentication required. Enter the local access key to continue.')
        return
      }

      setError(caughtError instanceof Error ? caughtError.message : 'Unable to save note.')
    } finally {
      setSaving(false)
    }
  }

  function toggleFavorite(path: string) {
    setFavorites((current) =>
      current.includes(path)
        ? current.filter((value) => value !== path)
        : [path, ...current].slice(0, 12),
    )
  }

  function toggleFolder(path: string) {
    setExpandedFolders((current) =>
      current.includes(path)
        ? current.filter((value) => value !== path)
        : [...current, path],
    )
  }

  return (
    <section className="notes-browser-layout">
      <aside className="panel notes-browser-sidebar">
        <div className="panel-heading">
          <h2>Notes</h2>
          <span>{allFileNodes.length} files</span>
        </div>
        <label className="field">
          <span>Filter notes</span>
          <input
            value={treeQuery}
            onChange={(event) => setTreeQuery(event.target.value)}
            placeholder="Search file names"
          />
        </label>
        <button
          type="button"
          className="secondary-button compact-button"
          onClick={() => void loadTree(selectedPath ?? undefined)}
          disabled={treeLoading}
        >
          {treeLoading ? 'Refreshing…' : 'Refresh tree'}
        </button>

        {favoriteNodes.length > 0 ? (
          <div className="notes-browser-section">
            <strong>Favorites</strong>
            <div className="notes-browser-shortcuts">
              {favoriteNodes.map((node) => (
                <button
                  key={`favorite-${node.path}`}
                  type="button"
                  className={`notes-browser-shortcut${node.path === selectedPath ? ' notes-browser-shortcut-active' : ''}`}
                  onClick={() => void openNote(node.path)}
                >
                  {node.title ?? node.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {recentNodes.length > 0 ? (
          <div className="notes-browser-section">
            <strong>Recent</strong>
            <div className="notes-browser-shortcuts">
              {recentNodes.map((node) => (
                <button
                  key={`recent-${node.path}`}
                  type="button"
                  className={`notes-browser-shortcut${node.path === selectedPath ? ' notes-browser-shortcut-active' : ''}`}
                  onClick={() => void openNote(node.path)}
                >
                  {node.title ?? node.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="notes-browser-section notes-browser-tree-block">
          <strong>All notes</strong>
          {treeError ? <p className="empty-copy">{treeError}</p> : null}
          {!treeError && visibleTreeNodes.length === 0 ? (
            <p className="empty-copy">{treeQuery.trim() ? 'No files match this filter.' : 'No notes indexed yet.'}</p>
          ) : null}
          {visibleTreeNodes.length > 0 ? (
            <div className="notes-browser-tree">
              {visibleTreeNodes.map((node) => (
                <TreeNodeView
                  key={node.path}
                  node={node}
                  depth={0}
                  expandedFolders={expandedFolders}
                  selectedPath={selectedPath}
                  favoritePaths={favorites}
                  onToggleFolder={toggleFolder}
                  onSelectFile={(path) => { void openNote(path) }}
                  onToggleFavorite={toggleFavorite}
                />
              ))}
            </div>
          ) : null}
        </div>
      </aside>

      <section className="panel notes-browser-pane">
        {selectedPath ? (
          <>
            <header className="notes-browser-header">
              <div>
                <p className="eyebrow">Browsing</p>
                <h2>{selectedNode?.title ?? selectedNode?.name ?? selectedPath}</h2>
                <p className="notes-browser-path">{selectedPath}</p>
              </div>
              <div className="notes-browser-actions">
                <button
                  type="button"
                  className="secondary-button compact-button"
                  onClick={() => toggleFavorite(selectedPath)}
                >
                  {favorites.includes(selectedPath) ? 'Unfavorite' : 'Favorite'}
                </button>
                <button
                  type="button"
                  className="secondary-button compact-button"
                  onClick={() => void navigator.clipboard.writeText(selectedPath)}
                >
                  Copy path
                </button>
              </div>
            </header>

            <div className="note-viewer-toggle notes-browser-mode-toggle" aria-label="Browser note mode">
              <button
                type="button"
                className={browserMode === 'rendered' ? 'note-viewer-toggle-active' : ''}
                onClick={() => setBrowserMode('rendered')}
              >
                Rendered
              </button>
              <button
                type="button"
                className={browserMode === 'markdown' ? 'note-viewer-toggle-active' : ''}
                onClick={() => setBrowserMode('markdown')}
              >
                Markdown
              </button>
              <button
                type="button"
                className={browserMode === 'edit' ? 'note-viewer-toggle-active' : ''}
                onClick={() => {
                  setDraftContent(noteContent)
                  setBrowserMode('edit')
                }}
              >
                Edit
              </button>
            </div>

            {noteContext ? (
              <div className="note-context-panel notes-browser-context">
                <div>
                  <strong>Related notes</strong>
                  {noteContext.relatedNotes.length > 0 ? (
                    <ul className="note-context-list">
                      {noteContext.relatedNotes.map((note) => (
                        <li key={note.path}>
                          <button type="button" className="note-context-link" onClick={() => void openNote(note.path)}>
                            {note.title}
                          </button>
                          <span>{note.reason}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="note-viewer-empty">No related notes found.</p>
                  )}
                </div>
                <div>
                  <strong>Linked tasks</strong>
                  {noteContext.linkedTasks.length > 0 ? (
                    <ul className="note-context-list">
                      {noteContext.linkedTasks.map((task) => (
                        <li key={`${task.noteName}-${task.text}`}>
                          <span>{task.text}</span>
                          <span>{task.noteName}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="note-viewer-empty">No linked tasks found.</p>
                  )}
                </div>
              </div>
            ) : null}

            {noteLoading ? <p className="note-viewer-status">Loading note…</p> : null}
            {noteError ? <p className="note-viewer-status note-viewer-error">{noteError}</p> : null}

            {!noteLoading && !noteError ? (
              browserMode === 'edit' ? (
                <div className="notes-browser-editor">
                  <textarea
                    value={draftContent}
                    onChange={(event) => setDraftContent(event.target.value)}
                    className="notes-browser-editor-textarea"
                    rows={24}
                  />
                  <div className="notes-browser-editor-actions">
                    <button
                      type="button"
                      className="primary-button compact-button"
                      onClick={() => void handleSave()}
                      disabled={saving || draftContent === noteContent}
                    >
                      {saving ? 'Saving…' : 'Save note'}
                    </button>
                    <button
                      type="button"
                      className="secondary-button compact-button"
                      onClick={() => {
                        setDraftContent(noteContent)
                        setBrowserMode('rendered')
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : browserMode === 'markdown' ? (
                <pre className="note-viewer-content">{noteContent || 'This note is empty.'}</pre>
              ) : (
                <div className="note-viewer-content note-viewer-rendered notes-browser-content">
                  {noteContent.trim() ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {noteContent}
                    </ReactMarkdown>
                  ) : (
                    <p className="note-viewer-empty">This note is empty.</p>
                  )}
                </div>
              )
            ) : null}
          </>
        ) : (
          <div className="empty-state">
            <strong>Choose a note</strong>
            <p>Select any file from the tree to browse it here.</p>
          </div>
        )}
      </section>
    </section>
  )
}

function TreeNodeView(props: {
  node: NoteTreeNode
  depth: number
  expandedFolders: string[]
  selectedPath: string | null
  favoritePaths: string[]
  onToggleFolder: (path: string) => void
  onSelectFile: (path: string) => void
  onToggleFavorite: (path: string) => void
}) {
  const { node, depth, expandedFolders, selectedPath, favoritePaths, onToggleFolder, onSelectFile, onToggleFavorite } = props

  if (node.type === 'folder') {
    const isOpen = expandedFolders.includes(node.path)
    return (
      <div className="notes-browser-tree-node">
        <button
          type="button"
          className="notes-browser-folder"
          style={{ paddingLeft: `${0.7 + depth * 0.8}rem` }}
          onClick={() => onToggleFolder(node.path)}
        >
          <span>{isOpen ? '▾' : '▸'}</span>
          <span>{node.name}</span>
        </button>
        {isOpen ? (
          <div>
            {(node.children ?? []).map((child) => (
              <TreeNodeView
                key={child.path}
                node={child}
                depth={depth + 1}
                expandedFolders={expandedFolders}
                selectedPath={selectedPath}
                favoritePaths={favoritePaths}
                onToggleFolder={onToggleFolder}
                onSelectFile={onSelectFile}
                onToggleFavorite={onToggleFavorite}
              />
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="notes-browser-tree-node notes-browser-file-row">
      <button
        type="button"
        className={`notes-browser-file${node.path === selectedPath ? ' notes-browser-file-active' : ''}`}
        style={{ paddingLeft: `${1.55 + depth * 0.8}rem` }}
        onClick={() => onSelectFile(node.path)}
      >
        <span>{node.title ?? node.name}</span>
      </button>
      <button
        type="button"
        className={`notes-browser-favorite${favoritePaths.includes(node.path) ? ' notes-browser-favorite-active' : ''}`}
        onClick={() => onToggleFavorite(node.path)}
        aria-label={favoritePaths.includes(node.path) ? 'Remove favorite' : 'Mark as favorite'}
      >
        ★
      </button>
    </div>
  )
}

function loadStoredPaths(key: string) {
  const raw = window.localStorage.getItem(key)

  if (!raw) {
    return []
  }

  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
  } catch {
    return []
  }
}

function flattenNoteFiles(nodes: NoteTreeNode[]): NoteTreeNode[] {
  return nodes.flatMap((node) => {
    if (node.type === 'file') {
      return [node]
    }

    return flattenNoteFiles(node.children ?? [])
  })
}

function filterNoteTree(nodes: NoteTreeNode[], query: string): NoteTreeNode[] {
  if (!query) {
    return nodes
  }

  return nodes.flatMap((node) => {
    if (node.type === 'file') {
      const haystack = `${node.name} ${node.title ?? ''}`.toLowerCase()
      return haystack.includes(query) ? [node] : []
    }

    const children = filterNoteTree(node.children ?? [], query)
    const folderMatches = node.name.toLowerCase().includes(query)

    if (folderMatches || children.length > 0) {
      return [{
        ...node,
        children,
      }]
    }

    return []
  })
}

function getAncestorFolderPaths(path: string | null) {
  if (!path) {
    return []
  }

  const parts = path.split('/').slice(0, -1)
  const ancestors: string[] = []
  let currentPath = ''

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part
    ancestors.push(currentPath)
  }

  return ancestors
}

function pickInitialNotePath(
  availablePaths: string[],
  selectedPath: string | null,
  favorites: string[],
  recents: string[],
) {
  if (selectedPath && availablePaths.includes(selectedPath)) {
    return selectedPath
  }

  for (const path of [...favorites, ...recents, ...availablePaths]) {
    if (availablePaths.includes(path)) {
      return path
    }
  }

  return null
}
