import express, { type Request, type Response } from 'express'
import { z } from 'zod'
import { NotesService } from './notes-service'
import { CopilotService } from './copilot-service'
import { AuthStore } from './auth-store'

const notesService = new NotesService()
await notesService.initialize()

const copilotService = new CopilotService(notesService)
const authStore = new AuthStore()
await authStore.initialize()

const app = express()
const authBodySchema = z.object({
  accessKey: z.string().min(1),
})
const emailAssistSchema = z.object({
  draft: z.string().min(10),
  subject: z.string().optional(),
  goal: z.string().optional(),
  incomingEmail: z.string().optional(),
  outputFormat: z.enum(['short-reply', 'full-reply', 'bullet-summary', 'reply-with-next-actions']).optional(),
})
const dayPlanSchema = z.object({
  focus: z.string().optional(),
})
const ticketDraftSchema = z.object({
  task: z.string().min(2),
  project: z.string().optional(),
  notePath: z.string().optional(),
  extraContext: z.string().optional(),
})
const rootNoteNameSchema = z.enum(['TODAY.md', 'WAITING.md', 'INBOX.md'])
const quickActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('capture-root-item'), target: rootNoteNameSchema, item: z.string().min(1) }),
  z.object({ type: z.literal('move-root-item'), from: rootNoteNameSchema, to: rootNoteNameSchema, item: z.string().min(1) }),
  z.object({ type: z.literal('promote-inbox-item'), item: z.string().min(1) }),
  z.object({ type: z.literal('defer-today-item'), item: z.string().min(1) }),
  z.object({ type: z.literal('mark-root-item-done'), target: rootNoteNameSchema, item: z.string().min(1) }),
  z.object({
    type: z.literal('update-root-item'),
    target: rootNoteNameSchema,
    item: z.string().min(1),
    nextItem: z.string().optional(),
    ticket: z.string().optional(),
    link: z.string().optional(),
    person: z.string().optional(),
    context: z.string().optional(),
    due: z.string().optional(),
    followUpOn: z.string().optional(),
    important: z.boolean().optional(),
    lane: z.enum(['critical', 'should-do', 'can-wait']).optional(),
    project: z.string().optional(),
    moveTo: rootNoteNameSchema.optional(),
  }),
  z.object({ type: z.literal('promote-today-item-to-project'), item: z.string().min(1), project: z.string().min(1), summary: z.string().optional() }),
  z.object({ type: z.literal('append-project-update'), project: z.string().min(1), update: z.string().min(1), fileName: z.string().optional(), heading: z.string().optional() }),
  z.object({ type: z.literal('add-project-next-step'), project: z.string().min(1), item: z.string().min(1) }),
  z.object({ type: z.literal('undo-last-change') }),
])

app.use(express.json({ limit: '2mb' }))

app.use('/api', (request: Request, response: Response, next) => {
  const origin = request.headers.origin

  if (!origin) {
    next()
    return
  }

  try {
    const parsed = new URL(origin)
    const allowedHosts = new Set(['localhost', '127.0.0.1', '::1'])

    if (allowedHosts.has(parsed.hostname)) {
      next()
      return
    }
  } catch {
    // Fall through to the rejection below.
  }

  response.status(403).json({
    error: 'Requests must originate from a loopback origin.',
  })
})

function isAuthenticated(request: Request) {
  return authStore.verify(request.header('x-second-brain-key'))
}

app.get('/api/health', async (request: Request, response: Response) => {
  if (!isAuthenticated(request)) {
    response.json({
      ok: true,
      auth: authStore.getStatus(false),
    })
    return
  }

  response.json({
    ok: true,
    auth: authStore.getStatus(true),
    notes: notesService.getConfig(),
    copilot: await copilotService.getStatus(),
  })
})

app.get('/api/auth/status', (request: Request, response: Response) => {
  response.json(authStore.getStatus(isAuthenticated(request)))
})

app.post('/api/auth/verify', (request: Request, response: Response) => {
  try {
    const body = authBodySchema.parse(request.body)

    if (!authStore.verify(body.accessKey)) {
      response.status(401).json({
        error: 'The access key is invalid.',
      })
      return
    }

    response.json(authStore.getStatus(true))
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : 'Unable to verify access key.',
    })
  }
})

app.use('/api', (request: Request, response: Response, next) => {
  if (isAuthenticated(request)) {
    next()
    return
  }

  response.status(401).json({
    error: 'Authentication required. Enter the local access key to continue.',
  })
})

app.get('/api/search', (request: Request, response: Response) => {
  try {
    const q = typeof request.query.q === 'string' ? request.query.q.trim() : ''
    const limit = Number(request.query.limit) || 8

    if (!q) {
      response.status(400).json({ error: 'The "q" query parameter is required.' })
      return
    }

    const results = notesService.search(q, limit)
    response.json({ query: q, results })
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Search failed unexpectedly.',
    })
  }
})

app.get('/api/notes/read', async (request: Request, response: Response) => {
  try {
    const notePath = typeof request.query.path === 'string' ? request.query.path.trim() : ''

    if (!notePath) {
      response.status(400).json({ error: 'The "path" query parameter is required.' })
      return
    }

    const note = await notesService.readNote(notePath)
    response.json(note)
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : 'Unable to read note.',
    })
  }
})

