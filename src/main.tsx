import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import { App } from './app/App'
import { DemoApp } from './screens/DemoApp'
import { LibraryApp } from './screens/LibraryApp'
import './styles/app.css'

let diagnosticCallback = false
try { diagnosticCallback = window.location.pathname === '/callback' && sessionStorage.getItem('jamify.auth.destination') === 'diagnostics' } catch { /* The screen reports blocked storage. */ }
const path = window.location.pathname
createRoot(document.getElementById('root')!).render(path === '/demo' ? <DemoApp /> : path === '/diagnostics' || diagnosticCallback ? <App /> : <LibraryApp />)
