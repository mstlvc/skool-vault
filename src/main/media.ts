// Video downloads: yt-dlp (best quality, any host) with an ffmpeg fallback for HLS.
import { app, net } from 'electron'
import { spawn, spawnSync, ChildProcess } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'fs'
import { join, basename } from 'path'
import { BASE, resolveVimeo } from './skool'
import { vimeoPlayerUrl } from './vimeo'
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

/**
 * A finished file yt-dlp refused to claim. The remuxer exits non-zero with
 * "already is in target format mp4" when the merge already wrote an mp4, and a
 * parallel fragment download can throw after that file is on disk.
 * `bad` means the file is present but too small or too short to keep.
 */
async function judgeVideo(r: DownloadReq): Promise<{ path: string | null; bad: boolean }> {
  const f = existingVideo(r.dir, r.stem)
  if (!f) return { path: null, bad: false }
  let size = 0
  try {
    size = statSync(f).size
  } catch {
    return { path: null, bad: false }
  }
  if (size < 64 * 1024) return { path: null, bad: true }
  const info = await probeVideo(f)
  if (!info) return { path: null, bad: false }
  if (!info.hasVideo || !(info.durationSec > 0.5)) return { path: null, bad: true }
  if (r.durationMs && r.durationMs >= 1000) {
    const expected = r.durationMs / 1000
    const short = info.durationSec < expected * 0.85 && Math.abs(info.durationSec - expected) > 3
    if (short) return { path: null, bad: true }
  }
  return { path: f, bad: false }
}

function probeVideo(file: string): Promise<{ durationSec: number; hasVideo: boolean } | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: { durationSec: number; hasVideo: boolean } | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(v)
    }
    const p = spawn(ffmpegPath(), ['-hide_banner', '-i', file], { windowsHide: true })
    const timer = setTimeout(() => {
      killTree(p)
      finish(null)
    }, 20000)
    let text = ''
    p.stderr.on('data', (b: Buffer) => {
      text += b.toString()
      if (text.length > 12000) text = text.slice(-12000)
    })
    p.on('error', () => finish(null))
    p.on('close', () => {
      const d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text)
      finish({
        durationSec: d ? +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]) : 0,
        hasVideo: /\bVideo:/.test(text)
      })
    })
  })
}

/** Drop half-finished yt-dlp pieces for this stem. A playable final video stays unless `dropFinal`. */
function clearFragments(dir: string, stem: string, dropFinal: boolean) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(stem + '.')) continue
    if (/\.vtt$/i.test(name)) continue
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
    if (!dropFinal && name === stem + ext && VIDEO_EXT.has(ext)) continue
    try {
      unlinkSync(join(dir, name))
    } catch {
      /* still open */
    }
  }
}

/** Download to dir/stem.<ext>; resolves with the final file path. */
export async function downloadVideo(r: DownloadReq): Promise<string> {
  mkdirSync(r.dir, { recursive: true })
  if (!/vimeo\.com/i.test(r.url)) return downloadFile(r)
  // The vimeo.com website has no player config, so yt-dlp asks for a Vimeo login.
  // The embed page on player.vimeo.com has the file. Read it here first; if that file
  // will not download, ask yt-dlp to open the player page itself.
  const player = vimeoPlayerUrl(r.url)
  const direct = await resolveVimeo(r.url, r.maxHeight).catch(() => null)
  if (direct) {
    r.log('using the embedded Vimeo file')
    try {
      return await downloadFile({ ...r, url: direct })
    } catch (e: any) {
      if (r.signal.aborted || !player) throw e
      r.log('embedded file failed; opening the Vimeo player')
      clearFragments(r.dir, r.stem, true)
    }
  }
  if (player) r = { ...r, url: player }
  return downloadFile(r)
}

