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

app.post('/api/chat', async (request: Request, response: Response) => {
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