app.get('/api/notes/context', async (request: Request, response: Response) => {
  try {
    const notePath = typeof request.query.path === 'string' ? request.query.path.trim() : ''

    if (!notePath) {
      response.status(400).json({ error: 'The "path" query parameter is required.' })
      return
    }

    response.json(notesService.getNoteContext(notePath))
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : 'Unable to load note context.',
    })
  }
})

app.get('/api/weekly', async (_request: Request, response: Response) => {
  try {
    const content = await notesService.getWeeklyContent()
    response.json({ content })
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to read weekly log.',
    })
  }
})

app.get('/api/config', async (_request: Request, response: Response) => {
  response.json({
    ...notesService.getConfig(),
    copilot: await copilotService.getStatus(),
    auth: authStore.getStatus(true),
  })
})

app.post('/api/config', async (request: Request, response: Response) => {
  try {
    const config = await notesService.updateConfig(request.body)
    copilotService.clearSessions()
    response.json({
      ...config,
      copilot: await copilotService.getStatus(),
      auth: authStore.getStatus(true),
    })
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : 'Unable to update configuration.',
    })
  }
})

app.get('/api/dashboard', (_request: Request, response: Response) => {
  response.json(notesService.getDashboard())
})

app.get('/api/activity', (_request: Request, response: Response) => {
  response.json({
    items: notesService.getRecentActivity(),
  })
})

app.get('/api/history', (_request: Request, response: Response) => {
  response.json({
    items: notesService.getHistory(),
    lastUndo: notesService.getLastUndoSummary(),
  })
})

app.post('/api/reindex', async (_request: Request, response: Response) => {
  try {
    const config = await notesService.rebuildIndex()
    response.json({
      ...config,
      dashboard: notesService.getDashboard(),
    })
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to rebuild the index.',
    })
  }
})

app.post('/api/actions', async (request: Request, response: Response) => {
  try {
    const body = quickActionSchema.parse(request.body)
    const result = await notesService.runQuickAction(body)
    response.json({
      result,
      dashboard: notesService.getDashboard(),
    })
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : 'The requested action failed.',
    })
  }
})

app.post('/api/undo', async (_request: Request, response: Response) => {
  try {
    const result = await notesService.undoLastChange()
    response.json({
      result,
      dashboard: notesService.getDashboard(),
    })
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : 'Unable to undo the last change.',
    })
  }
})

app.post('/api/chat', async (request: Request, response: Response) => {
  if (notesService.getConfig().localOnlyMode) {
    response.status(409).json({
      error: 'Local-only mode is enabled. Chat is currently disabled.',
    })
    return
  }

  try {
    const result = await copilotService.chat(request.body)
    response.json(result)
  } catch (error) {
    response.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : 'The Copilot request failed unexpectedly.',
    })
  }
})

app.post('/api/email', async (request: Request, response: Response) => {
  if (notesService.getConfig().localOnlyMode) {
    response.status(409).json({
      error: 'Local-only mode is enabled. The email helper is currently disabled.',
    })
    return
  }

  try {
    const body = emailAssistSchema.parse(request.body)
    const result = await copilotService.improveEmail(body)
    response.json(result)
  } catch (error) {
    response.status(error instanceof z.ZodError ? 400 : 500).json({
      error:
        error instanceof Error
          ? error.message
          : 'The email helper request failed unexpectedly.',
    })
  }
})

app.post('/api/day-plan', async (request: Request, response: Response) => {
  if (notesService.getConfig().localOnlyMode) {
    response.status(409).json({
      error: 'Local-only mode is enabled. Daily planning is currently disabled.',
    })
    return
  }

  try {
    const body = dayPlanSchema.parse(request.body)
    const result = await copilotService.generateDayPlan(body)
    response.json(result)
  } catch (error) {
    response.status(error instanceof z.ZodError ? 400 : 500).json({
      error:
        error instanceof Error
          ? error.message
          : 'The daily planning request failed unexpectedly.',
    })
  }
})

app.post('/api/ticket-draft', async (request: Request, response: Response) => {
  if (notesService.getConfig().localOnlyMode) {
    response.status(409).json({
      error: 'Local-only mode is enabled. Ticket drafting is currently disabled.',
    })
    return
  }

  try {
    const body = ticketDraftSchema.parse(request.body)
    const result = await copilotService.draftTicket(body)
    response.json(result)
  } catch (error) {
    response.status(error instanceof z.ZodError ? 400 : 500).json({
      error:
        error instanceof Error
          ? error.message
          : 'The ticket drafting request failed unexpectedly.',
    })
  }
})

const server = app.listen(8787, '127.0.0.1', () => {
  console.log('Second Brain API listening on http://127.0.0.1:8787')
})

const shutdown = async () => {
  server.close()
  await copilotService.shutdown()
  await notesService.shutdown()
  process.exit(0)
}

process.on('SIGINT', () => {
  void shutdown()
})

process.on('SIGTERM', () => {
  void shutdown()
})
