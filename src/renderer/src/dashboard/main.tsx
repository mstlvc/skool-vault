import { createRoot } from 'react-dom/client'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans-condensed/600.css'
import '@fontsource/ibm-plex-sans-condensed/700.css'
import './dashboard.css'
import { App } from './App'
import { applyTheme } from './theme'

applyTheme()
createRoot(document.getElementById('root')!).render(<App />)
