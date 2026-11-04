// Talks to skool.com through a real (hidden) Chromium window that shares the
// login session, so Skool's bot protection and auth behave like a normal visit.
import { BrowserWindow, session, Session, shell } from 'electron'
import { createWriteStream, mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { activeFingerprint, activePartition, bindSession, hasActiveAccount } from './accounts'
import { deviceMetrics, userAgentOverride } from './fingerprint'
import { vimeoPlayerUrl, vimeoStreamFromHtml } from './vimeo'

export const BASE = 'https://www.skool.com'

export const skoolSession = (): Session => {
  const ses = session.fromPartition(activePartition())
  bindSession(ses)
  return ses
}

/** User agent, client hints, screen size, and CPU count for the account that owns this window. */
export async function prepareSkoolWindow(win: BrowserWindow) {
  const fp = activeFingerprint()
  bindSession(win.webContents.session, fp)
  win.webContents.setUserAgent(fp.ua)
  const dbg = win.webContents.debugger
  try {
    if (!dbg.isAttached()) dbg.attach('1.3')
  } catch {
    /* already attached */
  }
  if (!dbg.isAttached() || win.isDestroyed()) return
  // These commands never reply until the window has a document, so give it one first.
  if (!win.webContents.getURL()) await win.loadURL('about:blank').catch(() => {})
  if (win.isDestroyed() || !dbg.isAttached()) return
  const [width, height] = win.getContentSize()
  const send = (method: string, params: object) =>
    withTimeout(dbg.sendCommand(method, params).then(() => undefined), 5000, undefined)
  await send('Emulation.setUserAgentOverride', userAgentOverride(fp))
  await send('Emulation.setDeviceMetricsOverride', deviceMetrics(fp, width || 1366, height || 768))
  await send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: fp.hardwareConcurrency })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Resolve with `fallback` if `p` hasn't settled within `ms` (so nothing can hang a download forever). */
export function withTimeout<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: NodeJS.Timeout
  return Promise.race([p, new Promise<F>((r) => (timer = setTimeout(() => r(fallback), ms)))]).finally(() => clearTimeout(timer))
}

import { deepFind, parseJson } from './util'
export { deepFind, parseJson }

export async function isLoggedIn(): Promise<boolean> {
  if (!hasActiveAccount()) return false
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
      webPreferences: { partition: activePartition() }
    })
    let done = false
    const check = async () => {
      const url = win.webContents.getURL()
      if (done || win.isDestroyed() || !url || url === 'about:blank' || /\/(login|signup)/.test(url)) return
      const cookies = await win.webContents.session.cookies.get({ domain: 'skool.com' })
      if (cookies.some((c) => c.name === 'auth_token' && !!c.value)) {
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
    void prepareSkoolWindow(win).finally(() => {
      if (!win.isDestroyed()) win.loadURL(`${BASE}/login`)
    })
  })
}

export async function logout() {
  await skoolSession().clearStorageData()
}

const skoolHost = (url: string) => {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && (u.hostname === 'skool.com' || u.hostname.endsWith('.skool.com'))
  } catch {
    return false
  }
}

let skoolBrowser: BrowserWindow | null = null

function wireSkoolWindow(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (skoolHost(url)) {
      const popup = new BrowserWindow({
        width: 980,
        height: 760,
        title: 'Skool',
        autoHideMenuBar: true,
        webPreferences: { partition: activePartition() }
      })
      wireSkoolWindow(popup)
      void prepareSkoolWindow(popup).finally(() => {
        if (!popup.isDestroyed()) popup.loadURL(url)
      })
    } else if (/^https?:/i.test(url)) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })
}

/**
 * A visible Skool window on the saved login. One window is reused; popups stay on the same login.
 * With no url, an open window is just focused.
 */
export function closeSkoolWindow() {
  if (skoolBrowser && !skoolBrowser.isDestroyed()) skoolBrowser.destroy()
  skoolBrowser = null
}

