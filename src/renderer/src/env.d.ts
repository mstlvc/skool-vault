/// <reference types="vite/client" />
import type { VaultApi } from '../../preload/index'
import type { WindowApi } from '../../preload/window'

declare global {
  interface Window {
    vault: VaultApi
    /** present only inside the app's own windows (not in a regular browser) */
    appWindow?: WindowApi
  }
}
export {}
