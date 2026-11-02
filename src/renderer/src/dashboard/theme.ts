import { useEffect, useState } from 'react'

// Follows the Windows light/dark setting until the user picks one with the title bar toggle.
const KEY = 'sv:dash-theme'
const system = matchMedia('(prefers-color-scheme: dark)')
type Mode = 'light' | 'dark'

const chosen = (): Mode | null => {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' ? v : null
}
export const currentMode = (): Mode => chosen() ?? (system.matches ? 'dark' : 'light')
export const applyTheme = () => {
  document.documentElement.dataset.theme = currentMode() === 'dark' ? 'vault-dark' : 'vault'
}

export function useTheme(): [Mode, () => void] {
  const [mode, setMode] = useState<Mode>(currentMode)
  useEffect(() => {
    const on = () => {
      applyTheme()
      setMode(currentMode())
    }
    system.addEventListener('change', on)
    return () => system.removeEventListener('change', on)
  }, [])
  const toggle = () => {
    localStorage.setItem(KEY, mode === 'dark' ? 'light' : 'dark')
    applyTheme()
    setMode(currentMode())
  }
  return [mode, toggle]
}
