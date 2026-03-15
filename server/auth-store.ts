import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { APP_STATE_DIR } from './config-store'

const AUTH_FILE = path.join(APP_STATE_DIR, 'auth.json')

interface StoredAuthConfig {
  accessKey: string
}

export interface AuthStatus {
  required: true
  authenticated: boolean
  keySource: 'env' | 'file'
  prompt: string
}

export class AuthStore {
  private accessKey = ''
  private keySource: 'env' | 'file' = 'file'

  async initialize() {
    const envAccessKey = process.env.SECOND_BRAIN_ACCESS_KEY?.trim()

    if (envAccessKey) {
      this.accessKey = envAccessKey
      this.keySource = 'env'
      return
    }

    try {
      const raw = await readFile(AUTH_FILE, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StoredAuthConfig>

      if (!parsed.accessKey?.trim()) {
        throw new Error('Missing access key')
      }

      this.accessKey = parsed.accessKey.trim()
      this.keySource = 'file'
      await chmod(AUTH_FILE, 0o600).catch(() => undefined)
      return
    } catch {
      const accessKey = randomBytes(24).toString('base64url')
      await mkdir(APP_STATE_DIR, { recursive: true, mode: 0o700 })
      await writeFile(
        AUTH_FILE,
        `${JSON.stringify({ accessKey }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
      await chmod(AUTH_FILE, 0o600).catch(() => undefined)
      this.accessKey = accessKey
      this.keySource = 'file'
    }
  }

  verify(candidate?: string | null) {
    if (!candidate) {
      return false
    }

    const normalizedCandidate = candidate.trim()
    const expected = Buffer.from(this.accessKey, 'utf8')
    const actual = Buffer.from(normalizedCandidate, 'utf8')

    if (expected.length !== actual.length) {
      return false
    }

    return timingSafeEqual(expected, actual)
  }

  getStatus(authenticated: boolean): AuthStatus {
    const prompt =
      this.keySource === 'env'
        ? 'Enter the local access key configured in SECOND_BRAIN_ACCESS_KEY.'
        : `Enter the local access key stored in ${AUTH_FILE}.`

    return {
      required: true,
      authenticated,
      keySource: this.keySource,
      prompt,
    }
  }
}
