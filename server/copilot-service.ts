import { CopilotClient, approveAll, defineTool, type CopilotSession } from '@github/copilot-sdk'
import { z } from 'zod'
import { NotesService } from './notes-service'

interface ChatRequest {
  prompt: string
  sessionId?: string
}

interface ToolCallLog {
  name: string
  status: 'started' | 'completed'
  summary?: string
}

const rootNoteSchema = z.enum(['TODAY.md', 'WAITING.md', 'INBOX.md'])

export class CopilotService {
  private client: CopilotClient | null = null
  private readonly sessions = new Map<string, CopilotSession>()
  private readonly notes: NotesService

  constructor(notes: NotesService) {
    this.notes = notes
  }

  async getStatus() {
    try {
      const client = await this.getClient()
      const auth = await client.getAuthStatus()
      const isAuthenticated = auth?.isAuthenticated ?? true

      return {
        ready: isAuthenticated,
        message: isAuthenticated
          ? 'Copilot SDK is available.'
          : 'Copilot CLI is reachable, but authentication is missing.',
      }
    } catch (error) {
      return {
        ready: false,
        message: error instanceof Error ? error.message : 'Unable to start Copilot SDK.',
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.disconnect().catch(() => undefined)
    }

    this.sessions.clear()

    if (this.client) {
      await this.client.stop().catch(() => [])
      this.client = null
    }
  }

  async chat(request: ChatRequest) {
    const session = await this.getSession(request.sessionId)
    const toolCalls: ToolCallLog[] = []
    const toolNamesByCallId = new Map<string, string>()

    const off = session.on((event) => {
      if (event.type === 'tool.execution_start') {
        toolNamesByCallId.set(event.data.toolCallId, event.data.toolName)
        toolCalls.push({
          name: event.data.toolName,
          status: 'started',
        })
      }

      if (event.type === 'tool.execution_complete') {
        const toolName = toolNamesByCallId.get(event.data.toolCallId) ?? 'unknown_tool'
        toolCalls.push({
          name: toolName,
          status: 'completed',
          summary:
            event.data.result?.detailedContent ??
            event.data.result?.content ??
            (event.data.success ? 'Tool execution completed.' : 'Tool execution failed.'),
        })
      }
    })

    try {
      const response = await session.sendAndWait({ prompt: request.prompt }, 120_000)

      return {
        sessionId: session.sessionId,
        answer: response?.data.content ?? 'No response was returned by Copilot.',
        toolCalls,
      }
    } finally {
      off()
    }
  }

  private async getSession(sessionId?: string) {
    if (sessionId) {
      const cached = this.sessions.get(sessionId)

      if (cached) {
        return cached
      }
    }

    const client = await this.getClient()
    const toolDefinitions = this.createTools()
    const sessionConfig = {
      model: this.notes.getConfig().model,
      workingDirectory: this.notes.getConfig().notesPath,
      tools: toolDefinitions,
      availableTools: toolDefinitions.map((tool) => tool.name),
      onPermissionRequest: approveAll,
      systemMessage: {
        content: `
<assistant_role>
You are a notes operator for a solution architect's local PARA-style workspace.
</assistant_role>

<operating_rules>
- The Notes workspace is the source of truth. Use tools before making factual claims.
- Use \`notes_overview\` for questions about today, waiting, inbox, or overall status.
- Use \`search_notes\` before answering project, process, or research questions. It returns chunk-level citations.
- Use \`read_note\` before quoting or summarizing a specific file.
- Prefer the structured root-note tools for task capture, moving items between lists, and marking things done.
- Prefer \`promote_inbox_item\` and \`defer_today_item\` for common list triage.
- Prefer \`append_project_update\` and \`add_project_next_step\` for small project updates instead of rewriting full files.
- File updates are allowed automatically. Use \`write_note\` or \`append_note\` when the user asks you to update the Notes workspace.
- Preserve existing structure where practical. For tasks, prefer Markdown checklists.
- When \`search_notes\` returns relevant chunks, cite the chunk labels in the form \`path#section\` when available.
- End answers with a short "Sources:" line that lists the chunk citations or relative note paths you used.
</operating_rules>
`,
      },
    } as const

    const session = sessionId
      ? await client.resumeSession(sessionId, sessionConfig)
      : await client.createSession(sessionConfig)

    this.sessions.set(session.sessionId, session)
    return session
  }

  private async getClient() {
    if (this.client) {
      return this.client
    }

    const client = new CopilotClient({
      cwd: process.cwd(),
      logLevel: 'error',
    })

    await client.start()
    this.client = client
    return client
  }

  private createTools() {
    return [
      defineTool('notes_overview', {
        description: 'Get the current dashboard summary for Today, Waiting, Inbox, and project highlights.',
        handler: async () => this.notes.getOverviewForAssistant(),
      }),
      defineTool('search_notes', {
        description: 'Search the notes workspace and return the most relevant note chunks with citation labels.',
        parameters: z.object({
          query: z.string().min(2).describe('What to search for'),
          limit: z.number().int().min(1).max(10).default(5),
        }),
        handler: async ({ query, limit }) => ({
          query,
          results: this.notes.search(query, limit),
        }),
      }),
      defineTool('read_note', {
        description: 'Read a single markdown note from the Notes workspace.',
        parameters: z.object({
          path: z.string().describe('Path relative to the Notes workspace root'),
        }),
        handler: async ({ path }) => this.notes.readNote(path),
      }),
      defineTool('write_note', {
        description: 'Replace the full contents of a markdown file in the Notes workspace.',
        parameters: z.object({
          path: z.string().describe('Path relative to the Notes workspace root'),
          content: z.string().describe('Full markdown content to write'),
        }),
        handler: async ({ path, content }) => this.notes.writeNote(path, content),
      }),
      defineTool('append_note', {
        description: 'Append markdown content to the end of a note in the Notes workspace.',
        parameters: z.object({
          path: z.string().describe('Path relative to the Notes workspace root'),
          content: z.string().describe('Markdown content to append'),
        }),
        handler: async ({ path, content }) => this.notes.appendNote(path, content),
      }),
      defineTool('capture_root_item', {
        description: 'Add a new item to TODAY.md, WAITING.md, or INBOX.md without rewriting the full file.',
        parameters: z.object({
          target: rootNoteSchema.describe('Which root note to update'),
          item: z.string().min(2).describe('Task or reminder text'),
        }),
        handler: async ({ target, item }) => this.notes.captureRootItem(target, item),
      }),
      defineTool('move_root_item', {
        description: 'Move an existing item between TODAY.md, WAITING.md, and INBOX.md.',
        parameters: z.object({
          from: rootNoteSchema.describe('Current root note'),
          to: rootNoteSchema.describe('Destination root note'),
          item: z.string().min(2).describe('Task text to move'),
        }),
        handler: async ({ from, to, item }) => this.notes.moveRootItem(from, to, item),
      }),
      defineTool('mark_root_item_done', {
        description: 'Mark an item as done in a root note.',
        parameters: z.object({
          target: rootNoteSchema.describe('Which root note contains the item'),
          item: z.string().min(2).describe('Task text to mark as done'),
        }),
        handler: async ({ target, item }) => this.notes.markRootItemDone(target, item),
      }),
      defineTool('promote_inbox_item', {
        description: 'Move an item from INBOX.md to TODAY.md.',
        parameters: z.object({
          item: z.string().min(2).describe('Task text to move into Today'),
        }),
        handler: async ({ item }) => this.notes.promoteInboxItemToToday(item),
      }),
      defineTool('defer_today_item', {
        description: 'Move an item from TODAY.md to WAITING.md.',
        parameters: z.object({
          item: z.string().min(2).describe('Task text to defer'),
        }),
        handler: async ({ item }) => this.notes.deferTodayItemToWaiting(item),
      }),
      defineTool('append_project_update', {
        description: 'Append a dated update entry to a project note, usually status.md.',
        parameters: z.object({
          project: z.string().min(2).describe('Project folder name'),
          update: z.string().min(4).describe('Update text to append'),
          fileName: z.string().min(1).default('status.md').describe('Target markdown file within the project'),
          heading: z.string().min(1).default('Updates').describe('Heading to append under'),
        }),
        handler: async ({ project, update, fileName, heading }) =>
          this.notes.appendProjectUpdate(project, update, fileName, heading),
      }),
      defineTool('add_project_next_step', {
        description: 'Add a next-step item to a project note.',
        parameters: z.object({
          project: z.string().min(2).describe('Project folder name'),
          item: z.string().min(2).describe('Next step to record'),
        }),
        handler: async ({ project, item }) => this.notes.addProjectNextStep(project, item),
      }),
      defineTool('list_project_files', {
        description: 'List the files for a project folder under projects/.',
        parameters: z.object({
          project: z.string().describe('Project folder name'),
        }),
        handler: async ({ project }) => ({
          project,
          files: this.notes.listProjectFiles(project),
        }),
      }),
    ]
  }
}