export function openSkoolWindow(url?: string) {
  const go = url && skoolHost(url) ? url : undefined
  let win = skoolBrowser
  const created = !win || win.isDestroyed()
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      width: 1280,
      height: 900,
      title: 'Skool',
      autoHideMenuBar: true,
      webPreferences: { partition: activePartition() }
    })
    skoolBrowser = win
    win.on('closed', () => {
      if (skoolBrowser === win) skoolBrowser = null
    })
    wireSkoolWindow(win)
  } else {
    win.show()
    win.focus()
  }
  if (created || go) {
    const target = go || `${BASE}/`
    void prepareSkoolWindow(win).finally(() => {
      if (!win.isDestroyed()) win.loadURL(target)
    })
  }
}

/**
 * A page that already finished without __NEXT_DATA__ will not grow it.
 * A blank navigation is retried; a document that is still loading keeps waiting.
 */
export function pageAttemptDecision(s: {
  href: string
  ready: string
  hasData: boolean
  elapsedMs: number
  completeForMs: number
  /** CloudFront's refusal page. It will not grow into lesson data. */
  blocked?: boolean
}): 'data' | 'retry' | 'wait' {
  if (s.hasData && /^https?:/i.test(s.href)) return 'data'
  const blank = s.href === '' || s.href === 'about:blank'
  if (blank && s.elapsedMs >= 15000) return 'retry'
  if (s.blocked && !blank && s.ready === 'complete' && s.completeForMs >= 1000) return 'retry'
  if (!blank && s.ready === 'complete' && s.completeForMs >= 12000) return 'retry'
  return 'wait'
}

