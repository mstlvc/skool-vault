// Disposable data: Chromium's cache, and half-finished yt-dlp pieces. Saved videos are never touched.
import { execFileSync } from 'child_process'
import { readdirSync, rmSync, statSync, unlinkSync } from 'fs'
import { join, extname } from 'path'
import { app, session } from 'electron'
import { hasActiveAccount } from './accounts'
import { skoolSession } from './skool'
import { getSettings } from './settings'
import type { TempClearResult, TempUsage } from '../shared/types'

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v'])

/** Cache folders Chromium recreates. Cookies and the login stay in Network and Local Storage. */
const CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'Partitions/skool/Cache',
  'Partitions/skool/Code Cache',
  'Partitions/skool/GPUCache',
  'Partitions/skool/DawnGraphiteCache',
  'Partitions/skool/DawnWebGPUCache',
  'Partitions/skool/Service Worker/CacheStorage'
]

/** Unfinished download pieces. A finished "Part 1.mp4" does not match. */
export function isDownloadLeftover(name: string): boolean {
  return /\.ytdl$/i.test(name) || /\.json\.tmp$/i.test(name) || /\.part(-Frag\d+)?$/i.test(name)
}

function dirSize(root: string): number {
  let n = 0
  const walk = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) {
        try {
          n += statSync(p).size
        } catch {
          /* gone */
        }
      }
    }
  }
  walk(root)
  return n
}

function ytDlpRunning(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq yt-dlp.exe', '/NH'], { encoding: 'utf8', windowsHide: true })
    return /yt-dlp\.exe/i.test(out)
  } catch {
    return false
  }
}

export function tempUsage(): TempUsage {
  const libraryDir = getSettings().libraryDir
  const userData = app.getPath('userData')
  let libraryBytes = 0
  let videoBytes = 0
  let leftoverBytes = 0
  const walk = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) {
        let size = 0
        try {
          size = statSync(p).size
        } catch {
          continue
        }
        libraryBytes += size
        if (VIDEO_EXT.has(extname(e.name).toLowerCase())) videoBytes += size
        if (isDownloadLeftover(e.name)) leftoverBytes += size
      }
    }
  }
  walk(libraryDir)
  const cacheBytes = CACHE_DIRS.reduce((n, rel) => n + dirSize(join(userData, rel)), 0)
  return { libraryBytes, videoBytes, cacheBytes, leftoverBytes }
}

function rmQuiet(path: string) {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    /* still in use */
  }
}

function deleteLeftovers(libraryDir: string): number {
  let freed = 0
  const walk = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && isDownloadLeftover(e.name)) {
        try {
          const size = statSync(p).size
          unlinkSync(p)
          freed += size
        } catch {
          /* the download still has this file open */
        }
      }
    }
  }
  walk(libraryDir)
  return freed
}

/** Clear the browser cache and, when nothing is downloading, unfinished video pieces. */
export async function clearTemporary(downloading: boolean): Promise<TempClearResult> {
  const before = tempUsage()
  const keepLeftovers = downloading || ytDlpRunning()
  const clears: Promise<unknown>[] = [session.defaultSession.clearCache(), session.defaultSession.clearCodeCaches({})]
  if (hasActiveAccount()) clears.push(skoolSession().clearCache(), skoolSession().clearCodeCaches({}))
  await Promise.all(clears)
  const userData = app.getPath('userData')
  for (const rel of CACHE_DIRS) rmQuiet(join(userData, rel))
  if (!keepLeftovers) deleteLeftovers(getSettings().libraryDir)
  const after = tempUsage()
  const freedBytes = Math.max(0, before.cacheBytes + before.leftoverBytes - (after.cacheBytes + after.leftoverBytes))
  return { ...after, freedBytes, keptLeftovers: keepLeftovers && before.leftoverBytes > 0 }
}