async function downloadFile(r: DownloadReq): Promise<string> {
  const yt = await ensureYtDlp(r.log)
  let err = ''
  if (yt) {
    let fragments: number | undefined
    for (let pass = 0; pass < 2 && !r.signal.aborted; pass++) {
      try {
        await runYtDlp(yt, r, fragments)
        const f = existingVideo(r.dir, r.stem)
        if (f) return f
        err = 'yt-dlp finished but no file was written'
      } catch (e: any) {
        if (r.signal.aborted) throw e
        err = e.message
      }
      const judged = await judgeVideo(r)
      if (judged.path) return judged.path
      // Missing .part-Frag files are a yt-dlp race under parallel fragments. One-at-a-time avoids it.
      const retry = pass === 0 && (/part-Frag\d+/i.test(err) || /already is in target format/i.test(err))
      if (!retry) break
      r.log(/part-Frag\d+/i.test(err) ? 'a fragment file vanished; retrying one piece at a time' : 'retrying after a skipped remux')
      clearFragments(r.dir, r.stem, judged.bad)
      fragments = 1
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

/**
 * Stop a download process and everything it started. yt-dlp's packaged builds run as a launcher plus
 * a child process; ending only the launcher leaves the child downloading (and writing into a file
 * a resumed download would reuse).
 */
function killTree(p: ChildProcess) {
  if (!p.pid || p.exitCode !== null) return
  if (isWin) spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else {
    try {
      process.kill(-p.pid, 'SIGTERM') // the whole process group (started detached below)
    } catch {
      p.kill('SIGTERM')
    }
  }
}

/** Spawn options so killTree can reach every child: own process group outside Windows. */
const spawnOpts = { windowsHide: true, detached: !isWin } as const

function track(p: ChildProcess, signal: AbortSignal) {
  const kill = () => killTree(p)
  signal.addEventListener('abort', kill, { once: true })
  p.on('exit', () => signal.removeEventListener('abort', kill))
}

function runYtDlp(bin: string, r: DownloadReq, fragments?: number): Promise<void> {
  const fmt = r.maxHeight ? `bv*[height<=${r.maxHeight}]+ba/b[height<=${r.maxHeight}]/bv*+ba/b` : 'bv*+ba/b'
  const args = [
    '-f', fmt,
    '-S', 'res,fps,br',
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4',
    '--ffmpeg-location', ffmpegPath(),
    '--referer', /vimeocdn\.com/i.test(r.url) ? 'https://player.vimeo.com/' : BASE + '/',
    '--add-header', `Origin:${/vimeocdn\.com/i.test(r.url) ? 'https://player.vimeo.com' : BASE}`,
    '--concurrent-fragments', String(fragments ?? speedProfile().fragments),
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
    const p = spawn(bin, args, spawnOpts)
    track(p, r.signal)
    let note = ''
    let failure = ''
    const onLine = (buf: Buffer) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        const m = /\[download\]\s+([\d.]+)%.*?at\s+(\S+)/.exec(line)
        if (m) r.onProgress(parseFloat(m[1]), m[2])
        const t = line.trim()
        if (!t) continue
        // The remuxer prints "already is in target format" on stdout after a real ERROR on stderr.
        if (/^ERROR:/i.test(t)) failure = t.replace(/^ERROR:\s*/i, '')
        else note = t
      }
    }
    p.stdout.on('data', onLine)
    p.stderr.on('data', onLine)
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(r.signal.aborted ? 'cancelled' : failure || note || `yt-dlp exit ${code}`))))
  })
}

function runFfmpeg(r: DownloadReq): Promise<void> {
  const out = join(r.dir, `${r.stem}.mp4`)
  const tmp = join(r.dir, `${r.stem}.part.mp4`)
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-stats',
    '-headers', `Referer: ${/vimeocdn\.com/i.test(r.url) ? 'https://player.vimeo.com/' : BASE + '/'}\r\nOrigin: ${/vimeocdn\.com/i.test(r.url) ? 'https://player.vimeo.com' : BASE}\r\n`,
    '-i', r.url,
    '-map', '0:v:0?', '-map', '0:a:0?', // ffmpeg ranks the HLS variants; v:0 after sorting is the best
    '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart',
    tmp
  ]
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, spawnOpts)
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
