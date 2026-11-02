// Viewer windows only get title bar controls: they display archived community content.
import { contextBridge } from 'electron'
import { windowApi } from './window'

contextBridge.exposeInMainWorld('appWindow', windowApi)
