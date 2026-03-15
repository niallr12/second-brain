import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import matter from 'gray-matter'
import { z } from 'zod'
import type { AppConfig } from './config-store'
import { ConfigStore } from './config-store'
import { ActivityStore } from './activity-store'

const ROOT_NOTE_NAMES = ['TODAY.md', 'WAITING.md', 'INBOX.md'] as const

export type RootNoteName = (typeof ROOT_NOTE_NAMES)[number]

const ROOT_NOTE_LABELS: Record<RootNoteName, string> = {
  'TODAY.md': 'Today',
  'WAITING.md': 'Waiting',
  'INBOX.md': 'Inbox',
}

const updateConfigSchema = z.object({
  notesPath: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
})

interface NoteDocument {
  absolutePath: string
  relativePath: string
  title: string
  content: string
  excerpt: string
  project: string | null
  rootNote: RootNoteName | null
  updatedAt: string
  tokens: string[]
}

interface NoteChunk {
  id: string
  path: string
  documentTitle: string
  sectionTitle: string | null
  content: string
  excerpt: string
  project: string | null
  rootNote: RootNoteName | null
  updatedAt: string
  tokens: string[]
  citation: string
}

interface RootNoteMetadata {
  ticket?: string
  link?: string
  person?: string
  context?: string
}

interface RootNoteItem {
  text: string
  done: boolean
  metadata: RootNoteMetadata
}

interface RootNoteCard {
  fileName: RootNoteName
  label: string
  path: string
  preview: string
  lineCount: number
  taskCount: number
  items: RootNoteItem[]
  updatedAt: string | null
}

interface ProjectSummary {
  name: string
  fileCount: number
  lastUpdated: string | null
  highlights: string[]
}

interface WorkspaceHealth {
  notesPathExists: boolean
  watcherEnabled: boolean
  rootNotesPresent: number
  missingRootNotes: RootNoteName[]
  warnings: string[]
}

export type QuickActionRequest =
  | { type: 'capture-root-item'; target: RootNoteName; item: string }
  | { type: 'move-root-item'; from: RootNoteName; to: RootNoteName; item: string }
  | { type: 'promote-inbox-item'; item: string }
  | { type: 'defer-today-item'; item: string }
  | { type: 'mark-root-item-done'; target: RootNoteName; item: string }
  | { type: 'update-root-item'; target: RootNoteName; item: string; nextItem?: string; ticket?: string; link?: string; person?: string; context?: string; moveTo?: RootNoteName }
  | { type: 'append-project-update'; project: string; update: string; fileName?: string; heading?: string }
  | { type: 'add-project-next-step'; project: string; item: string }

export class NotesService {
  private config!: AppConfig
  private readonly configStore = new ConfigStore()
  private readonly activityStore = new ActivityStore()
  private watcher: FSWatcher | null = null
  private watcherDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private readonly pendingWatcherPaths = new Set<string>()
  private documentsByPath = new Map<string, NoteDocument>()
  private chunksByPath = new Map<string, NoteChunk[]>()
  private documents: NoteDocument[] = []
  private chunks: NoteChunk[] = []
  private lastIndexedAt: string | null = null
  private indexOperation: Promise<void> = Promise.resolve()
  private watcherUnavailable = false

  async initialize(): Promise<void> {
    this.config = await this.configStore.load()
    await this.activityStore.initialize()
    await this.ensureNotesPath()
    await this.ensureWorkspaceStructure()
    await this.reindex()
    await this.startWatcher()
  }

  async shutdown(): Promise<void> {
    this.clearWatcherRefresh()
    await this.watcher?.close()
    await this.indexOperation
  }

  getConfig() {
    return {
      notesPath: this.config.notesPath,
      model: this.config.model,
      lastIndexedAt: this.lastIndexedAt,
      documentCount: this.documents.length,
      chunkCount: this.chunks.length,
      projectCount: this.getProjectSummaries().length,
      health: this.getWorkspaceHealth(),
    }
  }

  async updateConfig(input: unknown) {
    const next = updateConfigSchema.parse(input)
    const notesPath = next.notesPath
      ? path.resolve(next.notesPath)
      : this.config.notesPath

    const model = next.model ?? this.config.model
    const pathStats = await stat(notesPath).catch(() => null)

    if (!pathStats?.isDirectory()) {
      throw new Error(`Notes path does not exist: ${notesPath}`)
    }

    this.config = { notesPath, model }
    await this.configStore.save(this.config)
    await this.ensureWorkspaceStructure()
    await this.reindex()
    await this.restartWatcher()
    await this.activityStore.record({
      kind: 'config',
      title: 'Updated Notes workspace',
      detail: `Notes path set to ${notesPath}`,
      paths: [],
    })

    return this.getConfig()
  }

  getDashboard() {
    return {
      ...this.getConfig(),
      rootNotes: ROOT_NOTE_NAMES.map((fileName) => this.getRootNoteCard(fileName)),
      projects: this.getProjectSummaries(),
      recentActivity: this.activityStore.list(),
    }
  }

