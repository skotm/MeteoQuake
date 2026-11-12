import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 同梱フォント(Inter・Noto Sans JP)。@font-faceはこのimportで読み込まれ、フォントファイルは
// 実際に使われる文字の分だけ、必要になった時に取得される。
// パッケージ直下(".")ではなく、CSSファイルを明示して取り込む(wght.css = 太さ可変の@font-face定義)。
import '@fontsource-variable/inter/wght.css'
import '@fontsource-variable/noto-sans-jp/wght.css'
import './index.css'
import { preloadCriticalFonts } from './app/fonts.js'
import App from './App.jsx'

// canvas(観測点アイコン・震央ラベル)の文字は、描く時点でフォントが読み込み済みでないと
// 代わりのフォントで焼き込まれてしまうため、最初の描画の前に、canvasで使う文字だけを先に読み込む
// (回線が遅い・オフラインでも、最大2.5秒で打ち切って起動する)。
preloadCriticalFonts().finally(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
