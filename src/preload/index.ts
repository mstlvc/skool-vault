import { contextBridge, ipcRenderer } from 'electron'
import type { Account, DownloadOptions, JobState, LibraryEntry, RemoteGroup, RemoteState, ScanResult, ScanSection, Settings, StripResult, TempClearResult, TempUsage } from '../shared/types'
import { windowApi } from './window'

const api = {
  account: () => ipcRenderer.invoke('account:get') as Promise<Account>,
  login: () => ipcRenderer.invoke('account:login') as Promise<Account>,
  logout: () => ipcRenderer.invoke('account:logout') as Promise<Account>,
  switchAccount: (id: string) => ipcRenderer.invoke('account:switch', id) as Promise<Account>,
  addAccount: () => ipcRenderer.invoke('account:add') as Promise<Account>,
  removeAccount: (id: string) => ipcRenderer.invoke('account:remove', id) as Promise<Account>,
  remoteGroups: () => ipcRenderer.invoke('groups:remote') as Promise<RemoteGroup[]>,
  scan: (slug: string) => ipcRenderer.invoke('groups:scan', slug) as Promise<ScanResult>,
  courseOutline: (slug: string, courseSlug: string) => ipcRenderer.invoke('groups:outline', slug, courseSlug) as Promise<ScanSection[]>,
  browseSkool: (url?: string) => ipcRenderer.invoke('skool:open', url),
  startJob: (o: DownloadOptions) => ipcRenderer.invoke('job:start', o) as Promise<string>,
  cancelJob: (id: string) => ipcRenderer.invoke('job:cancel', id),
  pauseJob: (id: string) => ipcRenderer.invoke('job:pause', id),
  resumeJob: (id: string) => ipcRenderer.invoke('job:resume', id),
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
  tempUsage: () => ipcRenderer.invoke('storage:usage') as Promise<TempUsage>,
  clearTemp: () => ipcRenderer.invoke('storage:clear') as Promise<TempClearResult>,
  stripPersonal: () => ipcRenderer.invoke('library:strip') as Promise<StripResult>,
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
