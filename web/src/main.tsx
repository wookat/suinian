import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const media = window.matchMedia('(prefers-color-scheme: dark)')
function applyTheme() {
  document.documentElement.classList.toggle('dark', media.matches)
}
applyTheme()
media.addEventListener('change', applyTheme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
