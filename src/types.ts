export interface CopilotStatus {
  ready: boolean
  message: string
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
  kind: 'capture' | 'move' | 'complete' | 'project-update' | 'write' | 'config'
  title: string
  detail: string
  paths: string[]
}

export interface ConfigResponse {
  notesPath: string
  model: string
  lastIndexedAt: string | null
  documentCount: number
  chunkCount: number
  projectCount: number
  copilot: CopilotStatus
  health: WorkspaceHealth
}

export interface RootNoteCard {
  fileName: string
  label: string
  path: string
  preview: string
  lineCount: number
  taskCount: number
  updatedAt: string | null
}

export interface ProjectSummary {
  name: string
  fileCount: number
  lastUpdated: string | null
  highlights: string[]
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

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolCalls?: ChatToolCall[]
  error?: boolean
}

export type QuickActionRequest =
  | { type: 'capture-root-item'; target: 'TODAY.md' | 'WAITING.md' | 'INBOX.md'; item: string }
  | { type: 'move-root-item'; from: 'TODAY.md' | 'WAITING.md' | 'INBOX.md'; to: 'TODAY.md' | 'WAITING.md' | 'INBOX.md'; item: string }
  | { type: 'promote-inbox-item'; item: string }
  | { type: 'defer-today-item'; item: string }
  | { type: 'mark-root-item-done'; target: 'TODAY.md' | 'WAITING.md' | 'INBOX.md'; item: string }
  | { type: 'append-project-update'; project: string; update: string; fileName?: string; heading?: string }
  | { type: 'add-project-next-step'; project: string; item: string }

export interface QuickActionResponse {
  result: unknown
  dashboard: DashboardResponse
}