export function cloudFrontBlock(title: string): boolean {
  return /request could not be satisfied/i.test(title)
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
      webPreferences: { partition: activePartition(), backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' }
    })
    this.win.webContents.setUserAgent(activeFingerprint().ua)
    this.win.webContents.setAudioMuted(true)
    const ses = skoolSession()
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
      if (d.webContentsId === this.win.webContents.id && /\.(m3u8|mpd)(\?|$)/.test(d.url)) {
        this.mediaHits.push(d.url)
      }
      cb({})
    })
    // Page loads wait on this chain, so network capture is on before the first navigation.
    this.chain = this.captureApi()
    // Skool opens resource files with window.open; record the URL instead of opening a window.
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      this.openedUrls.push(url)
      return { action: 'deny' }
    })
  }

  /** API responses (api2.skool.com) the current page received, captured via the DevTools protocol. */
  apiResponses: { url: string; status: number; body: string }[] = []
  openedUrls: string[] = []

  private captureApi(): Promise<void> {
    const dbg = this.win.webContents.debugger
    return prepareSkoolWindow(this.win)
      .catch(() => {})
      .then(() => {
        if (this.win.isDestroyed()) return
        if (!dbg.isAttached()) {
          try {
            dbg.attach('1.3')
          } catch {
            /* prepareSkoolWindow may already have attached */
          }
        }
        if (!dbg.isAttached()) return
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
        return withTimeout(dbg.sendCommand('Network.enable', { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 20_000_000 }).then(() => undefined), 5000, undefined)
      })
      .catch(() => {})
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
  async apiInPage(path: string, method = 'GET', headers?: Record<string, string>): Promise<{ status: number; text: string }> {
    // Every step has a time limit: one stuck request must never freeze the whole download.
    const extra = JSON.stringify(headers || {})
    const js = `(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      const opts = { method: ${JSON.stringify(method)}, credentials: 'include', headers: Object.assign({ 'content-type': 'application/json' }, ${extra}), signal: ctrl.signal };
      const plain = window.fetch.bind(window);
      let f = plain;
      let waf = false;
      try {
        const wafFetch = window.AwsWafIntegration && window.AwsWafIntegration.fetch;
        const getToken = window.AwsWafIntegration && window.AwsWafIntegration.getToken;
        // Skool uses the WAF fetch only when getToken() returns a token. Using it otherwise drops the session cookie.
        if (wafFetch && getToken) {
          const token = await Promise.race([getToken(), new Promise((r) => setTimeout(() => r(false), 8000))]);
          if (token) { f = wafFetch; waf = true; }
        }
      } catch (e) {}
      const call = async (fn) => {
        const r = await fn('https://api2.skool.com' + ${JSON.stringify(path)}, opts);
        return { status: r.status, text: await r.text() };
      };
      try {
        const first = await call(f);
        if (first.status === 401 && waf) return await call(plain);
        return first;
      } catch (e) { return { status: 0, text: String(e) }; }
      finally { clearTimeout(timer); }
    })()`
    const r: { status: number; text: string } = await withTimeout(
      this.win.webContents.executeJavaScript(js),
      35000,
      { status: 0, text: 'Skool did not answer in time' }
    ).catch((e) => ({ status: 0, text: String(e) }))
    if (r.status === 429) {
      this.backoff('too many requests')
      await sleep(this.penalty)
    }
    return r
  }

  /** The one-shot `x-sk-sec` value Skool embedded in this page. Empty when the page has none. */
  async pageSecurityNonce(): Promise<string> {
    const js = `(() => { try { const s = window.__NEXT_DATA__ && window.__NEXT_DATA__.props && window.__NEXT_DATA__.props.pageProps && window.__NEXT_DATA__.props.pageProps.securityNonce; return typeof s === 'string' ? s : ''; } catch (e) { return ''; } })()`
    const s = await withTimeout(this.win.webContents.executeJavaScript(js), 5000, '').catch(() => '')
    return typeof s === 'string' ? s : ''
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
  nextData(url: string, tries = 5): Promise<any> {
    return this.run(() => this.loadNextData(url, tries))
  }

  /** Load a page, then let `extra` inspect it while we still own the tab. */
  withPage<T>(url: string, extra: (nd: any) => Promise<T>, tries = 5): Promise<T> {
    return this.run(async () => extra(await this.loadNextData(url, tries)))
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
        if (this.win.isDestroyed()) throw new Error('page closed')
        // A retry skips a cached copy of the page that never rendered.
        const opts = i > 0 ? { extraHeaders: 'Cache-Control: no-cache\r\nPragma: no-cache\r\n' } : undefined
        // redirects can reject, and some pages never report "finished loading": either way we poll below
        await withTimeout(this.win.loadURL(url, opts).catch(() => {}), 45000, undefined)
        const started = Date.now()
        const deadline = started + 60000
        let completeSince = 0
        let title = ''
        const read = `(() => ({ d: document.getElementById('__NEXT_DATA__')?.textContent || '', r: document.readyState, t: document.title || '' }))()`
        while (Date.now() < deadline) {
          if (this.win.isDestroyed()) throw new Error('page closed')
          const snap = await withTimeout(this.win.webContents.executeJavaScript(read), 8000, null).catch(() => null)
          const ready = typeof snap?.r === 'string' ? snap.r : ''
          const data = typeof snap?.d === 'string' ? snap.d : ''
          if (ready === 'complete') {
            if (!completeSince) completeSince = Date.now()
          } else completeSince = 0
          if (typeof snap?.t === 'string') title = snap.t.replace(/\s+/g, ' ').trim().slice(0, 80)
          let href = ''
          try {
            href = this.win.webContents.getURL()
          } catch {
            href = ''
          }
          const decision = pageAttemptDecision({
            href,
            ready,
            hasData: data.length > 0,
            elapsedMs: Date.now() - started,
            completeForMs: completeSince ? Date.now() - completeSince : 0,
            blocked: cloudFrontBlock(title)
          })
          if (decision === 'data') {
            this.penalty = Math.max(0, this.penalty - 1000)
            return JSON.parse(data)
          }
          if (decision === 'retry') break
          await sleep(500)
        }
        throw new Error(title ? `page data not found (timeout, "${title}")` : 'page data not found (timeout)')
      } catch (e) {
        lastErr = e
        if (i >= tries - 1) break
        this.backoff(`a page did not load, retry ${i + 2}/${tries}`)
        // A stuck navigation keeps the next try from rendering. Drop it before retrying.
        await this.recoverPage()
      }
    }
    throw new Error(`Could not load ${url}: ${lastErr?.message || lastErr}`)
  }

  /** Stop a hung load so the next attempt starts from a blank page. */
  private async recoverPage() {
    if (this.win.isDestroyed()) return
    try {
      this.win.webContents.stop()
    } catch {
      /* already stopped */
    }
    await withTimeout(this.win.loadURL('about:blank').catch(() => {}), 10000, undefined)
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
    // Loom's player loads a signed, video-only, single-quality stream; the share link gets the real video
    const hits = [...found, ...this.mediaHits].map((u) => loomShareUrl(u) || u)
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

/**
 * The Loom share link for any Loom address that carries the video id:
 * player streams (luna.loom.com/id/<id>/...), thumbnails (cdn.loom.com/sessions/thumbnails/<id>-...),
 * embeds and share links. yt-dlp turns the share link into the best-quality video with audio.
 */
export function loomShareUrl(u: unknown): string | null {
  const s = String(u || '')
  const m =
    /\/\/luna\.loom\.com\/id\/([0-9a-f]{32})\b/i.exec(s) ||
    /\/\/cdn\.loom\.com\/sessions\/(?:thumbnails|raw)\/([0-9a-f]{32})\b/i.exec(s) ||
    /\/\/(?:www\.)?loom\.com\/(?:share|embed)\/([0-9a-f]{32})\b/i.exec(s)
  return m ? `https://www.loom.com/share/${m[1].toLowerCase()}` : null
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

/**
 * Call Skool's API (api2.skool.com).
 * `bearer` is the file-download fallback. `cookie` sends the session cookie and no Authorization
 * header, because api2 answers 401 "not logged in" when a Bearer header is present.
 */
export async function fetchText(url: string, init: RequestInit = {}, authMode: 'bearer' | 'cookie' = 'bearer'): Promise<{ ok: boolean; status: number; text: string }> {
  const listed = await skoolSession().cookies.get(authMode === 'cookie' ? { url } : { domain: 'skool.com' })
  const host = new URL(url).hostname
  const hasAuth = (list: { name: string; value: string }[]) => list.some((c) => c.name === 'auth_token' && c.value)
  const cookies =
    authMode === 'cookie' && !hasAuth(listed)
      ? (await skoolSession().cookies.get({ domain: 'skool.com' })).filter((c) => {
          const d = (c.domain || '').replace(/^\./, '')
          return host === d || host.endsWith('.' + d)
        })
      : listed
  const get = (n: string) => cookies.find((c) => c.name === n)?.value
  const auth: Record<string, string> = {}
  if (authMode === 'cookie') {
    const jar = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    if (jar) auth.Cookie = jar
  } else if (get('auth_token')) auth.Authorization = `Bearer ${get('auth_token')}`
  if (get('aws-waf-token')) auth['x-aws-waf-token'] = get('aws-waf-token')!
  const res = await skoolSession().fetch(url, {
    ...init,
    credentials: authMode === 'cookie' ? 'include' : init.credentials,
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

/**
 * Vimeo file address for an embed, read by this app's browser.
 * yt-dlp's website client asks for a Vimeo login, and its impersonation is refused on a VPN.
 */
export async function resolveVimeo(url: string, maxHeight = 0): Promise<string | null> {
  const player = vimeoPlayerUrl(url)
  if (!player) return null
  const res = await skoolSession().fetch(player, {
    headers: { Referer: BASE + '/', Accept: 'text/html,application/xhtml+xml' }
  })
  if (!res.ok) return null
  return vimeoStreamFromHtml(await res.text(), maxHeight)
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
