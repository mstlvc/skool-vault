import { contextBridge, ipcRenderer } from 'electron'
import type { Account, DownloadOptions, JobState, LibraryEntry, RemoteGroup, RemoteState, ScanResult, Settings } from '../shared/types'
import { windowApi } from './window'

const api = {
  account: () => ipcRenderer.invoke('account:get') as Promise<Account>,
  login: () => ipcRenderer.invoke('account:login') as Promise<Account>,
  logout: () => ipcRenderer.invoke('account:logout') as Promise<Account>,
  remoteGroups: () => ipcRenderer.invoke('groups:remote') as Promise<RemoteGroup[]>,
  scan: (slug: string) => ipcRenderer.invoke('groups:scan', slug) as Promise<ScanResult>,
  startJob: (o: DownloadOptions) => ipcRenderer.invoke('job:start', o) as Promise<string>,
  cancelJob: (id: string) => ipcRenderer.invoke('job:cancel', id),
  jobs: () => ipcRenderer.invoke('job:list') as Promise<JobState[]>,
  clearJobs: () => ipcRenderer.invoke('job:clear'),
  onJob: (cb: (s: JobState) => void) => {
    const fn = (_: unknown, s: JobState) => cb(s)
    ipcRenderer.on('job', fn)
    return () => {
      ipcRenderer.removeListener('job', fn)
    }
  },
  library: () => ipcRenderer.invoke('library:list') as Promise<LibraryEntry[]>,
  openViewer: (slug?: string) => ipcRenderer.invoke('viewer:open', slug),
  openInBrowser: (slug?: string) => ipcRenderer.invoke('viewer:external', slug),
  showFolder: (slug?: string) => ipcRenderer.invoke('folder:show', slug),
  settings: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
  saveSettings: (p: Partial<Settings>) => ipcRenderer.invoke('settings:set', p) as Promise<Settings>,
  pickDir: () => ipcRenderer.invoke('settings:pickDir') as Promise<string | null>,
  serverInfo: () => ipcRenderer.invoke('server:info') as Promise<{ url: string; port: number; lan: string[] }>,
  remote: () => ipcRenderer.invoke('remote:get') as Promise<RemoteState>,
  startRemote: () => ipcRenderer.invoke('remote:start') as Promise<RemoteState>,
  stopRemote: () => ipcRenderer.invoke('remote:stop') as Promise<RemoteState>,
  resetAccessKey: () => ipcRenderer.invoke('remote:resetKey') as Promise<RemoteState>,
  onRemote: (cb: (s: RemoteState) => void) => {
    const fn = (_: unknown, s: RemoteState) => cb(s)
    ipcRenderer.on('remote', fn)
    return () => {
      ipcRenderer.removeListener('remote', fn)
    }
  },
  // Electron 45 no longer gives preload scripts the clipboard, so the main process writes it
  copy: (text: string) => ipcRenderer.invoke('clipboard:write', text) as Promise<boolean>
}

export type VaultApi = typeof api
contextBridge.exposeInMainWorld('vault', api)
contextBridge.exposeInMainWorld('appWindow', windowApi)
