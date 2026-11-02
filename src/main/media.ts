// Video downloads: yt-dlp (best quality, any host) with an ffmpeg fallback for HLS.
import { app, net } from 'electron'
import { spawn, spawnSync, ChildProcess } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'fs'
import { join, basename } from 'path'
import { BASE } from './skool'
import { speedProfile } from './settings'

const isWin = process.platform === 'win32'

export function ffmpegPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p: string = require('ffmpeg-static')
    if (p) {
      const fixed = p.replace('app.asar', 'app.asar.unpacked')
      if (existsSync(fixed)) return fixed
    }
  } catch {
    /* not bundled */
  }
  return 'ffmpeg'
}

const binDir = () => join(app.getPath('userData'), 'bin')
const ytName = isWin ? 'yt-dlp.exe' : 'yt-dlp'
const ytAsset = isWin ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux'

let ytPromise: Promise<string | null> | null = null

/** Find or fetch the yt-dlp binary (official GitHub release), refreshed weekly. */
export function ensureYtDlp(log: (s: string) => void): Promise<string | null> {
  if (!ytPromise) ytPromise = locate(log).catch((e) => {
    log(`yt-dlp unavailable (${e.message}); falling back to ffmpeg for Skool videos`)
    ytPromise = null
    return null
  })
  return ytPromise
}

async function locate(log: (s: string) => void): Promise<string> {
  const local = join(binDir(), ytName)
  if (existsSync(local)) {
    const ageDays = (Date.now() - statSync(local).mtimeMs) / 864e5
    if (ageDays > 7) {
      // Keep extractors current; ignore failures.
      spawn(local, ['-U'], { stdio: 'ignore' }).on('exit', () => {
        try {
          const now = new Date()
          require('fs').utimesSync(local, now, now)
        } catch {
          /* ignore */
        }
      })
    }
    return local
  }
  const sys = spawnSync('yt-dlp', ['--version'], { encoding: 'utf8', shell: false })
  if (sys.status === 0) return 'yt-dlp'
  log('Downloading yt-dlp (first run only)...')
  const res = await net.fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytAsset}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  mkdirSync(binDir(), { recursive: true })
  writeFileSync(local, Buffer.from(await res.arrayBuffer()))
  if (!isWin) chmodSync(local, 0o755)
  return local
}

export interface DownloadReq {
  url: string
  dir: string
  stem: string // filename without extension
  maxHeight: number
  cookieFile?: string
  durationMs?: number | null
  onProgress: (pct: number, speed?: string) => void
  signal: AbortSignal
  log: (s: string) => void
}

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v'])

export function existingVideo(dir: string, stem: string): string | null {
  if (!existsSync(dir)) return null
  // exact "stem.ext" only, so partial/intermediate files (stem.part.mp4, stem.f137.mp4) don't count
  const f = readdirSync(dir).find((n) => {
    const ext = n.slice(n.lastIndexOf('.'))
    return n === stem + ext && VIDEO_EXT.has(ext.toLowerCase())
  })
  return f ? join(dir, f) : null
}

/** Download to dir/stem.<ext>; resolves with the final file path. */
export async function downloadVideo(r: DownloadReq): Promise<string> {
  mkdirSync(r.dir, { recursive: true })
  const yt = await ensureYtDlp(r.log)
  let err = ''
  if (yt) {
    try {
      await runYtDlp(yt, r)
      const f = existingVideo(r.dir, r.stem)
      if (f) return f
      err = 'yt-dlp finished but no file was written'
    } catch (e: any) {
      if (r.signal.aborted) throw e
      err = e.message
    }
  }
  if (/\.m3u8|\.mpd|\.mp4(\?|$)/.test(r.url)) {
    r.log(yt ? `yt-dlp failed (${err}); retrying with ffmpeg` : 'Downloading with ffmpeg')
    await runFfmpeg(r)
    const f = existingVideo(r.dir, r.stem)
    if (f) return f
  }
  throw new Error(err || 'download failed')
}

function track(p: ChildProcess, signal: AbortSignal) {
  const kill = () => p.kill()
  signal.addEventListener('abort', kill, { once: true })
  p.on('exit', () => signal.removeEventListener('abort', kill))
}

function runYtDlp(bin: string, r: DownloadReq): Promise<void> {
  const fmt = r.maxHeight ? `bv*[height<=${r.maxHeight}]+ba/b[height<=${r.maxHeight}]/bv*+ba/b` : 'bv*+ba/b'
  const args = [
    '-f', fmt,
    '-S', 'res,fps,br',
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4',
    '--ffmpeg-location', ffmpegPath(),
    '--referer', BASE + '/',
    '--add-header', `Origin:${BASE}`,
    '--concurrent-fragments', String(speedProfile().fragments),
    '--retries', '10',
    '--fragment-retries', '10',
    '--no-mtime',
    '--no-playlist',
    '--newline',
    '--no-colors',
    '--postprocessor-args', 'ffmpeg:-movflags +faststart',
    '--write-subs', '--sub-langs', 'en.*,en', '--convert-subs', 'vtt',
    '-o', join(r.dir, `${r.stem}.%(ext)s`)
  ]
  if (r.cookieFile && /skool\.com/.test(r.url)) args.push('--cookies', r.cookieFile)
  args.push(r.url)
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true })
    track(p, r.signal)
    let last = ''
    const onLine = (buf: Buffer) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        const m = /\[download\]\s+([\d.]+)%.*?at\s+(\S+)/.exec(line)
        if (m) r.onProgress(parseFloat(m[1]), m[2])
        else if (line.trim()) last = line.trim()
      }
    }
    p.stdout.on('data', onLine)
    p.stderr.on('data', onLine)
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(r.signal.aborted ? 'cancelled' : last || `yt-dlp exit ${code}`))))
  })
}

function runFfmpeg(r: DownloadReq): Promise<void> {
  const out = join(r.dir, `${r.stem}.mp4`)
  const tmp = join(r.dir, `${r.stem}.part.mp4`)
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-stats',
    '-headers', `Referer: ${BASE}/\r\nOrigin: ${BASE}\r\n`,
    '-i', r.url,
    '-map', '0:v:0?', '-map', '0:a:0?', // ffmpeg ranks the HLS variants; v:0 after sorting is the best
    '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart',
    tmp
  ]
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true })
    track(p, r.signal)
    let last = ''
    p.stderr.on('data', (b: Buffer) => {
      const s = b.toString()
      const m = /time=(\d+):(\d+):([\d.]+)/.exec(s)
      if (m && r.durationMs) {
        const sec = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])
        r.onProgress(Math.min(99.9, (sec * 100000) / r.durationMs))
      }
      if (s.trim()) last = s.trim().split('\n').pop()!
    })
    p.on('error', reject)
    p.on('exit', (code) => {
      if (code === 0) {
        try {
          require('fs').renameSync(tmp, out)
          return resolve()
        } catch (e) {
          return reject(e)
        }
      }
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      reject(new Error(last || `ffmpeg exit ${code}`))
    })
  })
}

/** Subtitles yt-dlp saved next to the video (stem.en.vtt etc). */
export function existingCaptions(dir: string, stem: string): string | null {
  if (!existsSync(dir)) return null
  const f = readdirSync(dir).find((n) => n.startsWith(stem + '.') && n.toLowerCase().endsWith('.vtt'))
  return f ? join(dir, f) : null
}

export const fileLabel = (p: string) => basename(p)
