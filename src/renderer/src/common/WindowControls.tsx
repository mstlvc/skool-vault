import { useEffect, useState } from 'react'
import './window.css'

/** True inside the app's own windows (where the OS title bar is hidden). */
export const inAppWindow = () => !!window.appWindow && window.appWindow.platform !== 'darwin'

/** Minimize / maximize / close for the app-drawn title bar (Windows & Linux; macOS keeps its traffic lights). */
export function WindowControls() {
  const w = window.appWindow
  const [max, setMax] = useState(false)
  useEffect(() => {
    if (!w) return
    w.isMaximized().then(setMax)
    return w.onMaximized(setMax)
  }, [])
  if (!w || w.platform === 'darwin') return null
  return (
    <div className="wc no-drag">
      <button className="wc-btn" onClick={() => w.minimize()} aria-label="Minimize" title="Minimize">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button className="wc-btn" onClick={() => w.toggleMaximize()} aria-label={max ? 'Restore' : 'Maximize'} title={max ? 'Restore' : 'Maximize'}>
        {max ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="2.5" width="7" height="7" />
            <path d="M2.5 2.5V0.5h7v7h-2" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        )}
      </button>
      <button className="wc-btn wc-close" onClick={() => w.close()} aria-label="Close" title="Close">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  )
}
