// "On your phone": a temporary public link to the viewer via a Cloudflare quick tunnel
// (https://<random>.trycloudflare.com, no account needed). The link carries the access key,
// so the server only lets in devices that were given it.
import { app, net } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import QRCode from 'qrcode'
import type { RemoteState } from '../shared/types'
import { getSettings } from './settings'
import { lanUrls, serverPort } from './server'

const binDir = () => join(app.getPath('userData'), 'bin')
const isWin = process.platform === 'win32'
const exe = () => join(binDir(), isWin ? 'cloudflared.exe' : 'cloudflared')

let proc: ChildProcess | null = null
let state: RemoteState = { status: 'off' }
let listener: ((s: RemoteState) => void) | null = null

export const onRemoteChange = (fn: (s: RemoteState) => void) => (listener = fn)
const set = (s: RemoteState) => {
  state = s
  listener?.(s)
}

const qr = (text: string) =>
  QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#1e2a38', light: '#ffffff' } })

/** Current sharing state, including the Wi-Fi links when Wi-Fi sharing is on. */
export async function remoteState(): Promise<RemoteState> {
  const lan = getSettings().lan ? lanUrls() : []
  if (state.status === 'on' || state.status === 'starting' || state.status === 'error') return { ...state, lanUrls: lan }
  return { status: 'off', lanUrls: lan, qr: lan[0] ? await qr(lan[0]) : undefined }
}

/** Official cloudflared release from GitHub, downloaded once into the app's data folder. */
async function ensureCloudflared(): Promise<string> {
  if (existsSync(exe())) return exe()
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const asset =
    process.platform === 'win32'
      ? `cloudflared-windows-${arch}.exe`
      : process.platform === 'darwin'
        ? `cloudflared-darwin-${arch}.tgz`
        : `cloudflared-linux-${arch}`
  const res = await net.fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`)
  if (!res.ok) throw new Error(`couldn't download cloudflared (HTTP ${res.status})`)
  mkdirSync(binDir(), { recursive: true })
  const buf = Buffer.from(await res.arrayBuffer())
  if (asset.endsWith('.tgz')) {
    const tgz = join(binDir(), asset)
    writeFileSync(tgz, buf)
    await new Promise<void>((ok, fail) =>
      spawn('tar', ['-xzf', tgz, '-C', binDir()]).on('exit', (c) => (c === 0 ? ok() : fail(new Error('could not unpack cloudflared'))))
    )
    rmSync(tgz, { force: true })
  } else writeFileSync(exe(), buf)
  if (!isWin) chmodSync(exe(), 0o755)
  return exe()
}

export async function startRemote(): Promise<RemoteState> {
  if (proc) return remoteState()
  set({ status: 'starting' })
  try {
    const bin = await ensureCloudflared()
    const port = serverPort()
    const p = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { windowsHide: true })
    proc = p
    const url = await new Promise<string>((resolve, reject) => {
      let found = ''
      let lastLine = ''
      const timer = setTimeout(() => reject(new Error(lastLine || 'Cloudflare did not answer in time')), 60000)
      const onData = (b: Buffer) => {
        for (const line of b.toString().split(/\r?\n/)) {
          if (line.trim()) lastLine = line.replace(/^\S+\s+(INF|ERR|WRN)\s+/, '').trim()
          const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line)
          if (m && !found) found = m[0]
          // the address is printed first; it works once a connection is registered
          if (found && /Registered tunnel connection/i.test(line)) {
            clearTimeout(timer)
            resolve(found)
          }
        }
      }
      p.stdout?.on('data', onData)
      p.stderr?.on('data', onData)
      p.on('exit', () => {
        clearTimeout(timer)
        reject(new Error(lastLine || 'cloudflared stopped'))
      })
    })
    const link = `${url}/?k=${getSettings().accessKey}`
    set({ status: 'on', url: link, qr: await qr(link) })
    // if the tunnel dies later, say so instead of showing a dead link
    p.on('exit', () => {
      if (proc === p) {
        proc = null
        set({ status: 'error', error: 'The connection to Cloudflare closed. Turn sharing on again for a new link.' })
      }
    })
  } catch (e: any) {
    proc?.kill()
    proc = null
    set({ status: 'error', error: String(e?.message || e) })
  }
  return remoteState()
}

export async function stopRemote(): Promise<RemoteState> {
  const p = proc
  proc = null
  p?.kill()
  set({ status: 'off' })
  return remoteState()
}

/** The link includes the key, so after a key reset the running tunnel needs the new link. */
export async function refreshRemoteLink() {
  if (state.status === 'on' && state.url) {
    const base = state.url.replace(/\/\?k=.*$/, '')
    const link = `${base}/?k=${getSettings().accessKey}`
    set({ status: 'on', url: link, qr: await qr(link) })
  }
}
