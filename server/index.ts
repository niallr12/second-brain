import express, { type Request, type Response } from 'express'
import { NotesService } from './notes-service'
import { CopilotService } from './copilot-service'

const notesService = new NotesService()
await notesService.initialize()

const copilotService = new CopilotService(notesService)
const app = express()

app.use(express.json({ limit: '2mb' }))

app.get('/api/health', async (_request: Request, response: Response) => {
  response.json({
    ok: true,
    notes: notesService.getConfig(),
    copilot: await copilotService.getStatus(),
  })
})

app.get('/api/config', async (_request: Request, response: Response) => {
  response.json({
    ...notesService.getConfig(),
    copilot: await copilotService.getStatus(),
  })
})

app.post('/api/config', async (request: Request, response: Response) => {
  try {
    const config = await notesService.updateConfig(request.body)
    response.json({
      ...config,
      copilot: await copilotService.getStatus(),
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

const server = app.listen(8787, () => {
  console.log('Second Brain API listening on http://localhost:8787')
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
