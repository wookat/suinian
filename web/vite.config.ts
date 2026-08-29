import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg'],
      workbox: {
        importScripts: ['push-sw.js'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        navigateFallbackDenylist: [/^\/api\//],
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
        theme_color: '#18181b',
        background_color: '#fafafa',
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
