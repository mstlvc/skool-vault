// Talks to skool.com through a real (hidden) Chromium window that shares the
// login session, so Skool's bot protection and auth behave like a normal visit.
import { BrowserWindow, session, Session } from 'electron'
import { createWriteStream, mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

export const BASE = 'https://www.skool.com'
export const PARTITION = 'persist:skool'

export const skoolSession = (): Session => session.fromPartition(PARTITION)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

import { deepFind, parseJson } from './util'
export { deepFind, parseJson }

export async function isLoggedIn(): Promise<boolean> {
  const cookies = await skoolSession().cookies.get({ domain: 'skool.com' })
  return cookies.some((c) => c.name === 'auth_token' && !!c.value)
}

export function openLoginWindow(parent?: BrowserWindow): Promise<boolean> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 520,
      height: 760,
      parent,
      modal: false,
      title: 'Log in to Skool',
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION }
    })
    let done = false
    const check = async () => {
      const url = win.webContents.getURL()
      if (done || /\/(login|signup)/.test(url)) return
      if (await isLoggedIn()) {
        done = true
        resolve(true)
        setTimeout(() => !win.isDestroyed() && win.close(), 600)
      }
    }
    win.webContents.on('did-navigate', check)
    win.webContents.on('did-navigate-in-page', check)
    win.on('closed', async () => {
      if (!done) resolve(await isLoggedIn())
    })
    win.loadURL(`${BASE}/login`)
  })
}

export async function logout() {
  await skoolSession().clearStorageData()
}

/** A single hidden browser tab. All calls are serialized. */
export class PageLoader {
  win: BrowserWindow
  mediaHits: string[] = []
  delayMs: number
  private chain: Promise<any> = Promise.resolve()
  private last = 0

