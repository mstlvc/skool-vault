// Local web server: serves the viewer, the archive JSON and media files
// (with HTTP Range support so videos can seek).
import { timingSafeEqual } from 'crypto'
import { createReadStream, existsSync, statSync } from 'fs'
import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import { networkInterfaces } from 'os'
import { extname, join, normalize, sep } from 'path'
import { groupDir, listLibrary, loadGroup } from './archive'
import { getSettings } from './settings'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}

let server: Server | null = null
let rendererDir = ''

/** Resolve `rel` inside `root`, refusing anything that escapes it. */
function inside(root: string, rel: string): string | null {
  const p = normalize(join(root, decodeURIComponent(rel)))
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep) ? p : null
}

function sendJson(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

function sendFile(req: IncomingMessage, res: ServerResponse, path: string, download = false) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404)
    return res.end('Not found')
  }
  const size = statSync(path).size
  const headers: Record<string, string | number> = {
    'Content-Type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600'
  }
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.split(sep).pop()!)}`
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '')
  if (range) {
    let start = range[1] ? parseInt(range[1]) : size - parseInt(range[2])
    let end = range[1] && range[2] ? parseInt(range[2]) : size - 1
    start = Math.max(0, start)
    end = Math.min(end, size - 1)
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      return res.end()
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    if (req.method === 'HEAD') return res.end()
    return createReadStream(path, { start, end }).pipe(res)
  }
  res.writeHead(200, { ...headers, 'Content-Length': size })
  if (req.method === 'HEAD') return res.end()
  createReadStream(path).pipe(res)
}

// ---------------------------------------------------------------- access key
// This PC opens the viewer freely. Any other device (phone on Wi-Fi, the internet tunnel)
// needs the access key: once via ?k=<key> in the link, then a cookie.

/** A request from this PC itself (not via the tunnel, which also connects from localhost). */
function fromThisPC(req: IncomingMessage) {
  const ra = req.socket.remoteAddress || ''
  const loopback = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1'
  const host = String(req.headers.host || '').replace(/:\d+$/, '')
  return loopback && (host === '127.0.0.1' || host === 'localhost') && !req.headers['cf-connecting-ip']
}

const sameKey = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const cookieKey = (req: IncomingMessage) => /(?:^|;\s*)sv_key=([^;]+)/.exec(String(req.headers.cookie || ''))?.[1] || ''

/** Returns true when the request may continue; otherwise it has already answered. */
function checkAccess(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (fromThisPC(req)) return true
  const key = getSettings().accessKey
  const k = url.searchParams.get('k')
  if (k && sameKey(k, key)) {
    url.searchParams.delete('k')
    const secure = req.headers['x-forwarded-proto'] === 'https' || !!req.headers['cf-connecting-ip']
    res.writeHead(302, {
      Location: url.pathname + (url.searchParams.size ? `?${url.searchParams}` : ''),
      'Set-Cookie': `sv_key=${key}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
      'Cache-Control': 'no-store'
    })
    res.end()
    return false
  }
  if (sameKey(cookieKey(req), key)) return true
  res.writeHead(401, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Locked</title>
<body style="font:16px/1.5 system-ui,sans-serif;background:#f7f8f9;color:#1e2a38;display:grid;place-items:center;min-height:90vh;margin:0;padding:24px">
<div style="max-width:24rem"><h1 style="font-size:1.4rem;margin:0 0 .5rem">This link is locked</h1>
<p style="margin:0;color:#6b7a89">Open the full link from Skool Vault on your PC (Library, then On your phone), or scan its QR code.</p></div>`)
  return false
}

function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', 'http://x')
  if (fromThisPC(req)) res.setHeader('Access-Control-Allow-Origin', '*') // lets the dev viewer (vite) call us
  if (!checkAccess(req, res, url)) return
  const path = url.pathname
  try {
    if (path === '/api/library') return sendJson(res, listLibrary())
    let m = /^\/api\/group\/([^/]+)$/.exec(path)
    if (m) {
      const g = loadGroup(decodeURIComponent(m[1]))
      return g ? sendJson(res, g) : sendJson(res, { error: 'not found' }, 404)
    }
    m = /^\/archive\/([^/]+)\/(.+)$/.exec(path)
    if (m) {
      const root = groupDir(decodeURIComponent(m[1]))
      const file = inside(root, m[2])
      if (!file || /(^|[\\/])(\.cookies\.txt|raw)([\\/]|$)/.test(m[2])) {
        res.writeHead(403)
        return res.end()
      }
      return sendFile(req, res, file, url.searchParams.has('download'))
    }
    // viewer (built renderer)
    if (path === '/' || path === '/index.html') {
      res.writeHead(302, { Location: '/viewer.html' })
      return res.end()
    }
    const file = inside(rendererDir, path.slice(1))
    if (file && existsSync(file) && statSync(file).isFile()) return sendFile(req, res, file)
    return sendFile(req, res, join(rendererDir, 'viewer.html'))
  } catch (e: any) {
    sendJson(res, { error: e.message }, 500)
  }
}

export function startServer(dir: string): Promise<number> {
  rendererDir = dir
  const { port, lan } = getSettings()
  return new Promise((resolve, reject) => {
    const s = createServer(handle)
    s.on('error', (e: any) => {
      if (e.code === 'EADDRINUSE') {
        // try the next port
        s.listen(0, lan ? '0.0.0.0' : '127.0.0.1')
      } else reject(e)
    })
    s.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
      server = s
      resolve((s.address() as any).port)
    })
  })
}

export async function restartServer(dir: string): Promise<number> {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
  return startServer(dir)
}

export function serverPort(): number {
  return (server?.address() as any)?.port || 0
}

export function lanUrls(): string[] {
  const port = serverPort()
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i!.address}:${port}/?k=${getSettings().accessKey}`)
}
