import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import { App } from './app/App'
import './styles/app.css'

createRoot(document.getElementById('root')!).render(<App />)
