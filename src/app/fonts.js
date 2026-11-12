/* ─────────────────────────────────────────────────────
   アプリ共通のフォント

   端末ごとにフォントが違って見えないよう、フォントをアプリに同梱して配信する。
     - 数字・英字: Inter        (@fontsource-variable/inter)
     - 日本語   : Noto Sans JP  (@fontsource-variable/noto-sans-jp)
   どちらもSIL Open Font License 1.1(設定 → 利用規約等・注意事項 → ライセンス に全文を掲載)。
   バリアブルフォント(太さ100〜900を1ファイルで持つ)で、日本語は文字範囲(unicode-range)ごとに
   分割された小さいファイルとして配信されるため、実際に表示された文字の分だけを取得する。
   取得したフォントファイルはService Workerが端末に保存する(vite.config.tsのruntimeCaching)ので、
   2回目以降の起動・オフライン時も同じフォントで表示できる。

   フォントスタックはこのファイルを唯一の定義とし、画面全体(globalStyles)・canvas描画
   (観測点アイコン・震央ラベル)など、すべてここから参照する(index.cssの--sansは同じ内容を手で写している)。
   Interを先頭にするのは、Interが持たない文字(日本語)だけが後続のNoto Sans JPに回るため。
   同梱フォントが読み込めなかった場合は、従来どおり端末のフォントにフォールバックする。
   ───────────────────────────────────────────────────── */
export const FONT_SANS =
  '"Inter Variable", "Noto Sans JP Variable", -apple-system, BlinkMacSystemFont, "Helvetica Neue", "Hiragino Sans", "Noto Sans JP", sans-serif';

// canvasに描く文字は、描く時点でフォントが読み込み済みでないと、代わりのフォントで焼き込まれてしまう。
// そのため、起動時に、canvasで使う文字(観測点アイコンの震度・震央ラベル)を先に読み込む。
//   観測点アイコン: 0-7・5-・6+・?・未   震央ラベル: 「推定深さ: 〇km」「M: 〇.〇」「信頼度 0.00」
const CANVAS_LATIN_TEXT = "0123456789.:+-?kmM ";
const CANVAS_JAPANESE_TEXT = "推定深さ信頼度未";

// 重要なフォントの読み込みを待つ(最大timeoutMs)。回線が遅い・オフラインでも、起動を止めすぎないよう
// 時間切れ後は読み込みを待たずに先へ進む(その場合は、一時的に端末のフォントで表示される)。
export function preloadCriticalFonts(timeoutMs = 2500) {
  if (typeof document === "undefined" || !document.fonts || !document.fonts.load) {
    return Promise.resolve();
  }
  const loads = [
    document.fonts.load('400 16px "Inter Variable"', CANVAS_LATIN_TEXT),
    document.fonts.load('800 16px "Inter Variable"', CANVAS_LATIN_TEXT),
    document.fonts.load('400 16px "Noto Sans JP Variable"', CANVAS_JAPANESE_TEXT),
    document.fonts.load('700 16px "Noto Sans JP Variable"', CANVAS_JAPANESE_TEXT),
  ];
  const timeout = new Promise(resolve => setTimeout(resolve, timeoutMs));
  return Promise.race([Promise.allSettled(loads), timeout]).then(() => undefined);
}
