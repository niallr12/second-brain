import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { APP_STATE_DIR } from './config-store'

const HISTORY_FILE = path.join(APP_STATE_DIR, 'history.json')
const MAX_HISTORY_ITEMS = 25

export interface FileSnapshot {
  path: string
  existed: boolean
  content: string
}

export interface HistoryEntry {
  id: string
  timestamp: string
  title: string
  detail: string
  paths: string[]
  snapshots: FileSnapshot[]
}

export class HistoryStore {
  private entries: HistoryEntry[] = []

  async initialize(): Promise<void> {
    try {
      const raw = await readFile(HISTORY_FILE, 'utf8')
      const parsed = JSON.parse(raw) as HistoryEntry[]
      this.entries = parsed.slice(0, MAX_HISTORY_ITEMS)
    } catch {
      this.entries = []
      await this.flush()
    }
  }

  list() {
    return [...this.entries]
  }

  peek() {
    return this.entries[0] ?? null
  }

  async record(entry: Omit<HistoryEntry, 'id' | 'timestamp'>) {
    const nextEntry: HistoryEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    }

    this.entries = [nextEntry, ...this.entries].slice(0, MAX_HISTORY_ITEMS)
    await this.flush()
    return nextEntry
  }

  async shift() {
    const [firstEntry, ...remainingEntries] = this.entries

    if (!firstEntry) {
      return null
    }

    this.entries = remainingEntries
    await this.flush()
    return firstEntry
  }

  private async flush() {
    await mkdir(APP_STATE_DIR, { recursive: true })
    await writeFile(HISTORY_FILE, `${JSON.stringify(this.entries, null, 2)}\n`, 'utf8')
  }
}
