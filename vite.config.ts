import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/MeteoQuake/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // licenses/*.txt: 設定画面で表示するフォントのライセンス全文(オフラインでも読めるように事前キャッシュする)
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'licenses/*.txt'],
      manifest: {
        name: '地震気象防災アプリ',
        short_name: 'MeteoQuake', // お好みの名前に変更してください
        description: '地震・気象・防災情報アプリ',
        theme_color: '#0B0B0C',
        background_color: '#0B0B0C',
        display: 'standalone',
        start_url: '/MeteoQuake/',
        scope: '/MeteoQuake/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // P2P地震情報APIなど外部APIへのfetchはキャッシュしない。
        // 地震情報はリアルタイム性が命なので、Service Workerが古いキャッシュを
        // 返して「新しい地震が来たのに古い情報が表示され続ける」事態を避ける。
        // 同梱フォント(Inter・Noto Sans JP)のファイルは、使われた分だけ端末に保存して再利用する。
        // 日本語フォントは文字範囲ごとに多数のファイル(woff2)に分割されており、全部を事前キャッシュ
        // (precache)すると初回のダウンロードが重くなる。そのため、実際に表示に使われたファイルだけを
        // 初めて取得した時に保存し(CacheFirst)、2回目以降・オフライン時はそこから返す。
        // フォントファイルはビルドごとに内容でハッシュ化された名前になるため、古いキャッシュが
        // 誤って使われることはない。上限を超えたら、古いものから削除される。
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.endsWith('.woff2'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'meteoquake-fonts',
              expiration: { maxEntries: 150, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
        navigateFallbackDenylist: [/^\/api/],
      },
    }),
  ],
})