  getRecentActivity() {
    return this.activityStore.list()
  }

  getOverviewForAssistant() {
    return {
      dashboard: this.getDashboard(),
      rootFiles: ROOT_NOTE_NAMES.map((fileName) => ({
        fileName,
        label: ROOT_NOTE_LABELS[fileName],
        content: this.documents.find((document) => document.rootNote === fileName)?.content ?? '',
      })),
    }
  }

  search(query: string, limit = 5) {
    const normalizedLimit = Math.max(1, Math.min(limit, 10))
    const queryTokens = tokenize(query)

    if (queryTokens.length === 0) {
      return []
    }

    return this.chunks
      .map((chunk) => ({
        chunk,
        score: scoreChunk(chunk, queryTokens),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, normalizedLimit)
      .map(({ chunk, score }) => ({
        id: chunk.id,
        path: chunk.path,
        title: chunk.documentTitle,
        sectionTitle: chunk.sectionTitle,
        citation: chunk.citation,
        project: chunk.project,
        excerpt: createExcerpt(chunk.content, queryTokens),
        updatedAt: chunk.updatedAt,
        score,
      }))
  }

  listProjectFiles(projectName: string) {
    const normalizedProject = slugify(projectName)
    return this.documents
      .filter((document) => document.project === normalizedProject)
      .map((document) => ({
        path: document.relativePath,
        title: document.title,
        updatedAt: document.updatedAt,
      }))
  }

  async readNote(relativePath: string) {
    const absolutePath = this.resolveNotePath(relativePath)
    const content = await readFile(absolutePath, 'utf8')
    return {
      path: this.toRelativePath(absolutePath),
      content,
    }
  }

  async writeNote(relativePath: string, content: string) {
    const absolutePath = this.resolveNotePath(relativePath)
    await mkdir(path.dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content, 'utf8')
    await this.refreshIndexedPaths([absolutePath])
    await this.activityStore.record({
      kind: 'write',
      title: `Updated ${this.toRelativePath(absolutePath)}`,
      detail: 'Replaced full note content.',
      paths: [this.toRelativePath(absolutePath)],
    })

    return {
      path: this.toRelativePath(absolutePath),
      bytesWritten: Buffer.byteLength(content, 'utf8'),
    }
  }

  async appendNote(relativePath: string, content: string) {
    const absolutePath = this.resolveNotePath(relativePath)
    const existing = await readFile(absolutePath, 'utf8').catch(() => '')
    const separator = existing.endsWith('\n') || existing.length === 0 ? '' : '\n'
    const nextContent = `${existing}${separator}${content}\n`

    await mkdir(path.dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, nextContent, 'utf8')
    await this.refreshIndexedPaths([absolutePath])
    await this.activityStore.record({
      kind: 'write',
      title: `Appended to ${this.toRelativePath(absolutePath)}`,
      detail: createActivityDetail(content),
      paths: [this.toRelativePath(absolutePath)],
    })

    return {
      path: this.toRelativePath(absolutePath),
      bytesWritten: Buffer.byteLength(content, 'utf8'),
    }
  }

  async captureRootItem(noteName: RootNoteName, item: string) {
    const absolutePath = this.resolveNotePath(noteName)
    const lines = await readNoteLines(absolutePath)

    const blocks = parseRootNoteBlocks(lines)
    const blockIndex = findRootItemBlockIndex(blocks, item)

    if (blockIndex !== -1) {
      return {
        path: noteName,
        status: 'unchanged',
        item,
      }
    }

    const nextLines = appendRootNoteItemBlock(
      lines,
      serializeRootNoteItem(noteName, {
        text: item,
        done: false,
        metadata: {},
      }),
      createRootNoteTemplate(noteName),
    )

    await writeFile(absolutePath, serializeLines(nextLines), 'utf8')
    await this.refreshIndexedPaths([absolutePath])
    await this.activityStore.record({
      kind: 'capture',
      title: `Captured item in ${noteName}`,
      detail: item,
      paths: [noteName],
    })

    return {
      path: noteName,
      status: 'added',
      item,
    }
  }

  async moveRootItem(from: RootNoteName, to: RootNoteName, item: string) {
    const sourcePath = this.resolveNotePath(from)
    const destinationPath = this.resolveNotePath(to)
    const sourceLines = await readNoteLines(sourcePath)
    const destinationLines = await readNoteLines(destinationPath)
    const sourceBlocks = parseRootNoteBlocks(sourceLines)
    const destinationBlocks = parseRootNoteBlocks(destinationLines)
    const sourceIndex = findRootItemBlockIndex(sourceBlocks, item)

    if (sourceIndex === -1) {
      throw new Error(`Could not find "${item}" in ${from}`)
    }

    const sourceBlock = sourceBlocks[sourceIndex]
    const itemText = sourceBlock.item.text
    sourceLines.splice(sourceBlock.start, sourceBlock.end - sourceBlock.start)

    if (findRootItemBlockIndex(destinationBlocks, itemText) === -1) {
      const nextDestinationLines = appendRootNoteItemBlock(
        destinationLines,
        serializeRootNoteItem(to, {
          ...sourceBlock.item,
          done: false,
        }),
        createRootNoteTemplate(to),
      )
      await writeFile(destinationPath, serializeLines(nextDestinationLines), 'utf8')
    }

    await writeFile(sourcePath, serializeLines(trimTrailingBlankLines(sourceLines)), 'utf8')
    await this.refreshIndexedPaths([sourcePath, destinationPath])
    await this.activityStore.record({
      kind: 'move',
      title: `Moved item from ${from} to ${to}`,
      detail: itemText,
      paths: [from, to],
    })

    return {
      from,
      to,
      item: itemText,
      status: 'moved',
    }
  }

  async markRootItemDone(noteName: RootNoteName, item: string) {
    const absolutePath = this.resolveNotePath(noteName)
    const lines = await readNoteLines(absolutePath)
    const blocks = parseRootNoteBlocks(lines)
    const index = findRootItemBlockIndex(blocks, item)

    if (index === -1) {
      throw new Error(`Could not find "${item}" in ${noteName}`)
    }

    const block = blocks[index]
    const itemText = block.item.text
    lines.splice(
      block.start,
      block.end - block.start,
      ...serializeRootNoteItem(noteName, {
        ...block.item,
        done: true,
      }),
    )

    await writeFile(absolutePath, serializeLines(lines), 'utf8')
    await this.refreshIndexedPaths([absolutePath])
    await this.activityStore.record({
      kind: 'complete',
      title: `Completed item in ${noteName}`,
      detail: itemText,
      paths: [noteName],
    })

    return {
      path: noteName,
      item: itemText,
      status: 'done',
    }
  }

  async updateRootItem(
    noteName: RootNoteName,
    item: string,
    patch: {
      nextItem?: string
      ticket?: string
      link?: string
      person?: string
      context?: string
      moveTo?: RootNoteName
    },
  ) {
    const sourcePath = this.resolveNotePath(noteName)
    const sourceLines = await readNoteLines(sourcePath)
    const sourceBlocks = parseRootNoteBlocks(sourceLines)
    const sourceIndex = findRootItemBlockIndex(sourceBlocks, item)

    if (sourceIndex === -1) {
      throw new Error(`Could not find "${item}" in ${noteName}`)
    }

    const sourceBlock = sourceBlocks[sourceIndex]
    const nextItem: RootNoteItem = {
      ...sourceBlock.item,
      text: patch.nextItem?.trim() || sourceBlock.item.text,
      metadata: normalizeRootNoteMetadata({
        ...sourceBlock.item.metadata,
        ...(patch.ticket !== undefined ? { ticket: patch.ticket } : {}),
        ...(patch.link !== undefined ? { link: patch.link } : {}),
        ...(patch.person !== undefined ? { person: patch.person } : {}),
        ...(patch.context !== undefined ? { context: patch.context } : {}),
      }),
    }
    const destinationNote = patch.moveTo ?? noteName

    if (destinationNote === noteName) {
      sourceLines.splice(
        sourceBlock.start,
        sourceBlock.end - sourceBlock.start,
        ...serializeRootNoteItem(noteName, nextItem),
      )

      await writeFile(sourcePath, serializeLines(sourceLines), 'utf8')
      await this.refreshIndexedPaths([sourcePath])
      await this.activityStore.record({
        kind: 'write',
        title: `Updated item in ${noteName}`,
        detail: nextItem.text,
        paths: [noteName],
      })

      return {
        path: noteName,
        item: nextItem.text,
        status: 'updated',
      }
    }

    const destinationPath = this.resolveNotePath(destinationNote)
    const destinationLines = await readNoteLines(destinationPath)
    const destinationBlocks = parseRootNoteBlocks(destinationLines)

    sourceLines.splice(sourceBlock.start, sourceBlock.end - sourceBlock.start)

    if (findRootItemBlockIndex(destinationBlocks, nextItem.text) === -1) {
      const nextDestinationLines = appendRootNoteItemBlock(
        destinationLines,
        serializeRootNoteItem(destinationNote, {
          ...nextItem,
          done: false,
        }),
        createRootNoteTemplate(destinationNote),
      )
      await writeFile(destinationPath, serializeLines(nextDestinationLines), 'utf8')
    }

    await writeFile(sourcePath, serializeLines(trimTrailingBlankLines(sourceLines)), 'utf8')
    await this.refreshIndexedPaths([sourcePath, destinationPath])
    await this.activityStore.record({
      kind: 'move',
      title: `Updated item from ${noteName} to ${destinationNote}`,
      detail: nextItem.text,
      paths: [noteName, destinationNote],
    })

    return {
      from: noteName,
      to: destinationNote,
      item: nextItem.text,
      status: 'updated-and-moved',
    }
  }

  async appendProjectUpdate(
    project: string,
    update: string,
    fileName = 'status.md',
    heading = 'Updates',
  ) {
    const safeProject = slugify(project)
    const safeFileName = sanitizeProjectFileName(fileName)
    const relativePath = `projects/${safeProject}/${safeFileName}`
    const absolutePath = this.resolveNotePath(relativePath)
    const existing = await readFile(absolutePath, 'utf8').catch(() =>
      createProjectNoteTemplate(project, safeFileName),
    )
    const datedUpdate = `- ${new Date().toISOString().slice(0, 10)}: ${update.trim()}`
    const nextContent = appendUnderHeading(existing, heading, datedUpdate)

    await mkdir(path.dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, ensureTrailingNewline(nextContent), 'utf8')
    await this.refreshIndexedPaths([absolutePath])
    await this.activityStore.record({
      kind: 'project-update',
      title: `Updated project ${safeProject}`,
      detail: update.trim(),
      paths: [relativePath],
    })

    return {
      path: relativePath,
      status: 'updated',
      heading,
    }
  }

  async promoteInboxItemToToday(item: string) {
    return this.moveRootItem('INBOX.md', 'TODAY.md', item)
  }

  async deferTodayItemToWaiting(item: string) {
    return this.moveRootItem('TODAY.md', 'WAITING.md', item)
  }

  async addProjectNextStep(project: string, item: string) {
    return this.appendProjectUpdate(project, item, 'next-steps.md', 'Next Steps')
  }

  async runQuickAction(action: QuickActionRequest) {
    switch (action.type) {
      case 'capture-root-item':
        return this.captureRootItem(action.target, action.item)
      case 'move-root-item':
        return this.moveRootItem(action.from, action.to, action.item)
      case 'promote-inbox-item':
        return this.promoteInboxItemToToday(action.item)
      case 'defer-today-item':
        return this.deferTodayItemToWaiting(action.item)
      case 'mark-root-item-done':
        return this.markRootItemDone(action.target, action.item)
      case 'update-root-item':
        return this.updateRootItem(action.target, action.item, {
          nextItem: action.nextItem,
          ticket: action.ticket,
          link: action.link,
          person: action.person,
          context: action.context,
          moveTo: action.moveTo,
        })
      case 'append-project-update':
        return this.appendProjectUpdate(
          action.project,
          action.update,
          action.fileName,
          action.heading,
        )
      case 'add-project-next-step':
        return this.addProjectNextStep(action.project, action.item)
    }
  }

  private async ensureNotesPath(): Promise<void> {
    await mkdir(this.config.notesPath, { recursive: true })
  }

  private async ensureWorkspaceStructure(): Promise<void> {
    await mkdir(path.join(this.config.notesPath, 'projects'), { recursive: true })

    for (const noteName of ROOT_NOTE_NAMES) {
      const absolutePath = this.resolveNotePath(noteName)
      const exists = await access(absolutePath).then(() => true).catch(() => false)

      if (!exists) {
        await writeFile(
          absolutePath,
          ensureTrailingNewline(createRootNoteTemplate(noteName).join('\n')),
          'utf8',
        )
      }
    }
  }

  private async restartWatcher(): Promise<void> {
    this.clearWatcherRefresh()
    await this.watcher?.close()
    await this.startWatcher()
  }

  private async startWatcher(): Promise<void> {
    this.watcher = chokidar.watch(this.config.notesPath, {
      ignoreInitial: true,
      ignored: (targetPath) => !targetPath.endsWith('.md') && !isDirectoryLike(targetPath),
    })
    this.watcherUnavailable = false

    const handleChange = (targetPath: string) => {
      this.scheduleWatcherRefresh(targetPath)
    }

    this.watcher.on('add', handleChange)
    this.watcher.on('change', handleChange)
    this.watcher.on('unlink', handleChange)
    this.watcher.on('error', async (error) => {
      console.warn(`Notes watcher disabled: ${error instanceof Error ? error.message : 'unknown error'}`)
      this.clearWatcherRefresh()
      await this.watcher?.close()
      this.watcher = null
      this.watcherUnavailable = true
    })
  }

  private async reindex(): Promise<void> {
    await this.runIndexOperation(async () => {
      const markdownFiles = await findMarkdownFiles(this.config.notesPath)
      const nextDocuments = await Promise.all(
        markdownFiles.map((absolutePath) => this.loadDocument(absolutePath)),
      )

      this.documentsByPath = new Map(
        nextDocuments.map((document) => [document.absolutePath, document]),
      )
      this.chunksByPath = new Map(
        nextDocuments.map((document) => [document.absolutePath, createChunksForDocument(document)]),
      )
      this.rebuildIndexes()
    })
  }

  private async refreshIndexedPaths(absolutePaths: string[]): Promise<void> {
    const uniquePaths = [...new Set(absolutePaths.map((absolutePath) => path.resolve(absolutePath)))]

    if (uniquePaths.length === 0) {
      return
    }

    await this.runIndexOperation(async () => {
      await Promise.all(uniquePaths.map((absolutePath) => this.refreshIndexedPath(absolutePath)))
      this.rebuildIndexes()
    })
  }

  private async refreshIndexedPath(absolutePath: string): Promise<void> {
    if (path.extname(absolutePath) !== '.md') {
      return
    }

    const fileStats = await stat(absolutePath).catch(() => null)

    if (!fileStats?.isFile()) {
      this.documentsByPath.delete(absolutePath)
      this.chunksByPath.delete(absolutePath)
      return
    }

    const document = await this.loadDocument(absolutePath, fileStats)
    this.documentsByPath.set(absolutePath, document)
    this.chunksByPath.set(absolutePath, createChunksForDocument(document))
  }

  private async loadDocument(absolutePath: string, fileStats?: Awaited<ReturnType<typeof stat>>) {
    const raw = await readFile(absolutePath, 'utf8')
    const parsed = matter(raw)
    const relativePath = this.toRelativePath(absolutePath)
    const rootNote = ROOT_NOTE_NAMES.find((name) => name === path.basename(relativePath)) ?? null
    const project = getProjectName(relativePath)
    const updatedAt = (fileStats ?? (await stat(absolutePath))).mtime.toISOString()
    const title = deriveTitle(relativePath, parsed.content)

    return {
      absolutePath,
      relativePath,
      title,
      content: parsed.content.trim(),
      excerpt: createExcerpt(parsed.content, []),
      project,
      rootNote,
      updatedAt,
      tokens: tokenize(`${relativePath} ${title} ${parsed.content}`),
    } satisfies NoteDocument
  }

  private rebuildIndexes() {
    this.documents = [...this.documentsByPath.values()].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    )
    this.chunks = [...this.chunksByPath.values()]
      .flat()
      .sort((left, right) => left.citation.localeCompare(right.citation))
    this.lastIndexedAt = new Date().toISOString()
  }

  private scheduleWatcherRefresh(targetPath: string) {
    const absolutePath = path.resolve(targetPath)

    if (path.extname(absolutePath) !== '.md') {
      return
    }

    this.pendingWatcherPaths.add(absolutePath)

    if (this.watcherDebounceTimer) {
      clearTimeout(this.watcherDebounceTimer)
    }

    this.watcherDebounceTimer = setTimeout(() => {
      void this.flushWatcherRefresh()
    }, 250)
  }

  private clearWatcherRefresh() {
    if (this.watcherDebounceTimer) {
      clearTimeout(this.watcherDebounceTimer)
      this.watcherDebounceTimer = null
    }

    this.pendingWatcherPaths.clear()
  }

  private async flushWatcherRefresh() {
    const pendingPaths = [...this.pendingWatcherPaths]
    this.clearWatcherRefresh()

    if (pendingPaths.length === 0) {
      return
    }

    try {
      await this.refreshIndexedPaths(pendingPaths)
    } catch (error) {
      console.warn(
        `Notes watcher refresh failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    }
  }

  private async runIndexOperation(operation: () => Promise<void>) {
    const nextOperation = this.indexOperation.then(operation)
    this.indexOperation = nextOperation.catch(() => undefined)
    return nextOperation
  }

  private getRootNoteCard(fileName: RootNoteName): RootNoteCard {
    const document = this.documents.find((entry) => entry.rootNote === fileName)

    if (!document) {
      return {
        fileName,
        label: ROOT_NOTE_LABELS[fileName],
        path: fileName,
        preview: 'No content yet.',
        lineCount: 0,
        taskCount: 0,
        items: [],
        updatedAt: null,
      }
    }

    const lines = document.content.split('\n').filter((line) => line.trim().length > 0)
    const items = extractRootNoteItems(document.content)

    return {
      fileName,
      label: ROOT_NOTE_LABELS[fileName],
      path: document.relativePath,
      preview: lines.slice(0, 4).join('\n'),
      lineCount: lines.length,
      taskCount: items.length,
      items,
      updatedAt: document.updatedAt,
    }
  }

  private getProjectSummaries(): ProjectSummary[] {
    const projectMap = new Map<string, NoteDocument[]>()

    for (const document of this.documents) {
      if (!document.project) {
        continue
      }

      const documents = projectMap.get(document.project) ?? []
      documents.push(document)
      projectMap.set(document.project, documents)
    }

    return [...projectMap.entries()]
      .map(([projectName, documents]) => ({
        name: projectName,
        fileCount: documents.length,
        lastUpdated: documents
          .map((document) => document.updatedAt)
          .sort((left, right) => right.localeCompare(left))[0] ?? null,
        highlights: documents
          .slice(0, 3)
          .map((document) => `${document.title}: ${document.excerpt}`),
      }))
      .sort((left, right) => (right.lastUpdated ?? '').localeCompare(left.lastUpdated ?? ''))
  }

  private getWorkspaceHealth(): WorkspaceHealth {
    const rootNotesPresent = ROOT_NOTE_NAMES.filter((fileName) =>
      this.documents.some((document) => document.rootNote === fileName),
    ).length
    const missingRootNotes = ROOT_NOTE_NAMES.filter(
      (fileName) => !this.documents.some((document) => document.rootNote === fileName),
    )
    const warnings: string[] = []

    if (missingRootNotes.length > 0) {
      warnings.push(`Missing root notes: ${missingRootNotes.join(', ')}`)
    }

    if (this.watcherUnavailable && this.watcher === null && this.lastIndexedAt !== null) {
      warnings.push('Live file watching is unavailable. The app will still refresh after its own writes.')
    }

    return {
      notesPathExists: true,
      watcherEnabled: this.watcher !== null,
      rootNotesPresent,
      missingRootNotes,
      warnings,
    }
  }

  private resolveNotePath(relativePath: string) {
    const normalized = relativePath.replace(/^\/+/, '')
    const absolutePath = path.resolve(this.config.notesPath, normalized)
    const notesRoot = path.resolve(this.config.notesPath)

    if (
      absolutePath !== notesRoot &&
      !absolutePath.startsWith(`${notesRoot}${path.sep}`)
    ) {
      throw new Error(`Path escapes the Notes workspace: ${relativePath}`)
    }

    return absolutePath
  }

  private toRelativePath(absolutePath: string) {
    return path.relative(this.config.notesPath, absolutePath).split(path.sep).join('/')
  }
}

async function findMarkdownFiles(rootPath: string): Promise<string[]> {
  const output: string[] = []
  const entries = await readdir(rootPath, { withFileTypes: true })

  for (const entry of entries) {
    const absolutePath = path.join(rootPath, entry.name)

    if (entry.isDirectory()) {
      output.push(...(await findMarkdownFiles(absolutePath)))
      continue
    }

    if (entry.isFile() && entry.name.endsWith('.md')) {
      output.push(absolutePath)
    }
  }

  return output
}

function deriveTitle(relativePath: string, content: string) {
  const heading = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('# '))

  if (heading) {
    return heading.replace(/^#\s+/, '')
  }

  return path.basename(relativePath, '.md')
}

function getProjectName(relativePath: string) {
  const parts = relativePath.split('/')
  const projectsIndex = parts.findIndex((part) => part === 'projects')

  if (projectsIndex === -1 || projectsIndex === parts.length - 1) {
    return null
  }

  return slugify(parts[projectsIndex + 1])
}

function slugify(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '-')
}

function tokenize(value: string) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2)
}

function scoreChunk(chunk: NoteChunk, queryTokens: string[]) {
  let score = 0
  const title = chunk.documentTitle.toLowerCase()
  const sectionTitle = chunk.sectionTitle?.toLowerCase() ?? ''
  const relativePath = chunk.path.toLowerCase()
  const content = chunk.content.toLowerCase()
  const tokenSet = new Set(chunk.tokens)

  for (const token of queryTokens) {
    if (title.includes(token)) {
      score += 5
    }

    if (sectionTitle.includes(token)) {
      score += 6
    }

    if (relativePath.includes(token)) {
      score += 4
    }

    if (tokenSet.has(token)) {
      score += 2
    }

    const matches = content.match(new RegExp(token, 'g'))
    score += Math.min(matches?.length ?? 0, 3)
  }

  if (chunk.rootNote === 'TODAY.md' && queryTokens.some((token) => token === 'today')) {
    score += 8
  }

  if (chunk.rootNote === 'WAITING.md' && queryTokens.some((token) => token === 'waiting')) {
    score += 8
  }

  if (chunk.rootNote === 'INBOX.md' && queryTokens.some((token) => token === 'inbox')) {
    score += 8
  }

  return score
}

function createExcerpt(content: string, queryTokens: string[]) {
  const normalized = content.replace(/\s+/g, ' ').trim()

  if (normalized.length === 0) {
    return 'Empty note.'
  }

  const token = queryTokens[0]

  if (!token) {
    return `${normalized.slice(0, 180)}${normalized.length > 180 ? '…' : ''}`
  }

  const location = normalized.toLowerCase().indexOf(token)

  if (location === -1) {
    return `${normalized.slice(0, 180)}${normalized.length > 180 ? '…' : ''}`
  }

  const start = Math.max(0, location - 60)
  const end = Math.min(normalized.length, location + 140)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < normalized.length ? '…' : ''

  return `${prefix}${normalized.slice(start, end)}${suffix}`
}

function isDirectoryLike(targetPath: string) {
  return path.extname(targetPath) === ''
}

function createActivityDetail(content: string) {
  const normalized = content.replace(/\s+/g, ' ').trim()
  return normalized.slice(0, 140)
}

function createChunksForDocument(document: NoteDocument): NoteChunk[] {
  const sections = splitIntoSections(document.content)
  const chunks: NoteChunk[] = []

  if (sections.length === 0) {
    chunks.push(createChunk(document, null, document.content || document.title, 0))
    return chunks
  }

  for (const [sectionIndex, section] of sections.entries()) {
    const blocks = splitSectionIntoBlocks(section.content)

    if (blocks.length === 0) {
      chunks.push(createChunk(document, section.heading, section.content, sectionIndex))
      continue
    }

    for (const [blockIndex, block] of blocks.entries()) {
      chunks.push(
        createChunk(
          document,
          section.heading,
          block,
          sectionIndex,
          blockIndex,
        ),
      )
    }
  }

  return chunks
}

function createChunk(
  document: NoteDocument,
  sectionTitle: string | null,
  content: string,
  sectionIndex: number,
  blockIndex = 0,
): NoteChunk {
  const normalizedContent = content.trim()
  const id = `${document.relativePath}#${sectionIndex}-${blockIndex}`
  const citation = sectionTitle
    ? `${document.relativePath}#${sectionTitle}`
    : document.relativePath

  return {
    id,
    path: document.relativePath,
    documentTitle: document.title,
    sectionTitle,
    content: normalizedContent,
    excerpt: createExcerpt(normalizedContent, []),
    project: document.project,
    rootNote: document.rootNote,
    updatedAt: document.updatedAt,
    tokens: tokenize(`${document.relativePath} ${document.title} ${sectionTitle ?? ''} ${normalizedContent}`),
    citation,
  }
}

function splitIntoSections(content: string) {
  const lines = content.split('\n')
  const sections: Array<{ heading: string | null; content: string }> = []
  let currentHeading: string | null = null
  let currentLines: string[] = []

  const flush = () => {
    const normalized = currentLines.join('\n').trim()

    if (normalized.length > 0) {
      sections.push({
        heading: currentHeading,
        content: normalized,
      })
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (/^#{1,3}\s+/.test(trimmed)) {
      flush()
      currentHeading = trimmed.replace(/^#{1,3}\s+/, '')
      currentLines = []
      continue
    }

    currentLines.push(line)
  }

  flush()
  return sections
}

function splitSectionIntoBlocks(content: string) {
  const blocks = content
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)

  if (blocks.length <= 1) {
    return blocks
  }

  const mergedBlocks: string[] = []
  let currentBlock = ''

  for (const block of blocks) {
    const candidate = currentBlock.length === 0 ? block : `${currentBlock}\n\n${block}`

    if (candidate.length < 420) {
      currentBlock = candidate
      continue
    }

    if (currentBlock.length > 0) {
      mergedBlocks.push(currentBlock)
    }

    currentBlock = block
  }

  if (currentBlock.length > 0) {
    mergedBlocks.push(currentBlock)
  }

  return mergedBlocks
}

async function readNoteLines(absolutePath: string) {
  const content = await readFile(absolutePath, 'utf8').catch(() => '')
  return content.split('\n')
}

function createRootNoteTemplate(noteName: RootNoteName) {
  return [`# ${ROOT_NOTE_LABELS[noteName]}`, '']
}

function appendRootNoteItemBlock(lines: string[], blockLines: string[], fallbackTemplate: string[]) {
  const nextLines = lines.length > 1 || lines[0] !== '' ? [...lines] : [...fallbackTemplate]

  if (nextLines.length === 0) {
    nextLines.push(...fallbackTemplate)
  }

  if (nextLines.at(-1)?.trim() !== '') {
    nextLines.push('')
  }

  nextLines.push(...blockLines)
  return nextLines
}

function serializeLines(lines: string[]) {
  return ensureTrailingNewline(trimTrailingBlankLines(lines).join('\n'))
}

function ensureTrailingNewline(value: string) {
  return value.endsWith('\n') ? value : `${value}\n`
}

function trimTrailingBlankLines(lines: string[]) {
  const nextLines = [...lines]

  while (nextLines.length > 0 && nextLines.at(-1)?.trim() === '') {
    nextLines.pop()
  }

  return nextLines
}

function normalizeListText(value: string) {
  return value
    .replace(/^\s*[-*]\s+(\[[ xX]\]\s+)?/, '')
    .trim()
    .toLowerCase()
}

function extractListText(value: string) {
  const normalized = value.replace(/^\s*[-*]\s+(\[[ xX]\]\s+)?/, '').trim()
  return normalized.length > 0 ? normalized : null
}

function extractRootNoteItems(content: string) {
  return parseRootNoteBlocks(content.split('\n'))
    .map((block) => block.item)
    .filter((item) => !item.done)
}

function findRootItemBlockIndex(
  blocks: Array<{
    start: number
    end: number
    item: RootNoteItem
  }>,
  item: string,
) {
  const normalizedQuery = normalizeListText(item)
  let partialMatch = -1

  for (const [index, block] of blocks.entries()) {
    const normalizedLine = normalizeListText(block.item.text)

    if (normalizedLine.length === 0) {
      continue
    }

    if (normalizedLine === normalizedQuery) {
      return index
    }

    if (
      partialMatch === -1 &&
      normalizedQuery.length >= 4 &&
      normalizedLine.includes(normalizedQuery)
    ) {
      partialMatch = index
    }
  }

  return partialMatch
}

function formatRootNoteItem(noteName: RootNoteName, item: string, done: boolean) {
  const cleanItem = item.trim().replace(/\.$/, '')

  if (noteName === 'TODAY.md' || done) {
    return `- [${done ? 'x' : ' '}] ${cleanItem}`
  }

  return `- ${cleanItem}`
}

function serializeRootNoteItem(noteName: RootNoteName, item: RootNoteItem) {
  const lines = [formatRootNoteItem(noteName, item.text, item.done)]

  for (const [key, value] of rootNoteMetadataEntries(item.metadata)) {
    lines.push(`  - ${key}: ${value}`)
  }

  return lines
}

function parseRootNoteBlocks(lines: string[]) {
  const blocks: Array<{
    start: number
    end: number
    item: RootNoteItem
  }> = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (!isRootNoteItemLine(line)) {
      index += 1
      continue
    }

    const text = extractListText(line)

    if (!text) {
      index += 1
      continue
    }

    const metadata: RootNoteMetadata = {}
    let end = index + 1

    while (end < lines.length) {
      const nextLine = lines[end]

      if (isRootNoteMetadataLine(nextLine)) {
        const metadataEntry = parseRootNoteMetadataLine(nextLine)

        if (metadataEntry) {
          metadata[metadataEntry.key] = metadataEntry.value
        }

        end += 1
        continue
      }

      if (nextLine.trim() === '') {
        end += 1
        continue
      }

      break
    }

    blocks.push({
      start: index,
      end,
      item: {
        text,
        done: /^\s*[-*]\s+\[[xX]\]\s+/.test(line),
        metadata: normalizeRootNoteMetadata(metadata),
      },
    })

    index = end
  }

  return blocks
}

function isRootNoteItemLine(line: string) {
  return /^\s*[-*]\s+(\[[ xX]\]\s+)?\S+/.test(line)
}

function isRootNoteMetadataLine(line: string) {
  return /^\s{2,}[-*]\s+(ticket|link|person|context):\s+.+$/i.test(line)
}

function parseRootNoteMetadataLine(line: string) {
  const match = line.match(/^\s{2,}[-*]\s+(ticket|link|person|context):\s+(.+)$/i)

  if (!match) {
    return null
  }

  return {
    key: match[1].toLowerCase() as keyof RootNoteMetadata,
    value: match[2].trim(),
  }
}

function normalizeRootNoteMetadata(metadata: RootNoteMetadata): RootNoteMetadata {
  const normalizedTicket = normalizeRootNoteMetadataValue(metadata.ticket)
  const normalizedLink = normalizeRootNoteMetadataValue(metadata.link)
  const normalizedPerson = normalizeRootNoteMetadataValue(metadata.person)
  const normalizedContext = normalizeRootNoteMetadataValue(metadata.context)

  return {
    ...(normalizedTicket ? { ticket: normalizedTicket } : {}),
    ...(normalizedLink ? { link: normalizedLink } : {}),
    ...(normalizedPerson ? { person: normalizedPerson } : {}),
    ...(normalizedContext ? { context: normalizedContext } : {}),
  }
}

function rootNoteMetadataEntries(metadata: RootNoteMetadata) {
  return (['ticket', 'person', 'link', 'context'] as const)
    .flatMap((key) => {
      const value = metadata[key]
      return value ? [[key, value] as const] : []
    })
}

function normalizeRootNoteMetadataValue(value?: string) {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}

function sanitizeProjectFileName(fileName: string) {
  const trimmed = fileName.trim().replace(/^\/+/, '')
  const segments = trimmed.split('/').filter(Boolean)
  const leaf = segments.at(-1) ?? 'status.md'
  return leaf.endsWith('.md') ? leaf : `${leaf}.md`
}

function createProjectNoteTemplate(project: string, fileName: string) {
  const title = `${project
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')} ${path.basename(fileName, '.md')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())}`.trim()

  return `# ${title}\n`
}

function appendUnderHeading(content: string, heading: string, line: string) {
  const normalizedContent = content.trimEnd()
  const headingLine = `## ${heading}`

  if (normalizedContent.length === 0) {
    return `${headingLine}\n\n${line}`
  }

  if (!normalizedContent.includes(headingLine)) {
    return `${normalizedContent}\n\n${headingLine}\n\n${line}`
  }

  const lines = normalizedContent.split('\n')
  const headingIndex = lines.findIndex((value) => value.trim() === headingLine)
  let insertIndex = lines.length

  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      insertIndex = index
      break
    }
  }

  const nextLines = [...lines]
  nextLines.splice(insertIndex, 0, line)
  return nextLines.join('\n')
}
