import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initTheme } from './lib/theme'
import { loadSettings } from './lib/settings'
import { scrubApiCacheForToken } from './lib/api-cache'

initTheme()

// 启动即清掉不属于当前身份的 SW api 缓存（含升级前无指纹参数的历史条目）
void scrubApiCacheForToken(loadSettings().apiToken)

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