  constructor(delayMs = 700) {
    this.delayMs = delayMs
    this.win = new BrowserWindow({
      show: false,
      width: 1366,
      height: 900,
      webPreferences: { partition: PARTITION, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' }
    })
    this.win.webContents.setAudioMuted(true)
    const ses = skoolSession()
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
      if (d.webContentsId === this.win.webContents.id && /\.(m3u8|mpd)(\?|$)/.test(d.url)) {
        this.mediaHits.push(d.url)
      }
      cb({})
    })
    this.captureApi()
    // Skool opens resource files with window.open; record the URL instead of opening a window.
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      this.openedUrls.push(url)
      return { action: 'deny' }
    })
  }

  /** API responses (api2.skool.com) the current page received, captured via the DevTools protocol. */
  apiResponses: { url: string; status: number; body: string }[] = []
  openedUrls: string[] = []

  private captureApi() {
    const dbg = this.win.webContents.debugger
    try {
      dbg.attach('1.3')
    } catch {
      return
    }
    const pending = new Map<string, { url: string; status: number }>()
    dbg.on('message', async (_e, method, params: any) => {
      if (method === 'Network.responseReceived' && /api2?\.skool\.com/.test(params.response?.url || '')) {
        pending.set(params.requestId, { url: params.response.url, status: params.response.status })
      } else if (method === 'Network.loadingFinished' && pending.has(params.requestId)) {
        const meta = pending.get(params.requestId)!
        pending.delete(params.requestId)
        try {
          const r: any = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
          const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body
          this.apiResponses.push({ ...meta, body })
          if (this.apiResponses.length > 200) this.apiResponses.shift()
        } catch {
          /* body no longer available */
        }
      }
    })
    dbg.sendCommand('Network.enable', { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 20_000_000 }).catch(() => {})
  }

  /** Wait (while owning the tab) for the page to receive an API response whose URL matches. */
  async waitForApi(re: RegExp, timeoutMs = 8000): Promise<{ url: string; status: number; body: string } | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = this.apiResponses.find((r) => re.test(r.url))
      if (hit) return hit
      await sleep(250)
    }
    return null
  }

  /**
   * Call Skool's API from inside the logged-in page, the way Skool's own client does
   * (session cookies + the AWS WAF integration's fetch). Call while owning the tab.
   */
  async apiInPage(path: string, method = 'GET'): Promise<{ status: number; text: string }> {
    const js = `(async () => {
      const opts = { method: ${JSON.stringify(method)}, credentials: 'include', headers: { 'content-type': 'application/json' } };
      let f = window.fetch.bind(window);
      try {
        if (window.AwsWafIntegration && window.AwsWafIntegration.fetch) {
          if (window.AwsWafIntegration.getToken) await window.AwsWafIntegration.getToken();
          f = window.AwsWafIntegration.fetch;
        }
      } catch (e) {}
      try {
        const r = await f('https://api2.skool.com' + ${JSON.stringify(path)}, opts);
        return { status: r.status, text: await r.text() };
      } catch (e) { return { status: 0, text: String(e) }; }
    })()`
    const r: { status: number; text: string } = await this.win.webContents.executeJavaScript(js).catch((e) => ({ status: 0, text: String(e) }))
    if (r.status === 429) {
      this.backoff('too many requests')
      await sleep(this.penalty)
    }
    return r
  }

  destroy() {
    skoolSession().webRequest.onBeforeRequest(null)
    if (!this.win.isDestroyed()) this.win.destroy()
  }

  /** Run `fn` exclusively (one page at a time). */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => {})
    return next
  }

  /** Load a Skool page and return its Next.js data. */
  nextData(url: string, tries = 3): Promise<any> {
    return this.run(() => this.loadNextData(url, tries))
  }

  /** Load a page, then let `extra` inspect it while we still own the tab. */
  withPage<T>(url: string, extra: (nd: any) => Promise<T>): Promise<T> {
    return this.run(async () => extra(await this.loadNextData(url, 3)))
  }

  /** Extra pause added when Skool pushes back (failed loads, 429s); shrinks again as loads succeed. */
  private penalty = 0
  /** Called when the loader slows down, so a running job can say so in its log. */
  onBackoff: ((msg: string) => void) | null = null

  backoff(reason: string) {
    this.penalty = Math.min(Math.max(this.penalty * 2, 3000), 30000)
    this.onBackoff?.(`Skool is pushing back (${reason}); pausing ${Math.round(this.penalty / 1000)}s between pages for a while`)
  }

  private async loadNextData(url: string, tries: number): Promise<any> {
    let lastErr: any
    for (let i = 0; i < tries; i++) {
      const wait = this.last + this.delayMs + this.penalty - Date.now()
      if (wait > 0) await sleep(wait)
      this.last = Date.now()
      this.mediaHits = []
      this.apiResponses = []
      this.openedUrls = []
      try {
        await this.win.loadURL(url).catch(() => {}) // redirects can reject; we poll below
        const deadline = Date.now() + 60000
        while (Date.now() < deadline) {
          const txt: string | null = await this.win.webContents
            .executeJavaScript(`document.getElementById('__NEXT_DATA__')?.textContent || null`)
            .catch(() => null)
          if (txt) {
            this.penalty = Math.max(0, this.penalty - 1000)
            return JSON.parse(txt)
          }
          await sleep(500)
        }
        throw new Error('page data not found (timeout)')
      } catch (e) {
        lastErr = e
        this.backoff('a page did not load')
      }
    }
    throw new Error(`Could not load ${url}: ${lastErr?.message || lastErr}`)
  }

  /** Inspect the rendered page for a video player / embeds. Call inside withPage. */
  async probeVideo(): Promise<string | null> {
    const js = `(() => {
      const out = [];
      for (const el of document.querySelectorAll('mux-player, mux-video')) {
        const id = el.getAttribute('playback-id') || el.playbackId;
        const tok = el.getAttribute('playback-token') || (el.tokens && el.tokens.playback);
        if (id) out.push('https://stream.mux.com/' + id + '.m3u8' + (tok ? '?token=' + tok : ''));
      }
      for (const f of document.querySelectorAll('iframe[src]')) {
        if (/youtube|youtu\\.be|vimeo|loom|wistia|vidyard|bunny|mediadelivery|streamable|drive\\.google/i.test(f.src)) out.push(f.src);
      }
      for (const v of document.querySelectorAll('video[src]')) if (/^https?:/.test(v.src)) out.push(v.src);
      return out;
    })()`
    const read = async () => (await this.win.webContents.executeJavaScript(js).catch(() => [])) as string[]
    let found = await read()
    if (!found.length && !this.mediaHits.length) {
      // Some players only load the stream after a click.
      await this.win.webContents
        .executeJavaScript(
          `(() => { const el = document.querySelector('mux-player, video, [class*="VideoPlayer"], [class*="video" i] img'); if (el) el.click(); })()`
        )
        .catch(() => {})
      await sleep(4000)
      found = await read()
    }
    const hits = [...found, ...this.mediaHits]
    hits.sort((a, b) => rank(a) - rank(b))
    return hits[0] || null
  }

  /**
   * Click the element showing `text` (a lesson resource) the way a user would, and save the file
   * however Skool delivers it: a browser download, a window.open(url), or a download-url API response.
   * Call while owning the tab.
   */
  async clickDownload(text: string, dest: string, timeoutMs = 20000): Promise<boolean> {
    const ses = skoolSession()
    const opened = this.openedUrls.length
    const dl: { started: boolean; state: string | null } = { started: false, state: null }
    const onDl = (_e: any, it: Electron.DownloadItem) => {
      dl.started = true
      mkdirSync(dirname(dest), { recursive: true })
      it.setSavePath(dest)
      it.once('done', (_ev, s) => (dl.state = s))
    }
    ses.on('will-download', onDl)
    try {
      const clicked = await this.win.webContents
        .executeJavaScript(
          `(() => { const t = ${JSON.stringify(text.trim())};
            const els = [...document.querySelectorAll('a, button, [role=button], div, span, p')].filter(e => e.textContent.trim() === t);
            const el = els[els.length - 1]; if (!el) return false;
            (el.closest('a, button, [role=button]') || el).click(); return true })()`
        )
        .catch(() => false)
      if (!clicked) return false
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (dl.started) {
          if (dl.state) return dl.state === 'completed'
        } else {
          const url =
            this.openedUrls.slice(opened).find((u) => /^https?:/.test(u)) ||
            urlFromApi(this.apiResponses.find((r) => /\/files\/[^/]+\/download-url/.test(r.url))?.body)
          if (url) {
            await fetchToFile(url, dest)
            return true
          }
        }
        await sleep(300)
      }
      return false
    } catch {
      return false
    } finally {
      ses.removeListener('will-download', onDl)
    }
  }
}

