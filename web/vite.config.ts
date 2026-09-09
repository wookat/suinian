import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { marked, Renderer } from 'marked'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

const REPO_DOCS_URL = 'https://github.com/wookat/suinian/blob/main/docs/'

/** 把 docs/known-issues.md 渲染成同源静态页 /known-issues（仓库私有，GitHub 链接对未登录用户是 404）。 */
function knownIssuesPage(): Plugin {
  const src = path.resolve(__dirname, '../docs/known-issues.md')
  const render = () => {
    const renderer = new Renderer()
    const link = renderer.link.bind(renderer)
    renderer.link = (token) => {
      const m = /^\.\/([\w.-]+\.md)(#.*)?$/.exec(token.href)
      if (m) token.href = `${REPO_DOCS_URL}${m[1]}${m[2] ?? ''}`
      return link(token)
    }
    const body = marked.parse(fs.readFileSync(src, 'utf8'), { renderer, async: false })
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>碎念 Suinian · 已知问题清单（beta）</title><meta name="robots" content="noindex">
<style>body{max-width:44rem;margin:0 auto;padding:1.5rem 1rem 4rem;font:16px/1.7 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#18181b;background:#fafafa;word-break:break-word}a{color:#2563eb}blockquote{margin:0 0 1rem;padding:.25rem 1rem;border-left:3px solid #d4d4d8;color:#52525b}code{font-size:.9em;background:#f4f4f5;padding:.1em .3em;border-radius:3px}pre{overflow:auto;padding:.75rem;background:#f4f4f5;border-radius:6px}pre code{background:none;padding:0}table{border-collapse:collapse;display:block;overflow:auto;max-width:100%}td,th{border:1px solid #d4d4d8;padding:.3rem .6rem;text-align:left;vertical-align:top}h1{font-size:1.5rem}h2{font-size:1.2rem;margin-top:2rem}h3{font-size:1.05rem}@media(prefers-color-scheme:dark){body{color:#e4e4e7;background:#18181b}a{color:#93c5fd}code,pre{background:#27272a}blockquote{border-color:#3f3f46;color:#a1a1aa}td,th{border-color:#3f3f46}}</style>
</head><body><nav><a href="/">← 返回碎念</a></nav>
${body}
</body></html>
`
  }
  return {
    name: 'suinian-known-issues-page',
    buildStart() {
      this.addWatchFile(src)
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/known-issues') return next()
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(render())
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'known-issues.html', source: render() })
    },
  }
}

/** 构建身份：`BUILD_SHA`（scripts/deploy-sync.sh 注入 git SHA）写进首页 `<meta name="build">`，与 Worker `/health` 的 `build` 同源核验。 */
function buildIdentity(): Plugin {
  const sha = process.env.BUILD_SHA ?? 'dev'
  return {
    name: 'suinian-build-identity',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'build', content: sha }, injectTo: 'head' }],
  }
}

/**
 * 应用外壳预加载（R337 首屏体积优化）：入口分包只含 React + 欢迎页，外壳（src/app-shell.tsx）
 * 是动态导入。为免已引导用户多等一次串行往返，构建时生成一个外链 boot 脚本（CSP 禁止内联脚本）：
 * 读 localStorage 里的 onboarded 标记，为真则立即对外壳分包及其静态依赖注入 modulepreload，与入口并行下载；
 * 首次访客不受影响。Vite 的 __vitePreload 会复用已存在的 <link href>，不会重复拉取。
 */
function shellPreload(): Plugin {
  const SETTINGS_KEY = 'suinian.settings' // 与 src/lib/settings.ts 的 KEY 保持一致
  const SHELL_ID = path.resolve(__dirname, 'src/app-shell.tsx')
  let bootFile: string | null = null
  return {
    name: 'suinian-shell-preload',
    apply: 'build',
    generateBundle(_options, bundle) {
      const shell = Object.values(bundle).find(
        (c) => c.type === 'chunk' && c.facadeModuleId && path.resolve(c.facadeModuleId) === SHELL_ID,
      )
      if (!shell || shell.type !== 'chunk') return
      const closure = (root: string, seen = new Set<string>()) => {
        if (seen.has(root)) return seen
        seen.add(root)
        const chunk = bundle[root]
        if (chunk?.type === 'chunk') chunk.imports.forEach((i) => closure(i, seen))
        return seen
      }
      // 入口分包的静态依赖 index.html 已经 modulepreload，这里只补外壳独有的部分
      const entryFiles = Object.values(bundle)
        .filter((c) => c.type === 'chunk' && c.isEntry)
        .flatMap((c) => [...closure(c.fileName)])
      const files = [...closure(shell.fileName)].filter((f) => !entryFiles.includes(f)).map((f) => `/${f}`)
      const source =
        `(function(){try{var s=JSON.parse(localStorage.getItem(${JSON.stringify(SETTINGS_KEY)})||"{}");` +
        `if(s.onboarded!==true)return;var h=document.head;` +
        `${JSON.stringify(files)}.forEach(function(f){var l=document.createElement("link");l.rel="modulepreload";l.href=f;h.appendChild(l)})}catch(e){}})();`
      const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 8)
      bootFile = `assets/boot-${hash}.js`
      this.emitFile({ type: 'asset', fileName: bootFile, source })
    },
    transformIndexHtml: {
      order: 'post',
      handler: () =>
        bootFile ? [{ tag: 'script', attrs: { src: `/${bootFile}` }, injectTo: 'head-prepend' }] : [],
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    knownIssuesPage(),
    buildIdentity(),
    shellPreload(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg'],
      workbox: {
        importScripts: ['push-sw.js'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        navigateFallbackDenylist: [/^\/api\//, /^\/known-issues/],
        runtimeCaching: [
          {
            // auth/destructive and every other /api/ request goes straight to
            // the network: never cached, never served from cache, so account
            // deletion/logout cannot depend on Service Worker cache state
            urlPattern: ({ url, request }) =>
              url.pathname.startsWith('/api/') &&
              (request.method !== 'GET' ||
                url.pathname.startsWith('/api/auth/') ||
                !(/^\/api\/(notes|threads|reports)/.test(url.pathname) && url.searchParams.has('sn_uid'))),
            handler: 'NetworkOnly',
          },
          {
            // only requests carrying the identity fingerprint param are ever
            // cached, so entries are partitioned per account and an
            // un-partitioned request can never poison the cache
            urlPattern: ({ url, request }) =>
              request.method === 'GET' &&
              /^\/api\/(notes|threads|reports)/.test(url.pathname) &&
              url.searchParams.has('sn_uid'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'suinian-api',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 100, maxAgeSeconds: 7 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        lang: 'zh-CN',
        name: '碎念 Suinian',
        short_name: '碎念',
        description: '什么都能丢的 AI 收件箱',
        theme_color: '#0c0e12',
        background_color: '#f8fafc',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        screenshots: [
          {
            src: '/screenshot-wide.png',
            sizes: '640x400',
            type: 'image/png',
            form_factor: 'wide',
            label: '碎念时间流（桌面）',
          },
          {
            src: '/screenshot-narrow.png',
            sizes: '390x844',
            type: 'image/png',
            form_factor: 'narrow',
            label: '碎念时间流（移动端）',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
