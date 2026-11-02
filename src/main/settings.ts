import { app } from 'electron'
import { randomBytes } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Settings, Speed } from '../shared/types'

const file = () => join(app.getPath('userData'), 'settings.json')
export const newAccessKey = () => randomBytes(18).toString('base64url')

/**
 * Download speed presets.
 * - pageDelayMs: pause between Skool page loads. The only part that hits Skool itself, so it stays
 *   one page at a time; shorter pauses are faster but more likely to get rate-limited.
 * - videos / fragments / assets: parallel downloads from CDNs (Mux, Skool's asset servers); safe to raise.
 * - posts: posts whose media is processed while the next page loads.
 */
export const SPEEDS: Record<Speed, { pageDelayMs: number; videos: number; fragments: number; assets: number; posts: number }> = {
  gentle: { pageDelayMs: 1200, videos: 2, fragments: 8, assets: 4, posts: 1 },
  normal: { pageDelayMs: 600, videos: 3, fragments: 12, assets: 6, posts: 3 },
  fast: { pageDelayMs: 250, videos: 5, fragments: 16, assets: 10, posts: 4 }
}
export const speedProfile = () => SPEEDS[getSettings().speed] || SPEEDS.normal

const defaults = (): Settings => ({
  libraryDir: join(app.getPath('documents'), 'Skool Vault'),
  port: 4777,
  lan: false,
  maxHeight: 0,
  speed: 'normal',
  accessKey: ''
})

let cache: Settings | null = null

export function getSettings(): Settings {
  if (cache) return cache
  let s = defaults()
  try {
    if (existsSync(file())) s = { ...s, ...JSON.parse(readFileSync(file(), 'utf8')) }
  } catch {
    /* fall back to defaults */
  }
  if (!SPEEDS[s.speed]) s.speed = 'normal'
  let generated = false
  if (!s.accessKey) {
    s.accessKey = newAccessKey()
    generated = true
  }
  // for testing against another library without changing saved settings
  if (process.env.SKOOL_VAULT_LIBRARY) s.libraryDir = process.env.SKOOL_VAULT_LIBRARY
  if (process.env.SKOOL_VAULT_PORT) s.port = Number(process.env.SKOOL_VAULT_PORT)
  mkdirSync(s.libraryDir, { recursive: true })
  cache = s
  if (generated) persist(s)
  return s
}

function persist(s: Settings) {
  const { libraryDir, port, lan, maxHeight, speed, accessKey } = s
  writeFileSync(file(), JSON.stringify({ libraryDir, port, lan, maxHeight, speed, accessKey }, null, 2))
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const s = { ...getSettings(), ...patch }
  s.port = Math.min(Math.max(Number(s.port) || 4777, 1024), 65535)
  if (!SPEEDS[s.speed]) s.speed = 'normal'
  if (!s.accessKey) s.accessKey = newAccessKey()
  mkdirSync(s.libraryDir, { recursive: true })
  persist(s)
  cache = s
  return s
}
