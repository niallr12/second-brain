export type RootNoteName = 'TODAY.md' | 'WAITING.md' | 'INBOX.md'
export type TodayLane = 'critical' | 'should-do' | 'can-wait'
export type ProjectHealthStatus = 'active' | 'at-risk' | 'stalled'

export interface RootNoteMetadata {
  ticket?: string
  link?: string
  person?: string
  context?: string
  due?: string
  followUpOn?: string
  addedOn?: string
  important?: boolean
  lane?: TodayLane
  project?: string
}

export interface RootNoteItem {
  text: string
  done: boolean
  metadata: RootNoteMetadata
}

export interface CopilotStatus {
  ready: boolean
  message: string
}

export interface AuthStatus {
  required: true
  authenticated: boolean
  keySource: 'env' | 'file'
  prompt: string
}

export interface WorkspaceHealth {
  notesPathExists: boolean
  watcherEnabled: boolean
  rootNotesPresent: number
  missingRootNotes: string[]
  warnings: string[]
}

export interface ActivityEntry {
  id: string
  timestamp: string
  kind: 'capture' | 'move' | 'complete' | 'project-update' | 'write' | 'config' | 'undo'
  title: string
  detail: string
  paths: string[]
}

export interface HistoryEntry {
  id: string
  timestamp: string
  title: string
  detail: string
  paths: string[]
}

export interface ConfigResponse {
  notesPath: string
  model: string
  trustedMode: boolean
  localOnlyMode: boolean
  lastIndexedAt: string | null
  documentCount: number
  chunkCount: number
  projectCount: number
  copilot: CopilotStatus
  auth: AuthStatus
  health: WorkspaceHealth
}

export interface RootNoteCard {
  fileName: RootNoteName
  label: string
  path: string
  preview: string
  lineCount: number
  taskCount: number
  items: RootNoteItem[]
  updatedAt: string | null
}

export interface ProjectSummary {
  name: string
  fileCount: number
  lastUpdated: string | null
  highlights: string[]
  aliases: string[]
  status: ProjectHealthStatus
  healthReason: string
  openNextSteps: number
  linkedWaitingCount: number
}

export interface UrgentItem {
  text: string
  noteName: RootNoteName
  due?: string
  followUpOn?: string
  overdue: boolean
  followUpDue: boolean
}

export interface DashboardResponse {
  notesPath: string
  model: string
  lastIndexedAt: string | null
  documentCount: number
  chunkCount: number
  projectCount: number
  health: WorkspaceHealth
  rootNotes: RootNoteCard[]
  projects: ProjectSummary[]
  recentActivity: ActivityEntry[]
  recentHistory: HistoryEntry[]
  lastUndo: HistoryEntry | null
  urgentItems: UrgentItem[]
}

export interface ChatToolCall {
  name: string
  status: 'started' | 'completed'
  summary?: string
}

export interface ChatResponse {
  sessionId: string
  answer: string
  toolCalls: ChatToolCall[]
}

export interface EmailAssistResponse {
  subject: string
  email: string
  notes: string
  nextActions?: string[]
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolCalls?: ChatToolCall[]
  error?: boolean
}

export type QuickActionRequest =
  | { type: 'capture-root-item'; target: RootNoteName; item: string }
  | { type: 'move-root-item'; from: RootNoteName; to: RootNoteName; item: string }
  | { type: 'promote-inbox-item'; item: string }
  | { type: 'defer-today-item'; item: string }
  | { type: 'mark-root-item-done'; target: RootNoteName; item: string }
  | { type: 'update-root-item'; target: RootNoteName; item: string; nextItem?: string; ticket?: string; link?: string; person?: string; context?: string; due?: string; followUpOn?: string; important?: boolean; lane?: TodayLane; project?: string; moveTo?: RootNoteName }
  | { type: 'promote-today-item-to-project'; item: string; project: string; summary?: string }
  | { type: 'append-project-update'; project: string; update: string; fileName?: string; heading?: string }
  | { type: 'add-project-next-step'; project: string; item: string }
  | { type: 'undo-last-change' }

export interface QuickActionResponse {
  result: unknown
  dashboard: DashboardResponse
}

export interface SearchResult {
  id: string
  path: string
  title: string
  sectionTitle: string
  citation: string
  project: string | null
  excerpt: string
  updatedAt: string | null
  score: number
}

export interface SearchResponse {
  query: string
  results: SearchResult[]
}

export interface NoteContentResponse {
  path: string
  content: string
}

export interface NoteContextResponse {
  path: string
  relatedNotes: Array<{
    path: string
    title: string
    updatedAt: string | null
    reason: string
  }>
  linkedTasks: Array<{
    text: string
    noteName: RootNoteName
    important: boolean
    project?: string
  }>
}

export interface DayPlanResponse {
  summary: string
  deepWork: string[]
  quickWins: string[]
  followUps: string[]
  blockers: string[]
}

export interface TicketDraftResponse {
  title: string
  summary: string
  problem: string
  scope: string
  acceptanceCriteria: string[]
  dependencies: string[]
  risks: string[]
  notes: string
}
