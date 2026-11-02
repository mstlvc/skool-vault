import { ipcRenderer } from 'electron'

/** Controls for the app-drawn title bar (the OS one is hidden). */
export const windowApi = {
  platform: process.platform,
  minimize: () => ipcRenderer.invoke('win:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
  close: () => ipcRenderer.invoke('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:isMaximized') as Promise<boolean>,
  onMaximized: (cb: (max: boolean) => void) => {
    const fn = (_: unknown, max: boolean) => cb(max)
    ipcRenderer.on('win:maximized', fn)
    return () => {
      ipcRenderer.removeListener('win:maximized', fn)
    }
  }
}

export type WindowApi = typeof windowApi
