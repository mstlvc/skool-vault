import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron'
import appIcon from '../../build/icon.png?asset'
import { join } from 'path'
import type { Account, DownloadOptions, JobState, Settings } from '../shared/types'
import { groupDir, listLibrary } from './archive'
import { DownloadJob, listRemoteGroups, scanGroup } from './scraper'
import { lanUrls, restartServer, serverPort, startServer } from './server'
import { getSettings, newAccessKey, saveSettings, speedProfile } from './settings'
import { onRemoteChange, refreshRemoteLink, remoteState, startRemote, stopRemote } from './tunnel'
import { isLoggedIn, logout, openLoginWindow, PageLoader } from './skool'

const rendererDir = join(__dirname, '../renderer')
const devUrl = process.env.ELECTRON_RENDERER_URL

let main: BrowserWindow | null = null
let loader: PageLoader | null = null
let me: any = null
const jobs = new Map<string, DownloadJob>()

const getLoader = () => (loader ??= new PageLoader(speedProfile().pageDelayMs))

function viewerUrl(slug?: string) {
  const hash = slug ? `#/g/${encodeURIComponent(slug)}` : '#/'
  const port = serverPort()
  return devUrl
    ? `${devUrl}/viewer.html?server=${encodeURIComponent(`http://127.0.0.1:${port}`)}${hash}`
    : `http://127.0.0.1:${port}/viewer.html${hash}`
}

/**
 * No OS title bar: the app draws its own (with window buttons) in the page. 'hidden' keeps the
 * real window frame, so shadows, edge resizing, rounded corners and snapping still work.
 */
function chrome(): Electron.BrowserWindowConstructorOptions {
  return {
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1c1f' : '#f7f8f9',
    autoHideMenuBar: true,
    icon: appIcon
  }
}

function watchMaximize(w: BrowserWindow) {
  const send = () => !w.isDestroyed() && w.webContents.send('win:maximized', w.isMaximized())
  w.on('maximize', send)
  w.on('unmaximize', send)
}

function createMain() {
  main = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    title: 'Skool Vault',
    ...chrome(),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  watchMaximize(main)
  main.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (devUrl) main.loadURL(devUrl + '/index.html')
  else main.loadFile(join(rendererDir, 'index.html'))
}

async function account(): Promise<Account> {
  const loggedIn = await isLoggedIn()
  if (!loggedIn) return { loggedIn }
  if (!me) {
    try {
      me = (await listRemoteGroups(getLoader())).me
    } catch {
      /* show as logged in without details */
    }
  }
  const name = me ? [me.firstName, me.lastName].filter(Boolean).join(' ') || me.name : undefined
  return { loggedIn, name, avatar: me?.metadata?.pictureBubble || null }
}

function registerIpc() {
  // custom title bar buttons (act on whichever window asked)
  const win = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender)
  ipcMain.handle('win:minimize', (e) => win(e)?.minimize())
  ipcMain.handle('win:toggleMaximize', (e) => {
    const w = win(e)
    if (w) w.isMaximized() ? w.unmaximize() : w.maximize()
  })
  ipcMain.handle('win:close', (e) => win(e)?.close())
  ipcMain.handle('win:isMaximized', (e) => !!win(e)?.isMaximized())

  // "Copy link" and friends: the clipboard is only reliably available in the main process
  // (the clipboard API is async in Electron 45, hence the awaits)
  ipcMain.handle('clipboard:write', async (_e, text: unknown) => {
    const value = String(text ?? '')
    await clipboard.writeText(value)
    return (await clipboard.readText()) === value
  })

  ipcMain.handle('account:get', () => account())
  ipcMain.handle('account:login', async () => {
    await openLoginWindow(main || undefined)
    me = null
    return account()
  })
  ipcMain.handle('account:logout', async () => {
    for (const j of jobs.values()) j.cancel()
    await logout()
    me = null
    return account()
  })

  ipcMain.handle('groups:remote', async () => {
    const r = await listRemoteGroups(getLoader())
    me = r.me || me
    return r.groups
  })
  ipcMain.handle('groups:scan', (_e, slug: string) => scanGroup(getLoader(), slug))

  ipcMain.handle('job:start', (_e, opts: DownloadOptions) => {
    const running = [...jobs.values()].find((j) => j.state.slug === opts.slug && j.state.status === 'running')
    if (running) return running.state.id
    const send = (s: JobState) => main?.webContents.send('job', s)
    const job = new DownloadJob(getLoader(), opts, send)
    jobs.set(job.state.id, job)
    job.run()
    send(job.state)
    return job.state.id
  })
  ipcMain.handle('job:cancel', (_e, id: string) => jobs.get(id)?.cancel())
  ipcMain.handle('job:list', () => [...jobs.values()].map((j) => j.state))
  ipcMain.handle('job:clear', () => {
    for (const [id, j] of jobs) if (j.state.status !== 'running') jobs.delete(id)
  })

  ipcMain.handle('library:list', () => listLibrary())
  ipcMain.handle('viewer:open', (_e, slug?: string) => {
    const w = new BrowserWindow({
      width: 1360,
      height: 900,
      minWidth: 720,
      minHeight: 520,
      title: 'Skool Vault — Viewer',
      ...chrome(),
      // window buttons only: the viewer shows archived community content, so it gets no app API
      webPreferences: { preload: join(__dirname, '../preload/viewer.js'), sandbox: false }
    })
    watchMaximize(w)
    w.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })
    w.loadURL(viewerUrl(slug))
  })
  ipcMain.handle('viewer:external', (_e, slug?: string) => shell.openExternal(viewerUrl(slug)))
  ipcMain.handle('folder:show', (_e, slug?: string) => shell.openPath(slug ? groupDir(slug) : getSettings().libraryDir))

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', async (_e, patch: Partial<Settings>) => {
    const before = getSettings()
    const s = saveSettings(patch)
    if (loader) loader.delayMs = speedProfile().pageDelayMs
    if (before.port !== s.port || before.lan !== s.lan) await restartServer(rendererDir)
    return s
  })
  ipcMain.handle('settings:pickDir', async () => {
    const r = await dialog.showOpenDialog(main!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('server:info', () => ({
    url: viewerUrl(),
    port: serverPort(),
    lan: getSettings().lan ? lanUrls() : []
  }))

  // "On your phone": temporary public link (Cloudflare quick tunnel) + Wi-Fi links
  onRemoteChange(async () => main?.webContents.send('remote', await remoteState()))
  ipcMain.handle('remote:get', () => remoteState())
  ipcMain.handle('remote:start', () => startRemote())
  ipcMain.handle('remote:stop', () => stopRemote())
  ipcMain.handle('remote:resetKey', async () => {
    saveSettings({ accessKey: newAccessKey() }) // every old link (phone or Wi-Fi) stops working
    await refreshRemoteLink()
    return remoteState()
  })
}

// own taskbar identity on Windows (icon, grouping, pinning) instead of "Electron"
if (process.platform === 'win32') app.setAppUserModelId('app.skoolvault')

app.whenReady().then(async () => {
  await startServer(rendererDir)
  registerIpc()
  createMain()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createMain())
})

// The hidden scraper window keeps 'window-all-closed' from firing, so closing
// the dashboard quits the app (and stops any running downloads).
app.on('browser-window-created', (_e, w) => {
  w.once('closed', () => {
    if (w === main) {
      main = null
      for (const j of jobs.values()) j.cancel()
      stopRemote() // the phone link dies with the app
      loader?.destroy()
      app.quit()
    }
  })
})
