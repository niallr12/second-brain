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
    const result = await notesService.runQuickAction(request.body)
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