/** Pull a URL out of a download-url style API response ("https://…", "\"https://…\"" or {url: …}). */
export function urlFromApi(body?: string | null): string | null {
  if (!body) return null
  const t = body.trim().replace(/^"|"$/g, '')
  if (/^https?:\/\//.test(t)) return t
  const j = parseJson(body)
  if (j) for (const [, v] of deepFind(j, new Set(['url', 'download_url', 'downloadUrl', 'signed_url', 'link']))) if (typeof v === 'string' && /^https?:/.test(v)) return v
  return null
}

function rank(u: string) {
  // Mux master playlist (Skool serves Mux via stream.video.skool.com) beats rendition playlists
  if (/\/\/stream\.(video\.skool|mux)\.com\/[^/?]+\.m3u8/.test(u)) return 0
  if (/\.m3u8/.test(u)) return 2
  return 1
}

/** Download a URL using the Skool session's cookies. */
export async function fetchToFile(url: string, dest: string): Promise<void> {
  const res = await skoolSession().fetch(url, { headers: { Referer: BASE + '/' } })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  mkdirSync(dirname(dest), { recursive: true })
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest))
}

/** Call Skool's API (api2.skool.com) the way the web app does: Bearer token + WAF token headers. */
export async function fetchText(url: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; text: string }> {
  const cookies = await skoolSession().cookies.get({ domain: 'skool.com' })
  const get = (n: string) => cookies.find((c) => c.name === n)?.value
  const auth: Record<string, string> = {}
  if (get('auth_token')) auth.Authorization = `Bearer ${get('auth_token')}`
  if (get('aws-waf-token')) auth['x-aws-waf-token'] = get('aws-waf-token')!
  const res = await skoolSession().fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json, text/plain, */*',
      Referer: BASE + '/',
      Origin: BASE,
      ...auth,
      ...(init.method && init.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
      ...((init.headers as any) || {})
    },
    body: init.body ?? (init.method && init.method !== 'GET' ? '{}' : undefined)
  })
  return { ok: res.ok, status: res.status, text: await res.text() }
}

/** Netscape cookie file for yt-dlp (some embeds need the Skool session). */
export async function writeCookieFile(path: string) {
  const cookies = await skoolSession().cookies.get({})
  const lines = ['# Netscape HTTP Cookie File']
  for (const c of cookies) {
    const domain = c.domain || ''
    lines.push(
      [
        domain,
        domain.startsWith('.') ? 'TRUE' : 'FALSE',
        c.path || '/',
        c.secure ? 'TRUE' : 'FALSE',
        Math.floor(c.expirationDate || 0),
        c.name,
        c.value
      ].join('\t')
    )
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.join('\n') + '\n')
}
