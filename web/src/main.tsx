import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initTheme } from './lib/theme'

initTheme()

// Route on notification clicks relayed by the service worker (push-sw.js),
// which cannot navigate() uncontrolled clients directly.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data
    if (data && data.type === 'push-navigate' && typeof data.url === 'string') {
      window.location.href = data.url
    }
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
