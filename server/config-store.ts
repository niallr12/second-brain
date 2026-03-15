import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const APP_STATE_DIR = path.join(process.cwd(), '.second-brain')
const CONFIG_FILE = path.join(APP_STATE_DIR, 'config.json')

export interface AppConfig {
  notesPath: string
  model: string
  trustedMode: boolean
  localOnlyMode: boolean
}

const defaultConfig = (): AppConfig => ({
  notesPath: path.join(process.cwd(), 'sample-data', 'Notes'),
  model: 'gpt-5',
  trustedMode: false,
  localOnlyMode: false,
})

export class ConfigStore {
  async load(): Promise<AppConfig> {
    try {
      const raw = await readFile(CONFIG_FILE, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppConfig>
      return {
        notesPath: parsed.notesPath ?? defaultConfig().notesPath,
        model: parsed.model ?? defaultConfig().model,
        trustedMode: parsed.trustedMode ?? defaultConfig().trustedMode,
        localOnlyMode: parsed.localOnlyMode ?? defaultConfig().localOnlyMode,
      }
    } catch {
      const config = defaultConfig()
      await this.save(config)
      return config
    }
  }

  async save(config: AppConfig): Promise<void> {
    await mkdir(APP_STATE_DIR, { recursive: true })
    await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  }
}
