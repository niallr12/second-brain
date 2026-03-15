import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { APP_STATE_DIR } from './config-store'

const ACTIVITY_FILE = path.join(APP_STATE_DIR, 'activity.json')
const MAX_ACTIVITY_ITEMS = 50

export interface ActivityEntry {
  id: string
  timestamp: string
  kind: 'capture' | 'move' | 'complete' | 'project-update' | 'write' | 'config' | 'undo'
  title: string
  detail: string
  paths: string[]
}

export class ActivityStore {
  private entries: ActivityEntry[] = []

  async initialize(): Promise<void> {
    try {
      const raw = await readFile(ACTIVITY_FILE, 'utf8')
      const parsed = JSON.parse(raw) as ActivityEntry[]
      this.entries = parsed.slice(0, MAX_ACTIVITY_ITEMS)
    } catch {
      this.entries = []
      await this.flush()
    }
  }

  list() {
    return [...this.entries]
  }

  async record(entry: Omit<ActivityEntry, 'id' | 'timestamp'>) {
    const nextEntry: ActivityEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    }

    this.entries = [nextEntry, ...this.entries].slice(0, MAX_ACTIVITY_ITEMS)
    await this.flush()
    return nextEntry
  }

  private async flush() {
    await mkdir(APP_STATE_DIR, { recursive: true })
    await writeFile(ACTIVITY_FILE, `${JSON.stringify(this.entries, null, 2)}\n`, 'utf8')
  }
}
