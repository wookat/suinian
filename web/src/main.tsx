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
    // SW 在 pushsubscriptionchange 里重订阅后交给页面同步服务端（push-sw.js）
    // push 模块牵出 api 客户端，不进首屏入口：仅在真正收到 SW 消息时按需加载
    if (data && data.type === 'push-resubscribed')
      void import('./lib/push').then((mod) => mod.reconcilePushSubscription())
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
