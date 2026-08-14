import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useContext, createContext, forwardRef, Fragment, memo } from "react";
import { createPortal } from "react-dom";

/* ─────────────────────────────────────────────────────
   APP VERSION
   バージョン表記のルール(vMAJOR.MINOR.PATCH):
   - PATCH(3つ目の数字)を更新のたびに1ずつ増やす
   - PATCHが10になったらMINOR(2つ目)を1増やし、PATCHは0に戻す
   - MINORが10になったらMAJOR(1つ目)を1増やし、MINORは0に戻す
   - MAJORには繰り上げ先が無いので、10になってもそのまま11、12…と増え続ける
   (要するに10進の桁上がりと同じルールで、MAJORだけ上限が無い)
   ───────────────────────────────────────────────────── */
const APP_VERSION = "2.2.9";

/* ─────────────────────────────────────────────────────
   IN-APP DEBUG LOG
   実機のPWAではPCの開発者ツールに繋がずconsoleログを見る手段が無いため、
   console.log/info/warn/errorを横取りして直近分をメモリ上のリングバッファに
   保持し、設定タブ「詳細設定」→「ログ」から一覧表示・コピーできるようにする。
   - バッファ自体はReact stateではなくモジュールスコープの配列で持つ
     (発生頻度が高いログでrender/commitを都度挟むと重くなるため)。
   - 表示側は購読(subscribe)コールバックのSetを介して更新を検知する、
     ミニ版useSyncExternalStoreのような仕組み。
   - console.*の差し替えはモジュール読み込み時に1度だけ行う。元の関数呼び出し
     (PCでdevtoolsを開いている場合はそちらにも従来通り出る)は維持したまま、
     バッファへの追記を追加するだけ。
   ───────────────────────────────────────────────────── */
const DEBUG_LOG_MAX = 500; // 古いものから捨てる上限件数(メモリ節約のため)

let debugLogBuffer = [];
let debugLogSeq = 0;
const debugLogSubscribers = new Set();

function notifyDebugLogSubscribers() {
  for (const cb of debugLogSubscribers) cb();
}

// console.logなどに渡された1個の引数を、表示用の1行の文字列に変換する。
// 文字列はそのまま、Errorはname+message、それ以外(オブジェクト・配列等)は
// JSON化を試み、失敗すれば(循環参照など)String()にフォールバックする。
function formatDebugLogArg(arg) {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (arg === undefined) return "undefined";
  try {
    return JSON.stringify(arg, (key, value) => (typeof value === "bigint" ? value.toString() : value));
  } catch {
    return String(arg);
  }
}

function pushDebugLog(level, args) {
  debugLogSeq += 1;
  const entry = {
    id: debugLogSeq,
    level, // "log" | "info" | "warn" | "error"
    time: new Date(),
    text: args.map(formatDebugLogArg).join(" "),
  };
  debugLogBuffer.push(entry);
  if (debugLogBuffer.length > DEBUG_LOG_MAX) {
    debugLogBuffer.splice(0, debugLogBuffer.length - DEBUG_LOG_MAX);
  }
  notifyDebugLogSubscribers();
}

function clearDebugLog() {
  debugLogBuffer = [];
  notifyDebugLogSubscribers();
}

// console.log/info/warn/errorを横取りする。多重パッチ防止のためwindowにフラグを立てる
// (開発時のホットリロード等で複数回このモジュールが評価されても1回だけ差し替える)。
(function patchConsoleForDebugLog() {
  if (typeof window === "undefined" || window.__debugLogPatched) return;
  window.__debugLogPatched = true;
  for (const method of ["log", "info", "warn", "error"]) {
    const original = console[method] ? console[method].bind(console) : () => {};
    console[method] = (...args) => {
      original(...args);
      try { pushDebugLog(method, args); } catch { /* ログ機構自体の失敗は握りつぶす */ }
    };
  }
  // 通常のtry/catchを素通りしてしまうエラー(非同期処理内の未捕捉例外など)も
  // 追っておくと、実機での不具合調査に役立つ。
  window.addEventListener("error", (e) => {
    try { pushDebugLog("error", [`window.onerror: ${e.message}`, `${e.filename}:${e.lineno}`]); } catch {}
  });
  window.addEventListener("unhandledrejection", (e) => {
    try { pushDebugLog("error", ["unhandledrejection:", e.reason]); } catch {}
  });
})();

// バッファの現在の中身をコンポーネントから購読するためのフック。
// バッファ自体は毎回同じ配列参照を返す(pushDebugLog側でmutateしている)ため、
// 呼び出し側では返り値をそのまま使わず、参照だけをトリガーにして再描画のたびに
// 最新のdebugLogBufferを読みに行く形にしている。
function useDebugLog() {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const cb = () => forceUpdate(n => n + 1);
    debugLogSubscribers.add(cb);
    return () => { debugLogSubscribers.delete(cb); };
  }, []);
  return debugLogBuffer;
}

/* ─────────────────────────────────────────────────────
   RESPONSIVE LAYOUT
   スマホ縦持ちでは「下部タブバー + 下からドラッグして開くボトムシート」、
   横画面スマホ・タブレット・PCなど横幅が十分ある場合は「左端の縦タブバー
   (レール) + 常に画面右側に居るパネル」に切り替える。
   ここではその判定(=isWideLayout)だけを提供する。実際のレイアウト分岐は
   BottomDock側で行う。
   ───────────────────────────────────────────────────── */
const WIDE_LAYOUT_MIN_WIDTH = 720; // これ未満は常にスマホ縦持ち相当の下部タブバーを使う

function useIsWideLayout() {
  const [isWide, setIsWide] = useState(() =>
    typeof window !== "undefined" && window.innerWidth >= WIDE_LAYOUT_MIN_WIDTH
  );
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${WIDE_LAYOUT_MIN_WIDTH}px)`);
    const update = () => setIsWide(mq.matches);
    update();
    // Safari旧バージョン対応でaddListener/removeListenerもフォールバックしておく
    if (mq.addEventListener) mq.addEventListener("change", update);
    else mq.addListener(update);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", update);
      else mq.removeListener(update);
    };
  }, []);
  return isWide;
}

// 「ホーム画面に追加」して起動した、いわゆるスタンドアロンPWAかどうかを判定する。
// 通常のSafari/Chromeのタブとして開いている場合はfalse。
// スタンドアロンだとブラウザ自身のツールバーが無いためbottomのセーフエリアの
// 余白の付け方が変わるので、下部ナビの余白調整で使い分ける(BottomDock参照)。
function useIsStandalonePwa() {
  const [isStandalone, setIsStandalone] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(display-mode: standalone)").matches
      || window.navigator.standalone === true; // iOS Safariの旧来のフラグ
  });
  useEffect(() => {
    const mq = window.matchMedia("(display-mode: standalone)");
    const update = () => setIsStandalone(mq.matches || window.navigator.standalone === true);
    update();
    if (mq.addEventListener) mq.addEventListener("change", update);
    else mq.addListener(update);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", update);
      else mq.removeListener(update);
    };
  }, []);
  return isStandalone;
}

// 横画面レイアウト用のUI縮小率。PC・タブレットの横画面では画面の縦幅に
// 余裕があるので等倍(1)のままでよいが、横画面のスマホ(高さ400px前後)
// では同じ大きさのまま出すと文字・要素が窮屈になり壊滅的に見づらくなる
// ため、画面の縦幅に応じて0.7〜1の範囲で縮小する。
// 基準の700pxは、タブレット横画面などで概ね窮屈にならない高さの目安。
function useWideUIScale(isWide) {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!isWide) { setScale(1); return; }
    const update = () => {
      const h = window.innerHeight;
      setScale(Math.max(0.7, Math.min(1, h / 700)));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [isWide]);
  return scale;
}

/* ─────────────────────────────────────────────────────
   TRUE LIQUID GLASS
   
   Apple iOS 26 の物理モデル:
   - ガラス面 = ほぼ透明（tint なし）
   - 縁 = 光が屈折・集光 → feDisplacementMap で歪み
   - ハイライト = 縁の外側だけに細い白線（rim light）
   - 内部コンテンツは読みやすいよう最低限のblurのみ
   ───────────────────────────────────────────────────── */

const ALERT = { level: "warning", title: "大雨警報", region: "東京都・神奈川県" };

const LAYERS = [
  { id: "radar",        label: "雨雲レーダー", on: true  },
  { id: "quake",        label: "震度分布",     on: false },
  // 実際のon/offは常にApp側のestIntensityEnabled(設定と共有・localStorage永続化)で
  // 上書きされるため、ここでの初期値(false)自体は使われない(layersForPanelを参照)。
  { id: "estIntensity", label: "推計震度分布", on: false },
  { id: "tsunami",      label: "津波予報区",   on: false },
  { id: "river",        label: "河川水位",     on: true  },
  { id: "hazard",       label: "ハザード",     on: false },
  { id: "evac",         label: "避難所",       on: false },
];

const NAV = [
  { id: "quake",    label: "地震",   path: null },
  { id: "tsunami",  label: "津波",   path: null },
  { id: "weather",  label: "気象",   path: null },
  { id: "alert",    label: "警報",   path: null },
  { id: "settings", label: "設定",   path: null },
];

/* ─────────────────────────────────────────────────────
   SVG FILTERS
   真のLiquid Glass屈折: 縁にだけ歪みが集中する
   ───────────────────────────────────────────────────── */
function Filters() {
  return (
    <svg width="0" height="0" style={{ position: "absolute", overflow: "hidden" }} aria-hidden>
      <defs>

        {/* ── 縁屈折フィルタ（ピル・サークル用）────────────── */}
        {/*
            仕組み:
            1. SourceGraphic のアルファ境界を erode で細く取り出す
            2. その境界マスクで displacement をかける
            → 縁の内側だけ背景が歪む = ガラスの縁レンズ効果
        */}
        <filter id="lg-refract" x="-4%" y="-4%" width="108%" height="108%"
                colorInterpolationFilters="sRGB" primitiveUnits="userSpaceOnUse">
          {/* 境界マスク生成: ごく薄い縁のみ */}
          <feMorphology in="SourceAlpha" operator="erode" radius="0.5" result="inner"/>
          <feMorphology in="SourceAlpha" operator="dilate" radius="1" result="outer"/>
          <feComposite in="outer" in2="inner" operator="out" result="rim"/>
          <feGaussianBlur in="rim" stdDeviation="1.2" result="rimBlur"/>

          {/* 歪みベクター: 細かいノイズ＋縁マスク合成 */}
          <feTurbulence type="fractalNoise" baseFrequency="0.03 0.03"
                        numOctaves="1" seed="8" result="noise"/>
          <feComposite in="noise" in2="rimBlur" operator="in" result="edgeNoise"/>

          {/* 縁だけ歪む displacement — scaleを最小限に */}
          <feDisplacementMap in="SourceGraphic" in2="edgeNoise"
                             scale="2.5"
                             xChannelSelector="R" yChannelSelector="G"/>
        </filter>

        {/* ── 小型コントロール用（歪みさらに控えめ）───────────────── */}
        <filter id="lg-refract-sm" x="-6%" y="-6%" width="112%" height="112%"
                colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.05 0.05"
                        numOctaves="1" seed="3" result="noise"/>
          <feMorphology in="SourceAlpha" operator="erode" radius="0.5" result="inner"/>
          <feMorphology in="SourceAlpha" operator="dilate" radius="1" result="outer"/>
          <feComposite in="outer" in2="inner" operator="out" result="rim"/>
          <feGaussianBlur in="rim" stdDeviation="1" result="rimBlur"/>
          <feComposite in="noise" in2="rimBlur" operator="in" result="edgeNoise"/>
          <feDisplacementMap in="SourceGraphic" in2="edgeNoise"
                             scale="1.5"
                             xChannelSelector="R" yChannelSelector="G"/>
        </filter>

        {/* ── クロマティック・アベレーション（色収差）────────── */}
        {/* ガラスの縁で赤と青がわずかにずれる */}
        <filter id="lg-chroma" x="-4%" y="-4%" width="108%" height="108%"
                colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix"
                         values="1    0    0    0   0.004
                                 0    1    0    0   0
                                 0    0    1    0  -0.004
                                 0    0    0    1   0"/>
        </filter>

        {/* 天気アイコンの縁取りは、以前はここのSVGフィルタ(weather-icon-
            outline-dark/-light)を<img>にfilter:url(...)として直接適用して
            いたが、外部SVG画像+多段フィルタという組み合わせがSafari/iOSで
            アイコンの一部だけ透けて見える不具合を起こすため撤去した。
            現在はWeatherIconコンポーネント側でcanvasに焼き込んで処理する。 */}

      </defs>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   BACKDROP-FILTER 実効性の疑わしさを検出する
   
   Windows Chromium(ANGLE Direct3D11経由)では、backdrop-filterは
   CSS機能としては「対応」しているにもかかわらず(@supportsも通る)、
   背後のWebGL canvas(地図)がDirectCompositionのハードウェア
   オーバーレイに昇格し、ブラウザの通常コンポジタから見えなくなる
   ことがある。この場合ぼかしは一切効かず、ガラスパネルの背景が
   ほぼ完全に透けて見える(既存の @supports not(...) フォールバックは
   「機能自体に非対応」の場合しか拾えないため、この症状は検出できない)。
   
   WEBGL_debug_renderer_info 拡張でGPUレンダラー文字列を取得し、
   既知の発生条件(ANGLEのDirect3D11バックエンド)に一致するかで
   ヒューリスティックに判定する。100%正確な判定ではないため、
   設定側で手動オーバーライドできるようにlocalStorageに保存する
   ("auto" | "on"(常に不透明) | "off"(常にぼかし優先))。
   ───────────────────────────────────────────────────── */
function detectSuspectedBackdropFilterBreakage() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return false;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (!ext) return false;
    const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "";
    // 例: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)"
    return /ANGLE/i.test(String(renderer)) && /Direct3D11/i.test(String(renderer));
  } catch {
    return false;
  }
}

const GLASS_OPAQUE_OVERRIDE_KEY = "glassOpaqueFallback"; // "auto" | "on" | "off"

function loadGlassOpaqueOverride() {
  try {
    const v = localStorage.getItem(GLASS_OPAQUE_OVERRIDE_KEY);
    return v === "on" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}

function saveGlassOpaqueOverride(v) {
  try { localStorage.setItem(GLASS_OPAQUE_OVERRIDE_KEY, v); } catch {}
}

// Glassコンポーネント群、および設定画面の「フローティング関連」トグルが
// 共有するcontext。Appのトップレベルで判定結果(自動判定 or 手動オーバーライド)
// と、オーバーライドを変更するための関数をまとめて配信する。
// - opaque: 実際に不透明表示にするかどうか(Glassコンポーネントが参照)
// - override: "auto" | "on" | "off"(ユーザーの手動選択。設定画面のトグルに対応)
// - suspectedBroken: 自動判定の結果(ぼかしが実効しない疑いがあるか)
// - setOverride: overrideを変更する関数
const GlassOpaqueContext = createContext({
  opaque: false,
  override: "auto",
  suspectedBroken: false,
  setOverride: () => {},
});

/* ─────────────────────────────────────────────────────
   LIQUID GLASS SURFACE COMPONENT
   
   背景:  backdrop-filter: blur のみ（色付けない）
   面:    rgba(0,0,0,0) — 完全透明
   縁:    SVGフィルタで屈折 + CSSで細い白rim
   ───────────────────────────────────────────────────── */
const Glass = forwardRef(function Glass({
  children,
  radius = 20,
  style,
  filterSize = "normal",  // "normal" | "sm" | "none"
  blur = 14,               // backdrop blur量(px)。アニメーション中だけ軽くしたい場合に上書きする
  tintColor,               // 状態色(警報/予報など)を付けたい時だけ渡す、6桁hexの基準色(例:"#FF453A")
  ...rest
}, ref) {
  // backdrop-filterが実効しない(疑いがある)環境では、屈折SVGフィルタも
  // ぼかし層も使わず、はっきり見える不透明めの背景に切り替える。
  // 屈折フィルタは「ぼかされた背景を歪ませる」演出のため、ぼかし自体が
  // 効いていない状態でfilter:url(...)だけ生かしても視覚的な意味がない。
  const { opaque: glassOpaque } = useContext(GlassOpaqueContext);
  const { tokens } = useContext(ThemeContext);

  // filterSize="none" の場合は屈折SVGフィルタを外し、単純なbackdrop blurのみにする
  // （リサイズや角丸トランジション中など、フィルタの再計算コストが重くなる場面用の軽量モード）
  const filterId = glassOpaque ? null : (filterSize === "none" ? null : filterSize === "sm" ? "lg-refract-sm" : "lg-refract");

  // tintColor指定時の背景色。以前は呼び出し側がstyle.backgroundに直接
  // "${accent}8C"のような色を指定していたが、それは(下のglass-backdrop-layerより
  // 手前に敷かれるため)tokens.glassTint/glassOpaqueBgと重ねて表示される。
  // glassTintはライトモードで55%不透明の白、glassOpaqueBgはライト/ダークどちらも
  // 92〜94%不透明という設計上、accent色がモードや不透明設定によって大きく
  // 薄まったり別の色に見えてしまっていた。tintColorはglass-backdrop-layer自体の
  // 背景を直接置き換えることで、この二重ブレンドを避け、常に狙った濃さの色になる
  // ようにする(通常時は半透明、不透明モードでは十分濃くして視認性を保つ)。
  const backdropBackground = tintColor
    ? `${tintColor}${glassOpaque ? "E6" : "8C"}`
    : (glassOpaque ? tokens.glassOpaqueBg : tokens.glassTint);

  return (
    <div
      ref={ref}
      style={{
        position: "relative",
        borderRadius: radius,
        isolation: "isolate",
        ...style,
      }}
      {...rest}
    >
      {/* 背景ブラー層: backdrop-filterのみを単独で適用する。
          ここに filter:url(...) を同時指定すると、Windows版Chrome/Edge
          (ANGLE/D3D11経由のレンダリングパス)ではbackdrop-filterの
          ぼかし自体が丸ごと無効化され、rgba(255,255,255,0.02)というほぼ
          無色の背景だけが残って「完全に透ける」表示になってしまう
          既知の不具合があるため、意図的にfilterを外してある。 */}
      <div
        aria-hidden
        className="glass-backdrop-layer"
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "inherit",
          // ぼかしが実効しない環境ではbackdrop-filter自体を外す
          // (どうせ効かない処理をGPUにやらせ続けるコストを避ける)。
          backdropFilter: glassOpaque ? "none" : `blur(${blur}px) saturate(140%)`,
          WebkitBackdropFilter: glassOpaque ? "none" : `blur(${blur}px) saturate(140%)`,
          background: backdropBackground,
          zIndex: 0,
        }}
      />
      {/* 縁屈折(SVG displacement)層: 上のブラー層とは別要素にすることで、
          backdrop-filter + filter の組み合わせ不具合がここで起きても
          このレイヤーだけが無効になり、下のブラー層は影響を受けない
          (＝最悪の場合でも「ぼかしは効くが屈折演出だけ消える」に留まり、
          「完全に透ける」事態は起きない、というフォールバック構造)。 */}
      {filterId && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "inherit",
            backdropFilter: `blur(${blur}px) saturate(140%)`,
            WebkitBackdropFilter: `blur(${blur}px) saturate(140%)`,
            filter: `url(#${filterId})`,
            zIndex: 0,
            pointerEvents: "none",
          }}
        />
      )}
      {/* 縁のrim light: シャープな1pxの白線、歪みなし */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "inherit",
          boxShadow: `
            inset 0 0 0 0.75px ${tokens.rimLight},
            inset 0 1px 0 ${tokens.rimHighlight}
          `,
          pointerEvents: "none",
          zIndex: 1,
        }}
      />
      {/* コンテンツ層: 歪みフィルタの影響を一切受けない */}
      <div style={{ position: "relative", zIndex: 2, width: "100%", height: "100%" }}>
        {children}
      </div>
    </div>
  );
});

/* ─────────────────────────────────────────────────────
   PRESSABLE BUTTON
   ガラスデザインではないフラットなボタン(設定行・一覧行・チップなど)向けの、
   共通のタップフィードバック。押している間だけ少し縮小+暗くなり、離すと
   すぐ戻る。個々のボタンでpressed状態を都度書かなくて済むように、ここに
   一箇所だけ実装して使い回す(ガラス側は既にGlass+pressedで独自の
   "膨らむ"演出があるので対象外)。
   ───────────────────────────────────────────────────── */
const PressableButton = forwardRef(function PressableButton({ style, onClick, children, ...rest }, ref) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      ref={ref}
      onClick={onClick}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      style={{
        ...style,
        opacity: pressed ? 0.55 : (style?.opacity ?? 1),
        transform: pressed ? "scale(0.97)" : (style?.transform ?? "scale(1)"),
        transition: "opacity 0.12s ease, transform 0.12s ease",
      }}
      {...rest}
    >
      {children}
    </button>
  );
});

/* ─────────────────────────────────────────────────────
   GLOBAL STYLES
   ───────────────────────────────────────────────────── */
function GlobalStyles({ tokens = THEME_TOKENS.dark }) {
  return (
    <style>{`
      :root {
        --page-bg: ${tokens.pageBg};
        --text: ${tokens.text};
        --glass-opaque-bg: ${tokens.glassOpaqueBg};
      }
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      /* PC(Windows/Mac)のChrome・Edgeでは、地震一覧などスクロール可能な
         パネル内に、ネイティブの太い白っぽいスクロールバーがそのまま
         出てしまい、Liquid Glassの見た目にそぐわない。スクロール自体は
         有効なまま、バーの見た目だけ全要素で非表示にする。 */
      *, *::before, *::after {
        scrollbar-width: none;      /* Firefox */
        -ms-overflow-style: none;   /* 旧Edge/IE */
      }
      *::-webkit-scrollbar {
        display: none;              /* Chrome, 新Edge, Safari */
        width: 0;
        height: 0;
      }
      html, body, #root { height: 100%; width: 100%; }
      /* iOSのスタンドアロンPWAは、ステータスバー分(env(safe-area-inset-top))だけ
         ドキュメント全体を上にずらして描画するが、高さ自体は増えないため、
         その分だけ下端に隙間ができてしまう。ずらされる分だけ高さを余分に
         確保しておくことで、この隙間を無くす。 */
      html { min-height: calc(100% + env(safe-area-inset-top, 0px)); }
      html {
        overflow: hidden;
        background: var(--page-bg);
      }
      body {
        /*
          position:fixed でページ自体を完全に固定する。
          iOSのSafariは、地図をドラッグした際に地図だけでなく
          ページ全体がわずかに弾性スクロール(ラバーバンド)してしまうことがあり、
          その一瞬だけSafariのデフォルトのUI背景(白)が画面端に見えてしまう。
          overscroll-behavior だけでは防ぎきれないため、position:fixedで
          ページ自体をスクロール不可能な状態に固定して根本的に防ぐ。
        */
        position: fixed;
        inset: 0;
        background: var(--page-bg);
        font-family: -apple-system, BlinkMacSystemFont,
                     "SF Pro Display", "Helvetica Neue",
                     "Noto Sans JP", sans-serif;
        -webkit-font-smoothing: antialiased;
        overflow: hidden;
        overscroll-behavior: none;
        touch-action: none;
        color: var(--text);
      }
      /* アプリ全体をネイティブアプリのUIのように扱うため、長押しでの
         テキスト選択・コピー/調べる/翻訳メニュー(iOSのcallout)を無効化する。
         フローティングパネルや震度凡例を長押しした時に、意図せず選択
         ハイライトやコピーメニューが出てしまうのを防ぐ。 */
      *, *::before, *::after {
        -webkit-user-select: none;
        user-select: none;
        -webkit-touch-callout: none;
        -webkit-tap-highlight-color: transparent;
      }
      #root {
        position: absolute;
        inset: 0;
        overflow: hidden;
      }
      button { font-family: inherit; background: none; border: none; cursor: pointer; }

      /* Liquid Glassの背景は backdrop-filter の blur ありきで
         rgba(255,255,255,0.02) というほぼ完全に透明な色にしている。
         backdrop-filter に対応していない環境(一部のAndroid端末やPC)では、
         ぼかしが一切効かず、ほぼ透明な色だけが残るため、パネルが
         「完全に透けて見える」状態になってしまう。
         backdrop-filterが使えない場合だけ、はっきり見える不透明めの
         背景色に差し替える(!importantはこのフォールバック目的でのみ使用)。 */
      @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
        .glass-backdrop-layer {
          background: var(--glass-opaque-bg) !important;
        }
      }

      @keyframes pulse {
        0%,100% { opacity:1; transform:scale(1); box-shadow: 0 0 0 0 currentColor; }
        50%      { opacity:0.4; transform:scale(0.55); }
      }
      @keyframes appear {
        from { opacity:0; transform:translateY(10px) scale(0.97); }
        to   { opacity:1; transform:translateY(0)    scale(1); }
      }
      @keyframes eewFabPulse {
        0%,100% { box-shadow: 0 0 0 0 rgba(255,69,58,0.5); }
        50%      { box-shadow: 0 0 0 8px rgba(255,69,58,0); }
      }
      /* レイヤーパネルはキーフレームではなく transform/opacity の
         トランジションで開閉する（下部アイコンバーへ向けて滑らかに
         スライスイン・アウトできるよう、常時マウントして状態だけ切替える） */
      @keyframes fadeIn {
        from { opacity:0; }
        to   { opacity:1; }
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      /* MapLibreの標準UIはLiquid Glassの自前コントロールに置き換えるため非表示 */
      .maplibregl-ctrl-top-right,
      .maplibregl-ctrl-top-left,
      .maplibregl-ctrl-bottom-left,
      .maplibregl-ctrl-bottom-right,
      .maplibregl-control-container { display: none; }

      .mono { font-variant-numeric: tabular-nums; }

      /* 台風の予報円の横に出す時刻ラベル(maplibregl.Marker)。
         デザインは参考実装(index.html)の.forecast-time-marker/.fc-class-badgeに合わせている。 */
      .typhoon-forecast-time-marker {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(0, 0, 0, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.55);
        color: #fff;
        font-size: 14px;
        font-weight: 700;
        line-height: 1.25;
        white-space: nowrap;
        text-shadow: 0 1px 2px #000;
        pointer-events: auto;
        cursor: pointer;
      }
      .typhoon-forecast-class-badge {
        font-size: 10px;
        font-weight: 700;
        padding: 1px 6px;
        border-radius: 999px;
        background: rgba(154, 160, 166, 0.95);
        color: #1a1a1a;
        text-shadow: none;
        white-space: nowrap;
      }

      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation-duration: 0.01ms !important;
          transition-duration: 0.01ms !important;
        }
      }
    `}</style>
  );
}

/* ─────────────────────────────────────────────────────
   MAPLIBRE LOADER
   CDNからmaplibre-gl本体とCSSを動的読み込みする
   （Reactアーティファクト環境にはnpmパッケージが無いため）
   ───────────────────────────────────────────────────── */
const MAPLIBRE_JS  = "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.js";
const MAPLIBRE_CSS = "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.css";

let maplibreLoadPromise = null;
function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (maplibreLoadPromise) return maplibreLoadPromise;

  maplibreLoadPromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${MAPLIBRE_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = MAPLIBRE_CSS;
      document.head.appendChild(link);
    }
    const existing = document.querySelector(`script[src="${MAPLIBRE_JS}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(window.maplibregl));
      return;
    }
    const script = document.createElement("script");
    script.src = MAPLIBRE_JS;
    script.async = true;
    script.onload = () => resolve(window.maplibregl);
    script.onerror = () => reject(new Error("MapLibre GL JS の読み込みに失敗しました"));
    document.head.appendChild(script);
  });

  return maplibreLoadPromise;
}

/* ─────────────────────────────────────────────────────
   TURF.JS LOADER
   CDNからturf.js本体を動的読み込みする(maplibre-glと同じ理由でnpm importできない)。
   台風レイヤーの幾何計算(暴風域の円・警戒領域ポリゴンの結合など)にのみ使うため、
   台風情報がONになった時点で初めて読み込む(使わない利用者には一切通信させない)。
   ───────────────────────────────────────────────────── */
const TURF_JS = "https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js";

let turfLoadPromise = null;
function loadTurf() {
  if (window.turf) return Promise.resolve(window.turf);
  if (turfLoadPromise) return turfLoadPromise;

  turfLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${TURF_JS}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(window.turf));
      return;
    }
    const script = document.createElement("script");
    script.src = TURF_JS;
    script.async = true;
    script.onload = () => resolve(window.turf);
    script.onerror = () => reject(new Error("turf.js の読み込みに失敗しました"));
    document.head.appendChild(script);
  });

  return turfLoadPromise;
}

/* ─────────────────────────────────────────────────────
   GEO DATA LOADER
   /map/world.json (GeometryCollection・国境) と
   /map/prefectures.json (FeatureCollection・都道府県) を取得し、
   ブラウザの localStorage にキャッシュする。
   ファイル構成:
     public/
     └─ map/
        ├─ world.json
        └─ prefectures.json

   注意: localStorage は容量上限が一般的に 5〜10MB 程度(ブラウザ依存)。
   world.json は比較的大きいファイルのため、容量超過時は保存に失敗することがある。
   その場合は例外を握りつぶしてキャッシュなしで動作を継続する
   (=毎回ネットワークから取得するだけで、アプリ自体は問題なく動く)。

   localStorageではなく Cache API (caches.open) を使う理由:
   - localStorageは5〜10MB程度(ブラウザ依存)しか使えず、world.jsonや
     細分区域.json(いずれも10MB超)を保存しようとすると容量超過しやすい。
   - Cache APIはResponseをそのまま保存できるため文字列化(JSON.stringify/parse)の
     コストが無く、上限もブラウザの空きディスク容量に応じて大きく取れる。
   - Service Worker無し(ページのJSから直接)でも caches.open() だけで利用できる。
   ───────────────────────────────────────────────────── */
const GEO_CACHE_VERSION = "v1"; // データ更新時はここを上げるとキャッシュを無効化できる
const GEO_CACHE_NAME = `bosai-geo-${GEO_CACHE_VERSION}`;

// Cache APIが使えない環境(プライベートブラウジング等で無効化されている場合や
// 古いブラウザ)でも、キャッシュを諦めるだけで動作は継続できるようにする。
function isCacheApiAvailable() {
  return typeof caches !== "undefined";
}

async function cachedFetchJSON(url) {
  if (!isCacheApiAvailable()) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} の取得に失敗しました (${res.status})`);
    return res.json();
  }

  try {
    const cache = await caches.open(GEO_CACHE_NAME);
    const cached = await cache.match(url);
    if (cached) return cached.json();

    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} の取得に失敗しました (${res.status})`);
    // レスポンスはストリームなので、キャッシュ保存用と読み取り用で複製してから使う
    await cache.put(url, res.clone());
    return res.json();
  } catch (err) {
    // QuotaExceededError などでキャッシュの読み書きに失敗した場合は、
    // キャッシュを諦めて素のfetchにフォールバックする(アプリ自体は動作を継続)。
    console.warn(`地図データのキャッシュ(Cache API)に失敗しました(${url})。`, err);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} の取得に失敗しました (${res.status})`);
    return res.json();
  }
}

let geoDataPromise = null;
function loadGeoData() {
  if (geoDataPromise) return geoDataPromise;
  geoDataPromise = Promise.all([
    cachedFetchJSON(`${import.meta.env.BASE_URL}map/world.json`),
    cachedFetchJSON(`${import.meta.env.BASE_URL}map/prefectures.json`),
    cachedFetchJSON(`${import.meta.env.BASE_URL}map/細分区域.json`),
  ]).then(([world, prefectures, areas]) => ({ world, prefectures, areas }));
  return geoDataPromise;
}

/* ─────────────────────────────────────────────────────
   断層(faults.geojson)・プレート境界(plate-boundaries.json)データ。
   いずれも数MB規模のファイルのため、world.json等とは違いアプリ起動時には
   読み込まず、設定でトグルが最初にONにされたタイミングで遅延読み込みする
   (loadGeoDataと同様、一度取得したPromiseはキャッシュして使い回す)。
   ファイル構成:
     public/
     └─ map/
        ├─ faults.geojson
        └─ plate-boundaries.json
   ───────────────────────────────────────────────────── */
let faultsDataPromise = null;
function loadFaultsData() {
  if (faultsDataPromise) return faultsDataPromise;
  faultsDataPromise = cachedFetchJSON(`${import.meta.env.BASE_URL}map/faults.geojson`);
  return faultsDataPromise;
}

let plateBoundariesDataPromise = null;
function loadPlateBoundariesData() {
  if (plateBoundariesDataPromise) return plateBoundariesDataPromise;
  plateBoundariesDataPromise = cachedFetchJSON(`${import.meta.env.BASE_URL}map/plate-boundaries.json`);
  return plateBoundariesDataPromise;
}

// 震央地名(気象庁の震央地名区域)データ。緊急地震速報テスト配信で「地図をタップして
// 震源を指定」した時に、タップ地点から震源地名を自動判定するためだけに使うので、
// 断層・プレート境界と同様、実験的機能が実際に使われた時だけ遅延読み込みする。
// ファイル: public/map/ep.json
// (以前は震央地名_geo.jsonという漢字入りファイル名だったが、環境によって
//  URLエンコード周りの問題を起こしうるためep.jsonに変更した)
let epicenterNamesDataPromise = null;
function loadEpicenterNamesData() {
  if (epicenterNamesDataPromise) return epicenterNamesDataPromise;
  epicenterNamesDataPromise = cachedFetchJSON(`${import.meta.env.BASE_URL}map/ep.json`);
  return epicenterNamesDataPromise;
}

// 津波予報区(海岸線)データ。津波情報の詳細を開いた時だけ、対象の予報区を
// 塗り分けるために遅延読み込みする(断層・プレート境界と同じ理由・同じ方式)。
// ファイル: public/map/tsunami-areas.json
let tsunamiAreasDataPromise = null;
function loadTsunamiAreasData() {
  if (tsunamiAreasDataPromise) return tsunamiAreasDataPromise;
  tsunamiAreasDataPromise = cachedFetchJSON(`${import.meta.env.BASE_URL}map/tsunami-areas.json`);
  return tsunamiAreasDataPromise;
}

/* ─────────────────────────────────────────────────────
   雨雲レーダー(高解像度降水ナウキャスト) — 気象庁のPNGタイルをMapLibreで表示する。
   ・提供されているズームレベルは偶数のみ(奇数ズームにはタイルが存在しない)。
     MapLibreの独自プロトコル(addProtocol)でタイル要求をフックし、奇数ズームは
     1段階粗い偶数ズームのタイルの該当象限(128×128)を切り出して256×256に
     拡大することで代用する(=通常のオーバーズーム表示と同じ見た目になる)。
   ・全国のデータが存在するのはおおよそ東経118°〜150°・北緯20°〜48°の範囲のみ。
     この範囲外でタイルをリクエストしないよう、raster sourceにbounds(範囲)を
     設定して無駄な通信を避ける(MapLibreは画面に映っている範囲のタイルしか
     要求しないため、無駄になるのは主に日本から離れた場所を見ている時)。
   ・それでも境界付近では404になり得るため、一度404だったタイルのURLを
     覚えておき、同じURLを再度リクエストしない(パンで同じ境界付近を
     行き来した時の無駄打ちを防ぐ)。
   ───────────────────────────────────────────────────── */
const NOWCAST_BOUNDS = [118, 20, 150, 48]; // [west, south, east, north] のおおよその提供範囲
// コマ切り替え(自動再生・手動スライダー操作とも)で一瞬レーダーが消えないよう、
// 前後何コマぶんタイルを先読みしておくか。
const NOWCAST_PRELOAD_RADIUS = 3;
const NOWCAST_TARGET_TIMES_URLS = {
  obs: "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json",       // 実況(過去)
  forecast: "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N2.json",  // 予測(60分先まで)
};
function nowcastTileUrl(basetime, validtime, z, x, y) {
  return `https://www.jma.go.jp/bosai/jmatile/data/nowc/${basetime}/none/${validtime}/surf/hrpns/${z}/${x}/${y}.png`;
}
// MapLibreのraster sourceに渡す独自プロトコルURL(実タイルURLの組み立てや
// 偶数ズームへの丸め・配色変換は下のregisterNowcastProtocol内で行う)。
// schemeIdをURLに含めることで、配色設定を切り替えた時にMapLibreが
// 「別のタイル」として再取得してくれる(実際のJMAタイル自体はブラウザの
// HTTPキャッシュに乗っているので、追加の通信は発生しない)。
function nowcastProtocolUrl(schemeId, basetime, validtime) {
  return `jmanowc://${schemeId}/${basetime}/${validtime}/{z}/{x}/{y}`;
}

/* ─────────────────────────────────────────────────────
   雨雲レーダーの配色スキーム。「震度配色」の設定と全く同じ考え方で、
   {id, label, palette} の一覧をここに増やしていけば選択肢を追加できる。
   ・palette: null の場合は気象庁配色そのまま(変換なし・最速)。
   ・palette がある場合は、JMA_NOWCAST_SOURCE_PALETTE の各色を、
     配列の対応するインデックスの色に1対1で置き換える(近似一致)。
   ───────────────────────────────────────────────────── */
// 気象庁「ホームページにおける気象情報の配色に関する設定指針」表２－１に定められた、
// レーダー・ナウキャストの降水強度(mm/h)ごとの正式なRGB値(弱い順)。
const JMA_NOWCAST_SOURCE_PALETTE = [
  [242, 242, 255], // 0~1   ほぼ白
  [160, 210, 255], // 1~5   薄い水色
  [33, 140, 255],  // 5~10  やや薄い青
  [0, 65, 255],    // 10~20 青
  [250, 245, 0],   // 20~30 黄
  [255, 153, 0],   // 30~50 橙
  [255, 40, 0],    // 50~80 赤
  [180, 0, 104],   // 80~   赤紫
];
// Yahoo!天気の降水強度カラーバー(スクリーンショットより近似抽出)。
// 上と同じ並び(弱い順)で対応させる。
const YAHOO_WEATHER_NOWCAST_PALETTE = [
  [216, 246, 246], // 0~1   ごく薄い水色
  [130, 210, 235], // 1~5   薄い水色
  [70, 150, 225],  // 5~10  青
  [90, 200, 90],   // 10~20 緑
  [225, 225, 60],  // 20~30 黄
  [235, 165, 60],  // 30~50 橙
  [230, 70, 40],   // 50~80 赤
  [204, 0, 0],     // 80~   濃い赤
];
const NOWCAST_COLOR_SCHEMES = {
  jma: {
    id: "jma",
    label: "気象庁配色(オリジナル)",
    palette: null,
  },
  yahoo: {
    id: "yahoo",
    label: "Yahoo!天気配色",
    palette: YAHOO_WEATHER_NOWCAST_PALETTE,
  },
};

// 現在選択中の雨雲レーダー配色スキームID("jma" | "yahoo")をアプリ全体に配る
// コンテキスト(震度配色と同じ仕組み)。
const NowcastColorSchemeContext = createContext("jma");
const NOWCAST_COLOR_SCHEME_STORAGE_KEY = "nowcastColorScheme";
function loadStoredNowcastColorScheme() {
  try {
    const saved = localStorage.getItem(NOWCAST_COLOR_SCHEME_STORAGE_KEY);
    if (saved && NOWCAST_COLOR_SCHEMES[saved]) return saved;
  } catch (err) {
    console.warn("雨雲レーダー配色の設定を読み込めませんでした:", err);
  }
  return "jma";
}
function saveNowcastColorScheme(schemeId) {
  try {
    localStorage.setItem(NOWCAST_COLOR_SCHEME_STORAGE_KEY, schemeId);
  } catch (err) {
    console.warn("雨雲レーダー配色の設定を保存できませんでした:", err);
  }
}

// 台風予報円の表示間隔(時間)。台風接近時は気象庁の予報が3時間おきに増えるため、
// 「現在から○時間ごと」の予報円だけを間引いて表示する設定。初期値は12時間ごと。
const TYPHOON_FORECAST_INTERVAL_STORAGE_KEY = "typhoonForecastIntervalHours";
const TYPHOON_FORECAST_INTERVAL_VALID_HOURS = new Set([3, 6, 12, 24]);
function loadStoredTyphoonForecastInterval() {
  try {
    const saved = Number(localStorage.getItem(TYPHOON_FORECAST_INTERVAL_STORAGE_KEY));
    if (TYPHOON_FORECAST_INTERVAL_VALID_HOURS.has(saved)) return saved;
  } catch (err) {
    console.warn("台風予報円の表示間隔の設定を読み込めませんでした:", err);
  }
  return 12;
}
function saveTyphoonForecastInterval(hours) {
  try {
    localStorage.setItem(TYPHOON_FORECAST_INTERVAL_STORAGE_KEY, String(hours));
  } catch (err) {
    console.warn("台風予報円の表示間隔の設定を保存できませんでした:", err);
  }
}

// ピクセルの色を、最も近いJMA元パレットの色に対応する変換先の色へ置き換える
// (透明度はそのまま維持する)。JMAのタイルは基本的に固定色のパレット画像なので、
// 単純なユークリッド距離での最近傍マッチングで十分な精度になる。
function remapImageDataColors(imageData, palette) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue; // 完全透明はそのまま(無駄な距離計算を省く)
    const r = data[i], g = data[i + 1], b = data[i + 2];
    let bestIdx = -1, bestDist = Infinity;
    for (let p = 0; p < JMA_NOWCAST_SOURCE_PALETTE.length; p++) {
      const [pr, pg, pb] = JMA_NOWCAST_SOURCE_PALETTE[p];
      const dr = r - pr, dg = g - pg, db = b - pb;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) { bestDist = dist; bestIdx = p; }
    }
    // 元パレットからかけ離れた色(誤差大きすぎ)は、地図の下地等が透けている
    // 縁のアンチエイリアシングとみなし、変換せずそのまま残す。
    if (bestDist > 60 * 60 * 3) continue;
    const [nr, ng, nb] = palette[bestIdx];
    data[i] = nr; data[i + 1] = ng; data[i + 2] = nb;
  }
  return imageData;
}

// 実況(N1)+予測(N2)を時刻昇順の1本のタイムラインにまとめて返す。
// [{ basetime, validtime, kind: "obs"|"forecast" }, ...]
async function loadNowcastFrames() {
  const [obsRes, fcRes] = await Promise.all([
    fetch(NOWCAST_TARGET_TIMES_URLS.obs),
    fetch(NOWCAST_TARGET_TIMES_URLS.forecast),
  ]);
  if (!obsRes.ok) throw new Error(`雨雲レーダーの時刻一覧(実況)の取得に失敗(HTTP ${obsRes.status})`);
  if (!fcRes.ok) throw new Error(`雨雲レーダーの時刻一覧(予測)の取得に失敗(HTTP ${fcRes.status})`);
  const [obsList, fcList] = await Promise.all([obsRes.json(), fcRes.json()]);
  // N1・N2とも新しい順(降順)で来るので、時系列順(昇順)に直してから連結する。
  const obsFrames = [...obsList].reverse().map(t => ({ basetime: t.basetime, validtime: t.validtime, kind: "obs" }));
  const fcFramesRaw = [...fcList].reverse().map(t => ({ basetime: t.basetime, validtime: t.validtime, kind: "forecast" }));
  // N1(実況)の最新コマとN2(予測)の先頭コマは、境目の「現在時刻」を指す
  // validtimeが一致することがある(予測は現在時刻を起点に60分先までを
  // 含むため)。そのまま連結すると、スライダー上に同じ時刻の目盛りが
  // 「実況」「予測」として2つ並んでしまう。実況側を正としてそちらを残し、
  // 予測側にある重複コマは取り除く。
  const obsValidtimes = new Set(obsFrames.map(f => f.validtime));
  const fcFrames = fcFramesRaw.filter(f => !obsValidtimes.has(f.validtime));
  return [...obsFrames, ...fcFrames];
}

// targetTimes_N1/N2.jsonのvalidtimeは"YYYYMMDDHHMMSS"形式の14桁文字列で、実際には
// UTCで返ってくる(コメントでJSTと誤解していたのが「実際は7:20なのに22:20と表示
// される」不具合の原因だった)。日付をまたぐ差し引きも正しく扱えるよう、一度UTCの
// タイムスタンプ(ms)として組み立ててから使う。
function nowcastValidtimeToMs(validtime) {
  if (!validtime || validtime.length < 12) return null;
  const y = Number(validtime.slice(0, 4));
  const mo = Number(validtime.slice(4, 6)) - 1;
  const d = Number(validtime.slice(6, 8));
  const h = Number(validtime.slice(8, 10));
  const mi = Number(validtime.slice(10, 12));
  const s = validtime.length >= 14 ? Number(validtime.slice(12, 14)) : 0;
  const ms = Date.UTC(y, mo, d, h, mi, s);
  return Number.isNaN(ms) ? null : ms;
}
// スライダー上に出す「16:40」のような短い時刻表示に変換する(UTC→JSTは+9時間)。
function parseNowcastValidTime(validtime) {
  const utcMs = nowcastValidtimeToMs(validtime);
  if (utcMs == null) return null;
  const jst = new Date(utcMs + 9 * 60 * 60 * 1000);
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mm = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
function formatNowcastFrameLabel(frame) {
  if (!frame) return "";
  const time = parseNowcastValidTime(frame.validtime);
  if (!time) return frame.kind === "obs" ? "実況" : "予測";
  return frame.kind === "obs" ? `${time} 実況` : `${time} 予測`;
}

// フレーム一覧の中から、現在時刻(Date.now())に一番近いものを探す。
// 雨雲レーダーのN1/N2のように「実況/予測」がファイルで分かれておらず、
// 1本のtargetTimes.jsonに実況・予報が混ざっている(と思われる)降水量では、
// これを「現在」の代わりに使う(一覧の再取得時に選択を維持するかどうかの
// 判定にも使う)。
function nowcastNearestIndexToNow(frames) {
  if (!frames || frames.length === 0) return null;
  const now = Date.now();
  let bestIdx = 0, bestDist = Infinity;
  frames.forEach((f, i) => {
    const ms = nowcastValidtimeToMs(f.validtime);
    if (ms == null) return;
    const dist = Math.abs(ms - now);
    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
  });
  return bestIdx;
}

/* ─────────────────────────────────────────────────────
   1時間・3時間・24時間降水量(気象庁「今後の雨」降水短時間予報)。
   配色は雨雲レーダーと共通(NOWCAST_COLOR_SCHEMES/remapImageDataColors を
   そのまま使う)。

   実際にtargetTimes.jsonを取得して確認済み(2026-08-08時点):
   - 要素名は"rasrf"(1時間)/"rasrf03h"(3時間)/"rasrf24h"(24時間)で正しかった。
   - 同じjsonの中に、この降水量とは無関係な要素(sjfcstmap・slmcs等)を含む
     エントリも大量に混ざっているため、目的のelementを含むエントリだけを
     拾う必要がある。
   - 各エントリにmemberフィールド("none"だったり"immed"だったりする)があり、
     タイルURL中の"none"の部分は固定ではなく、このmemberをそのまま使う必要が
     ある(直近の即時値・予報コマはmember="immed"になっており、"none"固定
     だとそこだけ404していた)。
   ───────────────────────────────────────────────────── */
const PRECIP_DATA_BASE = "https://www.jma.go.jp/bosai/jmatile/data/rasrf";
const PRECIP_MODE_CONFIG = {
  precip1h:  { element: "rasrf",     label: "1時間降水量" },
  precip3h:  { element: "rasrf03h",  label: "3時間降水量" },
  precip24h: { element: "rasrf24h",  label: "24時間降水量" },
};
function precipTileUrl(mode, member, basetime, validtime, z, x, y) {
  const element = PRECIP_MODE_CONFIG[mode]?.element || "rasrf";
  return `${PRECIP_DATA_BASE}/${basetime}/${member}/${validtime}/surf/${element}/${z}/${x}/${y}.png`;
}
function precipProtocolUrl(mode, schemeId, member, basetime, validtime) {
  return `jmaprecip://${mode}/${schemeId}/${member}/${basetime}/${validtime}/{z}/{x}/{y}`;
}

// modeの時刻一覧を取得する。[{ basetime, validtime, member }, ...] を時系列昇順で返す。
async function loadPrecipFrames(mode) {
  const label = PRECIP_MODE_CONFIG[mode]?.label || mode;
  const element = PRECIP_MODE_CONFIG[mode]?.element || "rasrf";
  const url = `${PRECIP_DATA_BASE}/targetTimes.json`;
  let raw;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (err) {
    console.warn(`降水量[${label}]: 時刻一覧の取得に失敗 url=${url}`, err);
    throw err;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    console.warn(`降水量[${label}]: 時刻一覧が空、または想定外の形式です url=${url}`, raw);
    return [];
  }
  // このjsonには降水量以外の要素(sjfcstmap・slmcs等)のエントリも混ざっているため、
  // elementsに目的の要素名を含むものだけを拾う。validtimeの文字列比較で昇順に
  // 整列する(YYYYMMDDHHMMSS形式なので文字列比較=時系列比較になる)。
  return raw
    .filter(t => t && t.basetime && t.validtime && Array.isArray(t.elements) && t.elements.includes(element))
    .sort((a, b) => String(a.validtime).localeCompare(String(b.validtime)))
    .map(t => ({ basetime: t.basetime, validtime: t.validtime, member: t.member || "none" }));
}

function formatPrecipFrameLabel(frame) {
  if (!frame) return "";
  const time = parseNowcastValidTime(frame.validtime);
  if (!time) return "";
  const ms = nowcastValidtimeToMs(frame.validtime);
  const isForecast = ms != null && ms > Date.now();
  return isForecast ? `${time} 予報` : `${time} 実況`;
}

/* ─────────────────────────────────────────────────────
   天気分布予報。「天気分布」(晴れ/くもり/雨/雨または雪/雪の5分類)と
   「気温分布」の2種類を実装する(降水量・降雪量・最高最低気温は対象外)。
   5kmメッシュで、3時間ごと・翌日24時まで予報するデータ(毎日5時・11時・
   17時発表)。

   ⚠️ 天気分布のタイルURL構造は実機で確認済み(2026年8月時点で正常に表示)。
   気温分布(要素名"temp")は、ページのURLハッシュ(elements:temp)から
   類推した未検証の値。実機で404や想定外のデータが出た場合はconsole.warnに
   実際のURL・レスポンスを出すようにしてあるので、そこから正しい値を
   特定して直す想定。
   ───────────────────────────────────────────────────── */
const WDIST_DATA_BASE = "https://www.jma.go.jp/bosai/jmatile/data/wdist";
const WDIST_MODE_CONFIG = {
  weather:     { element: "wm",   label: "天気分布" },
  temperature: { element: "temp", label: "気温分布" }, // 要検証
};
function wdistTileUrl(mode, member, basetime, validtime, z, x, y) {
  const element = WDIST_MODE_CONFIG[mode]?.element || "wm";
  return `${WDIST_DATA_BASE}/${basetime}/${member}/${validtime}/surf/${element}/${z}/${x}/${y}.png`;
}
function wdistProtocolUrl(mode, member, basetime, validtime) {
  return `jmawdist://${mode}/${member}/${basetime}/${validtime}/{z}/{x}/{y}`;
}

// modeの時刻一覧を取得する。[{ basetime, validtime, member }, ...] を時系列昇順で返す。
async function loadWdistFrames(mode) {
  const label = WDIST_MODE_CONFIG[mode]?.label || mode;
  const element = WDIST_MODE_CONFIG[mode]?.element || "wm";
  const url = `${WDIST_DATA_BASE}/targetTimes.json`;
  let raw;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (err) {
    console.warn(`${label}: 時刻一覧の取得に失敗 url=${url}`, err);
    throw err;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    console.warn(`${label}: 時刻一覧が空、または想定外の形式です url=${url}`, raw);
    return [];
  }
  // このjsonには天気分布予報以外の要素のエントリが混ざっている可能性がある
  // ため、elementsに目的の要素名を含むものだけを拾う。含まれていなかった
  // 場合(=elements自体が無い形式だった場合)に備えて、elementsが無ければ
  // 素通しするフォールバックも用意しておく。
  const filtered = raw.filter(t => t && t.basetime && t.validtime);
  const withElement = filtered.filter(t => Array.isArray(t.elements) && t.elements.includes(element));
  if (filtered.length > 0 && withElement.length === 0) {
    console.warn(
      `${label}: elements="${element}"を含むエントリが1件も無かった。` +
      `要素名の推測が外れている可能性があります。実際のエントリ例:`,
      filtered[0]
    );
  }
  const result = withElement.length > 0 ? withElement : filtered;
  return result
    .sort((a, b) => String(a.validtime).localeCompare(String(b.validtime)))
    .map(t => ({ basetime: t.basetime, validtime: t.validtime, member: t.member || "none" }));
}

// 天気分布予報のスライダー用ラベル。翌日24時まで予報があるため、雨雲レーダー・
// 降水量のような「HH:MM」だけだと今日なのか明日なのか分からなくなる。
// 「10日15時」のように日付+時をそのまま出す。
function formatWdistFrameLabel(frame) {
  if (!frame) return "";
  const ms = nowcastValidtimeToMs(frame.validtime);
  if (ms == null) return "";
  const jst = new Date(ms + 9 * 60 * 60 * 1000);
  const day = jst.getUTCDate();
  const hour = jst.getUTCHours();
  return `${day}日${hour}時`;
}

/* ─────────────────────────────────────────────────────
   台風情報 — 気象庁 台風情報API(bosai/typhoon)の取得と空間処理。
   turf.jsで暴風域・強風域の円、暴風警戒域(輪郭線から結合したポリゴン)、
   予報円の遷移から作る「警戒領域」の結合ポリゴンを組み立てる。
   1本のGeoJSON FeatureCollectionに全台風ぶんの各種フィーチャーを
   properties.type("center"/"forecastCircle"/"stormArea"/"windArea"/
   "pastTrack"/"track"/"forecastArea"/"stormWarningArea")で区別して入れ、
   MapCanvas側は1つのsourceに対してtypeごとにfilterした複数レイヤーを重ねる
   (雨雲レーダーの仕組みとは別で、こちらは前に作った参考実装をそのまま踏襲)。
   ───────────────────────────────────────────────────── */
const TYPHOON_DATA_BASE = "https://www.jma.go.jp/bosai/typhoon/data";

function parseJMACoord(coord) {
  if (!coord) return null;
  if (Array.isArray(coord) && coord.length >= 2) {
    const lat = Number(coord[0]);
    const lon = Number(coord[1]);
    return Number.isFinite(lat) && Number.isFinite(lon) ? [lon, lat] : null;
  }
  const match = String(coord).match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  if (match) {
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    return [lon, lat];
  }
  return null;
}

// 台風の「階級」(種別)がTY/STS/TSのいずれでもない場合は、熱帯低気圧・温帯低気圧などに
// 変化(減衰)したとみなす
const TYPHOON_CLASS_CODES = new Set(["TY", "STS", "TS"]);
function isWeakenedTyphoonClass(category) {
  if (!category || !category.en) return false;
  return !TYPHOON_CLASS_CODES.has(category.en);
}

// 種別(category: {jp, en})・台風番号・名称から表示名を組み立てる
function getTyphoonDisplayName(category, typhoonNo, name) {
  const suffix = name ? ` (${name})` : "";
  const jp = category?.jp;
  if (jp) {
    if (jp === "台風") {
      return `${Number(typhoonNo) ? `台風第${Number(typhoonNo)}号` : "台風"}${suffix}`;
    }
    return `${jp}${suffix}`;
  }
  return `${Number(typhoonNo) ? `台風第${Number(typhoonNo)}号` : "熱帯低気圧"}${suffix}`;
}

function formatTyphoonCategoryLabel(category, fallback) {
  if (category?.jp) return `${category.jp}${category.en ? `(${category.en})` : ""}`;
  return fallback || "-";
}

function getJMATyphoonRadiusKm(value) {
  if (value == null) return null;
  if (typeof value === "number") return value / 1000;
  if (Array.isArray(value)) return getJMATyphoonRadiusKm(value[0]);
  if (typeof value === "object") {
    // {km, nm}形式(気象庁specifications.jsonのprobabilityCircleRadius/stormWarning.range
    // 等で使われる形。値は既にkm単位なのでそのまま返す)
    if (typeof value.km === "number") return value.km;
    if (typeof value.radius === "number") return value.radius / 1000;
    if (typeof value.base === "number") return value.base / 1000;
    if (Array.isArray(value.base)) return getJMATyphoonRadiusKm(value.base[0]);
  }
  return null;
}

// forecast.json上の1予報点(item)から予報円の半径(km)を取り出す。
// 以前は item.probabilityCircle.radius という決め打ちのキー名だけを見ていたが、
// 実際の気象庁データではprobabilityCircleRadius(specifications.jsonと同じ{km,nm}形式)
// など別名で入ってくるケースがあり、その場合常にnullになって予報円が
// ひとつも描画されない不具合があった。そのため複数の候補キーを順に試す。
function getForecastCircleRadiusKm(item) {
  const candidates = [
    item.probabilityCircle?.radius,
    item.probabilityCircle,
    item.probabilityCircleRadius,
    item.circle?.radius,
    item.circle,
  ];
  for (const candidate of candidates) {
    const km = getJMATyphoonRadiusKm(candidate);
    if (km) return km;
  }
  return null;
}

// forecast.json上の1予報点(item)から、名称・階級・気圧・風速・大きさ・強さ・
// 移動方向速度など、詳細カード/予報タイムラインの表示に必要なフィールドをまとめて
// 作る。半径やジオメトリ(円・ラベル位置)は呼び出し側の用途(地図の予報円か、
// 一覧の予報タイムラインか)によって必要なものが違うため、ここには含めない。
function buildTyphoonForecastPointInfo(item, { tc, specifications, currentCategory, typhoonNo, name }) {
  const forecastLabel = formatTyphoonForecastTimeLabel(item.validtime?.JST || item.validtime?.UTC);
  const forecastSpec = specifications.find(spec => spec.advancedHours === item.advancedHours) || {};
  const forecastCategory = forecastSpec.category || currentCategory;
  return {
    id: tc.tropicalCyclone,
    name: getTyphoonDisplayName(forecastCategory, typhoonNo, name),
    category: formatTyphoonCategoryLabel(forecastCategory, tc.category),
    weakened: isWeakenedTyphoonClass(forecastCategory),
    forecastTime: forecastLabel,
    timeLabel: `${forecastLabel} 予報`,
    pressure: forecastSpec.pressure || "不明",
    maxWind: forecastSpec.maximumWind?.sustained?.["m/s"] || "不明",
    maxGust: forecastSpec.maximumWind?.gust?.["m/s"] || "不明",
    scale: forecastSpec.scale || "-",
    intensity: forecastSpec.intensity || "-",
    speed: forecastSpec.speed?.["km/h"] ? `${forecastSpec.course || ""} ${forecastSpec.speed["km/h"]}km/h`.trim() : (forecastSpec.course || "-"),
    courseText: forecastSpec.course || "-",
    speedKmh: forecastSpec.speed?.["km/h"] || null,
  };
}
// 予報点を「現在(advancedHours=0)から少なくともintervalHours時間離れているものだけ、
// 直前に採用した点からもintervalHours時間以上離れているものだけ」を貪欲に拾う形で間引く。
// 気象庁のadvancedHoursは発表時刻のズレにより必ずしも3,6,12,24の倍数の
// キレイなグリッドに並ばない(例: 1,4,7,10,...のように1時間オフセットしていたり、
// 12,24,45,69,...のように不規則だったりする)。そのため「advancedHours % interval」で
// 判定すると、オフセットとの相性次第で予報点が1つも一致せず、予報円が
// まるごと消えてしまうことがあった。この関数はオフセットに関係なく必ず動く。
function pickThinnedForecastPoints(points, intervalHours) {
  const sorted = points
    .filter(item => item.advancedHours > 0)
    .slice()
    .sort((a, b) => a.advancedHours - b.advancedHours);
  const picked = [];
  let lastHours = 0; // 現在時刻(advancedHours=0)を基準に数える
  for (const item of sorted) {
    if (item.advancedHours - lastHours >= intervalHours) {
      picked.push(item);
      lastHours = item.advancedHours;
    }
  }
  return picked;
}

// 暴風警戒域(stormWarningArea)のポリゴンを作る。
// 気象庁データのarc([中心,半径,角度範囲]の組)を角度どおりに弧として描き、
// 隣接する弧・直線(line)を「一番近い端点同士をつなぐ」貪欲法でリング状に
// つなぐ実装だったが、弧の向き(時計/反時計、劣弧/優弧)の判定が実データの
// 規則と合わずに自己交差し、画面いっぱいに伸びる細い三角形のような
// 破綻した形になる不具合があった。
// 同じファイル内でforecastArea(予報円の遷移)を作る際に使っている
// 「連続する円のconvex hullを合成していく」方式は角度に依存せず壊れないため、
// 暴風警戒域もarcの角度情報は使わず、中心・半径だけを取り出して単純な円を作り、
// それらを順にconvex hullで結んで帯状のポリゴンを作る方式に統一する。
function buildStormWarningAreaFeature(turf, stormWarningArea) {
  const circles = (stormWarningArea?.arc || [])
    .map(arc => {
      const center = parseJMACoord(arc?.[0]);
      const radiusKm = getJMATyphoonRadiusKm(arc?.[1]);
      if (!center || !radiusKm) return null;
      return turf.circle(center, radiusKm, { steps: 64, units: "kilometers" });
    })
    .filter(Boolean);
  if (circles.length === 0) return null;

  if (circles.length === 1) {
    const only = circles[0];
    only.properties = { type: "stormWarningArea" };
    return only;
  }

  let previous = circles[0];
  let result = null;
  for (let i = 1; i < circles.length; i++) {
    const segment = turf.convex(turf.explode(turf.featureCollection([previous, circles[i]])));
    if (segment) result = result ? (turf.union(result, segment) || result) : segment;
    previous = circles[i];
  }
  if (!result) return null;
  result.properties = { type: "stormWarningArea" };
  return result;
}

function formatTyphoonForecastTimeLabel(time) {
  if (!time) return "予報";
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return "予報";
  const day = date.getDate();
  const hour = date.getHours();
  if (hour === 0) return `${day}日午前0時`;
  if (hour < 12) return `${day}日午前${hour}時`;
  if (hour === 12) return `${day}日午後0時`;
  return `${day}日午後${hour - 12}時`;
}

async function fetchTyphoonJsonOrNull(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

// 「台風情報」ボタン自体を、台風が1つも発生していない間は表示しないために使う
// 軽い問い合わせ。targetTc.json(対象の台風の一覧)だけを見る、件数のみの確認で
// あり、各台風の詳細(forecast.json/specifications.json)は取りに行かない。
async function fetchActiveTyphoonExists() {
  const targetTc = await fetchTyphoonJsonOrNull(`${TYPHOON_DATA_BASE}/targetTc.json`);
  return Array.isArray(targetTc) && targetTc.length > 0;
}

// 気象庁「現在活動中の台風」一覧とその予報・実況を取得し、地図表示用GeoJSONと
// 一覧パネル表示用のサマリー配列にまとめて返す。
// forecastIntervalHours: 予報円を間引く間隔(時間)。台風接近時は気象庁の予報が
// 3時間おきに増えるため、advancedHoursがこの倍数の予報円だけを表示する
// (例: 12なら12,24,36...時間先だけ。3,6,9時間先などは間引かれる)。
// 戻り値: { geojson: FeatureCollection, list: [{id,name,category,weakened,pressure,
//           maxWind,maxGust,scale,intensity,speed,lon,lat}] }
async function fetchTyphoonData(forecastIntervalHours = 12) {
  const turf = await loadTurf();
  const features = [];
  const list = [];

  try {
    const targetTc = await fetchTyphoonJsonOrNull(`${TYPHOON_DATA_BASE}/targetTc.json`);
    if (!Array.isArray(targetTc) || targetTc.length === 0) {
      return { geojson: turf.featureCollection([]), list: [] };
    }

    const typhoonData = await Promise.all(targetTc.map(async (tc) => {
      const id = tc.tropicalCyclone;
      const [forecast, specifications] = await Promise.all([
        fetchTyphoonJsonOrNull(`${TYPHOON_DATA_BASE}/${id}/forecast.json`),
        fetchTyphoonJsonOrNull(`${TYPHOON_DATA_BASE}/${id}/specifications.json`),
      ]);
      return { tc, forecast: Array.isArray(forecast) ? forecast : [], specifications: Array.isArray(specifications) ? specifications : [] };
    }));

    typhoonData.forEach(({ tc, forecast, specifications }) => {
      const title = forecast.find(item => item.part === "title") || specifications.find(item => item.part === "title") || tc;
      const specNow = specifications.find(item => item.advancedHours === 0) || {};
      const points = forecast.filter(item => item && item.advancedHours !== undefined && item.center);
      const current = points.find(item => item.advancedHours === 0) || points[0];
      if (!current) return;

      const centerPos = parseJMACoord(current.center);
      if (!centerPos) return;

      const typhoonNo = String(title.typhoonNumber || tc.typhoonNumber || "").slice(-2).replace(/^0/, "");
      const name = title.name?.jp || title.name?.en || "";
      const maxWind = specNow.maximumWind?.sustained?.["m/s"] || specNow.maximumWind?.sustained?.mps || "不明";
      const maxGust = specNow.maximumWind?.gust?.["m/s"] || specNow.maximumWind?.gust?.mps || "不明";
      const currentCategory = specNow.category || (tc.category ? { jp: null, en: tc.category } : null);
      const displayName = getTyphoonDisplayName(currentCategory, typhoonNo, name);
      const weakened = isWeakenedTyphoonClass(currentCategory);
      const pressure = specNow.pressure || "不明";
      const scale = specNow.scale || "-";
      const intensity = specNow.intensity || "-";
      const speed = specNow.speed?.["km/h"] ? `${specNow.course || ""} ${specNow.speed["km/h"]}km/h`.trim() : (specNow.course || "-");
      // 移動速度・移動方向を別々の値としても持っておく(詳細カードで
      // 「移動速度」「移動方向」を別項目として大きく表示するため)。
      const courseText = specNow.course || "-";
      const speedKmh = specNow.speed?.["km/h"] || null;
      const timeLabel = `${formatTyphoonForecastTimeLabel(current.validtime?.JST || current.validtime?.UTC)} 実況`;

      // 暴風警戒域(輪郭線)の元データを先に確定させ、暴風域の塗りも同じ円弧を使う
      const stormWarningSource = points.slice().reverse().find(item => item.stormWarningArea?.arc?.length);
      const currentStormArc = current.stormWarningArea?.arc?.[0] || stormWarningSource?.stormWarningArea?.arc?.[0];
      const stormAreaCenter = parseJMACoord(currentStormArc?.[0]) || centerPos;
      const stormRadiusKm = getJMATyphoonRadiusKm(currentStormArc?.[1]);

      // 強風域(15m/s以上の風が吹く範囲)。台風一覧タップ時、この範囲が画面に収まる
      // ズーム倍率でflyToするために、暴風域より先に半径・中心を確定させておく。
      const galeCenter = parseJMACoord(current.galeWarningArea?.center) || centerPos;
      const galeRadiusKm = getJMATyphoonRadiusKm(current.galeWarningArea?.radius);

      features.push(turf.point(centerPos, {
        type: "center",
        id: tc.tropicalCyclone,
        name: displayName,
        category: formatTyphoonCategoryLabel(currentCategory, tc.category),
        weakened, pressure, maxWind, maxGust, scale, intensity, speed, courseText, speedKmh,
      }));
      list.push({
        id: tc.tropicalCyclone, name: displayName,
        category: formatTyphoonCategoryLabel(currentCategory, tc.category),
        weakened, pressure, maxWind, maxGust, scale, intensity, speed, courseText, speedKmh, timeLabel,
        lon: centerPos[0], lat: centerPos[1],
        // 一覧タップ時のflyTo先で、地図に強風域(無ければ暴風域、それも無ければ台風の中心のみ)が
        // 収まるズーム倍率を計算するために使う。
        areaRadiusKm: galeRadiusKm || stormRadiusKm || null,
        areaLon: (galeRadiusKm ? galeCenter[0] : stormRadiusKm ? stormAreaCenter[0] : centerPos[0]),
        areaLat: (galeRadiusKm ? galeCenter[1] : stormRadiusKm ? stormAreaCenter[1] : centerPos[1]),
      });

      if (stormRadiusKm) {
        features.push(turf.circle(stormAreaCenter, stormRadiusKm, { steps: 64, units: "kilometers", properties: { type: "stormArea" } }));
      }

      if (galeRadiusKm) {
        features.push(turf.circle(galeCenter, galeRadiusKm, { steps: 64, units: "kilometers", properties: { type: "windArea" } }));
      }

      const pastTrack = [
        ...(current.track?.preTyphoon || []),
        ...(current.track?.typhoon || []),
      ].map(point => parseJMACoord(point)).filter(Boolean);
      if (pastTrack.length >= 2) features.push(turf.lineString(pastTrack, { type: "pastTrack" }));

      const forecastTrack = points.map(item => parseJMACoord(item.center)).filter(Boolean);
      if (forecastTrack.length >= 2) features.push(turf.lineString(forecastTrack, { type: "track" }));

      const stormWarningArea = buildStormWarningAreaFeature(turf, stormWarningSource?.stormWarningArea);
      if (stormWarningArea) features.push(stormWarningArea);

      const forecastCircles = [];
      const thinnedPoints = pickThinnedForecastPoints(points, forecastIntervalHours);
      // 間引き設定(interval)が原因なのか、半径の取得自体が失敗しているのかを
      // 実機ログだけで切り分けられるよう、対象台風ごとに1回だけ生の予報点一覧を出す。
      console.info(
        `台風予報円デバッグ[${tc.tropicalCyclone}]: forecastIntervalHours=${forecastIntervalHours}`,
        `advancedHours一覧=${points.map(p => p.advancedHours).join(",")}`,
        `間引き後=${thinnedPoints.map(p => p.advancedHours).join(",")}`
      );
      thinnedPoints.forEach(item => {
        const fPos = parseJMACoord(item.center);
        const radiusKm = getForecastCircleRadiusKm(item);
        if (!fPos || !radiusKm) {
          // 半径が取れなかった場合、原因調査用に生データのキー名だけをログに残す
          // (実機での不具合調査用。設定タブ「詳細設定」→「ログ」で確認できる)
          console.warn(
            "台風予報円: 半径を取得できなかった予報点をスキップしました",
            `advancedHours=${item.advancedHours}`,
            `keys=${Object.keys(item).join(",")}`
          );
          return;
        }

        const info = buildTyphoonForecastPointInfo(item, { tc, specifications, currentCategory, typhoonNo, name });
        const labelPoint = turf.destination(turf.point(fPos), radiusKm + 35, 45, { units: "kilometers" }).geometry.coordinates;
        const circle = turf.circle(fPos, radiusKm, {
          steps: 64, units: "kilometers",
          properties: { type: "forecastCircle", ...info, radiusKm: Math.round(radiusKm), labelPoint },
        });
        forecastCircles.push(circle);
        features.push(circle);
      });
      console.info(
        `台風予報円デバッグ[${tc.tropicalCyclone}]: 間引き後の予報点=${thinnedPoints.length}件 / 実際に円を作れた数=${forecastCircles.length}件`
      );
      // 台風一覧の詳細カードの下に「予報を時系列で並べたリスト」を出すため、
      // 円のジオメトリを持たないプレーンな配列としても保持しておく。
      // 地図の予報円は表示間隔設定で間引くが、このリストは間引かず、
      // advancedHours>0の予報点を全件載せる(半径が無くても一覧には出せるので
      // getForecastCircleRadiusKmが失敗する点も除外しない)。
      list[list.length - 1].forecasts = points
        .filter(item => item.advancedHours > 0)
        .map(item => {
          const info = buildTyphoonForecastPointInfo(item, { tc, specifications, currentCategory, typhoonNo, name });
          const radiusKm = getForecastCircleRadiusKm(item);
          return { ...info, radiusKm: radiusKm ? Math.round(radiusKm) : null };
        });

      if (forecastCircles.length > 0) {
        let previousCircle = turf.circle(centerPos, 1, { steps: 64, units: "kilometers" });
        let finalWarningArea = null;
        forecastCircles.forEach(circle => {
          const warningAreaSegment = turf.convex(turf.explode(turf.featureCollection([previousCircle, circle])));
          if (warningAreaSegment) {
            finalWarningArea = finalWarningArea ? (turf.union(finalWarningArea, warningAreaSegment) || finalWarningArea) : warningAreaSegment;
          }
          previousCircle = circle;
        });
        if (finalWarningArea) {
          finalWarningArea.properties = { type: "forecastArea" };
          features.push(finalWarningArea);
        }
      }
    });

    return { geojson: turf.featureCollection(features), list };
  } catch (e) {
    console.warn("[台風] データ取得に失敗:", e);
    return { geojson: turf.featureCollection([]), list: [] };
  }
}


// 404だったタイルURLの記録(モジュールスコープでアプリ全体を通じて使い回す)。
const nowcastFailedTileUrls = new Set();

let nowcastProtocolRegistered = false;
function registerNowcastProtocol(maplibregl) {
  if (nowcastProtocolRegistered) return;
  nowcastProtocolRegistered = true;
  maplibregl.addProtocol("jmanowc", async (params, abortController) => {
    const m = params.url.match(/^jmanowc:\/\/([a-z]+)\/(\d+)\/(\d+)\/(\d+)\/(-?\d+)\/(-?\d+)$/);
    if (!m) return { data: null };
    const [, schemeId, basetime, validtime, zStr, xStr, yStr] = m;
    let z = Number(zStr), x = Number(xStr), y = Number(yStr);
    const palette = NOWCAST_COLOR_SCHEMES[schemeId]?.palette || null;

    // 奇数ズームは1段階粗い偶数ズームのタイルを取得し、該当する象限だけを
    // 切り出して代用する。
    // (鮮明さ優先で「1段階細かいズームの子タイル4枚を縮小合成」する方式も
    // 試したが、通信量が4倍になって重かったため、軽いこちらの方式に戻した)
    let cropQuadrant = null; // {qx, qy} | null(0=左/上, 1=右/下)
    if (z % 2 !== 0) {
      cropQuadrant = { qx: x % 2, qy: y % 2 };
      z = z - 1;
      x = Math.floor(x / 2);
      y = Math.floor(y / 2);
    }
    const url = nowcastTileUrl(basetime, validtime, z, x, y);
    if (nowcastFailedTileUrls.has(url)) return { data: null };

    let res;
    try {
      res = await fetch(url, { signal: abortController.signal });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      return { data: null };
    }
    if (!res.ok) {
      if (res.status === 404) nowcastFailedTileUrls.add(url);
      return { data: null };
    }
    const blob = await res.blob();

    // 奇数ズームの切り出しも、配色変換も不要な場合だけ、そのまま素通しする
    // (canvas処理をまるごと省いた方が速いため)。
    if (!cropQuadrant && !palette) {
      return { data: await blob.arrayBuffer() };
    }

    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(256, 256);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    if (cropQuadrant) {
      ctx.drawImage(bitmap, cropQuadrant.qx * 128, cropQuadrant.qy * 128, 128, 128, 0, 0, 256, 256);
    } else {
      ctx.drawImage(bitmap, 0, 0, 256, 256);
    }
    if (palette) {
      const imageData = ctx.getImageData(0, 0, 256, 256);
      remapImageDataColors(imageData, palette);
      ctx.putImageData(imageData, 0, 0);
    }
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    return { data: await outBlob.arrayBuffer() };
  });
}

// 404だったタイルURLの記録(降水量用。雨雲レーダーと別集合にして、
// 診断メッセージが混ざらないようにする)。
const precipFailedTileUrls = new Set();

let precipProtocolRegistered = false;
function registerPrecipProtocol(maplibregl) {
  if (precipProtocolRegistered) return;
  precipProtocolRegistered = true;
  maplibregl.addProtocol("jmaprecip", async (params, abortController) => {
    const m = params.url.match(/^jmaprecip:\/\/([a-z0-9]+)\/([a-z]+)\/([a-z]+)\/(\d+)\/(\d+)\/(\d+)\/(-?\d+)\/(-?\d+)$/);
    if (!m) return { data: null };
    const [, mode, schemeId, member, basetime, validtime, zStr, xStr, yStr] = m;
    let z = Number(zStr), x = Number(xStr), y = Number(yStr);
    const palette = NOWCAST_COLOR_SCHEMES[schemeId]?.palette || null;

    // 奇数ズームは1段階粗い偶数ズームのタイルを取得し、該当する象限だけを
    // 切り出して代用する(雨雲レーダーと同じ方式)。
    let cropQuadrant = null;
    if (z % 2 !== 0) {
      cropQuadrant = { qx: x % 2, qy: y % 2 };
      z = z - 1;
      x = Math.floor(x / 2);
      y = Math.floor(y / 2);
    }
    const url = precipTileUrl(mode, member, basetime, validtime, z, x, y);
    if (precipFailedTileUrls.has(url)) return { data: null };

    let res;
    try {
      res = await fetch(url, { signal: abortController.signal });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      return { data: null };
    }
    if (!res.ok) {
      if (res.status === 404) {
        precipFailedTileUrls.add(url);
        console.warn(`降水量[${mode}]タイル 404: ${url}`);
      }
      return { data: null };
    }
    const blob = await res.blob();

    if (!cropQuadrant && !palette) {
      return { data: await blob.arrayBuffer() };
    }

    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(256, 256);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    if (cropQuadrant) {
      ctx.drawImage(bitmap, cropQuadrant.qx * 128, cropQuadrant.qy * 128, 128, 128, 0, 0, 256, 256);
    } else {
      ctx.drawImage(bitmap, 0, 0, 256, 256);
    }
    if (palette) {
      const imageData = ctx.getImageData(0, 0, 256, 256);
      remapImageDataColors(imageData, palette);
      ctx.putImageData(imageData, 0, 0);
    }
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    return { data: await outBlob.arrayBuffer() };
  });
}

// 404だったタイルURLの記録(天気分布予報用)。
const wdistFailedTileUrls = new Set();

let wdistProtocolRegistered = false;
function registerWdistProtocol(maplibregl) {
  if (wdistProtocolRegistered) return;
  wdistProtocolRegistered = true;
  maplibregl.addProtocol("jmawdist", async (params, abortController) => {
    const m = params.url.match(/^jmawdist:\/\/([a-z]+)\/([a-z]+)\/(\d+)\/(\d+)\/(-?\d+)\/(-?\d+)\/(-?\d+)$/);
    if (!m) return { data: null };
    const [, mode, member, basetime, validtime, zStr, xStr, yStr] = m;
    let z = Number(zStr), x = Number(xStr), y = Number(yStr);

    // 奇数ズームは1段階粗い偶数ズームのタイルを取得し、該当する象限だけを
    // 切り出して代用する(雨雲レーダー・降水量と同じ方式)。天気種別・気温の
    // 色分けは配色スキームに関係なく固定なので、色の変換(remapImageDataColors)は
    // 行わない。
    let cropQuadrant = null;
    if (z % 2 !== 0) {
      cropQuadrant = { qx: x % 2, qy: y % 2 };
      z = z - 1;
      x = Math.floor(x / 2);
      y = Math.floor(y / 2);
    }
    const url = wdistTileUrl(mode, member, basetime, validtime, z, x, y);
    if (wdistFailedTileUrls.has(url)) return { data: null };

    let res;
    try {
      res = await fetch(url, { signal: abortController.signal });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      return { data: null };
    }
    if (!res.ok) {
      if (res.status === 404) {
        wdistFailedTileUrls.add(url);
        console.warn(`${WDIST_MODE_CONFIG[mode]?.label || mode}タイル 404(要素名・URL構造の推測が外れている可能性があります): ${url}`);
      }
      return { data: null };
    }
    const blob = await res.blob();
    if (!cropQuadrant) return { data: await blob.arrayBuffer() };

    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(256, 256);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, cropQuadrant.qx * 128, cropQuadrant.qy * 128, 128, 128, 0, 0, 256, 256);
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    return { data: await outBlob.arrayBuffer() };
  });
}

/* ─────────────────────────────────────────────────────
   キキクル(危険度分布) — 土砂キキクル(land)・浸水キキクル(inund)。
   雨雲レーダー・降水量・天気分布予報と全く同じ考え方(独自プロトコルで
   奇数ズームを1段階粗い偶数ズームタイルの象限切り出しで代用)。JMAのPNGは
   既に危険度に応じて色分け済みなので、天気分布予報と同じく配色変換
   (remapImageDataColors)は行わない。
   ───────────────────────────────────────────────────── */
const RISK_DATA_BASE = "https://www.jma.go.jp/bosai/jmatile/data/risk";
const RISK_MODE_CONFIG = {
  doshaKikkuru: { element: "land",  label: "土砂キキクル", targetTimesUrl: `${RISK_DATA_BASE}/targetTimes.json` },
  inundKikkuru: { element: "inund", label: "浸水キキクル", targetTimesUrl: `${RISK_DATA_BASE}/targetTimes_N1.json` },
};
function riskTileUrl(mode, basetime, validtime, z, x, y) {
  const element = RISK_MODE_CONFIG[mode]?.element || "land";
  return `${RISK_DATA_BASE}/${basetime}/none/${validtime}/surf/${element}/${z}/${x}/${y}.png`;
}
function riskProtocolUrl(mode, basetime, validtime) {
  return `jmarisk://${mode}/${basetime}/${validtime}/{z}/{x}/{y}`;
}

// modeの時刻一覧を取得する。[{ basetime, validtime }, ...] を時系列昇順で返す。
// 浸水(inund)はtargetTimes_N1.jsonが本来のエンドポイントだが、無ければ
// targetTimes.json(土砂と同じ)にフォールバックする(旧ツールと同じ考え方)。
async function loadRiskFrames(mode) {
  const config = RISK_MODE_CONFIG[mode] || RISK_MODE_CONFIG.doshaKikkuru;
  const label = config.label;
  let url = config.targetTimesUrl;
  let raw;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (err) {
    if (url !== RISK_MODE_CONFIG.doshaKikkuru.targetTimesUrl) {
      console.warn(`${label}: 時刻一覧の取得に失敗、targetTimes.jsonにフォールバックします url=${url}`, err);
      url = RISK_MODE_CONFIG.doshaKikkuru.targetTimesUrl;
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
      } catch (err2) {
        console.warn(`${label}: フォールバック先の時刻一覧取得にも失敗 url=${url}`, err2);
        throw err2;
      }
    } else {
      console.warn(`${label}: 時刻一覧の取得に失敗 url=${url}`, err);
      throw err;
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    console.warn(`${label}: 時刻一覧が空、または想定外の形式です url=${url}`, raw);
    return [];
  }
  return raw
    .filter(t => t && t.basetime && t.validtime)
    .sort((a, b) => String(a.validtime).localeCompare(String(b.validtime)))
    .map(t => ({ basetime: t.basetime, validtime: t.validtime }));
}

function formatRiskFrameLabel(frame) {
  if (!frame) return "";
  const time = parseNowcastValidTime(frame.validtime);
  if (!time) return "";
  return `${time} 実況`;
}

// 404だったタイルURLの記録(キキクル用)。
const riskFailedTileUrls = new Set();

let riskProtocolRegistered = false;
function registerRiskProtocol(maplibregl) {
  if (riskProtocolRegistered) return;
  riskProtocolRegistered = true;
  maplibregl.addProtocol("jmarisk", async (params, abortController) => {
    const m = params.url.match(/^jmarisk:\/\/([a-zA-Z]+)\/(\d+)\/(\d+)\/(-?\d+)\/(-?\d+)\/(-?\d+)$/);
    if (!m) return { data: null };
    const [, mode, basetime, validtime, zStr, xStr, yStr] = m;
    let z = Number(zStr), x = Number(xStr), y = Number(yStr);

    // 奇数ズームは1段階粗い偶数ズームのタイルを取得し、該当する象限だけを
    // 切り出して代用する(雨雲レーダー・降水量・天気分布予報と同じ方式)。
    let cropQuadrant = null;
    if (z % 2 !== 0) {
      cropQuadrant = { qx: x % 2, qy: y % 2 };
      z = z - 1;
      x = Math.floor(x / 2);
      y = Math.floor(y / 2);
    }
    const url = riskTileUrl(mode, basetime, validtime, z, x, y);
    if (riskFailedTileUrls.has(url)) return { data: null };

    let res;
    try {
      res = await fetch(url, { signal: abortController.signal });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      return { data: null };
    }
    if (!res.ok) {
      if (res.status === 404) riskFailedTileUrls.add(url);
      return { data: null };
    }
    const blob = await res.blob();

    if (!cropQuadrant) return { data: await blob.arrayBuffer() };

    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(256, 256);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, cropQuadrant.qx * 128, cropQuadrant.qy * 128, 128, 128, 0, 0, 256, 256);
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    return { data: await outBlob.arrayBuffer() };
  });
}


/* ─────────────────────────────────────────────────────
   河川水位観測所(国管理・主要河川、stg)。国交省「川の防災情報」(kawabou)
   アプリ自身が使っている静的生成JSONを、Cloudflare Workersのプロキシ経由で
   取得する(www.river.go.jpは直接fetchするとCORSでブロックされるため、実機
   検証で判明済み)。プロキシはエッジキャッシュ(5分)を効かせており、複数端末
   からの同時アクセスでもriver.go.jp側への実リクエストは最小限に抑えている。
   実機検証の結果、概観・市区町村単位一覧は/kawabou/file/gjson配下だが、
   時系列(tmlist)だけ/kawabou/file/files配下だったため、ベースを分けている。
   ───────────────────────────────────────────────────── */
const RIVER_PROXY_BASE = "https://meteoquake-river-proxy.meteoquake-river.workers.dev";
const RIVER_GJSON_BASE = `${RIVER_PROXY_BASE}/kawabou/file/gjson`;
const RIVER_FILES_BASE = `${RIVER_PROXY_BASE}/kawabou/file/files`;

// 危険度レベル(stg_ovlvl、10刻み想定)→ ラベル・色。他の危険度分布(キキクル・
// 警報)と統一感を持たせつつ、6段階に対応させる。
const RIVER_LEVEL_STEPS = [
  { level: 90, label: "氾濫発生",   color: "#140014" },
  { level: 80, label: "氾濫危険",   color: "#aa00aa" },
  { level: 40, label: "避難判断",   color: "#ff2800" },
  { level: 20, label: "氾濫注意",   color: "#f2e700" },
  { level: 10, label: "水防団待機", color: "#35a86b" },
  { level: 0,  label: "通常",       color: "#66ccff" },
];
function riverLevelInfo(stgOvlvl) {
  if (stgOvlvl == null) return { label: "欠測", color: "#c8c8cb" };
  for (const step of RIVER_LEVEL_STEPS) {
    if (stgOvlvl >= step.level) return step;
  }
  return RIVER_LEVEL_STEPS[RIVER_LEVEL_STEPS.length - 1];
}

// kawabouのgetDatePath()と同じ考え方(YYYYMMDD/HHmm/)。10分刻みに切り捨てる。
// Date.getTime()は元々タイムゾーンに関係ない絶対時刻(UTC epoch ms)なので、
// ローカルタイムゾーン分の補正(getTimezoneOffset())は不要かつ有害
// (端末のタイムゾーンがJSTだと9時間分が二重に足されてしまうバグの元だった)。
// 単純に+9時間してUTC getterでJSTの日時として読み出せば良い。
function riverDatePath(date) {
  const d = new Date(date.getTime() + 9 * 60 * 60000); // JST化
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const roundedMin = Math.floor(d.getUTCMinutes() / 10) * 10;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(roundedMin).padStart(2, "0");
  return { ymd: `${yyyy}${mm}${dd}`, hm: `${hh}${mi}` };
}

// 全国・基準超過(水防団待機水位以上)のみの概観一覧。生成が数分遅れることが
// あるため、現在時刻から10分刻みで最大6コマ(1時間分)遡って最初に成功した
// ものを使う。
async function loadRiverOverview() {
  // 直近のコマはまだファイルが生成されていない(サイト側の生成タイミングに
  // ラグがある)可能性が高いため、最初から10分遅れのコマから試す。
  const now = new Date(Date.now() - 10 * 60000);
  for (let back = 0; back < 6; back++) {
    const t = new Date(now.getTime() - back * 10 * 60000);
    const { ymd, hm } = riverDatePath(t);
    const url = `${RIVER_GJSON_BASE}/overobs/stg/${ymd}/${hm}/over-obs-create.json`;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const geojson = await res.json();
      if (geojson && Array.isArray(geojson.features)) return geojson;
    } catch (err) {
      if (back === 0) console.warn("河川水位(概観)の取得に失敗:", url, err);
    }
  }
  console.warn("河川水位(概観)の取得に失敗: 直近1時間分すべてダメでした");
  return { type: "FeatureCollection", features: [] };
}

// 市区町村単位・全件(通常水位の地点も含む)。twnCdは警報タブで既に持っている
// 市区町村コードをそのまま使う想定(桁数が違う場合は要調整、実機未確認)。
async function loadRiverStationsByTown(twnCd) {
  // 概観と同じく、最初から10分遅れのコマから試す。
  const now = new Date(Date.now() - 10 * 60000);
  for (let back = 0; back < 6; back++) {
    const t = new Date(now.getTime() - back * 10 * 60000);
    const { ymd, hm } = riverDatePath(t);
    const url = `${RIVER_GJSON_BASE}/obs/${ymd}/${hm}/stg/${twnCd}.json`;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const geojson = await res.json();
      if (geojson && Array.isArray(geojson.features)) return geojson;
    } catch {
      // 次のコマにフォールバック
    }
  }
  return { type: "FeatureCollection", features: [] };
}

// 河川水位観測所の基準水位(氾濫注意水位・避難判断水位・氾濫危険水位・氾濫水位
// など)は、全国概観(over-obs-create.json)には含まれておらず、市区町村単位の
// エンドポイント(obs/.../stg/{twnCd}.json)にしか無いと実機検証で判明した。
// ただしそちらのtwn_cdは、タップした観測所(全国概観由来)からは直接分からない
// ため、座標から警報タブで既に読み込んでいる市区町村境界(1,821件)に対して
// 点内判定を行い、regioncode(=twn_cdと同じ全国地方公共団体コード体系のはず、
// 実機未確認)を逆引きする。
async function findTwnCdForPoint(lon, lat) {
  if (lon == null || lat == null) {
    console.warn("[河川/基準水位] 座標が無いため逆引きできません", { lon, lat });
    return null;
  }
  const areas = await loadWarningAreas();
  for (const area of areas) {
    const [minLon, minLat, maxLon, maxLat] = area.bbox || [];
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
    if (pointInGeoJsonGeometry(lon, lat, area.geometry)) return area.properties.regioncode;
  }
  console.warn("[河川/基準水位] 座標から市区町村を特定できませんでした", { lon, lat, areasCount: areas.length });
  return null;
}

// 観測所の基準水位一式(あれば)を取得する。twn_cdの逆引き→市区町村単位一覧の
// 取得→obs_fcdが一致する地点の抽出、という3段構え。どこかで失敗してもnullを
// 返すだけで例外は投げない(グラフ自体は基準水位が無くても表示できるため)。
async function loadRiverStationThresholds(properties) {
  const twnCd = await findTwnCdForPoint(properties.__lon, properties.__lat);
  if (!twnCd) return null;
  const geojson = await loadRiverStationsByTown(twnCd);
  console.log(`[河川/基準水位] twnCd=${twnCd} ${geojson.features?.length ?? 0}件取得、obs_fcd=${properties.obs_fcd}を探索中`);
  const match = (geojson.features || []).find(f => f.properties?.obs_fcd === properties.obs_fcd);
  if (!match) {
    console.warn("[河川/基準水位] 市区町村単位一覧の中にobs_fcdが見つかりませんでした", {
      obs_fcd: properties.obs_fcd,
      twnCd,
      sampleFcds: (geojson.features || []).slice(0, 5).map(f => f.properties?.obs_fcd),
    });
    return null;
  }
  const p = match.properties;
  console.log("[河川/基準水位] 一致した地点のproperties:", p);
  // 実機検証で判明したフィールド名。水防法の基準水位5段階に相当すると推測:
  // rsrv_stg=水防団待機水位, warn_stg=氾濫注意水位, spcl_warn_stg=避難判断水位,
  // dng_stg=氾濫危険水位, fld_stg=氾濫水位(氾濫開始水位)。
  return {
    rsrv_stg: p.rsrv_stg ?? null,
    warn_stg: p.warn_stg ?? null,
    spcl_warn_stg: p.spcl_warn_stg ?? null,
    dng_stg: p.dng_stg ?? null,
    fld_stg: p.fld_stg ?? null,
  };
}


// 個別観測所の時系列(水位グラフ用)。実機検証で、ベースは/kawabou/file/files
// (gjsonではない)、引数はobs_fcd(13桁のフルコード)と判明済み。
async function loadRiverStationSeries(obsFcd, obsCd) {
  const { ymd } = riverDatePath(new Date());
  const url = `${RIVER_FILES_BASE}/tmlist/past/stg/${ymd}/${obsFcd}.json`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) return await res.json();
    console.warn("河川水位の時系列取得に失敗(HTTPエラー):", url, res.status);
  } catch (err) {
    console.warn("河川水位の時系列取得に失敗:", url, err);
  }
  return null;
}

/* ─────────────────────────────────────────────────────
   MAPLIBREスタイル生成
   ローカルのworld.json(GeometryCollection)・prefectures.json(FeatureCollection)を
   そのままGeoJSONソースとしてMapLibreに渡し、ダークテーマで塗り分ける。
   外部タイルサーバー・外部スタイルには一切依存しない。

   areas(細分区域.json)は、気象庁の細分区域ごとの震度分布を塗るためのソース。
   実際の色は震度分布モードがONの間だけ、feature-state(setFeatureState)で
   区域ごとに動的に設定する。ここでは初期値(無色・透明)のレイヤーだけ用意しておく。
   ───────────────────────────────────────────────────── */
function buildMapStyle({ world, prefectures, areas }, mapColors = THEME_TOKENS.dark) {
  return {
    version: 8,
    sources: {
      world: { type: "geojson", data: world },
      prefectures: { type: "geojson", data: prefectures },
      // idをproperties.code(気象庁の細分区域コード)に昇格しておくことで、
      // setFeatureState({ source: "areas", id: code }, ...) で個別に塗り分けできる。
      areas: { type: "geojson", data: areas, promoteId: "code" },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": mapColors.mapBg } },
      {
        id: "world-fill", type: "fill", source: "world",
        paint: { "fill-color": mapColors.mapWorldFill },
      },
      {
        id: "world-line", type: "line", source: "world",
        paint: { "line-color": mapColors.mapWorldLine, "line-width": 0.5 },
      },
      {
        id: "prefectures-fill", type: "fill", source: "prefectures",
        paint: { "fill-color": mapColors.mapPrefFill },
      },
      {
        id: "prefectures-line", type: "line", source: "prefectures",
        paint: { "line-color": mapColors.mapPrefLine, "line-width": 0.6 },
      },
      {
        // 震度分布(細分区域ごとの塗り分け)。feature-stateが無い区域は透明のまま。
        id: "areas-intensity-fill", type: "fill", source: "areas",
        paint: {
          "fill-color": ["coalesce", ["feature-state", "color"], "rgba(0,0,0,0)"],
          "fill-opacity": 0.75,
        },
      },
      {
        id: "areas-intensity-line", type: "line", source: "areas",
        paint: {
          "line-color": "rgba(0,0,0,0.35)",
          "line-width": ["coalesce", ["feature-state", "hasIntensity"], 0],
        },
      },
    ],
  };
}

/* ─────────────────────────────────────────────────────
   観測点の丸+観測された津波の高さバーを、1枚のアイコンにまとめて描画する。
   まとめる理由: バー(symbolレイヤー)と観測点の丸(circleレイヤー)を別々のレイヤーに
   分けたままだと、MapLibreは「レイヤー単位」でしか重なり順を制御できない
   (同じレイヤー内の重なり順はsymbol-sort-key等で調整できても、レイヤーをまたいだ
   重なり順=どちらのレイヤーが手前かは常に固定になってしまう)。そのため、
   「より南のバーが、より北の丸より手前に来る」ような、地物ごとに入り組んだ重なり順を
   実現するには、丸とバーを同じレイヤーの同じ地物(=1枚のアイコン)として描く必要がある。
   地図の座標オフセットで長さを表現する線分だと、ズームするたびに実際の距離のまま
   拡大縮小されて見た目の長さが変わってしまうため、キャンバスに描いた画像をアイコンと
   して貼り付けるsymbolレイヤー(icon-size固定)にしている。丸の直径・バーの太さは
   観測点の丸(circle-radius)と揃えたいので、丸の半径と全く同じズーム連動の式
   (TSUNAMI_BAR_WIDTH_STOPS)を使い、ズーム段階が変わった時だけアイコンを差し替える。
   ───────────────────────────────────────────────────── */
function roundRectPath(ctx, x, y, w, h, topR, bottomR = topR) {
  const tr = Math.max(0, Math.min(topR, w / 2, h / 2));
  const br = Math.max(0, Math.min(bottomR, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + tr, y);
  ctx.arcTo(x + w, y, x + w, y + h, tr);   // 右上
  ctx.arcTo(x + w, y + h, x, y + h, br);   // 右下
  ctx.arcTo(x, y + h, x, y, br);           // 左下
  ctx.arcTo(x, y, x + w, y, tr);           // 左上
  ctx.closePath();
}

// 観測点の丸(tide-station-points-layerの非選択時circle-radius)と全く同じズーム段階・
// 半径の組み合わせ(直径に換算済み)。バーの太さ・アイコン内の丸の直径をこれに揃える。
const TSUNAMI_BAR_WIDTH_STOPS = [[4, 9], [8, 11], [12, 14], [16, 19]]; // [zoom, 直径px]
function tsunamiBarWidthForZoom(zoom) {
  const stops = TSUNAMI_BAR_WIDTH_STOPS;
  if (zoom <= stops[0][0]) return stops[0][1];
  if (zoom >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [z0, w0] = stops[i], [z1, w1] = stops[i + 1];
    if (zoom >= z0 && zoom <= z1) return w0 + ((zoom - z0) / (z1 - z0)) * (w1 - w0);
  }
  return stops[stops.length - 1][1];
}

// heightM(観測された津波の高さ、実測のm)から、バー本体の長さ(CSSピクセル)を
// 求める式。「高さと長さが比例する」という要件どおり、0mの時に0px・maxMの時に
// maxPxになる単純な比例式にしている(以前は最小の高さ(negligibleM)の時に
// minPxになる、原点を通らない式だったため、高さを2倍にしても長さが2倍にならない
// 問題があった)。目盛りの位置も同じ式を使うので、自動的に等間隔になる。
function tsunamiBarPxForHeight(heightM, geom) {
  const { maxPx, maxM } = geom;
  const h = Math.max(0, Math.min(heightM, maxM));
  return (h / maxM) * maxPx;
}

// (丸の色, バーの色, 高さ, 太さ, 選択状態)の組み合わせごとにキャンバスへ描画し、
// map.addImageで登録して使い回す。heightMがnull/undefinedの間はバー無し(丸だけ)。
// 同じ組み合わせなら2回目以降は再描画せずキャッシュを返す。
// アイコンの見た目を変える修正をするたびに、この値を上げる。map.addImageは
// マップのインスタンスが生きている間ずっと使い回されるため、IDの構成が同じままだと
// (ページを再読み込みしない限り)古い見た目のアイコンがキャッシュされたまま
// 残ってしまうことがある。バージョンをキーに含めておくことで、コードを直しても
// 必ず新しい見た目で再描画されるようにする。
const TSUNAMI_ICON_VERSION = 5;

// 白縁の太さ(CSSピクセル)。アイコン生成側だけでなく、呼び出し側(MapCanvasのrender)
// でもicon-offsetの計算に同じ値が必要なため、モジュールスコープで共有する。
const TSUNAMI_ICON_BORDER = 2;

function tsunamiStationIconId(map, color, heightM, dotDiameterPx, barWidthPx, geom, selected) {
  const BORDER = TSUNAMI_ICON_BORDER;
  const DOT_D = Math.max(4, Math.round(dotDiameterPx));
  const BAR_W = Math.max(4, Math.round(barWidthPx));
  const fillColor = selected ? "#FF9F0A" : color;
  const hasBar = heightM != null;

  const heightPx = hasBar ? tsunamiBarPxForHeight(Math.min(heightM, geom.maxM), geom) : 0;
  // 矩形の高さ(=バーの長さ)は、見た目の変化を細かく反映できるよう1px単位で丸める
  // (4px単位でまとめていると、0.1m刻みの入力では見た目が変わらないことがあったため)。
  const bucket = hasBar ? Math.max(4, Math.round(heightPx)) : 0; // 4px未満は描画上の下限(比例関係をなるべく保つため最小限に)
  // 目盛りの位置計算にはheightMそのものを使うので、キャッシュキーにも含めておく。
  // 切り上げてしまうと「まだ届いていない目盛り」が出てしまうため、必ず切り捨てる
  // (0.47mを0.5m相当として点を打ってしまう、といった誤差を防ぐ)。
  const heightM10 = hasBar ? Math.floor(Math.min(heightM, geom.maxM) * 10 + 1e-6) : -1;

  const id = `tsunami-station-icon-v${TSUNAMI_ICON_VERSION}-${fillColor.replace("#", "")}-${DOT_D}-${hasBar ? `${BAR_W}-${bucket}-${heightM10}` : "nobar"}`;
  if (map.hasImage(id)) return id;

  const pixelRatio = typeof window !== "undefined" && window.devicePixelRatio ? Math.min(window.devicePixelRatio, 3) : 1;
  const contentW = Math.max(DOT_D, BAR_W);
  const totalW = contentW + BORDER * 2;
  const totalH = DOT_D + bucket + BORDER * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(totalW * pixelRatio);
  canvas.height = Math.ceil(totalH * pixelRatio);
  const ctx = canvas.getContext("2d");
  ctx.scale(pixelRatio, pixelRatio);

  const cx = totalW / 2;
  const dotCy = totalH - BORDER - DOT_D / 2; // 一番下 = 観測点そのものの位置
  const dotTopY = dotCy - DOT_D / 2; // 観測点の丸の上端

  if (hasBar) {
    // バーは観測点の丸に食い込ませず、丸の上端からちょうど数えた長さになるようにする
    // (以前は少し丸に重ねていたため、重なった分だけ見た目の長さが短くなっていた)。
    // 見た目の長さ(bucket)は、これまで通り丸の上端(dotTopY)からの距離として保つ
    // (目盛りの位置もdotTopY基準のまま)。ただし実際に塗る矩形は、丸の中心(dotCy)まで
    // 深く伸ばしておく。ぴったり同じ座標・わずかな重なり(前回の1.5px)でも、
    // キャンバスのアンチエイリアシングにより境目に細い隙間が見えることがあったため、
    // 丸の半径ぶんまるごと重ねて、後から描く丸で確実に覆い隠すようにする
    // (丸の中心より下には塗らないので、丸の下側からはみ出すことはない)。
    const barTopY = dotTopY - bucket;
    const barBottomY = dotCy;
    const drawnH = barBottomY - barTopY; // 見た目にはdotTopYより下は丸に隠れて見えない
    const TOP_CORNER_R = 3;
    roundRectPath(
      ctx,
      cx - BAR_W / 2 - BORDER, barTopY - BORDER,
      BAR_W + BORDER * 2, drawnH + BORDER,
      TOP_CORNER_R + BORDER, 0
    );
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    roundRectPath(ctx, cx - BAR_W / 2, barTopY, BAR_W, drawnH, TOP_CORNER_R, 0);
    ctx.fillStyle = fillColor;
    ctx.fill();

    // 0.5m刻みの目盛り(白い点)。丸の上端(dotTopY)を基準に、実際の高さの
    // 0.5, 1.0, 1.5m…の位置へ、バー全体の長さと同じ式で点を打つ。観測された高さを
    // 超える位置には打たない。1.0mごと(1.0, 2.0, 3.0m…)は少し濃く、0.5m刻みの
    // 残り(0.5, 1.5, 2.5m…)は薄く描いて、読み取りやすくする。
    const exactHeightM = heightM10 / 10;
    for (let h = 0.5; h <= exactHeightM + 1e-9; h += 0.5) {
      // 先端(=観測点の高さちょうど)にほぼ一致する点まで、必ず描く。棒の外にはみ出さない
      // よう、先端付近だけ位置をわずかにクランプする(以前は先端付近を丸ごと除外して
      // いたため、ちょうど0.5m単位の高さの時に最後の点が消えてしまっていた)。
      const d = Math.min(tsunamiBarPxForHeight(h, geom), bucket - 1);
      const isWholeMeter = Math.round(h * 10) % 10 === 0;
      ctx.fillStyle = isWholeMeter ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.arc(cx, dotTopY - d, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 観測点の丸(白縁+本体色)。バーより後に描くことで、バーの根本に重なって
  // 一体感のある土台に見える。
  ctx.beginPath();
  ctx.arc(cx, dotCy, DOT_D / 2 + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, dotCy, DOT_D / 2, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();

  map.addImage(id, ctx.getImageData(0, 0, canvas.width, canvas.height), { pixelRatio });
  return id;
}

/* ─────────────────────────────────────────────────────
   MAP CANVAS — MapLibre GL JS(描画エンジン) + ローカルGeoJSON(データ)
   世界(world.json)・都道府県(prefectures.json)をベクターとして描画する。
   外部タイル・外部スタイルサーバーには依存しない。
   ───────────────────────────────────────────────────── */
function MapCanvas({
  onReady, stationPoints, hypocenters, isWide,
  quakeTimeStr, maxIntensityKey, estIntensityEnabled, areaFillEnabled,
  faultsEnabled, plateBoundariesEnabled, boundaryLineColorId,
  epicenterPoints = [], onSelectEpicenterPoint,
  pointsLoading = false, epicenterLoading = false,
  tsunamiAreas = [],
  stationMarkersVisible = true,
  tideStationPoints = [], onSelectTideStation, selectedTideStationCode,
  tsunamiHeightBars = [], tideStationBarsMode = false,
  tideStationsInteractive = true,
  tsunamiAreaPickActive = false, onPickTsunamiArea, pickedTsunamiAreas = [],
  eews = [],
  eewEpicenterPickActive = false, onPickEewEpicenter,
  quakeEpicenterPickActive = false, onPickQuakeEpicenter,
  eewDetailOpen = false,
  currentLocationPoint = null, // { lat, lon } | null。気象タブ「地点」モード中のGPS現在地(iOS風の青丸)
  nowcastVisible = false,      // 雨雲レーダーレイヤーを表示するか
  nowcastFrame = null,         // { basetime, validtime } | null。表示中の時刻コマ
  nowcastPreloadFrames = [],   // 前後の先読み対象コマ({basetime,validtime}の配列)。
                                // タイルをバックグラウンドで読み込んでおき、切り替え時に一瞬消えるのを防ぐ
  nowcastKnownValidtimes = [], // 実況+予測の現在の全validtime一覧。この一覧に無くなった
                                // (=特に予測コマで一覧更新のたびに起きる)キャッシュ済みレイヤーの掃除に使う
  nowcastColorSchemeId = "jma", // 雨雲レーダーの配色スキームID
  precipVisible = false,        // 1/3/24時間降水量レイヤーを表示するか
  precipMode = null,            // "precip1h" | "precip3h" | "precip24h" | null
  precipFrame = null,           // { basetime, validtime, member } | null。表示中の時刻コマ
  precipKnownValidtimes = [],   // 現在のモードの全validtime一覧。この一覧に無くなった
                                 // (5分おきの一覧更新でありうる)キャッシュ済みレイヤーの掃除に使う
  wdistVisible = false,         // 天気分布予報レイヤーを表示するか
  wdistMode = null,             // "weather" | "temperature" | null
  wdistFrame = null,            // { basetime, validtime, member } | null。表示中の時刻コマ
  wdistKnownValidtimes = [],    // 現在のモードの全validtime一覧。キャッシュ済みレイヤーの掃除に使う
  typhoonVisible = false,       // 台風情報レイヤーを表示するか
  typhoonGeojson = null,        // fetchTyphoonData()が返すgeojson({type:"FeatureCollection"})| null
  onSelectTyphoonCenter,        // 台風の中心点/予報円をタップした時にpropertiesを渡すコールバック
  typhoonFlyToRequest = null,   // {lon, lat, nonce} | null。台風一覧の項目をタップした時のflyTo先
  warningVisible = false,       // 警報タブ: 警報・注意報レイヤーを表示するか(警報タブがアクティブな間だけtrue)
  warningLevelMap = {},         // 警報タブ: regioncode → {level, kinds} のマップ(App側でポーリング取得)
  selectedWarningArea = null,   // 警報タブ: タップ/一覧選択中のregioncode | null。選択中のエリアを地図上で強調する
  onSelectWarningArea,          // 警報タブ: 地図の塗り分けをタップした時に呼ぶコールバック(regioncodeを渡す)
  warningAreaFlyToRequest = null, // 警報タブ: {lon, lat, nonce} | null。一覧の項目をタップした時のflyTo先
  riskVisible = false,          // 警報タブ: キキクル(土砂/浸水)レイヤーを表示するか
  riskMode = null,              // "doshaKikkuru" | "inundKikkuru" | null
  riskFrame = null,             // { basetime, validtime } | null。表示中の時刻コマ
  riskKnownValidtimes = [],     // 現在のモードの全validtime一覧。この一覧に無くなったキャッシュ済みレイヤーの掃除に使う
  riverVisible = false,         // 警報タブ: 河川水位観測所レイヤーを表示するか
  riverStations = null,         // GeoJSON FeatureCollection(river.go.jpのstg概観)| null
  selectedRiverStation = null,  // タップ中の観測所のproperties | null。地図上で強調表示に使う
  onSelectRiverStation,         // 河川水位観測所のピンをタップした時に呼ぶコールバック(propertiesを渡す)
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [errorMsg, setErrorMsg] = useState("");
  // 現在選択中の震度配色スキーム。観測点マーカー・震度分布の塗り分けの両方で使う。
  const colorSchemeId = useContext(QuakeColorSchemeContext);
  const colorScheme = QUAKE_COLOR_SCHEMES[colorSchemeId] || QUAKE_COLOR_SCHEMES.fill;
  // 震央分布(circleレイヤー)は map.on("load") 内(初回マウント時のみ実行)で
  // 作るため、生成時点の最新配色をrefで参照できるようにしておく
  // (切り替え時の反映は別のuseEffectでsetPaintPropertyする。下方)。
  const colorSchemeRef = useRef(colorScheme);
  colorSchemeRef.current = colorScheme;

  // 震央分布の丸をホバー/タッチした時に出す簡易ツールチップ。
  // { x, y, title, text } | null。x,yは地図コンテナ基準のスクリーン座標
  // (MapLibreのe.pointがそのままその座標系なので、変換不要で使える)。
  const [epicenterTooltip, setEpicenterTooltip] = useState(null);

  // 地図に塗られている緊急地震速報の予想震度のうち、最も低いものと最も高いもの。
  // {minKey, maxKey} | null(何も塗られていない時)。右上の凡例表示に使う。
  const [eewFillRange, setEewFillRange] = useState(null);

  // 震央分布の丸をタップした時に呼ぶ選択コールバック。
  // map.on("load")内の登録は初回マウント時の1回きりなので、refで最新の
  // 関数を参照できるようにしておく。
  const onSelectEpicenterPointRef = useRef(onSelectEpicenterPoint);
  onSelectEpicenterPointRef.current = onSelectEpicenterPoint;
  const onSelectTideStationRef = useRef(onSelectTideStation);
  onSelectTideStationRef.current = onSelectTideStation;
  // 警報タブ: 警報・注意報レイヤーをタップした時のコールバック。他のタップ系
  // コールバックと同様、map.on("load")内の登録は初回マウント時の1回きりなので
  // refで最新の関数を参照できるようにしておく。
  const onSelectWarningAreaRef = useRef(onSelectWarningArea);
  onSelectWarningAreaRef.current = onSelectWarningArea;
  const onSelectRiverStationRef = useRef(onSelectRiverStation);
  onSelectRiverStationRef.current = onSelectRiverStation;
  const tideStationsInteractiveRef = useRef(tideStationsInteractive);
  tideStationsInteractiveRef.current = tideStationsInteractive;
  // 台風の中心点/予報円をタップした時のコールバック。map.on("load")内の登録は
  // 初回マウント時の1回きりなので、他のピック系コールバックと同様にrefで最新を参照する。
  const onSelectTyphoonCenterRef = useRef(onSelectTyphoonCenter);
  onSelectTyphoonCenterRef.current = onSelectTyphoonCenter;
  // 予報円の横に出す時刻ラベル(maplibregl.Marker)。map.on("load")の外(typhoonGeojsonが
  // 変わるたびに動くuseEffect)で作り直すため、現在出しているマーカーの配列をrefで保持する。
  const typhoonForecastMarkersRef = useRef([]);

  // 津波予報区の「地図タップで選択」モード用。map.on("load")内の登録は初回のみなので、
  // 最新のモードON/OFF・コールバック・読み込み済みデータをrefで参照できるようにする。
  const tsunamiAreaPickActiveRef = useRef(tsunamiAreaPickActive);
  tsunamiAreaPickActiveRef.current = tsunamiAreaPickActive;
  const onPickTsunamiAreaRef = useRef(onPickTsunamiArea);
  onPickTsunamiAreaRef.current = onPickTsunamiArea;
  const eewEpicenterPickActiveRef = useRef(eewEpicenterPickActive);
  eewEpicenterPickActiveRef.current = eewEpicenterPickActive;
  const onPickEewEpicenterRef = useRef(onPickEewEpicenter);
  onPickEewEpicenterRef.current = onPickEewEpicenter;
  // 地震情報テスト配信の「地図をタップして震源を指定」モード用。EEWのピックモードと
  // 同じ考え方・同じep.jsonの震央地名検索を共有し、activeな方だけ反応させる(両方
  // 同時にONにはならない)。
  const quakeEpicenterPickActiveRef = useRef(quakeEpicenterPickActive);
  quakeEpicenterPickActiveRef.current = quakeEpicenterPickActive;
  const onPickQuakeEpicenterRef = useRef(onPickQuakeEpicenter);
  onPickQuakeEpicenterRef.current = onPickQuakeEpicenter;
  // 震央地名データは、緊急地震速報テスト配信のピックモードが最初にONになった時だけ
  // 遅延読み込みする(実験的機能なので、使わないユーザーには一切通信させない)。
  const epicenterNamesGeoDataRef = useRef(null);
  const epicenterNamesLoadedRef = useRef(false);
  const tsunamiAreasGeoDataRef = useRef(null);
  // 地図の基本配色(海・陸・都道府県境界線)。ライト/ダークモードで切り替える。
  const { tokens: themeTokens, mode } = useContext(ThemeContext);
  const tokens = themeTokens; // 下方で自動変換されたtokens.*参照のためのエイリアス
  // マップ生成(下のuseEffect本体)は[]依存で一度きりしか走らないため、
  // 生成時点の最新トークンをrefで参照する。切り替え時の反映は
  // 別のuseEffectでsetPaintPropertyして行う(下方)。
  const themeTokensRef = useRef(themeTokens);
  themeTokensRef.current = themeTokens;
  // 震央分布の縁取り色(震度1・気象庁配色のみライトモードで黒にする)の判定に、
  // 生成時点のライト/ダーク状態も同様にrefで参照できるようにしておく。
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // 断層・プレート境界の「枠内の色」の現在値をrefでも持っておき、
  // map.on("load")内(初回マウント時のみ実行)で最新の選択値を読めるようにする。
  const boundaryLineColorIdRef = useRef(boundaryLineColorId);
  boundaryLineColorIdRef.current = boundaryLineColorId;

  useEffect(() => {
    let cancelled = false;

    Promise.all([loadMapLibre(), loadGeoData()])
      .then(([maplibregl, geo]) => {
        if (cancelled || !containerRef.current) return;
        registerNowcastProtocol(maplibregl);
        registerPrecipProtocol(maplibregl);
        registerWdistProtocol(maplibregl);
        registerRiskProtocol(maplibregl);

        let map;
        try {
          map = new maplibregl.Map({
            container: containerRef.current,
            style: buildMapStyle(geo, themeTokensRef.current),
            center: [138.0, 38.0], // 日本全体が収まる中心付近
            zoom: 4.5,
            pitch: 0,
            attributionControl: false,
            // ナビゲーション操作はLiquid Glassの自前ボタンで行うため
            // 標準コントロールはあえて追加しない

            // preserveDrawingBuffer: true
            // MapLibreのWebGL canvasはデフォルトだと描画直後にdrawing bufferを
            // 破棄してよいことになっている(次フレームでどうせ描き直すため)。
            // 通常表示ではこれで問題ないが、backdrop-filterはブラウザの
            // コンポジタが「今画面に出ている見た目」をその都度スナップショット
            // して読みに行く処理であり、Windows Chromium(ANGLE/D3D11経由)の
            // GPUコンポジットのタイミングによっては、そのスナップショットの
            // 瞬間にはすでにbufferがクリア済み=空、ということが起こり得る。
            // これが「backdrop-filterのガラスパネルの中だけWebGL地図が
            // 全く映らず完全に透ける」症状の典型的な原因のひとつ。
            // preserveDrawingBufferをtrueにすると毎フレームのbufferが
            // 保持されるため、コンポジタがいつ読みに来ても地図が残っている
            // 状態になる(引き換えに描画コストがわずかに上がる)。
            preserveDrawingBuffer: true,
          });
        } catch (constructErr) {
          console.error("MapLibre Map construction failed:", constructErr);
          if (!cancelled) {
            setStatus("error");
            setErrorMsg("地図の初期化に失敗: " + (constructErr.message || String(constructErr)));
          }
          return;
        }

        map.on("load", () => {
          if (cancelled) return;

          // 震源(バツ印)アイコンを生成してMapLibreへ登録しておく。
          // 白フチ付きの赤いバツ印にするため、まず太めの白でストロークしてから
          // その上に少し細い赤をストロークすることで、白い縁取りを再現する。
          const crossSize = 36;
          const crossCanvas = document.createElement("canvas");
          crossCanvas.width = crossSize; crossCanvas.height = crossSize;
          const cc = crossCanvas.getContext("2d");
          const crossPad = 10;
          const drawCrossPath = () => {
            cc.beginPath();
            cc.moveTo(crossPad, crossPad); cc.lineTo(crossSize - crossPad, crossSize - crossPad);
            cc.moveTo(crossSize - crossPad, crossPad); cc.lineTo(crossPad, crossSize - crossPad);
          };
          cc.lineCap = "round";
          cc.lineJoin = "round";
          cc.strokeStyle = "#ffffff";
          cc.lineWidth = 10;
          drawCrossPath();
          cc.stroke();
          cc.strokeStyle = "#FF453A";
          cc.lineWidth = 6;
          drawCrossPath();
          cc.stroke();
          map.addImage("hypocenter-cross", cc.getImageData(0, 0, crossSize, crossSize));

          // PLUM法震源(円)アイコン。index.html版の.eew-marker-plum(白フチ付き赤リング)
          // と同じ考え方で、バツ印と同じキャンバスサイズ・白→赤の二重ストロークにして
          // 見た目のトーンを揃える。PLUM法は到達時刻を伴わないためバツ印ではなく円で示す。
          const circleCanvas = document.createElement("canvas");
          circleCanvas.width = crossSize; circleCanvas.height = crossSize;
          const rc = circleCanvas.getContext("2d");
          const circleCenter = crossSize / 2;
          const circleRadius = 10;
          rc.lineCap = "round";
          rc.beginPath();
          rc.arc(circleCenter, circleCenter, circleRadius, 0, Math.PI * 2);
          rc.strokeStyle = "#ffffff";
          rc.lineWidth = 8;
          rc.stroke();
          rc.beginPath();
          rc.arc(circleCenter, circleCenter, circleRadius, 0, Math.PI * 2);
          rc.strokeStyle = "#FF453A";
          rc.lineWidth = 5;
          rc.stroke();
          map.addImage("hypocenter-plum-circle", rc.getImageData(0, 0, crossSize, crossSize));

          // 観測点(震度)マーカー用のアイコン(丸+白フチ+数字)を、
          // 現在の配色スキームに合わせて生成・登録しておく。
          registerStationIcons(map, colorScheme);
          // 震度速報・震源に関する情報(細分区域単位)専用の角丸正方形アイコン。
          registerAreaIcons(map, colorScheme);

          // 観測点マーカー本体。circleではなくsymbolレイヤーにすることで、
          // registerStationIconsで焼いたbitmap(白フチ+数字入り)をそのまま使う。
          // ズームに応じた大きさは、段階切り替えだとカクつくため連続補間(interpolate)にし、
          // 見やすさ重視で全体的に一回り大きめのサイズにしている。
          // 推計震度分布(250mメッシュをベクター化したもの)の塗り・境界線レイヤー。
          // 初期状態は空のFeatureCollectionで登録しておき、実際のデータは専用の
          // useEffect内でsetData()により差し替える(選択中の地震・トグルが変わるたび)。
          // station-points-symbolより前にaddLayerすることで、観測点マーカーより
          // 必ず下に来るようにしている。
          map.addSource("est-intensity-fill", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
            // MapLibreはGeoJSONソースを内部的にタイル分割して描画するため、単純化
            // (簡略化)されると、隣接タイル同士で境界の頂点位置がわずかにずれて、
            // 継ぎ目(細い線)として見えてしまうことがある。矩形はもともと単純な形状で
            // 単純化の恩恵もほぼ無いため、toleranceを0にして単純化自体を無効化する。
            tolerance: 0,
          });
          map.addLayer({
            id: "est-intensity-fill-layer",
            type: "fill",
            source: "est-intensity-fill",
            paint: {
              "fill-color": buildEstIntensityFillColorExpr(colorScheme),
              "fill-opacity": 0.75,
              // 隣接する矩形ポリゴン同士の境目(内部タイル分割の継ぎ目を含む)に
              // GPU描画特有の細い隙間(線)が出るのを防ぐため、アンチエイリアスを無効化する。
              "fill-antialias": false,
            },
          });
          map.addSource("est-intensity-line", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "est-intensity-line-layer",
            type: "line",
            source: "est-intensity-line",
            paint: {
              // 外周(色が付いた範囲と地図の背景との境目)は暗い地図に対して見やすいよう白、
              // 震度階級同士の境目(4と5-の間など)は両側とも明るい色なので黒のままにする。
              "line-color": ["match", ["get", "edgeType"], "outer", `rgba(${tokens.ink},0.8)`, "rgba(0,0,0,0.45)"],
              "line-width": 1,
            },
          });

          map.addSource("station-points", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "station-points-symbol",
            type: "symbol",
            source: "station-points",
            layout: {
              // ズーム6未満は円が小さく数字が潰れるため、数字なしアイコンに切り替える。
              "icon-image": [
                "step", ["zoom"],
                ["concat", "station-icon-", ["get", "intensityKey"], "-dot"],
                6, ["concat", "station-icon-", ["get", "intensityKey"], "-num"],
              ],
              "icon-size": [
                "interpolate", ["linear"], ["zoom"],
                4, 5 / STATION_ICON_BASE_RADIUS,
                7, 10 / STATION_ICON_BASE_RADIUS,
                9, 14 / STATION_ICON_BASE_RADIUS,
                11, 20 / STATION_ICON_BASE_RADIUS,
                14, 30 / STATION_ICON_BASE_RADIUS,
              ],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              // 震度が大きいほど後(=前面)に描画されるよう、sort-keyに震度の並び順を使う。
              "symbol-sort-key": ["get", "sortOrder"],
            },
          });

          // 震度速報・震源に関する情報(細分区域単位、isArea:true)専用のマーカー。
          // 通常の観測点マーカー(station-points、円形アイコン)とは別のソース・
          // レイヤーにして、角丸正方形アイコン(area-icon-*)を使う。
          // 1つの地震のpointsは常に「全部isArea:true」か「全部isArea:false」の
          // どちらかで、両方が混ざることは無いため、重なり順は特に気にしなくてよい。
          map.addSource("area-points", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "area-points-symbol",
            type: "symbol",
            source: "area-points",
            layout: {
              "icon-image": [
                "step", ["zoom"],
                ["concat", "area-icon-", ["get", "intensityKey"], "-dot"],
                4, ["concat", "area-icon-", ["get", "intensityKey"], "-num"],
              ],
              "icon-size": [
                "interpolate", ["linear"], ["zoom"],
                4, 6.5 / STATION_ICON_BASE_RADIUS,
                7, 13 / STATION_ICON_BASE_RADIUS,
                9, 18 / STATION_ICON_BASE_RADIUS,
                11, 26 / STATION_ICON_BASE_RADIUS,
                14, 38 / STATION_ICON_BASE_RADIUS,
              ],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              "symbol-sort-key": ["get", "sortOrder"],
            },
          });

          // プレート境界(plate-boundaries.json)・断層(faults.geojson)レイヤー。
          // いずれも数MB規模のファイルのため、初期状態では空のFeatureCollectionだけ
          // 登録しておき、実データは対応するトグルが最初にONにされた時点で
          // 遅延読み込みする(下方の専用useEffectでsetDataにより差し替える)。
          // トグルOFF時はvisibility:noneで非表示にするだけでレイヤー自体は
          // 削除しない(再ON時に読み込み直さずに済むようにするため)。
          // beforeIdに"station-points-symbol"を指定し、観測点マーカーより
          // 必ず下に来るようにする。
          //
          // 配色はプレート境界・断層とも、種別ごとの派手な色分けはせず、
          // 「縁取り(halo)は共通の固定グレー」「枠内の色(core)はユーザーが
          // 設定で選べる」という組み合わせにする。
          // ・縁取り(halo)はライト/ダーク共通の固定色(BOUNDARY_HALO_COLOR)。
          //   どちらのテーマでも海・陸に対して十分なコントラストが出る
          //   中間グレーを採用している。
          // ・枠内の色(core)は設定(BOUNDARY_LINE_COLORS)から選んだ色を使う。
          // ・どちらも、あえて半透明(rgba)にせず不透明の実色にしている。
          //   半透明にすると、線同士が交差・分岐する箇所(断層の枝分かれ・
          //   プレート境界同士の交点など)でアルファが重なって不自然に濃く
          //   見えてしまうため、それを避けるため。
          // 「線の先端を丸く」という見た目のため、太めのハローレイヤーを下に敷き、
          // その上に細めの中の線を重ねる「ケースドライン」の手法を使う
          // (halo→mainの順にaddLayerすることで、両方ともstation-points-symbolの
          // 直下・halo→mainの順で正しく積み重なる)。
          const boundaryLineLayout = { visibility: "none", "line-cap": "round", "line-join": "round" };
          const boundaryHaloWidth = ["interpolate", ["linear"], ["zoom"], 4, 2.2, 8, 3.6, 12, 5.2];
          const boundaryLineWidth = ["interpolate", ["linear"], ["zoom"], 4, 1.0, 8, 1.6, 12, 2.2];
          const initHalo = getBoundaryHaloColor(boundaryLineColorIdRef.current);
          const initCore = (BOUNDARY_LINE_COLORS[boundaryLineColorIdRef.current] || BOUNDARY_LINE_COLORS.gray).color;

          map.addSource("plate-boundaries", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "plate-boundaries-halo-layer",
            type: "line",
            source: "plate-boundaries",
            layout: boundaryLineLayout,
            paint: { "line-color": initHalo, "line-width": boundaryHaloWidth },
          }, "station-points-symbol");
          map.addLayer({
            id: "plate-boundaries-layer",
            type: "line",
            source: "plate-boundaries",
            layout: boundaryLineLayout,
            paint: { "line-color": initCore, "line-width": boundaryLineWidth },
          }, "station-points-symbol");

          map.addSource("faults", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "faults-halo-layer",
            type: "line",
            source: "faults",
            layout: boundaryLineLayout,
            paint: { "line-color": initHalo, "line-width": boundaryHaloWidth },
          }, "station-points-symbol");
          map.addLayer({
            id: "faults-layer",
            type: "line",
            source: "faults",
            layout: boundaryLineLayout,
            paint: { "line-color": initCore, "line-width": boundaryLineWidth },
          }, "station-points-symbol");

          // 津波予報区(海岸線)。津波情報の詳細を開いた時だけ、対象の予報区を
          // grade(危険度)の色で塗る。データ自体は遅延読み込みのため、
          // ここでは空のソースだけ用意しておく(下方のuseEffect参照)。
          map.addSource("tsunami-areas", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "tsunami-areas-layer",
            type: "line",
            source: "tsunami-areas",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "rgba(0,0,0,0)",
              "line-width": 4.5,
            },
          }, "station-points-symbol");

          // 津波テスト配信「地図タップで選択」機能用: 現在選んでいる予報区(複数可)を、
          // 実際の津波警報と同じグレード配色で太く強調するレイヤー。同じソース
          // (tsunami-areas)を使い回し、line-colorのmatch式(buildTsunamiAreaColorExpr)
          // で対象の予報区名だけに色を付け、それ以外は透明にする。filterでの絞り込みは
          // 行わず、色そのもので表示/非表示を切り替える(複数選択に対応するため)。
          map.addLayer({
            id: "tsunami-areas-pick-highlight-layer",
            type: "line",
            source: "tsunami-areas",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "rgba(0,0,0,0)",
              "line-width": 6,
            },
          }, "station-points-symbol");

          // 警報タブ: 気象警報・注意報レイヤー(市区町村単位の塗り分け)。
          // データ自体は警報タブを開いた時だけ遅延読み込みするため、ここでは
          // 空のソースだけ用意する(下方の専用useEffect参照)。
          map.addSource("warning-areas", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "warning-areas-fill-layer",
            type: "fill",
            source: "warning-areas",
            layout: { visibility: "none" },
            paint: {
              // 色そのものはベタ(不透明)で持たせ、不透明度はfill-opacityで別掛けする。
              // 移植元ツールと完全に同じ配色・不透明度(0.55)にする。
              "fill-color": buildWarningAreaColorExpr(),
              "fill-opacity": 0.55,
            },
          }, "station-points-symbol");
          map.addLayer({
            id: "warning-areas-line-layer",
            type: "line",
            source: "warning-areas",
            layout: { visibility: "none" },
            paint: {
              // 移植元ツールと同じく、境界線は警報レベルで色分けせず、
              // 市区町村境界を示すだけの固定の線にする。ライトモードは警報の
              // 塗り分け(黄〜赤)の上で白だと見えづらいので黒、ダークモードは
              // 従来通り薄い白にする(下方のテーマ切り替えeffectでも同期する)。
              "line-color": mode === "light" ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.25)",
              "line-width": 0.6,
              "line-opacity": 1,
            },
          }, "station-points-symbol");

          // タップ/一覧選択中の警報エリアを強調する専用レイヤー。同じソース
          // (warning-areas)を使い回し、setFilterで選択中のregioncodeだけに
          // 絞り込む(下方の専用useEffect参照)。太い白線で塗り分けの上から囲う。
          map.addLayer({
            id: "warning-areas-highlight-layer",
            type: "line",
            source: "warning-areas",
            layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
            filter: ["==", ["get", "regioncode"], "__none__"],
            paint: {
              "line-color": "#ffffff",
              "line-width": 3,
            },
          }, "station-points-symbol");

          // 河川水位観測所(国管理・主要河川)。stg_ovlvl(危険度、10刻み)で
          // 6段階に色分けした丸ポイント。警報の塗り分け・キキクルより上、
          // 選択中の市区町村ハイライトより下に置く(下方のuseEffectでデータ・
          // 表示状態を管理)。
          map.addSource("river-stations", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "river-stations-layer",
            type: "circle",
            source: "river-stations",
            layout: { visibility: "none" },
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 3, 10, 6, 14, 9],
              "circle-color": [
                "step", ["coalesce", ["get", "stg_ovlvl"], -1],
                "#c8c8cb", // 欠測(stg_ovlvlが無い)
                0, "#66ccff",   // 通常
                10, "#35a86b",  // 水防団待機
                20, "#f2e700",  // 氾濫注意
                40, "#ff2800",  // 避難判断
                80, "#aa00aa",  // 氾濫危険
                90, "#140014",  // 氾濫発生
              ],
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 1.2,
            },
          }, "station-points-symbol");
          // タップ中の観測所を強調する専用レイヤー(選択中の1件だけをsetFilterで絞る)。
          map.addLayer({
            id: "river-stations-highlight-layer",
            type: "circle",
            source: "river-stations",
            layout: { visibility: "none" },
            filter: ["==", ["get", "obs_fcd"], "__none__"],
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 6, 10, 10, 14, 14],
              "circle-color": "rgba(0,0,0,0)",
              "circle-stroke-color": "#0A84FF",
              "circle-stroke-width": 3,
            },
          }, "station-points-symbol");

          // 震央分布(P2P地震一覧・近傍地震検索・データベース検索の結果を、
          // 震度配色の丸として地図上に重ねて表示する)。
          // 独自のcanvasレイヤーではなくMapLibre標準のcircleレイヤーにすることで、
          // map.on('click'/'mousemove', layerId, ...)によるタップ選択・
          // ホバー/タッチ時のツールチップ表示がそのまま使える。
          // beforeIdを指定していないため、ここまでに作った他のレイヤー
          // (観測点・断層・プレート境界など)より上に、かつこの後に作る
          // hypocenter-point-symbol(選択中の地震の×印)より下に積み重なる。
          map.addSource("epicenter-points", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "epicenter-points-layer",
            type: "circle",
            source: "epicenter-points",
            paint: {
              // 参考にしたLeaflet版(circleMarker)と同じ考え方で、マグニチュードに
              // 応じた固定ピクセル半径にする(ズームで拡大縮小しない)。
              "circle-radius": ["max", ["*", ["coalesce", ["get", "mag"], 4], 2.2], 5],
              "circle-color": buildEpicenterCircleColorExpr(colorSchemeRef.current),
              "circle-opacity": 0.45,
              "circle-stroke-color": buildEpicenterCircleStrokeColorExpr(colorSchemeRef.current, modeRef.current),
              "circle-stroke-width": 1.4,
              "circle-stroke-opacity": 0.95,
            },
          });

          // 震源マーカー用のソース・レイヤー。観測点レイヤーより後にaddLayerすることで、
          // MapLibreのレイヤー順だけで「震源は常に観測点より上」を保証する。
          map.addSource("hypocenter-point", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "hypocenter-point-symbol",
            type: "symbol",
            source: "hypocenter-point",
            layout: {
              "icon-image": "hypocenter-cross",
              // crossSize(36px)を焼いたが、見た目の大きさは元の28px相当のまま保つための比率
              "icon-size": 28 / 36,
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            },
          });

          // 観測点の丸+観測された津波の高さ(推定)バーをまとめて表示するレイヤー
          // (tideStationBarsModeがtrueの間だけ使う。App側のcombinedTideStations参照。
          // データが空の間は何も描かれない)。tsunamiStationIconId参照のとおり、
          // 丸とバーを1枚のアイコンにまとめているのは、レイヤーをまたいだ重なり順を
          // MapLibreで制御できないため(同じレイヤー内でのみsymbol-sort-keyが効く)。
          map.addSource("tsunami-height-bars", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "tsunami-height-bars-layer",
            type: "symbol",
            source: "tsunami-height-bars",
            layout: {
              "icon-image": ["get", "iconId"],
              "icon-anchor": "bottom",
              "icon-size": 1, // 固定(ズームに応じた拡大縮小をしない)
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              // 観測点の丸(アイコン画像内では一番下)の中心を、実際の座標にきちんと
              // 合わせるためのズレ補正(render関数側で計算)。無いと、バーの分だけ
              // 画像全体が高くなる影響で、丸が実際の位置より北へズレて見えてしまう。
              "icon-offset": ["get", "offset"],
              // 観測点の丸のレイヤー(常に配列順=描画順)と重なり方を揃えるための
              // 明示的な並び順(symbolレイヤーは指定しないと重なり順が保証されないため)。
              "symbol-sort-key": ["get", "sortKey"],
            },
          });

          // 潮位観測点のピン。津波タブの「潮位計」モード、または現在進行形の津波情報が
          // ある間(発令中の予報区の観測点のみ)にデータが入る
          // (tideStationPointsが空の間は何も描かれない)。
          map.addSource("tide-station-points", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "tide-station-points-layer",
            type: "circle",
            source: "tide-station-points",
            paint: {
              "circle-radius": [
                "interpolate", ["linear"], ["zoom"],
                4,  ["case", ["get", "selected"], 7, 4.5],
                8,  ["case", ["get", "selected"], 8, 5.5],
                12, ["case", ["get", "selected"], 11, 7],
                16, ["case", ["get", "selected"], 15, 9.5],
              ],
              "circle-color": [
                "case",
                ["get", "selected"], "#FF9F0A",
                ["get", "dotColor"],
              ],
              "circle-stroke-width": ["case", ["get", "selected"], 2.5, 1.5],
              "circle-stroke-color": "#ffffff",
              // tideStationBarsModeがtrueの間(observedTsunamiHeightバーを表示するモード)は、
              // 丸とバーの重なり順を正しく揃えるため、代わりにtsunami-height-bars-layer
              // (1枚のアイコンに丸+バーをまとめて描く)を使う。このレイヤーはその間、
              // タップ判定(ヒットテスト)のためだけに透明のまま残しておく
              // (circle-opacityを0にしても、クリック判定自体は引き続き機能する)。
              "circle-opacity": 1,
              "circle-stroke-opacity": 1,
            },
          });
          map.on("mouseenter", "tide-station-points-layer", () => {
            if (!tideStationsInteractiveRef.current) return;
            map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", "tide-station-points-layer", () => {
            map.getCanvas().style.cursor = "";
          });
          map.on("click", "tide-station-points-layer", (e) => {
            if (!tideStationsInteractiveRef.current) return; // 過去の津波の参照専用表示ではタップを無効にする
            if (!e.features || !e.features.length) return;
            onSelectTideStationRef.current?.(e.features[0].properties.code);
          });
          // 観測点の丸+バーをまとめて描くレイヤー(tideStationBarsModeの間、実際に
          // 見えているのはこちら)。バーの部分をタップしても、丸をタップした時と
          // 同じく観測点を選択できるようにする(アイコン全体が当たり判定になるため、
          // 丸だけでなくバーの範囲もタップ可能)。
          map.on("click", "tsunami-height-bars-layer", (e) => {
            if (!tideStationsInteractiveRef.current) return; // 過去の津波の参照専用表示ではタップを無効にする
            if (!e.features || !e.features.length) return;
            onSelectTideStationRef.current?.(e.features[0].properties.code);
          });
          map.on("mouseenter", "tsunami-height-bars-layer", () => {
            if (!tideStationsInteractiveRef.current) return;
            map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", "tsunami-height-bars-layer", () => {
            map.getCanvas().style.cursor = "";
          });

          // 震央分布の丸のタップ選択・ホバー/タッチ時のツールチップ表示。
          map.on("mouseenter", "epicenter-points-layer", () => {
            map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", "epicenter-points-layer", () => {
            map.getCanvas().style.cursor = "";
            setEpicenterTooltip(null);
          });
          map.on("mousemove", "epicenter-points-layer", (e) => {
            if (!e.features || !e.features.length) return;
            const p = e.features[0].properties || {};
            const magNum = Number(p.mag);
            const magText = Number.isFinite(magNum) && magNum > 0 ? `M${magNum.toFixed(1)}` : "M不明";
            const depthNum = Number(p.depth);
            const depthText = depthNum === 0 ? "ごく浅い" : (Number.isFinite(depthNum) && depthNum > 0 ? `${depthNum}km` : "深さ不明");
            setEpicenterTooltip({
              x: e.point.x,
              y: e.point.y,
              title: p.place || "震源地不明",
              text: `${p.time || ""}　${magText}　深さ${depthText}`,
            });
          });
          map.on("click", "epicenter-points-layer", (e) => {
            if (!e.features || !e.features.length) return;
            setEpicenterTooltip(null);
            onSelectEpicenterPointRef.current?.(e.features[0].properties.id);
          });

          // 警報タブ: 塗り分けられた市区町村をタップした時、regioncodeを親(App)に
          // 伝える。名称・警報種別は親側でwarningLevelMap/エリア名マスタから
          // 引くため、ここではregioncodeだけ渡せば十分。
          map.on("click", "warning-areas-fill-layer", (e) => {
            if (!e.features || !e.features.length) return;
            onSelectWarningAreaRef.current?.(e.features[0].properties.regioncode);
          });
          map.on("mouseenter", "warning-areas-fill-layer", () => map.getCanvas().style.cursor = "pointer");
          map.on("mouseleave", "warning-areas-fill-layer", () => map.getCanvas().style.cursor = "");

          // 警報タブ: 河川水位観測所のピンをタップした時、properties一式に加えて
          // 座標(__lon/__lat)も一緒に親(App)に渡す。全国概観データ(over-obs-create)
          // のpropertiesには緯度経度が入っていないため、基準水位を市区町村単位
          // エンドポイントから逆引きする時に別途座標が必要になる。
          map.on("click", "river-stations-layer", (e) => {
            if (!e.features || !e.features.length) return;
            const f = e.features[0];
            const coords = f.geometry?.coordinates;
            onSelectRiverStationRef.current?.({
              ...f.properties,
              __lon: coords ? coords[0] : null,
              __lat: coords ? coords[1] : null,
            });
          });
          map.on("mouseenter", "river-stations-layer", () => map.getCanvas().style.cursor = "pointer");
          map.on("mouseleave", "river-stations-layer", () => map.getCanvas().style.cursor = "");

          // 津波テスト配信「地図タップで選択」モード中だけ有効になる、地図全体を対象と
          // したクリック(レイヤー指定なし)。タップ地点から一番近い予報区(海岸線)の
          // 頂点を探し、近すぎず遠すぎない(60km以内)場合だけ選択として採用する。
          // 海上や地図の対象外の場所を誤ってタップした場合は何も起きない。
          map.on("click", (e) => {
            if (!tsunamiAreaPickActiveRef.current) return;
            const geo = tsunamiAreasGeoDataRef.current;
            if (!geo) return;
            const nearest = findNearestTsunamiAreaWithDistance(e.lngLat.lat, e.lngLat.lng, geo);
            if (!nearest || nearest.distanceKm > 60) return;
            onPickTsunamiAreaRef.current?.(nearest.name);
          });

          // 緊急地震速報テスト配信「地図をタップして震源を指定」モード中だけ有効になる、
          // 地図全体を対象としたクリック。タップ地点の緯度経度をそのまま震源座標にし、
          // ep.json(遅延読み込み済みなら同期的に、まだなら取得してから)で
          // その地点を含む区域名を調べ、緯度・経度・震源地名をまとめて返す。
          map.on("click", (e) => {
            if (!eewEpicenterPickActiveRef.current) return;
            const { lat, lng } = e.lngLat;
            const geo = epicenterNamesGeoDataRef.current;
            if (geo) {
              const name = findEpicenterNameByPoint(geo, lat, lng);
              onPickEewEpicenterRef.current?.(lat, lng, name);
            } else {
              // 初回タップ時にまだ読み込めていない場合は、取得を待ってから確定する。
              loadEpicenterNamesData().then((loaded) => {
                epicenterNamesGeoDataRef.current = loaded;
                const name = findEpicenterNameByPoint(loaded, lat, lng);
                onPickEewEpicenterRef.current?.(lat, lng, name);
              }).catch((err) => {
                console.error("震央地名データの読み込みに失敗しました:", err);
                onPickEewEpicenterRef.current?.(lat, lng, null);
              });
            }
          });

          // 地震情報テスト配信「地図をタップして震源を指定」モード用。EEWの震源ピックと
          // 全く同じ処理(ep.jsonでの震央地名検索)を、行き先(onPickQuakeEpicenter)だけ
          // 変えて共有する。
          map.on("click", (e) => {
            if (!quakeEpicenterPickActiveRef.current) return;
            const { lat, lng } = e.lngLat;
            const geo = epicenterNamesGeoDataRef.current;
            if (geo) {
              const name = findEpicenterNameByPoint(geo, lat, lng);
              onPickQuakeEpicenterRef.current?.(lat, lng, name);
            } else {
              loadEpicenterNamesData().then((loaded) => {
                epicenterNamesGeoDataRef.current = loaded;
                const name = findEpicenterNameByPoint(loaded, lat, lng);
                onPickQuakeEpicenterRef.current?.(lat, lng, name);
              }).catch((err) => {
                console.error("震央地名データの読み込みに失敗しました:", err);
                onPickQuakeEpicenterRef.current?.(lat, lng, null);
              });
            }
          });

          // 現在地マーカー(iOSの地図でおなじみの、白フチ付きの青い丸+薄いハロー)。
          // 気象タブ「地点」モードでGPS取得に成功している間だけ、App側から
          // currentLocationPointが渡ってきてsetDataされる(下のuseEffect参照)。
          // それ以外のタブ・モードでは常に空のFeatureCollectionのままで何も描かれない。
          map.addSource("user-location-point", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "user-location-halo-layer",
            type: "circle",
            source: "user-location-point",
            paint: {
              "circle-radius": 16,
              "circle-color": "#0A84FF",
              "circle-opacity": 0.2,
              "circle-stroke-width": 0,
            },
          });
          map.addLayer({
            id: "user-location-dot-layer",
            type: "circle",
            source: "user-location-point",
            paint: {
              "circle-radius": 7,
              "circle-color": "#0A84FF",
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 3,
              "circle-opacity": 1,
              "circle-stroke-opacity": 1,
            },
          });

          // 緊急地震速報(EEW)の地域ごとの予測震度塗りつぶしは、専用レイヤーは
          // 持たず、地震情報の震度分布と同じ"areas"ソース/"areas-intensity-fill"・
          // "areas-intensity-line"レイヤー(feature-state)を共用する(下のuseEffectで
          // setFeatureStateする)。塗り方・線・重なり順を地震情報の震度塗りつぶしと
          // 完全に一致させるため。

          // ─────────────────────────────────────────────
          // 緊急地震速報(EEW): P波・S波の伝播円と震源マーカー。
          // データは別のuseEffect(下方)がrequestAnimationFrameで頻繁に
          // setDataするため、ここでは空のソースを用意するだけでよい。
          // 他のレイヤーより後に追加し、常に最前面に描画されるようにする。
          map.addSource("eew-pwave", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          map.addLayer({
            id: "eew-pwave-fill-layer", type: "fill", source: "eew-pwave",
            paint: { "fill-color": "#32ADE6", "fill-opacity": 0.08 },
          });
          map.addLayer({
            id: "eew-pwave-line-layer", type: "line", source: "eew-pwave",
            paint: { "line-color": "#32ADE6", "line-width": 1.5, "line-opacity": 0.8 },
          });

          map.addSource("eew-swave", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          map.addLayer({
            id: "eew-swave-fill-layer", type: "fill", source: "eew-swave",
            paint: { "fill-color": "#FF453A", "fill-opacity": 0.12 },
          });
          map.addLayer({
            id: "eew-swave-line-layer", type: "line", source: "eew-swave",
            paint: { "line-color": "#FF453A", "line-width": 2.2, "line-opacity": 0.9 },
          });

          map.addSource("eew-hypocenter", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          map.addLayer({
            id: "eew-hypocenter-symbol", type: "symbol", source: "eew-hypocenter",
            layout: {
              // PLUM法は震源からの距離だけで判定し到達時刻の予測を伴わないため、
              // バツ印ではなく円のアイコンで区別する(index.html版と同じ考え方)。
              "icon-image": ["case", ["boolean", ["get", "isPlum"], false], "hypocenter-plum-circle", "hypocenter-cross"],
              "icon-size": 28 / 36,
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            },
          });

          // ─────────────────────────────────────────────
          // 台風情報。1つのgeojson sourceに全台風ぶんの中心点・予報円・
          // 暴風域/強風域・過去/予測経路・警戒領域(結合ポリゴン)・暴風警戒域を
          // properties.typeで区別して入れ、typeごとにfilterした複数レイヤーを
          // 重ねる。データ本体はtyphoonGeojsonが変わるたびに動く別のuseEffectが
          // setDataするため、ここでは空のソースを用意するだけでよい。
          map.addSource("typhoon", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

          map.addLayer({
            id: "layer-typhoon-forecast-fill", type: "fill", source: "typhoon",
            layout: { visibility: "none" }, filter: ["==", "type", "forecastArea"],
            paint: { "fill-color": "#FFFFFF", "fill-opacity": 0.1 },
          });
          map.addLayer({
            id: "layer-typhoon-storm-warning-fill", type: "fill", source: "typhoon",
            layout: { visibility: "none" }, filter: ["==", "type", "stormWarningArea"],
            paint: { "fill-color": "#FF2800", "fill-opacity": 0.12 },
          });
          map.addLayer({
            id: "layer-typhoon-storm-warning-line", type: "line", source: "typhoon",
            layout: { visibility: "none" }, filter: ["==", "type", "stormWarningArea"],
            paint: { "line-color": "#FF2800", "line-width": 2.5, "line-opacity": 0.95 },
          });
          map.addLayer({
            id: "layer-typhoon-forecast-area-line", type: "line", source: "typhoon",
            layout: { visibility: "none" }, filter: ["==", "type", "forecastArea"],
            paint: { "line-color": "#FFFFFF", "line-width": 1.5, "line-opacity": 0.6 },
          });
          map.addLayer({
            id: "layer-typhoon-forecast-circle-line", type: "line", source: "typhoon",
            layout: { visibility: "none" }, filter: ["==", "type", "forecastCircle"],
            paint: {
              // 熱帯低気圧・温帯低気圧に変化した予報円はグレーで区別する
              "line-color": ["case", ["==", ["get", "weakened"], true], "#9AA0A6", "#FFFFFF"],
              "line-width": 1.4, "line-dasharray": [3, 4], "line-opacity": 0.8,
            },
          });
          map.addLayer({
            id: "layer-typhoon-area", type: "fill", source: "typhoon",
            layout: { visibility: "none" }, filter: ["in", "type", "stormArea", "windArea"],
            paint: {
              "fill-color": ["match", ["get", "type"], "stormArea", "#FF2800", "windArea", "#FFEF00", "#FFFFFF"],
              "fill-opacity": 0.35,
            },
          });
          map.addLayer({
            id: "layer-typhoon-past-track", type: "line", source: "typhoon",
            layout: { visibility: "none" }, filter: ["==", "type", "pastTrack"],
            paint: { "line-color": "#FFFFFF", "line-width": 1.6, "line-opacity": 0.55 },
          });
          map.addLayer({
            id: "layer-typhoon-track", type: "line", source: "typhoon",
            layout: { visibility: "none" }, filter: ["==", "type", "track"],
            paint: { "line-color": "#FFFFFF", "line-width": 2, "line-dasharray": [3, 3], "line-opacity": 0.75 },
          });
          map.addLayer({
            id: "layer-typhoon-center", type: "circle", source: "typhoon",
            layout: { visibility: "none" }, filter: ["==", "type", "center"],
            paint: {
              "circle-radius": 6,
              // 暴風域(赤)と紛らわしいため、現在位置の点はただの白丸にする。
              // 熱帯低気圧・温帯低気圧に変化している場合のみグレーで区別する。
              "circle-color": ["case", ["==", ["get", "weakened"], true], "#9AA0A6", "#FFFFFF"],
              "circle-stroke-width": 2, "circle-stroke-color": "#1c1c1e",
            },
          });
          map.on("mouseenter", "layer-typhoon-center", () => {
            map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", "layer-typhoon-center", () => {
            map.getCanvas().style.cursor = "";
          });
          map.on("click", "layer-typhoon-center", (e) => {
            if (!e.features || !e.features.length) return;
            onSelectTyphoonCenterRef.current?.(e.features[0].properties);
          });

          setStatus("ready");
          if (onReady) onReady(map);
        });

        map.on("error", (e) => {
          console.error("MapLibre error event:", e?.error || e);
          if (cancelled) return;
          setStatus("error");
          setErrorMsg(e?.error?.message || "地図の描画中にエラーが発生しました");
        });

        mapRef.current = map;
      })
      .catch((err) => {
        console.error("地図の読み込みに失敗:", err);
        if (cancelled) return;
        setStatus("error");
        setErrorMsg(err.message || "地図データまたはMapLibre GL JS本体の読み込みに失敗しました");
      });

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 選択中の地震(stationPoints)が変わるたびに、観測点マーカーのGeoJSONを更新する。
  // 緯度経度が引けなかった観測点(マスタに見つからなかったもの)は地図には出さない。
  // sortOrder(震度の小さい順の連番)をsymbol-sort-keyに渡すことで、
  // 震度が大きい観測点ほど前面に描画されるようにする。
  // 震度速報・震源に関する情報(isArea:true、細分区域単位)は、通常の観測点とは
  // 別のソース(area-points、角丸正方形アイコン)に分けて表示する。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const stationSource = map.getSource("station-points");
    const areaSource = map.getSource("area-points");
    if (!stationSource || !areaSource) return;

    const toFeature = (p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
      properties: {
        intensityKey: STATION_ICON_KEYS.includes(p.intensityKey) ? p.intensityKey : "0",
        sortOrder: STATION_ICON_KEYS.indexOf(p.intensityKey),
      },
    });

    const resolvedPoints = stationMarkersVisible
      ? (stationPoints || []).filter(p => p.latitude != null && p.longitude != null)
      : [];
    const stationFeatures = resolvedPoints.filter(p => !p.isArea).map(toFeature);
    const areaFeatures = resolvedPoints.filter(p => p.isArea).map(toFeature);

    stationSource.setData({ type: "FeatureCollection", features: stationFeatures });
    areaSource.setData({ type: "FeatureCollection", features: areaFeatures });
  }, [stationPoints, status, stationMarkersVisible]);

  // 緊急地震速報: P波・S波の伝播円と震源マーカーをリアルタイムに更新する。
  // eews自体は1秒間隔のstate更新(App側の生存タイマー)にしか追従しないため、
  // 経過時間から円を滑らかに広げるにはrequestAnimationFrameで独自に回す必要がある。
  // ただしGeoJSONのsetDataは決して軽くないので、フレームごとではなく
  // 約180ms間隔に間引いて呼び出す(タブが非表示の間は自動的に止まる)。
  const eewsRef = useRef(eews);
  eewsRef.current = eews;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    let frameId = null;
    let lastTick = 0;

    function tick(ts) {
      if (ts - lastTick >= 180) {
        lastTick = ts;
        const list = eewsRef.current || [];
        const pFeatures = [];
        const sFeatures = [];
        const hypoFeatures = [];

        list.forEach(eew => {
          if (eew.cancelled || eew.latitude == null || eew.longitude == null) return;
          hypoFeatures.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [eew.longitude, eew.latitude] },
            properties: { isPlum: !!eew.isPlum },
          });
          if (eew.isPlum) return; // PLUM法は到達時刻の予測が無いため円は描かない
          const originMs = eew.originTime ? new Date(eew.originTime.replace(/-/g, "/")).getTime() : NaN;
          if (!Number.isFinite(originMs)) return;
          const elapsedSec = (Date.now() - originMs) / 1000;
          const pRadiusKm = eewWaveSurfaceRadiusKm(elapsedSec, eew.depth, EEW_P_WAVE_SPEED_KM_S);
          const sRadiusKm = eewWaveSurfaceRadiusKm(elapsedSec, eew.depth, EEW_S_WAVE_SPEED_KM_S);
          const pRing = eewCirclePolygon(eew.latitude, eew.longitude, pRadiusKm);
          if (pRing) pFeatures.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [pRing] }, properties: {} });
          const sRing = eewCirclePolygon(eew.latitude, eew.longitude, sRadiusKm);
          if (sRing) sFeatures.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [sRing] }, properties: {} });
        });

        const pSource = map.getSource("eew-pwave");
        const sSource = map.getSource("eew-swave");
        const hypoSource = map.getSource("eew-hypocenter");
        if (pSource) pSource.setData({ type: "FeatureCollection", features: pFeatures });
        if (sSource) sSource.setData({ type: "FeatureCollection", features: sFeatures });
        if (hypoSource) hypoSource.setData({ type: "FeatureCollection", features: hypoFeatures });
      }
      frameId = requestAnimationFrame(tick);
    }
    frameId = requestAnimationFrame(tick);

    return () => { if (frameId != null) cancelAnimationFrame(frameId); };
  }, [status]);

  // 台風情報: typhoonGeojsonが変わるたびにsourceへ流し込み、予報円の横に出す
  // 時刻ラベル(maplibregl.Marker)も同じタイミングで作り直す。
  // マーカーはDOM要素なのでReactツリー外で自前管理し、古いものは必ず先にremoveする。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const source = map.getSource("typhoon");
    if (source) source.setData(typhoonGeojson || { type: "FeatureCollection", features: [] });

    // 既存マーカーを掃除
    typhoonForecastMarkersRef.current.forEach(marker => marker.remove());
    typhoonForecastMarkersRef.current = [];

    if (!typhoonVisible || !typhoonGeojson?.features) return;

    let maplibregl = window.maplibregl;
    if (!maplibregl) return; // 地図自体が読めていればここは通常falsyにならない

    typhoonGeojson.features
      .filter(f => f.properties?.type === "forecastCircle")
      .forEach(f => {
        const label = f.properties.forecastTime;
        const center = f.properties.labelPoint;
        if (!label || !center) return;

        const el = document.createElement("div");
        el.className = "typhoon-forecast-time-marker";
        if (f.properties.weakened && f.properties.category) {
          // 「熱帯低気圧(TD)」のように括弧付きで格納されているため、日本語部分のみ短く表示する
          const classText = String(f.properties.category).split("(")[0] || f.properties.category;
          const timeEl = document.createElement("span");
          timeEl.textContent = label;
          const badgeEl = document.createElement("span");
          badgeEl.className = "typhoon-forecast-class-badge";
          badgeEl.textContent = classText;
          el.appendChild(timeEl);
          el.appendChild(badgeEl);
        } else {
          el.textContent = label;
        }
        el.onclick = (event) => {
          event.stopPropagation();
          onSelectTyphoonCenterRef.current?.(f.properties);
        };
        typhoonForecastMarkersRef.current.push(
          new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat(center).addTo(map)
        );
      });

    return () => {
      typhoonForecastMarkersRef.current.forEach(marker => marker.remove());
      typhoonForecastMarkersRef.current = [];
    };
  }, [status, typhoonGeojson, typhoonVisible]);

  // 台風情報レイヤーのON/OFF切り替え。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const vis = typhoonVisible ? "visible" : "none";
    [
      "layer-typhoon-forecast-fill", "layer-typhoon-storm-warning-fill",
      "layer-typhoon-storm-warning-line", "layer-typhoon-forecast-area-line",
      "layer-typhoon-forecast-circle-line", "layer-typhoon-area",
      "layer-typhoon-past-track", "layer-typhoon-track", "layer-typhoon-center",
    ].forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
    });
  }, [status, typhoonVisible]);

  // 台風一覧の項目をタップした時、その台風の強風域(無ければ暴風域)が画面に
  // 収まるズーム倍率でflyToする。半径データが無い(弱い熱帯低気圧等で強風域・
  // 暴風域のどちらも出ていない)場合だけ、中心点への通常のflyToにフォールバックする。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready" || !typhoonFlyToRequest) return;
    const { lon, lat, areaLon, areaLat, areaRadiusKm } = typhoonFlyToRequest;
    if (areaRadiusKm) {
      // 中心+半径(km)から単純な矩形バウンディングボックスを作る。
      // 緯度1度 ≈ 111.32km、経度1度 ≈ 111.32km×cos(緯度) で近似する。
      const latDelta = areaRadiusKm / 111.32;
      const lonDelta = areaRadiusKm / (111.32 * Math.max(0.1, Math.cos(areaLat * Math.PI / 180)));
      map.fitBounds(
        [[areaLon - lonDelta, areaLat - latDelta], [areaLon + lonDelta, areaLat + latDelta]],
        {
          padding: isWide
            ? { top: 40, bottom: 40, left: 460, right: 40 }
            : { top: 80, bottom: 220, left: 40, right: 40 },
          maxZoom: 9,
          duration: 800,
        }
      );
    } else {
      map.flyTo({ center: [lon, lat], zoom: 6, duration: 800 });
    }
  }, [status, typhoonFlyToRequest]);

  // 緊急地震速報: areas[]に予測震度がある場合、その地域を細分区域.json上で
  // 名前が一致するポリゴンを探し、震度の色で塗りつぶす。P/S波の円と違って
  // 頻繁には変わらないため、requestAnimationFrameではなくeewsが変化した時だけ
  // 計算する。取消・タイムアウトで対象のEEWが無くなったら自動的に消える。
  // 地震情報の震度分布(下のuseEffect)と全く同じ"areas"ソース/feature-stateの
  // 仕組み(setFeatureState)を使い、同じ"areas-intensity-fill"・
  // "areas-intensity-line"レイヤーで描画する。塗った区域コードは
  // eewPaintedAreaCodesRefで別管理し、地震情報側が塗った区域(paintedAreaCodesRef)
  // を巻き込んで消してしまわないようにしている。
  const eewPaintedAreaCodesRef = useRef([]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    let cancelled = false;

    loadGeoData().then(({ areas: areasGeoJSON }) => {
      if (cancelled) return;

      for (const code of eewPaintedAreaCodesRef.current) {
        map.setFeatureState({ source: "areas", id: code }, { color: null, hasIntensity: 0 });
      }
      eewPaintedAreaCodesRef.current = [];

      const paintedCodes = new Set();
      let minOrderIdx = Infinity, maxOrderIdx = -Infinity;
      for (const eew of eews) {
        if (eew.cancelled || !Array.isArray(eew.areas)) continue;
        for (const area of eew.areas) {
          const intensityKey = area.maxIntensityKey;
          if (!intensityKey || intensityKey === "?") continue;
          const codes = findAreaCodesByName(areasGeoJSON, area.name);
          if (codes.length === 0) continue;
          const color = (colorScheme.colors[intensityKey] || colorScheme.colors["0"]).bg;
          const orderIdx = EEW_FILL_LEGEND_ORDER.indexOf(intensityKey);
          for (const code of codes) {
            if (paintedCodes.has(code)) continue; // 複数EEWが同じ地域を含む場合は先勝ちでよい
            paintedCodes.add(code);
            map.setFeatureState({ source: "areas", id: code }, { color, hasIntensity: 1 });
            if (orderIdx !== -1) {
              if (orderIdx < minOrderIdx) minOrderIdx = orderIdx;
              if (orderIdx > maxOrderIdx) maxOrderIdx = orderIdx;
            }
          }
        }
      }
      eewPaintedAreaCodesRef.current = [...paintedCodes];
      setEewFillRange(
        maxOrderIdx >= 0
          ? { minKey: EEW_FILL_LEGEND_ORDER[minOrderIdx], maxKey: EEW_FILL_LEGEND_ORDER[maxOrderIdx] }
          : null
      );
    }).catch(err => {
      console.error("緊急地震速報の地域塗りつぶし用データの読み込みに失敗:", err);
    });

    return () => { cancelled = true; };
  }, [eews, status, colorScheme]);

  // 配色スキームが切り替わったら、観測点アイコン(丸+白フチ+数字)を焼き直す。
  // symbolレイヤー側は同じicon-image名を参照し続けるので、updateImageするだけで
  // 表示中のマーカーにも即座に反映される。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    registerStationIcons(map, colorScheme);
    registerAreaIcons(map, colorScheme);
  }, [colorScheme, status]);

  // 震度分布(細分区域ごとの塗り分け)を更新する。
  // 前回塗った区域は毎回リセットしてから、今回の集計結果を塗り直す
  // (そうしないと、観測点が無くなった区域の色が古いまま残ってしまう)。
  // 設定でOFFにされている場合は、リセットだけ行って塗り直しはしない(塗りつぶし無し状態にする)。
  const paintedAreaCodesRef = useRef([]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    for (const code of paintedAreaCodesRef.current) {
      map.setFeatureState({ source: "areas", id: code }, { color: null, hasIntensity: 0 });
    }
    paintedAreaCodesRef.current = [];

    if (!areaFillEnabled) return;

    const maxByArea = aggregateByArea(stationPoints || []);
    const codes = [];
    maxByArea.forEach((intensityKey, code) => {
      const color = (colorScheme.colors[intensityKey] || colorScheme.colors["0"]).bg;
      map.setFeatureState({ source: "areas", id: code }, { color, hasIntensity: 1 });
      codes.push(code);
    });
    paintedAreaCodesRef.current = codes;
  }, [stationPoints, status, colorScheme, areaFillEnabled]);

  // 断層(faults.geojson)の表示ON/OFF。トグルがONになった最初の1回だけ
  // 実データ(数MB)を取得してsetDataで流し込み、以降のON/OFF切り替えは
  // レイヤーのvisibilityを変えるだけ(再取得しない)にすることで、
  // OFFのままなら通信自体が発生しないようにしている。
  const faultsLoadedRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("faults-layer")) return;

    const v = faultsEnabled ? "visible" : "none";
    map.setLayoutProperty("faults-halo-layer", "visibility", v);
    map.setLayoutProperty("faults-layer", "visibility", v);

    if (faultsEnabled && !faultsLoadedRef.current) {
      faultsLoadedRef.current = true;
      loadFaultsData()
        .then((geojson) => {
          const source = map.getSource("faults");
          if (source) source.setData(geojson);
        })
        .catch((err) => {
          console.error("断層データの読み込みに失敗しました:", err);
          faultsLoadedRef.current = false; // 失敗時は次回ONで再試行できるようにする
        });
    }
  }, [faultsEnabled, status]);

  // プレート境界(plate-boundaries.json)の表示ON/OFF。断層と同様の遅延読み込み。
  const plateBoundariesLoadedRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("plate-boundaries-layer")) return;

    const v = plateBoundariesEnabled ? "visible" : "none";
    map.setLayoutProperty("plate-boundaries-halo-layer", "visibility", v);
    map.setLayoutProperty("plate-boundaries-layer", "visibility", v);

    if (plateBoundariesEnabled && !plateBoundariesLoadedRef.current) {
      plateBoundariesLoadedRef.current = true;
      loadPlateBoundariesData()
        .then((geojson) => {
          const source = map.getSource("plate-boundaries");
          if (source) source.setData(geojson);
        })
        .catch((err) => {
          console.error("プレート境界データの読み込みに失敗しました:", err);
          plateBoundariesLoadedRef.current = false; // 失敗時は次回ONで再試行できるようにする
        });
    }
  }, [plateBoundariesEnabled, status]);

  // 津波予報区(海岸線)。断層・プレート境界と同じ遅延読み込みだが、こちらは
  // 設定トグルではなく「表示すべき予報区(tsunamiAreas)が1件以上ある」ことが
  // トリガーになる(=津波タブで津波情報の詳細を開いた時だけ実データを取得する)。
  const tsunamiAreasLoadedRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("tsunami-areas-layer")) return;

    // ピックモード中は、まだ何も選ばれていなくても海岸線自体が見えていないと
    // タップする場所が分からないため、全予報区を薄く一律で見せる。
    // 通常時は今まで通り、実際に有効な津波情報の予報区だけをグレードの色で塗る。
    map.setPaintProperty(
      "tsunami-areas-layer",
      "line-color",
      tsunamiAreaPickActive ? "rgba(120,190,255,0.55)" : buildTsunamiAreaColorExpr(tsunamiAreas)
    );
    map.getCanvas().style.cursor = tsunamiAreaPickActive ? "crosshair" : "";

    if ((tsunamiAreas.length > 0 || tsunamiAreaPickActive) && !tsunamiAreasLoadedRef.current) {
      tsunamiAreasLoadedRef.current = true;
      loadTsunamiAreasData()
        .then((geojson) => {
          tsunamiAreasGeoDataRef.current = geojson; // クリック時の最近傍探索用に保持
          const source = map.getSource("tsunami-areas");
          if (source) source.setData(geojson);
        })
        .catch((err) => {
          console.error("津波予報区データの読み込みに失敗しました:", err);
          tsunamiAreasLoadedRef.current = false; // 失敗時は次回表示対象が出た時に再試行できるようにする
        });
    }
  }, [tsunamiAreas, tsunamiAreaPickActive, status]);

  // 警報タブ: 警報・注意報レイヤー。境界データ(warning_areas.json、1,821件)は
  // 警報タブを一度でも開いた時だけ遅延読み込みする(断層・津波予報区と同じ方式)。
  // warningLevelMapが実際に更新された時だけ、色を塗り直す(=setDataし直す)。
  const warningAreasLoadedRef = useRef(false);
  const warningAreasBaseGeoJsonRef = useRef(null);
  // 直近でsetDataに使ったwarningLevelMapの参照。タブを開き直しただけで
  // warningLevelMapの中身が変わっていない(=Appの再取得がまだ終わっていない)
  // 間は、visibilityの切り替えだけにして、1,821件分の塗り直し
  // (setData、MapLibre内部の再タイル化を伴う重い処理)をスキップする。
  const warningAreasLastMergedLevelMapRef = useRef(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("warning-areas-fill-layer")) return;

    map.setLayoutProperty("warning-areas-fill-layer", "visibility", warningVisible ? "visible" : "none");
    map.setLayoutProperty("warning-areas-line-layer", "visibility", warningVisible ? "visible" : "none");
    // キキクル表示中は警報の塗り分けを見た目上だけ消す(visibilityではなく
    // opacityを0にする)。visibility:noneにするとMapLibreのクリック判定
    // (queryRenderedFeatures)も効かなくなり、キキクル表示中に市区町村を
    // タップできなくなってしまうため。
    map.setPaintProperty("warning-areas-fill-layer", "fill-opacity", riskVisible ? 0 : 0.55);
    map.setPaintProperty("warning-areas-line-layer", "line-opacity", riskVisible ? 0 : 1);
    if (!warningVisible) return;

    if (!warningAreasLoadedRef.current) {
      warningAreasLoadedRef.current = true;
      loadWarningAreasFullGeoJson()
        .then((geojson) => {
          warningAreasBaseGeoJsonRef.current = geojson;
          warningAreasLastMergedLevelMapRef.current = warningLevelMap;
          const merged = buildWarningAreasGeoJson(geojson, warningLevelMap);
          const source = map.getSource("warning-areas");
          if (source) source.setData(merged);
        })
        .catch((err) => {
          console.error("警報・注意報の境界データの読み込みに失敗しました:", err);
          warningAreasLoadedRef.current = false; // 失敗時は次回表示された時に再試行できるようにする
        });
    } else if (
      warningAreasBaseGeoJsonRef.current &&
      warningAreasLastMergedLevelMapRef.current !== warningLevelMap
    ) {
      // 境界データは既にあり、かつwarningLevelMapが前回塗り直した時から
      // 実際に変わっている場合(ポーリング更新、または再取得完了)だけ
      // setDataし直す(再取得は不要)。
      warningAreasLastMergedLevelMapRef.current = warningLevelMap;
      const merged = buildWarningAreasGeoJson(warningAreasBaseGeoJsonRef.current, warningLevelMap);
      const source = map.getSource("warning-areas");
      if (source) source.setData(merged);
    }
  }, [warningVisible, warningLevelMap, riskVisible, status]);

  // 警報タブ: 河川水位観測所。riverStations(BottomDock側で10分おきに取得した
  // GeoJSON)をそのままsetDataし、riverVisibleでON/OFFする。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("river-stations-layer")) return;

    map.setLayoutProperty("river-stations-layer", "visibility", riverVisible ? "visible" : "none");
    map.setLayoutProperty("river-stations-highlight-layer", "visibility", riverVisible ? "visible" : "none");
    const source = map.getSource("river-stations");
    if (source) source.setData(riverStations || { type: "FeatureCollection", features: [] });
    console.log(`[河川水位/地図] visible=${riverVisible} features=${riverStations?.features?.length ?? 0}`);
  }, [riverVisible, riverStations, status]);

  // 警報タブ: タップ中の河川水位観測所を強調表示する。obs_fcdで絞り込む。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("river-stations-highlight-layer")) return;
    map.setFilter("river-stations-highlight-layer", [
      "==", ["get", "obs_fcd"], selectedRiverStation?.obs_fcd ?? "__none__",
    ]);
  }, [selectedRiverStation, status]);


  // 警報タブ: タップ/一覧選択中のエリアを強調するレイヤーの表示切り替え。
  // 選択が無い間は("__none__"は実在しないregioncodeなので)何も塗られない状態にしておく。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("warning-areas-highlight-layer")) return;

    map.setLayoutProperty(
      "warning-areas-highlight-layer",
      "visibility",
      warningVisible && selectedWarningArea ? "visible" : "none"
    );
    if (selectedWarningArea) {
      map.setFilter("warning-areas-highlight-layer", ["==", ["get", "regioncode"], selectedWarningArea]);
    }
  }, [warningVisible, selectedWarningArea, status]);

  // 警報タブ: 一覧の項目をタップした時、そのエリアの代表座標へflyToする
  // (台風一覧のflyToと同じ考え方)。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready" || !warningAreaFlyToRequest) return;
    const { lon, lat } = warningAreaFlyToRequest;
    if (lon == null || lat == null) return;
    map.flyTo({ center: [lon, lat], zoom: 8, duration: 800 });
  }, [status, warningAreaFlyToRequest]);

  // 緊急地震速報テスト配信「地図をタップして震源を指定」モード用。ONになったら
  // カーソルをcrosshairにし、震央地名データをこの時点で先読みしておく
  // (タップ時に読めていればそのまま同期的に確定でき、待たせずに済む)。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    map.getCanvas().style.cursor = (tsunamiAreaPickActive || eewEpicenterPickActive || quakeEpicenterPickActive) ? "crosshair" : "";

    if ((eewEpicenterPickActive || quakeEpicenterPickActive) && !epicenterNamesLoadedRef.current) {
      epicenterNamesLoadedRef.current = true;
      loadEpicenterNamesData()
        .then((geojson) => { epicenterNamesGeoDataRef.current = geojson; })
        .catch((err) => {
          console.error("震央地名データの読み込みに失敗しました:", err);
          epicenterNamesLoadedRef.current = false; // 失敗時は次回ONで再試行できるようにする
        });
    }
  }, [eewEpicenterPickActive, quakeEpicenterPickActive, tsunamiAreaPickActive, status]);

  // ピックモードで選ばれている予報区(pickedTsunamiAreas、複数・グレード別可)を、
  // それぞれの実際の配色で強調レイヤーに反映する。buildTsunamiAreaColorExprは
  // 「(name, grade)の配列→match式」を作る関数で、実際の津波警報表示と全く同じロジックを
  // 使うことで、選択中の色と本番配信時の色が必ず一致するようにしている。
  // このレイヤーは「テスト配信のピックモード中」だけの一時的な下書き表示のため、
  // ピックモードを抜けたら(=tsunamiAreaPickActiveがfalseになったら)pickedTsunamiAreas
  // が配列に残っていても必ず消す。これをしないと、テスト配信で選んだ予報区が
  // タブを切り替えても地図に残り続け、あたかも本物の警報が出ているように
  // 見えてしまう。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("tsunami-areas-pick-highlight-layer")) return;
    map.setPaintProperty(
      "tsunami-areas-pick-highlight-layer",
      "line-color",
      tsunamiAreaPickActive ? buildTsunamiAreaColorExpr(pickedTsunamiAreas) : "rgba(0,0,0,0)"
    );
  }, [pickedTsunamiAreas, tsunamiAreaPickActive, status]);

  // 選択中の地震(hypocenters)が変わるたびに、震源のバツ印マーカーを更新し、
  // 震源(複数の場合は全件)+周辺の観測点がちょうど収まる範囲へズームする。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const source = map.getSource("hypocenter-point");
    if (!source) return;

    const validHypocenters = (hypocenters || [])
      .filter(h => h && h.latitude != null && h.longitude != null);

    if (validHypocenters.length === 0) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    source.setData({
      type: "FeatureCollection",
      features: validHypocenters.map(h => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [h.longitude, h.latitude] },
        properties: {},
      })),
    });

    // 震源(複数あれば全件) + 観測点(緯度経度が引けたもの)が全部収まる
    // bounding boxを作ってfitBoundsする。観測点が1件も無い(マッチできなかった)
    // 場合は、震源(複数なら重心)を中心にほどよいズームへ寄せる。
    const coords = validHypocenters.map(h => [h.longitude, h.latitude]);
    (stationPoints || []).forEach(p => {
      if (p.latitude != null && p.longitude != null) coords.push([p.longitude, p.latitude]);
    });

    if (coords.length > 1) {
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      coords.forEach(([lon, lat]) => {
        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      });
      // 横画面(isWide)ではフローティングパネルが画面左側を覆っているため、
      // 左のpaddingを広めに取り、パネルに隠れない範囲にズームする。
      map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
        padding: isWide
          ? { top: 40, bottom: 40, left: 460, right: 40 }
          : { top: 80, bottom: 220, left: 40, right: 40 },
        maxZoom: 9,
        duration: 800,
      });
    } else {
      const [lon, lat] = coords[0];
      map.flyTo({
        center: [lon, lat], zoom: 7, duration: 800,
        // 横画面ではパネルぶん(360px)画面左側が隠れているので、
        // 見た目の中心が隠れない範囲の中央に来るようずらす。
        offset: isWide ? [230, 0] : [0, 0],
      });
    }
  }, [hypocenters, stationPoints, status, isWide]);

  // 現在地マーカー(青丸)の更新。currentLocationPointはApp側で気象タブ
  // 「地点」モード中のGPS取得結果のみを保持しているため、それ以外のタブ・
  // モードでは自動的にnullになり、ここで空のFeatureCollectionに戻る
  // (=地図から消える)。ズーム・パン等は一切行わない(観測点選択と違い、
  // 現在地の表示のために地図を動かすと津波タブ等での閲覧を邪魔するため)。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const source = map.getSource("user-location-point");
    if (!source) return;
    if (!currentLocationPoint || currentLocationPoint.lat == null || currentLocationPoint.lon == null) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    source.setData({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "Point", coordinates: [currentLocationPoint.lon, currentLocationPoint.lat] },
        properties: {},
      }],
    });
  }, [currentLocationPoint, status]);

  // 雨雲レーダー(高解像度降水ナウキャスト)。
  // 表示中のコマ(nowcastFrame)に加えて、前後の先読み対象コマ(nowcastPreloadFrames)
  // ぶんもopacity:0のレイヤーとしてあらかじめ追加しておく。MapLibreは
  // visibility:visibleなレイヤーであればopacityが0でもタイルを読み込むため、
  // これで「表示に使う前からバックグラウンドでタイルを読み込んでおく」先読みになる。
  // コマが切り替わった時は、既存レイヤーのopacityを差し替えるだけで済むので
  // (先読み済みなら)一瞬レーダーが消える瞬間が無くなる。
  // コマ(validtime)ごとに専用のsource/layerを持たせ、一度読み込んだコマは
  // (配色スキームを変えない限り)ずっとキャッシュしておく。ただし予測コマは
  // 5分おきの一覧更新のたびにほぼ総入れ替えになるので、nowcastKnownValidtimes
  // に無くなったコマだけは都度削除する(でないとキャッシュが際限なく増え続ける)。
  const nowcastPreloadKey = nowcastPreloadFrames.map(f => f.validtime).join(",");
  const nowcastKnownValidtimesKey = nowcastKnownValidtimes.join(",");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const removeAllNowcastLayers = () => {
      const style = map.getStyle();
      if (!style) return;
      (style.layers || []).forEach(l => {
        if (l.id.startsWith("nowcast-layer-")) map.removeLayer(l.id);
      });
      Object.keys(style.sources || {}).forEach(id => {
        if (id.startsWith("nowcast-src-")) map.removeSource(id);
      });
    };

    if (!nowcastVisible || !nowcastFrame) {
      removeAllNowcastLayers();
      return;
    }

    const wantedFrames = [nowcastFrame, ...nowcastPreloadFrames];
    const keyOf = (f) => `${nowcastColorSchemeId}-${f.validtime}`;
    const knownValidtimeSet = new Set(nowcastKnownValidtimes);

    // 一度読み込んだコマはそのまま(opacity:0で)残しておき、後で戻ってきた時に
    // 再取得・再デコードしなくて済むようにする。削除するのは、(1)配色スキームが
    // 変わって別物になったもの、(2)実況/予測の一覧更新でもう存在しなくなったコマ
    // (特に予測コマは「今から60分先まで」を毎回丸ごと再計算するので、5分おきの
    // 更新のたびにほぼ総入れ替えになる)の2種類だけ。
    // ソースはレイヤーから参照されている間は削除できないので、必ずレイヤー→ソースの順で消す。
    const style = map.getStyle();
    if (style) {
      (style.layers || []).forEach(l => {
        if (!l.id.startsWith("nowcast-layer-")) return;
        const [scheme, validtime] = l.id.slice("nowcast-layer-".length).split("-");
        const stale = scheme !== nowcastColorSchemeId || !knownValidtimeSet.has(validtime);
        if (stale) map.removeLayer(l.id);
      });
      Object.keys(style.sources || {}).forEach(srcId => {
        if (!srcId.startsWith("nowcast-src-")) return;
        const [scheme, validtime] = srcId.slice("nowcast-src-".length).split("-");
        const stale = scheme !== nowcastColorSchemeId || !knownValidtimeSet.has(validtime);
        if (stale) map.removeSource(srcId);
      });
    }

    // 細分区域の震度塗り分け(areas-intensity-fill)より下に挿入することで、
    // 震度分布・各種マーカーの上に雨雲がかぶらないようにする。
    const beforeId = map.getLayer("areas-intensity-fill") ? "areas-intensity-fill" : undefined;

    // 既にキャッシュ済み(=前に一度でも表示したことがある)レイヤーは、現在のコマだけ
    // 不透明にし、それ以外は透明に戻す。ここで既存レイヤーのopacityを直接切り替える
    // ことで、先読み・キャッシュ済みのコマへはremoveLayer/addLayerを介さず瞬時に切り替わる。
    const currentKey = keyOf(nowcastFrame);
    if (style) {
      (style.layers || []).forEach(l => {
        if (!l.id.startsWith("nowcast-layer-")) return;
        const key = l.id.slice("nowcast-layer-".length);
        if (!key.startsWith(`${nowcastColorSchemeId}-`)) return;
        // styleは冒頭で一度だけ取得したスナップショットなので、直前のremoveLayerで
        // 既に消されたレイヤーがまだ載っていることがある。setPaintPropertyは
        // 存在しないレイヤーに対して呼ぶと例外を投げるため、実際に地図上に
        // まだ存在するか(map.getLayer)を確認してから呼ぶ。
        if (!map.getLayer(l.id)) return;
        map.setPaintProperty(l.id, "raster-opacity", key === currentKey ? 0.75 : 0);
      });
    }

    // 先読み対象コマ(まだキャッシュに無いもの)だけ、新たにsource/layerを追加する。
    wantedFrames.forEach(f => {
      const key = keyOf(f);
      const srcId = `nowcast-src-${key}`;
      const layerId = `nowcast-layer-${key}`;
      if (map.getSource(srcId) && map.getLayer(layerId)) return; // キャッシュ済み(上のループで処理済み)
      if (!map.getSource(srcId)) {
        map.addSource(srcId, {
          type: "raster",
          tiles: [nowcastProtocolUrl(nowcastColorSchemeId, f.basetime, f.validtime)],
          tileSize: 256,
          minzoom: 4, // JMAのナウキャストは偶数ズーム(4,6,8,10)にしか実データが無く、
                      // minzoom=3だと奇数ズーム丸め処理で存在しないズーム2を取りに行き
                      // 404になって何も表示されなくなっていたため、確実に存在する4にする
          maxzoom: 10,
          bounds: NOWCAST_BOUNDS,
          attribution: "気象庁",
        });
      }
      if (!map.getLayer(layerId)) {
        map.addLayer({
          id: layerId,
          type: "raster",
          source: srcId,
          paint: { "raster-opacity": key === currentKey ? 0.75 : 0 },
        }, beforeId);
      }
    });
    // このeffectは既存レイヤーのopacity書き換え・不足分の追加だけで完結しており、
    // 依存配列の値が変わるたびに(=コマが変わるたびに)全部作り直す必要は無いので、
    // ここではクリーンアップ関数を返さない(返すとコマが変わるたびにキャッシュが
    // 消えてしまい、先読み・キャッシュの意味が無くなる)。OFF時の後片付けは上の
    // 早期returnブランチで、マウント解除時の後片付けは地図本体の破棄(map.remove())
    // で行われる。
  }, [nowcastVisible, nowcastFrame?.basetime, nowcastFrame?.validtime, nowcastColorSchemeId, status, nowcastPreloadKey, nowcastKnownValidtimesKey]);

  // 1/3/24時間降水量。雨雲レーダーとは排他(BottomDock側でどちらか一方しか
  // ONにならない)。
  // 以前は「コマが変わるたびに他のレイヤーを全部消してから作り直す」実装に
  // なっており、切り替えるたびに(1)前のコマが即座に消える→(2)新しいタイルを
  // 取得し終わるまで空白になる、という2段階のチカチカが起きていた。
  // 雨雲レーダーと同じく「一度読み込んだコマのレイヤーは残しておき、
  // 表示中のコマだけopacityを上げる」方式に変更し、既に見たことのあるコマへ
  // 戻る時は通信無しで瞬時に切り替わるようにする。
  const precipKnownValidtimesKey = precipKnownValidtimes.join(",");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const removeAllPrecipLayers = () => {
      const style = map.getStyle();
      if (!style) return;
      (style.layers || []).forEach(l => {
        if (l.id.startsWith("precip-layer-")) map.removeLayer(l.id);
      });
      Object.keys(style.sources || {}).forEach(id => {
        if (id.startsWith("precip-src-")) map.removeSource(id);
      });
    };

    if (!precipVisible || !precipMode || !precipFrame) {
      removeAllPrecipLayers();
      return;
    }

    // レイヤーid/sourceidの名前空間にmode+schemeを含めることで、モードや
    // 配色を切り替えた時は「別物」として扱われ、古いキャッシュとは混ざらない。
    const keyOf = (mode, validtime) => `${mode}-${nowcastColorSchemeId}-${validtime}`;
    const knownValidtimeSet = new Set(precipKnownValidtimes);

    // 掃除するのは、(1)モード・配色が変わって別物になったもの、
    // (2)一覧の再取得でもう存在しなくなったコマ、の2種類だけ。
    const style = map.getStyle();
    if (style) {
      (style.layers || []).forEach(l => {
        if (!l.id.startsWith("precip-layer-")) return;
        const [mode, scheme, validtime] = l.id.slice("precip-layer-".length).split("-");
        const stale = mode !== precipMode || scheme !== nowcastColorSchemeId || !knownValidtimeSet.has(validtime);
        if (stale) map.removeLayer(l.id);
      });
      Object.keys(style.sources || {}).forEach(srcId => {
        if (!srcId.startsWith("precip-src-")) return;
        const [mode, scheme, validtime] = srcId.slice("precip-src-".length).split("-");
        const stale = mode !== precipMode || scheme !== nowcastColorSchemeId || !knownValidtimeSet.has(validtime);
        if (stale) map.removeSource(srcId);
      });
    }

    // 細分区域の震度塗り分けより下に挿入し、震度分布・各種マーカーの上に
    // かぶらないようにする(雨雲レーダーと同じ考え方)。
    const beforeId = map.getLayer("areas-intensity-fill") ? "areas-intensity-fill" : undefined;

    // 既にキャッシュ済みのレイヤーは、現在のコマだけ不透明にし、それ以外は
    // 透明に戻す(既存レイヤーのopacityを直接切り替えるだけなので瞬時)。
    const currentKey = keyOf(precipMode, precipFrame.validtime);
    if (style) {
      (style.layers || []).forEach(l => {
        if (!l.id.startsWith("precip-layer-")) return;
        const key = l.id.slice("precip-layer-".length);
        // styleは冒頭で一度だけ取得したスナップショットなので、直前のremoveLayerで
        // 既に消されたレイヤーがまだ載っていることがある(モードを切り替えた時など)。
        // setPaintPropertyは存在しないレイヤーに対して呼ぶと例外を投げるため、
        // 実際に地図上にまだ存在するか(map.getLayer)を確認してから呼ぶ。
        if (!map.getLayer(l.id)) return;
        map.setPaintProperty(l.id, "raster-opacity", key === currentKey ? 0.75 : 0);
      });
    }

    // 現在のコマがまだキャッシュに無ければ、新たにsource/layerを追加する。
    const srcId = `precip-src-${currentKey}`;
    const layerId = `precip-layer-${currentKey}`;
    if (!map.getSource(srcId)) {
      map.addSource(srcId, {
        type: "raster",
        tiles: [precipProtocolUrl(precipMode, nowcastColorSchemeId, precipFrame.member, precipFrame.basetime, precipFrame.validtime)],
        tileSize: 256,
        minzoom: 4,
        maxzoom: 10,
        bounds: NOWCAST_BOUNDS,
        attribution: "気象庁",
      });
    }
    if (!map.getLayer(layerId)) {
      map.addLayer({
        id: layerId,
        type: "raster",
        source: srcId,
        paint: { "raster-opacity": 0.75 },
      }, beforeId);
    }
    // このeffectは既存レイヤーのopacity書き換え・不足分の追加だけで完結しており、
    // コマが変わるたびに全部作り直す必要は無いので、ここではクリーンアップ関数を
    // 返さない(雨雲レーダーと同じ考え方)。OFF時の後片付けは上の早期returnで、
    // マウント解除時の後片付けは地図本体の破棄(map.remove())で行われる。
  }, [precipVisible, precipMode, precipFrame?.basetime, precipFrame?.validtime, nowcastColorSchemeId, status, precipKnownValidtimesKey]);

  // 警報タブ: キキクル(土砂/浸水)。雨雲レーダー・降水量と全く同じキャッシュ方式
  // (一度読み込んだコマのレイヤーは残しておき、表示中のコマだけopacityを
  // 上げる)。配色は固定(JMAのPNGが既に危険度で色分け済み)なので、
  // nowcastColorSchemeIdには依存しない。
  const riskKnownValidtimesKey = riskKnownValidtimes.join(",");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const removeAllRiskLayers = () => {
      const style = map.getStyle();
      if (!style) return;
      (style.layers || []).forEach(l => {
        if (l.id.startsWith("risk-layer-")) map.removeLayer(l.id);
      });
      Object.keys(style.sources || {}).forEach(id => {
        if (id.startsWith("risk-src-")) map.removeSource(id);
      });
    };

    if (!riskVisible || !riskMode || !riskFrame) {
      removeAllRiskLayers();
      return;
    }

    // レイヤーid/sourceidの名前空間にmode(土砂/浸水)を含めることで、
    // 切り替えた時は「別物」として扱われ、古いキャッシュとは混ざらない。
    const keyOf = (mode, validtime) => `${mode}-${validtime}`;
    const knownValidtimeSet = new Set(riskKnownValidtimes);

    // 掃除するのは、(1)モードが変わって別物になったもの、
    // (2)一覧の再取得でもう存在しなくなったコマ、の2種類だけ。
    const style = map.getStyle();
    if (style) {
      (style.layers || []).forEach(l => {
        if (!l.id.startsWith("risk-layer-")) return;
        const [mode, validtime] = l.id.slice("risk-layer-".length).split("-");
        const stale = mode !== riskMode || !knownValidtimeSet.has(validtime);
        if (stale) map.removeLayer(l.id);
      });
      Object.keys(style.sources || {}).forEach(srcId => {
        if (!srcId.startsWith("risk-src-")) return;
        const [mode, validtime] = srcId.slice("risk-src-".length).split("-");
        const stale = mode !== riskMode || !knownValidtimeSet.has(validtime);
        if (stale) map.removeSource(srcId);
      });
    }

    // 選択中エリアの強調リング(warning-areas-highlight-layer)より下、
    // 警報の塗り分け(fill/line。キキクル表示中はopacity:0)より上に挿入する。
    const beforeId = map.getLayer("warning-areas-highlight-layer") ? "warning-areas-highlight-layer" : undefined;

    // 既にキャッシュ済みのレイヤーは、現在のコマだけ不透明にし、それ以外は
    // 透明に戻す(既存レイヤーのopacityを直接切り替えるだけなので瞬時)。
    const currentKey = keyOf(riskMode, riskFrame.validtime);
    if (style) {
      (style.layers || []).forEach(l => {
        if (!l.id.startsWith("risk-layer-")) return;
        const key = l.id.slice("risk-layer-".length);
        if (!map.getLayer(l.id)) return;
        map.setPaintProperty(l.id, "raster-opacity", key === currentKey ? 0.8 : 0);
      });
    }

    // 現在のコマがまだキャッシュに無ければ、新たにsource/layerを追加する。
    const srcId = `risk-src-${currentKey}`;
    const layerId = `risk-layer-${currentKey}`;
    if (!map.getSource(srcId)) {
      map.addSource(srcId, {
        type: "raster",
        tiles: [riskProtocolUrl(riskMode, riskFrame.basetime, riskFrame.validtime)],
        tileSize: 256,
        minzoom: 4, // 土砂・浸水キキクルも雨雲レーダーと同じく偶数ズーム(2,4,6,8,10)にしか
                    // 実データが無いため、確実に存在する4にする
        maxzoom: 10,
        bounds: NOWCAST_BOUNDS,
        attribution: "<a href='https://www.jma.go.jp/bosai/risk/' target='_blank'>気象庁 危険度分布（キキクル）</a>",
      });
    }
    if (!map.getLayer(layerId)) {
      map.addLayer({
        id: layerId,
        type: "raster",
        source: srcId,
        paint: { "raster-opacity": 0.8 },
      }, beforeId);
    }
    // このeffectは既存レイヤーのopacity書き換え・不足分の追加だけで完結しており、
    // コマが変わるたびに全部作り直す必要は無いので、ここではクリーンアップ関数を
    // 返さない(雨雲レーダー・降水量と同じ考え方)。OFF時の後片付けは上の早期returnで、
    // マウント解除時の後片付けは地図本体の破棄(map.remove())で行われる。
  }, [riskVisible, riskMode, riskFrame?.basetime, riskFrame?.validtime, status, riskKnownValidtimesKey]);

  // 天気分布予報(天気分布・気温分布)。雨雲レーダー・降水量とは排他。
  // 配色スキームには依存しない(色は固定)が、モード(天気/気温)によって
  // 中身が全く別物になるため、レイヤーid/sourceidの名前空間にはmode+validtimeを
  // 含める。キャッシュの仕組み(既読みコマは残してopacityだけ切り替える)は
  // 降水量と同じ。
  const wdistKnownValidtimesKey = wdistKnownValidtimes.join(",");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const removeAllWdistLayers = () => {
      const style = map.getStyle();
      if (!style) return;
      (style.layers || []).forEach(l => {
        if (l.id.startsWith("wdist-layer-")) map.removeLayer(l.id);
      });
      Object.keys(style.sources || {}).forEach(id => {
        if (id.startsWith("wdist-src-")) map.removeSource(id);
      });
    };

    if (!wdistVisible || !wdistMode || !wdistFrame) {
      removeAllWdistLayers();
      return;
    }

    const keyOf = (mode, validtime) => `${mode}-${validtime}`;
    const knownValidtimeSet = new Set(wdistKnownValidtimes);

    // 掃除するのは、(1)モードが変わって別物になったもの、
    // (2)一覧の再取得でもう存在しなくなったコマ、の2種類だけ。
    const style = map.getStyle();
    if (style) {
      (style.layers || []).forEach(l => {
        if (!l.id.startsWith("wdist-layer-")) return;
        const [mode, validtime] = l.id.slice("wdist-layer-".length).split("-");
        const stale = mode !== wdistMode || !knownValidtimeSet.has(validtime);
        if (stale) map.removeLayer(l.id);
      });
      Object.keys(style.sources || {}).forEach(srcId => {
        if (!srcId.startsWith("wdist-src-")) return;
        const [mode, validtime] = srcId.slice("wdist-src-".length).split("-");
        const stale = mode !== wdistMode || !knownValidtimeSet.has(validtime);
        if (stale) map.removeSource(srcId);
      });
    }

    // 細分区域の震度塗り分けより下に挿入し、震度分布・各種マーカーの上に
    // かぶらないようにする(雨雲レーダー・降水量と同じ考え方)。
    const beforeId = map.getLayer("areas-intensity-fill") ? "areas-intensity-fill" : undefined;

    // 既にキャッシュ済みのレイヤーは、現在のコマだけ不透明にし、それ以外は
    // 透明に戻す。
    const currentKey = keyOf(wdistMode, wdistFrame.validtime);
    if (style) {
      (style.layers || []).forEach(l => {
        if (!l.id.startsWith("wdist-layer-")) return;
        const key = l.id.slice("wdist-layer-".length);
        if (!map.getLayer(l.id)) return;
        map.setPaintProperty(l.id, "raster-opacity", key === currentKey ? 0.75 : 0);
      });
    }

    // 現在のコマがまだキャッシュに無ければ、新たにsource/layerを追加する。
    const srcId = `wdist-src-${currentKey}`;
    const layerId = `wdist-layer-${currentKey}`;
    if (!map.getSource(srcId)) {
      map.addSource(srcId, {
        type: "raster",
        tiles: [wdistProtocolUrl(wdistMode, wdistFrame.member, wdistFrame.basetime, wdistFrame.validtime)],
        tileSize: 256,
        minzoom: 4,
        maxzoom: 10,
        bounds: NOWCAST_BOUNDS,
        attribution: "気象庁",
      });
    }
    if (!map.getLayer(layerId)) {
      map.addLayer({
        id: layerId,
        type: "raster",
        source: srcId,
        paint: { "raster-opacity": 0.75 },
      }, beforeId);
    }
  }, [wdistVisible, wdistMode, wdistFrame?.basetime, wdistFrame?.validtime, status, wdistKnownValidtimesKey]);

  // 推計震度分布(気象庁 estimated_intensity_map)を更新する。
  // 選択中の地震・設定トグルが変わるたびに、画像を取得・ピクセル解析してGeoJSONに変換し、
  // 塗り(est-intensity-fill)・境界線(est-intensity-line)の2つのソースにsetData()する。
  // 画像デコード・320×320のピクセル走査はメッシュ数によっては時間がかかるため、
  // 処理中はestIntensityLoadingをtrueにして呼び出し側(このコンポーネント自身)で
  // ローディング表示を出す。
  const estIntensityRequestIdRef = useRef(0);
  const [estIntensityLoading, setEstIntensityLoading] = useState(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const requestId = ++estIntensityRequestIdRef.current;
    const isStale = () => requestId !== estIntensityRequestIdRef.current || mapRef.current !== map;

    const clearData = () => {
      if (map.getSource("est-intensity-fill")) {
        map.getSource("est-intensity-fill").setData({ type: "FeatureCollection", features: [] });
      }
      if (map.getSource("est-intensity-line")) {
        map.getSource("est-intensity-line").setData({ type: "FeatureCollection", features: [] });
      }
    };

    clearData();
    setEstIntensityLoading(false);

    // 対象外(トグルOFF・震度5弱未満・地震未選択)ならここで終了
    if (!estIntensityEnabled || !EST_INTENSITY_MIN_INTENSITY_KEYS.includes(maxIntensityKey)) {
      return;
    }

    setEstIntensityLoading(true);

    fetchEstimatedIntensityMatch(quakeTimeStr, maxIntensityKey)
      .then(async matched => {
        if (isStale()) return;
        if (!matched) { setEstIntensityLoading(false); return; }

        const baseUrl = `https://www.jma.go.jp/bosai/estimated_intensity_map/data/${matched.url}/`;

        // フェーズ1: 全メッシュ画像を取得してピクセル解析し、格子(grid)だけ先に揃える。
        // 境界線の判定で隣接メッシュの実データを参照できるようにするため、
        // 先に全メッシュ分のgridを用意してから、フェーズ2で塗り・境界線を組み立てる。
        // 1枚の取得・解析に失敗しても、他のメッシュは表示できるよう処理を継続する。
        // 1枚ごとにわずかに間を空け(setTimeout 0)、ピクセル走査中もブラウザが
        // 操作やアニメーションに応答できるようにする(長時間のフリーズを避けるため)。
        const gridsByMeshCode = new Map();
        const boundsByMeshCode = new Map();
        for (const meshCode of matched.mesh_num) {
          if (isStale()) return;
          try {
            const bounds = meshCodeToBounds(meshCode);
            const img = await loadImageElement(`${baseUrl}${meshCode}.png`);
            if (isStale()) return;
            gridsByMeshCode.set(meshCode, buildEstIntensityGridFromImage(img));
            boundsByMeshCode.set(meshCode, bounds);
            await new Promise(resolve => setTimeout(resolve, 0));
          } catch (err) {
            console.error(`推計震度分布メッシュ(${meshCode})の変換に失敗:`, err);
          }
        }

        if (isStale()) return;

        // フェーズ2: 各メッシュの塗り・境界線を組み立てる。
        // 境界線は、画像の端(1次メッシュの継ぎ目)で誤って線を引いてしまわないよう、
        // 東隣・南隣のメッシュが取得できていれば、その実データを参照して判定する。
        const allFillFeatures = [];
        const allOuterLineCoords = [];
        const allInnerLineCoords = [];
        for (const [meshCode, grid] of gridsByMeshCode) {
          const bounds = boundsByMeshCode.get(meshCode);
          allFillFeatures.push(...buildEstIntensityFillFeatures(grid, bounds));

          const eastCode = offsetMeshCode(meshCode, 0, 1);
          const southCode = offsetMeshCode(meshCode, -1, 0);
          const neighborGrids = {
            eastGrid: eastCode ? gridsByMeshCode.get(eastCode) : undefined,
            southGrid: southCode ? gridsByMeshCode.get(southCode) : undefined,
          };
          const { outerCoords, innerCoords } = buildEstIntensityLineCoords(grid, bounds, neighborGrids);
          allOuterLineCoords.push(...outerCoords);
          allInnerLineCoords.push(...innerCoords);
        }

        if (isStale()) return;

        map.getSource("est-intensity-fill")?.setData({ type: "FeatureCollection", features: allFillFeatures });
        map.getSource("est-intensity-line")?.setData({
          type: "FeatureCollection",
          features: [
            // 色が付いた範囲と地図の背景との境目(外周)。暗い地図に対して見やすいよう白線にする。
            { type: "Feature", properties: { edgeType: "outer" }, geometry: { type: "MultiLineString", coordinates: allOuterLineCoords } },
            // 震度階級同士の境目(4と5-の間など)。両側とも明るい色なので黒線のままでよい。
            { type: "Feature", properties: { edgeType: "inner" }, geometry: { type: "MultiLineString", coordinates: allInnerLineCoords } },
          ],
        });
        setEstIntensityLoading(false);
      })
      .catch(err => {
        console.error("推計震度分布の取得に失敗:", err);
        if (!isStale()) setEstIntensityLoading(false);
      });
  }, [status, quakeTimeStr, maxIntensityKey, estIntensityEnabled]);

  // 震度配色スキームが変わったら、既に表示中の推計震度分布の塗り色だけを塗り替える
  // (データの再取得・再解析は不要なため、これは別のuseEffectに分けている)。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (map.getLayer("est-intensity-fill-layer")) {
      map.setPaintProperty("est-intensity-fill-layer", "fill-color", buildEstIntensityFillColorExpr(colorScheme));
    }
  }, [colorScheme, status]);

  // ライト/ダークモードが切り替わったら、地図の基本配色(海・陸・都道府県境界線)
  // だけを塗り替える。マップの再生成は行わない(ソースの再読み込みが走ると
  // 一瞬地図が消えてちらつくため)。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    map.setPaintProperty("bg", "background-color", themeTokens.mapBg);
    map.setPaintProperty("world-fill", "fill-color", themeTokens.mapWorldFill);
    map.setPaintProperty("world-line", "line-color", themeTokens.mapWorldLine);
    map.setPaintProperty("prefectures-fill", "fill-color", themeTokens.mapPrefFill);
    map.setPaintProperty("prefectures-line", "line-color", themeTokens.mapPrefLine);
    // 警報タブの市区町村境界線 — ライトモードは警報の塗り分け(黄〜赤)の上で
    // 白線だと見えづらいので黒にする。ダークモードは従来通り薄い白のまま。
    if (map.getLayer("warning-areas-line-layer")) {
      map.setPaintProperty(
        "warning-areas-line-layer",
        "line-color",
        mode === "light" ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.25)"
      );
    }
  }, [themeTokens, mode, status]);

  // 断層・プレート境界の「枠内の色」を、設定で選んだ色に合わせて塗り替える。
  // 縁取り(halo)は基本的にライト/ダーク・設定を問わず固定色だが、
  // 枠内の色が「グレー」の時だけ白にして、芯とのコントラストを保つ。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const core = (BOUNDARY_LINE_COLORS[boundaryLineColorId] || BOUNDARY_LINE_COLORS.gray).color;
    const halo = getBoundaryHaloColor(boundaryLineColorId);
    if (map.getLayer("plate-boundaries-layer")) {
      map.setPaintProperty("plate-boundaries-layer", "line-color", core);
      map.setPaintProperty("plate-boundaries-halo-layer", "line-color", halo);
    }
    if (map.getLayer("faults-layer")) {
      map.setPaintProperty("faults-layer", "line-color", core);
      map.setPaintProperty("faults-halo-layer", "line-color", halo);
    }
  }, [boundaryLineColorId, status]);

  // 震央分布(P2P地震一覧・近傍地震検索・データベース検索)のデータを反映する。
  // 呼び出し元(App/BottomDock)側で、今どの一覧を表示中かに応じて渡す点の
  // 配列を切り替えているので、ここでは受け取った配列をGeoJSON化するだけ。
  // MapLibreのcircleレイヤーには「z-index」に相当するものが無く、重なった時の
  // 上下関係はソースの配列順(後ろにあるものほど上)がそのまま描画順になるため、
  // 最大震度が大きいものほど後ろに来るよう昇順にソートしてから渡す。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const source = map.getSource("epicenter-points");
    if (!source) return;
    const sortedPoints = [...(epicenterPoints || [])].sort((a, b) => {
      const ra = QUAKE_INTENSITY_RANK[a.maxIntensityKey] ?? -1;
      const rb = QUAKE_INTENSITY_RANK[b.maxIntensityKey] ?? -1;
      return ra - rb;
    });
    const features = sortedPoints
      .filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
      .map(p => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
        properties: {
          id: p.id,
          mag: p.magnitude,
          depth: p.depth,
          scaleKey: p.maxIntensityKey,
          time: p.time,
          place: p.place,
        },
      }));
    source.setData({ type: "FeatureCollection", features });
  }, [epicenterPoints, status]);

  // 潮位観測点ピンの更新。tideStationPointsが空の間(潮位計モードでもなく、有効な
  // 津波情報も無い間)は何も表示されない。選択中の地点は"selected"プロパティを立てて、レイヤー側の
  // data-drivenなpaint式で強調表示させるのに加え、配列の最後に置くことで
  // (MapLibreは描画順=配列順のため)他のピンより必ず前面に来るようにする。
  // 選択中でないもの同士は、より南(緯度が小さい)ものが前面に来るよう並べる
  // (津波の高さバーのレイヤーもsymbol-sort-keyで同じ考え方に揃えている。MapCanvas内)。
  // tideStationBarsModeがtrueの間は、丸自体の見た目は下のtsunami-height-bars-layer
  // (丸+バーをまとめて描くレイヤー)に任せ、このレイヤーは透明にしてタップ判定
  // だけを担う(データそのものは変わらず入れておく=クリックは引き続き機能する)。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (map.getLayer("tide-station-points-layer")) {
      map.setPaintProperty("tide-station-points-layer", "circle-opacity", tideStationBarsMode ? 0 : 1);
      map.setPaintProperty("tide-station-points-layer", "circle-stroke-opacity", tideStationBarsMode ? 0 : 1);
    }
    const source = map.getSource("tide-station-points");
    if (!source) return;
    const points = [...(tideStationPoints || [])].sort((a, b) => {
      const aSel = a.code === selectedTideStationCode ? 1 : 0;
      const bSel = b.code === selectedTideStationCode ? 1 : 0;
      if (aSel !== bSel) return aSel - bSel; // 選択中のものが最後(=最前面)に来るよう昇順ソート
      return b.lat - a.lat; // より南のものが後(=前面)に来るよう並べる
    });
    const features = points
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map(p => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
        properties: { code: p.code, name: p.name, selected: p.code === selectedTideStationCode, dotColor: p.dotColor || "#B9B9C0" },
      }));
    source.setData({ type: "FeatureCollection", features });
  }, [tideStationPoints, selectedTideStationCode, tideStationBarsMode, status]);

  // 観測点の丸+観測された津波の高さバーをまとめて描画する(tsunamiStationIconId参照)。
  // tideStationBarsModeがfalseの間は何もしない(通常の丸レイヤーがそのまま見える)。
  // 長さ(高さ方向)はズームで変わらない固定ピクセルだが、太さは観測点の丸に合わせて
  // ズームごとに変える必要があるため、データが変わった時だけでなく、ズーム段階が
  // 変わった時にも再描画する(ズーム段階が変わっていない間は何もしない=無駄な
  // 再生成をしない)。
  const combinedTideDataRef = useRef({ points: tideStationPoints, bars: tsunamiHeightBars, selectedCode: selectedTideStationCode });
  combinedTideDataRef.current = { points: tideStationPoints, bars: tsunamiHeightBars, selectedCode: selectedTideStationCode };
  const tsunamiBarZoomBucketRef = useRef(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const source = map.getSource("tsunami-height-bars");
    if (!source) return;

    if (!tideStationBarsMode) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const MAX_PX = 210;  // 10m でこの長さになる(比例式の基準点。以前より少し急な傾きに)
    const geom = { maxPx: MAX_PX, maxM: 10 };

    function render() {
      const { points, bars, selectedCode } = combinedTideDataRef.current;
      const heightByCode = new Map((bars || []).map(b => [b.code, b]));
      const dotDiameterPx = tsunamiBarWidthForZoom(map.getZoom());
      const barWidthPx = dotDiameterPx; // 太さは丸の直径と同じにする(ご要望どおり)
      // icon-anchor: "bottom" は「アイコン画像の一番下」を地図上の座標に合わせるが、
      // 実際の観測点(丸)の中心は画像の一番下からBORDER+丸の半径ぶん上にある
      // (バーの分だけ画像全体の高さが観測点より高くなるため)。そのままだと丸が
      // 実際の位置より北へズレて見えてしまうので、その分だけ画像を下にずらす
      // (icon-offsetは画面ピクセル単位で、+yが下向き)。
      const dotD = Math.max(4, Math.round(dotDiameterPx));
      const offsetY = TSUNAMI_ICON_BORDER + dotD / 2;
      const features = (points || [])
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))
        .map(p => {
          const bar = heightByCode.get(p.code);
          const heightM = bar ? Math.abs(bar.heightM) : null;
          const selected = p.code === selectedCode;
          const iconId = tsunamiStationIconId(map, p.dotColor || "#B9B9C0", heightM, dotDiameterPx, barWidthPx, geom, selected);
          return {
            type: "Feature",
            geometry: { type: "Point", coordinates: [p.lon, p.lat] },
            // より南(緯度が小さい)ものほど前面に描く。選択中は無条件で最前面。
            properties: { code: p.code, iconId, sortKey: selected ? 1e9 : -p.lat, offset: [0, offsetY] },
          };
        });
      source.setData({ type: "FeatureCollection", features });
      // addImageで登録したばかりのアイコン(=新しく選択された観測点のオレンジ色の
      // アイコンなど)が、まれに次の描画までパッと反映されないことがあるため、
      // setData直後に明示的に再描画を促す。
      map.triggerRepaint();
    }

    render(); // データ自体が変わった時は、ズーム段階に関わらず必ず再描画する

    // ズームは連続的に発火するので、太さの見た目が変わるバケット(0.25刻み程度)が
    // 実際に変わった時だけ再描画する。
    function handleZoom() {
      const bucket = Math.round(map.getZoom() * 4);
      if (bucket === tsunamiBarZoomBucketRef.current) return;
      tsunamiBarZoomBucketRef.current = bucket;
      render();
    }
    tsunamiBarZoomBucketRef.current = Math.round(map.getZoom() * 4);
    map.on("zoom", handleZoom);
    return () => { map.off("zoom", handleZoom); };
  }, [tideStationPoints, tsunamiHeightBars, selectedTideStationCode, tideStationBarsMode, status]);

  // 配色スキームが切り替わったら、震央分布の丸の色も塗り直す。
  // 縁取り色はライト/ダークでも変わりうるため(気象庁配色の震度1のみ)、modeも依存に含める。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("epicenter-points-layer")) return;
    map.setPaintProperty("epicenter-points-layer", "circle-color", buildEpicenterCircleColorExpr(colorScheme));
    map.setPaintProperty("epicenter-points-layer", "circle-stroke-color", buildEpicenterCircleStrokeColorExpr(colorScheme, mode));
  }, [colorScheme, mode, status]);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: themeTokens.mapBg }}>
      <div
        ref={containerRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          opacity: status === "ready" ? 1 : 0,
          transition: "opacity 0.4s ease",
        }}
      />

      {/* ロード中インジケータ */}
      {status === "loading" && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 10, color: `rgba(${tokens.ink},0.4)`,
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: "50%",
            border: `2px solid rgba(${tokens.ink},0.15)`,
            borderTopColor: `rgba(${tokens.ink},0.6)`,
            animation: "spin 0.8s linear infinite",
          }}/>
          <span style={{ fontSize: 12 }}>地図を読み込み中…</span>
        </div>
      )}

      {/* 震央分布の丸をホバー/タッチした時に出る簡易ツールチップ */}
      {epicenterTooltip && (
        <div style={{
          position: "absolute",
          left: epicenterTooltip.x,
          top: epicenterTooltip.y,
          transform: "translate(-50%, -100%) translateY(-10px)",
          pointerEvents: "none",
          zIndex: 20,
          padding: "6px 10px",
          borderRadius: 10,
          background: mode === "dark" ? "rgba(28,28,30,0.92)" : "rgba(255,255,255,0.95)",
          boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
          color: tokens.text,
          fontSize: 11,
          lineHeight: 1.4,
          whiteSpace: "nowrap",
          maxWidth: 220,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 2 }}>{epicenterTooltip.title}</div>
          <div>{epicenterTooltip.text}</div>
        </div>
      )}

      {/* 推計震度分布の画像→ベクター変換中、観測点データの突き合わせ処理中、
          または震央分布の丸をバックグラウンドで読み込み中に、地図を隠さない
          小さなローディング表示を出す。複数同時に走ることもあるが、その場合は
          推計震度分布 → 観測点データ → 震央分布 の優先順で1つだけ文言を出す。 */}
      {status === "ready" && (estIntensityLoading || pointsLoading || epicenterLoading) && (
        <div style={{
          position: "absolute",
          top: "calc(14px + env(safe-area-inset-top, 0px))",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 5,
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 14px",
          borderRadius: 999,
          background: tokens.glassOpaqueBg,
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          color: tokens.text,
          fontSize: 12,
          fontWeight: 600,
          // 直下に地図(任意の色)が透けるため、文字の可読性を担保する縁取り。
          textShadow: mode === "light"
            ? "0 1px 2px rgba(255,255,255,0.6)"
            : "0 1px 3px rgba(0,0,0,0.6)",
          boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
          pointerEvents: "none",
        }}>
          <div style={{
            width: 14, height: 14, borderRadius: "50%",
            border: `2px solid rgba(${tokens.ink},0.25)`,
            borderTopColor: `rgba(${tokens.ink},0.9)`,
            animation: "spin 0.8s linear infinite",
            flexShrink: 0,
          }}/>
          {estIntensityLoading ? "推計震度分布を計算中…"
            : pointsLoading ? "観測点データを処理中…"
            : "震央分布を読み込み中…"}
        </div>
      )}

      {/* 緊急地震速報の予想震度の凡例。地図に塗られている震度のうち最も低いものから
          最も高いものまでを一覧できる、右上固定のミニ凡例。EEW詳細(びっくりボタン)を
          開いている間だけ出す — 塗り潰しに興味が無い場面で常時出っぱなしにしないため。 */}
      {status === "ready" && eewDetailOpen && eewFillRange && (() => {
        const minIdx = EEW_FILL_LEGEND_ORDER.indexOf(eewFillRange.minKey);
        const maxIdx = EEW_FILL_LEGEND_ORDER.indexOf(eewFillRange.maxKey);
        if (minIdx === -1 || maxIdx === -1) return null;
        const keys = EEW_FILL_LEGEND_ORDER.slice(minIdx, maxIdx + 1).reverse(); // 強い震度を上に
        return (
          <Glass
            radius={12}
            style={{
              position: "absolute",
              top: "calc(14px + env(safe-area-inset-top, 0px))",
              right: 16,
              zIndex: 6,
              pointerEvents: "none",
              animation: "appear 0.35s cubic-bezier(.25,1,.5,1)",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 0, padding: "8px 10px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: `rgba(${tokens.ink},0.5)`, marginBottom: 3 }}>予想震度</div>
              {keys.map(key => {
                const c = colorScheme.colors[key] || colorScheme.colors["0"];
                return (
                  <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, padding: "0px 0" }}>
                    <span style={{ width: 14, height: 14, borderRadius: 4, background: c.bg, flexShrink: 0 }}/>
                    <span style={{ fontSize: 12, fontWeight: 700, color: tokens.text }}>{INTENSITY_LABEL[key]}</span>
                  </div>
                );
              })}
            </div>
          </Glass>
        );
      })()}

      {/* エラー表示 */}
      {status === "error" && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 10, color: "rgba(255,140,140,0.9)", padding: 24, textAlign: "center",
          textShadow: mode === "light" ? "0 1px 2px rgba(255,255,255,0.7)" : "0 1px 3px rgba(0,0,0,0.6)",
        }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>地図を表示できませんでした</span>
          <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.5)`, maxWidth: 280 }}>{errorMsg}</span>
          <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.3)`, maxWidth: 280, marginTop: 4 }}>
            public/map/world.json と public/map/prefectures.json が正しい場所に
            配置されているか、CDNへのアクセスが制限されていないか確認してください。
          </span>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   LIVE CLOCK
   ───────────────────────────────────────────────────── */
function Clock() {
  const { tokens } = useContext(ThemeContext);

  const [t, setT] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="mono" style={{ fontSize: 12, color: `rgba(${tokens.ink},0.5)` }}>
      {t.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
    </span>
  );
}

/* ─────────────────────────────────────────────────────
   ALERT PILL
   ───────────────────────────────────────────────────── */
const ALERT_COLOR = {
  watch:     "#FFD60A",
  warning:   "#FF9F0A",
  emergency: "#FF453A",
};
function AlertPill({ alert }) {
  const { tokens } = useContext(ThemeContext);

  // "warning"等の警報色は演出上どのテーマでも同じ鮮やかな色を保つが、
  // 警報なし("none")の通常表示は地の文なので、他のテキストと同様に
  // テーマの文字色に追従させる(固定の白だとライトモードで読めなくなるため)。
  const color = ALERT_COLOR[alert.level] || tokens.textSecondary;
  const hasAlert = alert.level !== "none";

  return (
    <Glass
      radius={999}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 16px",
        animation: "appear 0.4s cubic-bezier(.25,1,.5,1)",
      }}
    >
      {hasAlert && (
        <span style={{
          width: 7, height: 7, borderRadius: "50%",
          background: color, flexShrink: 0, color,
          animation: "pulse 1.5s ease-in-out infinite",
          boxShadow: `0 0 8px ${color}`,
          display: "block",
        }}/>
      )}
      <span style={{ fontSize: 13, fontWeight: 600, color }}>
        {alert.title}
      </span>
      <span style={{ fontSize: 13, color: `rgba(${tokens.ink},0.65)` }}>
        {alert.region}
      </span>
      <div style={{ width: 0.5, height: 13, background: `rgba(${tokens.ink},0.25)`, flexShrink: 0 }}/>
      <Clock/>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   緊急地震速報FABボタン — BackToListButtonと全く同じ丸型Glassの形状・押下演出を
   使った、ビックリマークのアイコンボタン。EEW発表中は画面左上に浮かび、押すと
   緊急地震速報の詳細画面(フローティングカード)へ遷移する。
   ───────────────────────────────────────────────────── */
function EewFabButton({ onClick }) {
  const [pressed, setPressed] = useState(false);

  return (
    <Glass
      radius={999}
      style={{
        width: 44, height: 44,
        transform: pressed ? "scale(1.16)" : "scale(1)",
        transformOrigin: "center",
        transition: "transform 0.18s cubic-bezier(.22,1,.36,1)",
        animation: "eewFabPulse 1.4s ease-in-out infinite",
      }}
    >
      <button
        onClick={onClick}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerCancel={() => setPressed(false)}
        onPointerLeave={() => setPressed(false)}
        aria-label="緊急地震速報を確認"
        style={{
          position: "relative", zIndex: 1,
          width: "100%", height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#FF453A",
        }}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none"
             stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="14"/>
          <line x1="12" y1="18.4" x2="12" y2="18.5"/>
        </svg>
      </button>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   緊急地震速報(警報)の対象地域が多数にのぼる場合、個別の地域名(細分区域名)を
   ずらずら並べても読みにくいため、2段階で丸めて表示する。
     ・7件を超えたら → 細分区域名ではなく「都道府県」単位(重複排除)
     ・丸めた都道府県が7件を超えたら → さらに「地方」単位(重複排除)
   都道府県は北→南の固定順、地方も同様の固定順で並べ替える(Setの出現順には
   依存しない)。
   EEWのareas[].pref はP2P地震情報のEEW(code:556)なら都道府県名
   (例:"東京都""神奈川県")が入っているが、テスト配信生成分など pref が
   空文字のデータもあるため、その場合は area.name の先頭一致(細分区域名は
   必ず都道府県名で始まる)から都道府県を推定するフォールバックを持つ。
   ───────────────────────────────────────────────────── */
// 北→南の固定順(JIS都道府県コード順=ほぼ地理的な北→南)。
const PREF_ORDER = [
  "北海道",
  "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県",
  "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
  "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県",
  "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県",
  "沖縄県",
];
const PREF_TO_REGION = {
  "北海道": "北海道",
  "青森県": "東北", "岩手県": "東北", "宮城県": "東北", "秋田県": "東北", "山形県": "東北", "福島県": "東北",
  "茨城県": "関東", "栃木県": "関東", "群馬県": "関東", "埼玉県": "関東", "千葉県": "関東", "東京都": "関東", "神奈川県": "関東",
  "新潟県": "北陸", "富山県": "北陸", "石川県": "北陸", "福井県": "北陸",
  "山梨県": "中部", "長野県": "中部", "岐阜県": "中部",
  "静岡県": "東海", "愛知県": "東海", "三重県": "東海",
  "滋賀県": "近畿", "京都府": "近畿", "大阪府": "近畿", "兵庫県": "近畿", "奈良県": "近畿", "和歌山県": "近畿",
  "鳥取県": "中国", "島根県": "中国", "岡山県": "中国", "広島県": "中国", "山口県": "中国",
  "徳島県": "四国", "香川県": "四国", "愛媛県": "四国", "高知県": "四国",
  "福岡県": "九州", "佐賀県": "九州", "長崎県": "九州", "熊本県": "九州", "大分県": "九州", "宮崎県": "九州", "鹿児島県": "九州",
  "沖縄県": "沖縄",
};
const EEW_REGION_ORDER = ["北海道", "東北", "関東", "北陸", "中部", "東海", "近畿", "中国", "四国", "九州", "沖縄"];
const EEW_AREA_GROUPING_THRESHOLD = 7; // 対象地域の件数がこれを超えたら都道府県表示に丸める
const EEW_PREF_GROUPING_THRESHOLD = 7; // 丸めた都道府県の件数がこれを超えたらさらに地方表示に丸める

// 北海道の細分区域名(石狩地方北部、渡島地方東部、日高地方西部…)は、他の道府県と
// 違って先頭に都道府県名「北海道」が付かない特殊な表記のため、上のPREF_ORDER前方
// 一致だけでは拾えない。支庁地方名の一覧で個別に判定する。
const HOKKAIDO_SUBAREA_NAME_PREFIXES = [
  "石狩", "渡島", "檜山", "後志", "空知", "上川", "留萌", "宗谷", "網走",
  "北見", "紋別", "胆振", "日高", "十勝", "釧路", "根室",
];

// area.pref が空/未知の場合に、area.name(細分区域名)の先頭一致から都道府県名を
// 推定する。細分区域名は「◯◯県△△」のように都道府県名で始まる表記なので、
// PREF_ORDERを順に前方一致でチェックすれば一意に決まる(prefix同士の衝突は無い)。
// 北海道だけは表記が異なるため、支庁地方名リストで別途判定する。
function derivePrefFromEewAreaName(name) {
  if (!name) return null;
  for (const pref of PREF_ORDER) {
    if (name.startsWith(pref)) return pref;
  }
  if (HOKKAIDO_SUBAREA_NAME_PREFIXES.some(p => name.startsWith(p))) return "北海道";
  return null;
}

// EEWの対象地域一覧(areas[])を、カード表示用の1本のテキストに整形する。
function formatEewAreasSummary(areas) {
  if (!Array.isArray(areas) || areas.length === 0) return "";
  if (areas.length <= EEW_AREA_GROUPING_THRESHOLD) {
    return areas.map(a => a.name).join("、");
  }

  // 第1段階: 都道府県に丸める(pref優先、無ければ地域名から推定。
  // それでも分からなければ元の地域名のままフォールバックで残す)。
  const prefsSeen = new Set();
  const unresolvedNames = new Set();
  for (const a of areas) {
    const pref = (a.pref && PREF_TO_REGION[a.pref]) ? a.pref : derivePrefFromEewAreaName(a.name);
    if (pref) prefsSeen.add(pref);
    else unresolvedNames.add(a.name);
  }
  const orderedPrefs = PREF_ORDER.filter(p => prefsSeen.has(p));

  if (orderedPrefs.length <= EEW_PREF_GROUPING_THRESHOLD) {
    return [...orderedPrefs, ...unresolvedNames].join("、");
  }

  // 第2段階: 都道府県数も7件を超えていたら、さらに地方に丸める。
  const regionsSeen = new Set();
  for (const pref of orderedPrefs) {
    const region = PREF_TO_REGION[pref];
    if (region) regionsSeen.add(region);
  }
  const orderedRegions = EEW_REGION_ORDER.filter(r => regionsSeen.has(r));
  return [...orderedRegions, ...unresolvedNames].join("、");
}

/* ─────────────────────────────────────────────────────
   緊急地震速報の詳細フローティングカード。
   地震タブの選択中カード(QuakeDetailCard)と同じ「最大震度バッジ＋震源地／M・
   深さ／発生時刻」のレイアウトを踏襲しつつ、Glassで包んで地図上に浮かべ、
   ヘッダーに第◯報・PLUM法バッジ・警戒文言、下段に対象地域を足したもの。
   複数のEEWが同時に発表された場合は縦に積んで表示する(EEW_MAX_CONCURRENTで
   件数を制限しているため、実用上は積みすぎて見づらくなることはない)。
   取消(cancelled)を受信した場合は「取消」表示に切り替わり、一定時間後に
   一覧から消える(App側のEEW_CANCEL_LINGER_MSタイマーで管理)。
   ───────────────────────────────────────────────────── */
function EewDetailFloatingCard({ eew, onHandoffToPanelDrag }) {
  const { tokens } = useContext(ThemeContext);
  const style = useIntensityStyle(eew.maxIntensityKey);
  const { num, suffix } = splitIntensityLabel(style.label);
  const isWarnLevel = eew.isWarnLevel !== false; // 警報級かどうか(Wolfxの予報はfalse)
  // 警報=赤、予報=amber、取消=グレー、と重要度で色分けする。
  const accent = eew.cancelled ? tokens.textSecondary : (isWarnLevel ? "#FF453A" : "#FF9F0A");

  return (
    <div>
      {/* 見出し — 「緊急地震速報(警報)」チップと「#報番号」チップを、色付きの
          Glass(すりガラス)で囲う。tintColorはGlass内部のブラー層自体の背景を
          直接置き換えるため、ライト/ダークモードやフローティング不透明設定に
          関わらず常に同じ濃さの色になる(以前はstyle.backgroundで指定していたため、
          tokens.glassTint/glassOpaqueBgと二重に重なって、モードや不透明設定ごとに
          色の見え方がバラついていた)。
          テスト配信バッジは、この見出しブロックの左上に重ねて絶対配置する
          (このdivだけをposition:relativeにすることで、カード全体やスクロール
          位置には影響させず、見出しブロックとの相対位置だけで決まるようにする)。 */}
      <PanelDragHandoffCard onHandoffToPanelDrag={onHandoffToPanelDrag}>
        <div style={{ position: "relative", margin: "4px 16px 10px" }}>
          {eew.isTest && (
            <span style={{
              position: "absolute", top: -6, left: 8, zIndex: 1,
              fontSize: 9.5, fontWeight: 800, color: "#fff",
              background: "#FF453A", borderRadius: 4, padding: "2px 6px",
            }}>
              テスト配信
            </span>
          )}
          <div style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
          <Glass
            radius={14}
            tintColor={eew.cancelled ? null : accent}
            style={{
              flex: 1, minWidth: 0,
              padding: "10px 14px",
              display: "flex", alignItems: "center",
              background: eew.cancelled ? `rgba(${tokens.ink},0.08)` : undefined,
            }}
          >
            <span style={{
              fontSize: 16, fontWeight: 800, lineHeight: 1.25,
              color: tokens.text,
            }}>
              緊急地震速報{eew.cancelled ? "(取消)" : (isWarnLevel ? "(警報)" : "(予報)")}{!eew.cancelled && eew.isPlum ? "・PLUM法" : ""}
            </span>
          </Glass>
          {!eew.cancelled && (
            <Glass
              radius={14}
              style={{
                flexShrink: 0,
                padding: "10px 14px",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <span style={{ fontSize: 16, fontWeight: 800, color: tokens.text, whiteSpace: "nowrap" }}>
                # {eew.serial ?? "-"}{eew.isFinal ? "(最終)" : ""}
              </span>
            </Glass>
          )}
          </div>
        </div>
      </PanelDragHandoffCard>

      {eew.cancelled ? (
        <div style={{ margin: "2px 16px 10px", fontSize: 13, color: tokens.textSecondary, lineHeight: 1.7 }}>
          この緊急地震速報は取り消されました。
        </div>
      ) : (
        <>
          {/* ここから先は地震タブのQuakeDetailCardと全く同じ構造・スタイル(囲みなし) */}
          <div
            style={{
              margin: "2px 14px 4px",
              borderRadius: 16,
              padding: "8px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 3,
              background: `linear-gradient(135deg, ${style.bg}2E, ${style.bg}14)`,
              boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.12)`,
              animation: "appear 0.35s cubic-bezier(.25,1,.5,1)",
            }}
          >
            {/* 震源地 — カード上部に全幅で表示 */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0, lineHeight: 1.1 }}>
              <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.55)`, flexShrink: 0, lineHeight: 1.1 }}>{eew.isPlum ? "検知観測点" : "震源地"}</span>
              <AutoFitText
                text={eew.place}
                maxFontSize={25}
                minFontSize={13}
                style={{ fontWeight: 800, color: tokens.text, lineHeight: 1.1 }}
              />
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.6)`, whiteSpace: "nowrap", lineHeight: 1.1 }}>
                  最大予測震度
                </span>
                <div
                  style={{
                    width: 58, height: 58,
                    borderRadius: 13,
                    background: style.bg, color: style.fg,
                    position: "relative",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  {suffix ? (
                    <>
                      <span className="mono" style={{ fontSize: 29, fontWeight: 800, lineHeight: 1 }}>{num}</span>
                      <span style={{
                        fontSize: 14, fontWeight: 700, lineHeight: 1,
                        marginLeft: 2, alignSelf: "flex-end", marginBottom: 12,
                      }}>{suffix}</span>
                    </>
                  ) : (
                    <span className="mono" style={{ fontSize: 29, fontWeight: 800, lineHeight: 1 }}>{num}</span>
                  )}
                </div>
              </div>

              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                {/* PLUM法(観測点の揺れの実測から震源を仮定する方式)の場合は、
                    M・深さの行そのものを「PLUM法による仮定震源要素」というラベルに
                    差し替えて同じ位置に表示する(通常方式のときだけM・深さを表示)。 */}
                {eew.isPlum ? (
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6, lineHeight: 1.1, marginBottom: 14 }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.1 }}>
                      PLUM法による仮定震源要素
                    </span>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "baseline", gap: 12, lineHeight: 1.1 }}>
                    <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.1 }}>
                      M<span className="mono" style={{ fontSize: 25, fontWeight: 800, color: tokens.text, marginLeft: 3, lineHeight: 1.1 }}>
                        {eew.magnitude != null ? eew.magnitude.toFixed(1) : "-"}
                      </span>
                    </span>
                    <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.1 }}>
                      深さ<span className="mono" style={{ fontSize: 25, fontWeight: 800, color: tokens.text, marginLeft: 3, lineHeight: 1.1 }}>
                        {eew.depth != null ? (eew.depth === 0 ? "ごく浅い" : eew.depth) : "-"}
                      </span>
                      {eew.depth != null && eew.depth !== 0 && (
                        <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.6)`, marginLeft: 2, lineHeight: 1.1 }}>km</span>
                      )}
                    </span>
                  </div>
                )}

                <div style={{ display: "flex", alignItems: "baseline", gap: 6, lineHeight: 1.1 }}>
                  <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, flexShrink: 0, lineHeight: 1.1 }}>発生時刻</span>
                  <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: `rgba(${tokens.ink},0.85)`, lineHeight: 1.1 }}>
                    {formatEewTimeShort(eew.originTime)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* 対象地域 — QuakeMessageCardと全く同じ「電文カード」風の下段パネル(囲みなし) */}
          {eew.areas && eew.areas.length > 0 && (
            <div style={{ margin: "2px 14px 8px" }}>
              <div style={{
                borderRadius: 12,
                padding: "10px 12px",
                display: "flex", flexDirection: "column", gap: 8,
                background: `rgba(${tokens.ink},0.04)`,
                boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
              }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#FFD60A" }}>
                    【対象地域】
                  </span>
                  <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.85)`, lineHeight: 1.5 }}>
                    {formatEewAreasSummary(eew.areas)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {eew.isPlum && (
            <div style={{ margin: "0 16px 8px", fontSize: 11, color: tokens.textSecondary, lineHeight: 1.6 }}>
              ※観測点の揺れの実測から予測しています(到達時刻は未提供)。
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   震度スケール — JMA震度階(0〜7、10区分)を液体ガラスのダークUIに合わせて配色。
   明るい色(〜5強)は黒文字、暗く濃い色(6弱〜7)は白文字でコントラストを確保。

   ユーザーが「地震」タブの設定画面から配色スキームを切り替えられるよう、
   色(bg/fg)だけを複数パレット化している。ラベル("6弱"等)はスキームに
   依存しない共通の情報なのでINTENSITY_LABELに1本化した。
   ───────────────────────────────────────────────────── */
const INTENSITY_LABEL = {
  "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
  "5": "5", "5-": "5弱", "5+": "5強", "6": "6", "6-": "6弱", "6+": "6強", "7": "7",
  "5u": "5弱以上未入電", // 観測点の震度計が検知したが、確定した震度をまだ入電できていない状態(scale=46)
  "?": "?", // 震度が取得できなかった場合(「0」と区別する)
};

// INTENSITY_LABELの逆引き("5弱"→"5-"等)。Wolfx APIは震度を"5弱"のような
// 表示用文字列そのもので返してくるため、内部キーへ変換するのに使う。
const INTENSITY_LABEL_TO_KEY = Object.fromEntries(
  Object.entries(INTENSITY_LABEL).map(([key, label]) => [label, key])
);
function intensityLabelToKey(label) {
  if (!label) return "?";
  return INTENSITY_LABEL_TO_KEY[label] ?? "?";
}

// 震度の弱い順(緊急地震速報の塗り潰し範囲の凡例表示用)。"5"/"6"は1996年10月改定前
// 専用の値なので、実運用の並びには含めない。
// (下方のQuakeIntensityLegend用のINTENSITY_LEGEND_ORDERとは別物 — あちらは
//  震度1始まりで実際の地震向け、こちらは震度0を含む緊急地震速報の塗り潰し向け)
const EEW_FILL_LEGEND_ORDER = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];

// 観測点マーカーをMapLibreのsymbolレイヤーで描くための下準備。
// 震度キーは有限個(0〜7,5-,5+,6-,6+,?)しかないので、キーごとに
// 「丸+白フチ+震度番号」を1枚のbitmapとして事前にcanvasへ焼いておき、
// addImageでMapLibreに登録する。text-fieldを使わないため、
// スタイルにglyphs(フォント配信)を用意しなくても数字を表示できる。
const STATION_ICON_KEYS = ["0", "1", "2", "3", "4", "5", "5-", "5u", "5+", "6", "6-", "6+", "7", "?"];

// 震度キーの弱い順(小さい順)の並び。震度リストのソート・グループ化・
// 折りたたみ判定など、複数箇所で「震度の大小比較」が必要な場面で共通して使う。
// "5u"(震度5弱以上未入電)は、実際の値が5弱〜7のどれになるか分からず、
// 気象庁も速報として最優先で扱う情報のため、震度の大小比較上は一番大きい
// 場所(最後尾)に置き、「各地の震度」一覧で一番上に来るようにしている。
const INTENSITY_ORDER = ["0","1","2","3","4","5","5-","5+","6","6-","6+","7","5u"];
const STATION_ICON_BASE_RADIUS = 32; // bitmap側の半径(px)。icon-sizeで実際の大きさへスケールする。

// withText=falseの場合は数字を描かない(低ズームで円が小さいときに文字が潰れるのを避けるため)。
// strokeColorは通常は白固定だが、配色によっては塗りが白に近く縁が見えなくなる
// 震度キーがあるため、呼び出し側(registerStationIcons)で個別に上書きできるようにしている。
function buildStationIconCanvas(bg, fg, label, withText, strokeColor = "#ffffff") {
  const size = STATION_ICON_BASE_RADIUS * 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const cx = size / 2, cy = size / 2, r = STATION_ICON_BASE_RADIUS - 2;

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = strokeColor;
  ctx.stroke();

  if (withText) {
    // アプリ全体のCSSと同じフォントスタックに揃える。iOSではSan Francisco、
    // それ以外ではNoto Sans JP等に自然にフォールバックし、見た目を統一する。
    const STATION_ICON_FONT_STACK =
      '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", "Noto Sans JP", sans-serif';
    // 文字数で単純に切り替えると「5-」「6+」のような2文字が「1」等の1文字より
    // 見た目に小さくなってしまうため、実際の文字幅を測って、丸からはみ出さない
    // 範囲でできるだけ大きく表示されるようフォントサイズを自動調整する。
    const maxTextWidth = r * 1.7;
    let fontSize = r * 1.3;
    ctx.font = `800 ${fontSize}px ${STATION_ICON_FONT_STACK}`;
    const width = ctx.measureText(label).width;
    if (width > maxTextWidth) {
      fontSize *= maxTextWidth / width;
      ctx.font = `800 ${fontSize.toFixed(1)}px ${STATION_ICON_FONT_STACK}`;
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = fg;
    ctx.fillText(label, cx, cy + 1);
  }
  return ctx.getImageData(0, 0, size, size);
}

// 現在の配色スキームに合わせて、観測点アイコン(数字あり/なしの2種類 x 震度キー分)を
// まとめて生成し、MapLibreへaddImage/updateImageする。配色スキームが切り替わるたびに呼ぶ。
function registerStationIcons(map, scheme) {
  STATION_ICON_KEYS.forEach(key => {
    const style = scheme.colors[key === "5u" ? "5-" : key] || scheme.colors["0"];
    // 地図上の丸には「5弱」「6強」ではなくキー表記(5-,6+等)をそのまま出すが、
    // "5u"(震度5弱以上未入電)だけは内部キーをそのまま出さず「未」にする。
    const label = key === "5u" ? "未" : key;
    // 気象庁配色の震度1は塗りがほぼ白(#F2F2FF)なので、既定の白い縁のままだと
    // 塗りと縁が同化して見分けづらい。この組み合わせの時だけ縁を黒にする。
    const strokeColor = (scheme.id === "jma" && key === "1") ? "#000000" : "#ffffff";
    const dotImg = buildStationIconCanvas(style.bg, style.fg, label, false, strokeColor);
    const numImg = buildStationIconCanvas(style.bg, style.fg, label, true, strokeColor);
    const dotId = `station-icon-${key}-dot`;
    const numId = `station-icon-${key}-num`;
    if (map.hasImage(dotId)) map.updateImage(dotId, dotImg); else map.addImage(dotId, dotImg);
    if (map.hasImage(numId)) map.updateImage(numId, numImg); else map.addImage(numId, numImg);
  });
}

// buildStationIconCanvasの角丸正方形(スクイーカル)版。震度速報・震源に関する情報
// (細分区域単位、isArea:true)専用のアイコンに使う。観測点一覧の同じ場面で使っている
// 角丸正方形バッジと見た目を揃え、「これは区域単位のざっくりした震度」だと地図上でも
// 一目で分かるようにする。
function buildAreaIconCanvas(bg, fg, label, withText, strokeColor = "#ffffff") {
  const size = STATION_ICON_BASE_RADIUS * 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const inset = 3; // 縁の線幅分、正方形を少し内側に描く(はみ出し防止)。数字を大きく見せるため、円のアイコンより少し薄めの余白にしている。
  const rectSize = size - inset * 2;
  const cornerRadius = rectSize * 0.14; // 角の丸め具合(値が大きいほど丸くなる)。より四角く見えるよう控えめにする。

  ctx.beginPath();
  ctx.roundRect(inset, inset, rectSize, rectSize, cornerRadius);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = strokeColor;
  ctx.stroke();

  if (withText) {
    const STATION_ICON_FONT_STACK =
      '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", "Noto Sans JP", sans-serif';
    const maxTextWidth = rectSize * 0.86;
    let fontSize = rectSize * 0.66;
    ctx.font = `800 ${fontSize}px ${STATION_ICON_FONT_STACK}`;
    const width = ctx.measureText(label).width;
    if (width > maxTextWidth) {
      fontSize *= maxTextWidth / width;
      ctx.font = `800 ${fontSize.toFixed(1)}px ${STATION_ICON_FONT_STACK}`;
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = fg;
    ctx.fillText(label, size / 2, size / 2 + 1);
  }
  return ctx.getImageData(0, 0, size, size);
}

// registerStationIconsの角丸正方形版。area-icon-{key}-dot / -num を生成・登録する。
function registerAreaIcons(map, scheme) {
  STATION_ICON_KEYS.forEach(key => {
    const style = scheme.colors[key === "5u" ? "5-" : key] || scheme.colors["0"];
    const label = key === "5u" ? "未" : key;
    const strokeColor = (scheme.id === "jma" && key === "1") ? "#000000" : "#ffffff";
    const dotImg = buildAreaIconCanvas(style.bg, style.fg, label, false, strokeColor);
    const numImg = buildAreaIconCanvas(style.bg, style.fg, label, true, strokeColor);
    const dotId = `area-icon-${key}-dot`;
    const numId = `area-icon-${key}-num`;
    if (map.hasImage(dotId)) map.updateImage(dotId, dotImg); else map.addImage(dotId, dotImg);
    if (map.hasImage(numId)) map.updateImage(numId, numImg); else map.addImage(numId, numImg);
  });
}

/* ─────────────────────────────────────────────────────
   断層・プレート境界レイヤーの配色。
   ・縁取り(halo)はライト/ダーク共通の固定色にする(どちらのテーマでも
     海・陸に対して十分なコントラストが出る中間グレーを採用)。
   ・枠内の色(core)は設定画面でユーザーが選べるようにする。
   ───────────────────────────────────────────────────── */
const BOUNDARY_HALO_COLOR = "#86868c";

// 枠内の色が「グレー」の時だけ、縁取り(halo)を白にする。
// core・halo両方が似た中間グレーだと、二層構造(縁取り+芯)のコントラストが
// なくなって見分けにくくなるため、グレー選択時だけ縁取りを明るくして
// 芯とのコントラストを保つ。それ以外の色(オレンジ等)は、既に彩度差で
// haloとの区別がつくため、共通の固定グレーのままにする。
function getBoundaryHaloColor(colorId) {
  return colorId === "gray" ? "#ffffff" : BOUNDARY_HALO_COLOR;
}

const BOUNDARY_LINE_COLORS = {
  gray:   { label: "グレー",   color: "#9a9a9f" },
  white:  { label: "ホワイト", color: "#ffffff", checkColor: "#1c1c1e" }, // 白背景に白チェックだと見えないため、チェックだけ濃色にする
  orange: { label: "オレンジ", color: "#ff9500" },
  red:    { label: "レッド",   color: "#ff3b30" },
  blue:   { label: "ブルー",   color: "#0a84ff" },
  green:  { label: "グリーン", color: "#34c759" },
  purple: { label: "パープル", color: "#af52de" },
};

const QUAKE_COLOR_SCHEMES = {
  // 過去のLeaflet版(getIntensityColor)と全く同じ、鮮やかなApple風パレット。
  legacy: {
    id: "legacy",
    label: "eqs viewer配色",
    colors: {
      "0":  { bg: "#8E8E93", fg: "#fff" },
      "1":  { bg: "#64D2FF", fg: "#0B0B0C" },
      "2":  { bg: "#0A84FF", fg: "#fff" },
      "3":  { bg: "#30D158", fg: "#0B0B0C" },
      "4":  { bg: "#FFD60A", fg: "#0B0B0C" },
      "5":  { bg: "#FF9F0A", fg: "#0B0B0C" }, // 1996年10月改定前の「弱/強」区分が無い震度5
      "5-": { bg: "#FF9F0A", fg: "#0B0B0C" },
      "5+": { bg: "#FF453A", fg: "#fff" },
      "6":  { bg: "#FF2D55", fg: "#fff" }, // 同上、震度6
      "6-": { bg: "#FF2D55", fg: "#fff" },
      "6+": { bg: "#BF5AF2", fg: "#fff" },
      "7":  { bg: "#5E5CE6", fg: "#fff" },
      "?":  { bg: "#8E8E93", fg: "rgba(255,255,255,0.5)" },
    },
  },
  // 気象庁「ホームページにおける気象情報の配色に関する設定指針」(表２－２ 震度)に
  // 定められた公式のRGB値をそのまま使用。
  // 震度7:(180,0,104) 6強:(165,0,33) 6弱:(255,40,0) 5強:(255,153,0) 5弱:(255,230,0)
  // 4:(250,230,150) 3:(0,65,255) 2:(0,170,255) 1:(242,242,255)
  jma: {
    id: "jma",
    label: "気象庁配色",
    colors: {
      "0":  { bg: "#E5E5EA", fg: "#0B0B0C" }, // 震度0は指針に規定が無いため、背景に馴染む薄いグレーにしている
      "1":  { bg: "#F2F2FF", fg: "#0B0B0C" },
      "2":  { bg: "#00AAFF", fg: "#0B0B0C" },
      "3":  { bg: "#0041FF", fg: "#fff" },
      "4":  { bg: "#FAE696", fg: "#0B0B0C" },
      "5":  { bg: "#FFE600", fg: "#0B0B0C" }, // 1996年10月改定前の「弱/強」区分が無い震度5
      "5-": { bg: "#FFE600", fg: "#0B0B0C" },
      "5+": { bg: "#FF9900", fg: "#0B0B0C" },
      "6":  { bg: "#FF2800", fg: "#fff" }, // 同上、震度6
      "6-": { bg: "#FF2800", fg: "#fff" },
      "6+": { bg: "#A50021", fg: "#fff" },
      "7":  { bg: "#B40068", fg: "#fff" },
      "?":  { bg: "#C7C7CC", fg: "rgba(11,11,12,0.5)" },
    },
  },
  // このアプリで震度分布の塗りつぶし・バッジに元々使っていた配色。
  fill: {
    id: "fill",
    label: "",
    colors: {
      "0":  { bg: "#3A3A3C", fg: "#fff" },
      "1":  { bg: "#2F6690", fg: "#fff" },
      "2":  { bg: "#3FA9E0", fg: "#0B0B0C" },
      "3":  { bg: "#4FBF67", fg: "#0B0B0C" },
      "4":  { bg: "#FFD60A", fg: "#0B0B0C" },
      "5":  { bg: "#FF9F0A", fg: "#0B0B0C" }, // 1996年10月改定前の「弱/強」区分が無い震度5
      "5-": { bg: "#FF9F0A", fg: "#0B0B0C" },
      "5+": { bg: "#FF7A1A", fg: "#0B0B0C" },
      "6":  { bg: "#E0342C", fg: "#fff" }, // 同上、震度6
      "6-": { bg: "#E0342C", fg: "#fff" },
      "6+": { bg: "#8A1518", fg: "#fff" },
      "7":  { bg: "#AF52DE", fg: "#fff" }, // 紫
      "?":  { bg: "#3A3A3C", fg: "rgba(255,255,255,0.5)" },
    },
  },
};

// 現在選択中の震度配色スキームID("legacy" | "jma" | "fill")を
// アプリ全体に配るコンテキスト。地図・バッジ・凡例など離れた場所からでも
// props バケツリレーせずに参照できるようにする。
const QuakeColorSchemeContext = createContext("legacy");

// 震度配色スキームの選択はブラウザのlocalStorageに保存し、次回起動時も覚えておく。
// (プライベートブラウジング等でlocalStorageが使えない環境でも落ちないようtry/catchで囲む)
const QUAKE_COLOR_SCHEME_STORAGE_KEY = "quakeColorScheme";

function loadStoredQuakeColorScheme() {
  try {
    const saved = localStorage.getItem(QUAKE_COLOR_SCHEME_STORAGE_KEY);
    if (saved && QUAKE_COLOR_SCHEMES[saved]) return saved;
  } catch (err) {
    console.warn("震度配色の設定を読み込めませんでした:", err);
  }
  return "legacy";
}

function saveQuakeColorScheme(schemeId) {
  try {
    localStorage.setItem(QUAKE_COLOR_SCHEME_STORAGE_KEY, schemeId);
  } catch (err) {
    console.warn("震度配色の設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   ライト/ダークモード
   
   アプリ全体はもともとダーク基調(#121214背景+白文字)で作られているため、
   ライトモードは「別の配色を丸ごと用意し、UIのベースとなる色をcontext経由で
   出し分ける」形で追加する。地図の基本配色(海・陸のタイル色)や、震度色
   バッジのような意味を持つ色(震度配色スキームなど)まではこの対応範囲に
   含めない(それらは別途テーマ対応が必要)。まずは背景・カード・文字色
   など、UIチューム全体に効いてくる基礎トークンをテーマ切り替え対象にする。
   ───────────────────────────────────────────────────── */
const THEME_TOKENS = {
  dark: {
    pageBg: "#121214",
    text: "#ffffff",
    textSecondary: "rgba(255,255,255,0.55)",
    textTertiary: "rgba(255,255,255,0.35)",
    cardBg: "rgba(255,255,255,0.04)",
    cardBorder: "rgba(255,255,255,0.08)",
    divider: "rgba(255,255,255,0.08)",
    glassTint: "rgba(255,255,255,0.02)",
    glassOpaqueBg: "rgba(32,32,36,0.92)",
    rimLight: "rgba(255,255,255,0.45)",
    rimHighlight: "rgba(255,255,255,0.55)",
    // ナビ行(SideNavRail/BottomDockの下部タブ)の選択中ピル。
    // ダークはこれまで通りガラスの縁取り(rim)入りの見た目を維持する。
    navPillBg: "rgba(255,255,255,0.13)",
    navPillShadow: "inset 0 0 0 0.5px rgba(255,255,255,0.45), inset 0 1px 0 rgba(255,255,255,0.55)",
    // 文字・線用のRGBチャンネル値(不透明度だけ変えたrgba(${tokens.ink},X)の形で
    // 各所から使う。ダークは白、ライトはほぼ黒)。
    ink: "255,255,255",
    // 検索ボタンなどのアクセント文字色。ダークは明るい水色の方が背景に映えるが、
    // ライトの明るい背景だと同じ色ではコントラストが足りず読みにくくなるため、
    // ライトモードではやや濃い標準的なシステムブルーにする。
    accentText: "#64D2FF",
    // 地図の基本配色(海・陸・都道府県境界線)
    mapBg: "#121214",         // 海
    mapWorldFill: "#2c2c2e",  // 陸地(海外)
    mapWorldLine: "rgba(255,255,255,0.08)",
    mapPrefFill: "#3a3a3c",   // 都道府県(日本)
    mapPrefLine: "rgba(255,255,255,0.18)",
  },
  light: {
    pageBg: "#eef0f3",
    text: "#15161a",
    textSecondary: "rgba(21,22,26,0.6)",
    textTertiary: "rgba(21,22,26,0.4)",
    cardBg: "rgba(21,22,26,0.045)",
    cardBorder: "rgba(21,22,26,0.10)",
    divider: "rgba(21,22,26,0.10)",
    glassTint: "rgba(255,255,255,0.55)",
    glassOpaqueBg: "rgba(244,245,248,0.94)",
    rimLight: "rgba(21,22,26,0.16)",
    rimHighlight: "rgba(255,255,255,0.8)",
    // ナビ行の選択中ピル。参考画像のような、縁取りのないフラットな
    // 淡いグレーのピルにする(ダークのようなガラスの縁取りは入れない)。
    navPillBg: "rgba(21,22,26,0.07)",
    navPillShadow: "none",
    ink: "21,22,26",
    accentText: "#0A84FF",
    // 地図の基本配色(海・陸・都道府県境界線)
    mapBg: "#aecbe8",         // 海
    mapWorldFill: "#e4e2dc",  // 陸地(海外)
    mapWorldLine: "rgba(21,22,26,0.12)",
    mapPrefFill: "#f2f0ea",   // 都道府県(日本)
    mapPrefLine: "rgba(21,22,26,0.22)",
  },
};

// UIのベースになる配色トークンを、モード("dark"|"light")込みでアプリ全体に配るcontext。
// mode: 実際に適用中のライト/ダーク("dark"|"light"、"system"選択時はデバイス設定から解決した結果)。
// modePref: ユーザーが選んだ設定そのもの("system"|"light"|"dark"、初期設定は"system")。
// setModePref: modePrefを変更する関数。
const ThemeContext = createContext({
  mode: "dark",
  tokens: THEME_TOKENS.dark,
  modePref: "system",
  setModePref: () => {},
});

// デバイスの配色設定(prefers-color-scheme)をライブで監視するフック。
// "デバイスの設定に合わせる"がONの間、この値をそのままthemeMode解決に使う。
// 端末側でライト/ダークが切り替わった場合もリアルタイムに追従する。
function useSystemThemeMode() {
  const [systemMode, setSystemMode] = useState(() => {
    try {
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch (err) {
      return "dark";
    }
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = (e) => setSystemMode(e.matches ? "light" : "dark");
    if (mq.addEventListener) mq.addEventListener("change", handleChange);
    else if (mq.addListener) mq.addListener(handleChange); // 古いSafari向けフォールバック
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handleChange);
      else if (mq.removeListener) mq.removeListener(handleChange);
    };
  }, []);

  return systemMode;
}

// ナビ等のハイライトピルを指で押している間だけ本物のガラス(backdrop-filter)に
// する際のぼかし量。ライトモードは背景の色情報が少なく、ダークと同じ強さでは
// 「ガラス感」が弱く見えるため、ぼかし・彩度ともライトの方を強めにしている。
function touchGlassBackdropFilter(mode) {
  return mode === "light"
    ? "blur(22px) saturate(220%)"
    : "blur(16px) saturate(160%)";
}

// テーマの選択はlocalStorageに保存し、次回起動時も覚えておく。
// 値は"system"(デバイスの設定に合わせる。初期設定) | "light" | "dark"。
const THEME_MODE_STORAGE_KEY = "themeMode";

function loadStoredThemeModePref() {
  try {
    const saved = localStorage.getItem(THEME_MODE_STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch (err) {
    console.warn("テーマ設定を読み込めませんでした:", err);
  }
  return "system";
}

function saveThemeModePref(modePref) {
  try {
    localStorage.setItem(THEME_MODE_STORAGE_KEY, modePref);
  } catch (err) {
    console.warn("テーマ設定を保存できませんでした:", err);
  }
}


/* ─────────────────────────────────────────────────────
   推計震度分布(気象庁 estimated_intensity_map)の表示ON/OFF設定。
   震度配色と同様、ブラウザのlocalStorageに保存し次回起動時も覚えておく。
   デフォルトはON(防災アプリとして、初回起動時から見えている方が安全側)。
   ───────────────────────────────────────────────────── */
const EST_INTENSITY_ENABLED_STORAGE_KEY = "showEstimatedIntensity";

function loadStoredEstIntensityEnabled() {
  try {
    const saved = localStorage.getItem(EST_INTENSITY_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("推計震度分布の表示設定を読み込めませんでした:", err);
  }
  return true;
}

function saveEstIntensityEnabled(enabled) {
  try {
    localStorage.setItem(EST_INTENSITY_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("推計震度分布の表示設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   細分区域(気象庁の細分区域単位)を震度の色で塗りつぶすかどうかの設定。
   推計震度分布と同様、localStorageに保存し次回起動時も覚えておく。
   デフォルトはON(従来どおりの見た目を維持する)。
   ───────────────────────────────────────────────────── */
const AREA_FILL_ENABLED_STORAGE_KEY = "showAreaIntensityFill";

function loadStoredAreaFillEnabled() {
  try {
    const saved = localStorage.getItem(AREA_FILL_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("細分区域塗りつぶしの表示設定を読み込めませんでした:", err);
  }
  return true;
}

function saveAreaFillEnabled(enabled) {
  try {
    localStorage.setItem(AREA_FILL_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("細分区域塗りつぶしの表示設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   実験的・テスト機能のON/OFF設定。デフォルトはOFF
   (明示的にONにした場合のみ、設定画面にテスト配信UI等が現れる)。
   ───────────────────────────────────────────────────── */
const EXPERIMENTAL_FEATURES_STORAGE_KEY = "experimentalFeaturesEnabled";

function loadStoredExperimentalFeaturesEnabled() {
  try {
    return localStorage.getItem(EXPERIMENTAL_FEATURES_STORAGE_KEY) === "true";
  } catch (err) {
    console.warn("実験的機能の設定を読み込めませんでした:", err);
  }
  return false;
}

function saveExperimentalFeaturesEnabled(enabled) {
  try {
    localStorage.setItem(EXPERIMENTAL_FEATURES_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("実験的機能の設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   断層(faults.geojson)の表示ON/OFF設定。
   推計震度分布などと同様、localStorageに保存し次回起動時も覚えておく。
   ファイルサイズが大きい(数MB)ため、デフォルトはOFF
   (明示的にONにした場合のみデータを読み込む)。
   ───────────────────────────────────────────────────── */
const FAULTS_ENABLED_STORAGE_KEY = "showFaults";

function loadStoredFaultsEnabled() {
  try {
    const saved = localStorage.getItem(FAULTS_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("断層表示の設定を読み込めませんでした:", err);
  }
  return false;
}

function saveFaultsEnabled(enabled) {
  try {
    localStorage.setItem(FAULTS_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("断層表示の設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   プレート境界(plate-boundaries.json)の表示ON/OFF設定。
   断層と同様、ファイルサイズが大きいためデフォルトはOFF。
   ───────────────────────────────────────────────────── */
const PLATE_BOUNDARIES_ENABLED_STORAGE_KEY = "showPlateBoundaries";

function loadStoredPlateBoundariesEnabled() {
  try {
    const saved = localStorage.getItem(PLATE_BOUNDARIES_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("プレート境界表示の設定を読み込めませんでした:", err);
  }
  return false;
}

function savePlateBoundariesEnabled(enabled) {
  try {
    localStorage.setItem(PLATE_BOUNDARIES_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("プレート境界表示の設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   震央分布(地図上の丸)の表示ON/OFF設定。
   一覧を開くたびに丸が大量に出ると地図が見づらいという声があるため、
   デフォルトはOFFにしておき、必要な人だけ設定でONにしてもらう。
   ───────────────────────────────────────────────────── */
const EPICENTER_CIRCLES_ENABLED_STORAGE_KEY = "showEpicenterCircles";

function loadStoredEpicenterCirclesEnabled() {
  try {
    const saved = localStorage.getItem(EPICENTER_CIRCLES_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("震央分布表示の設定を読み込めませんでした:", err);
  }
  return false;
}

function saveEpicenterCirclesEnabled(enabled) {
  try {
    localStorage.setItem(EPICENTER_CIRCLES_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("震央分布表示の設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   利用規約・プライバシーポリシー・注意事項への同意まわり。

   public/配下の3つのMarkdownファイルの「内容」から非暗号学的ハッシュ(cyrb53)を
   計算し、前回同意した時点のハッシュとlocalStorage上で比較することで、
   文書が更新されたかどうかを自動判定する。開発者が手動でバージョン番号を
   上げ忘れても、ファイルの中身さえ変われば自動的に再同意を求められる。

   改ざん耐性等は不要(あくまで「差分があるかどうか」の検知が目的)なため、
   Web Crypto(非同期)は使わず、高速な同期関数で済ませている。
   ───────────────────────────────────────────────────── */
function simpleHash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

const TERMS_AGREEMENT_STORAGE_KEY = "termsAgreementV1";

// { tou, privacy, notices: <各文書の同意時点でのハッシュ>, agreedAt } | null
function loadStoredTermsAgreement() {
  try {
    const saved = localStorage.getItem(TERMS_AGREEMENT_STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    if (parsed && typeof parsed === "object" && parsed.tou && parsed.privacy && parsed.notices) {
      return parsed;
    }
  } catch (err) {
    console.warn("利用規約等への同意状態を読み込めませんでした:", err);
  }
  return null;
}

function saveStoredTermsAgreement(agreement) {
  try {
    localStorage.setItem(TERMS_AGREEMENT_STORAGE_KEY, JSON.stringify(agreement));
  } catch (err) {
    console.warn("利用規約等への同意状態を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   断層・プレート境界の「枠内の色」設定。
   縁取り(halo)はライト/ダーク共通の固定色だが、枠内の色はBOUNDARY_LINE_COLORSの
   中からユーザーが選べるようにし、localStorageに保存する。デフォルトは"gray"。
   ───────────────────────────────────────────────────── */
const BOUNDARY_LINE_COLOR_STORAGE_KEY = "boundaryLineColorId";

function loadStoredBoundaryLineColorId() {
  try {
    const saved = localStorage.getItem(BOUNDARY_LINE_COLOR_STORAGE_KEY);
    if (saved && BOUNDARY_LINE_COLORS[saved]) return saved;
  } catch (err) {
    console.warn("断層・プレート境界の色設定を読み込めませんでした:", err);
  }
  return "gray";
}

function saveBoundaryLineColorId(id) {
  try {
    localStorage.setItem(BOUNDARY_LINE_COLOR_STORAGE_KEY, id);
  } catch (err) {
    console.warn("断層・プレート境界の色設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   地震一覧の取得件数の設定。
   P2P地震情報APIの /history から一度に取得する件数(=一覧に表示する最大件数)。
   1〜1000件の範囲でユーザーが指定でき、localStorageに保存する。デフォルトは100件。
   ───────────────────────────────────────────────────── */
const QUAKE_FETCH_LIMIT_STORAGE_KEY = "quakeFetchLimit";
const QUAKE_FETCH_LIMIT_MIN = 1;
const QUAKE_FETCH_LIMIT_MAX = 1000;
const QUAKE_FETCH_LIMIT_DEFAULT = 100;

function clampQuakeFetchLimit(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return QUAKE_FETCH_LIMIT_DEFAULT;
  return Math.min(QUAKE_FETCH_LIMIT_MAX, Math.max(QUAKE_FETCH_LIMIT_MIN, n));
}

function loadStoredQuakeFetchLimit() {
  try {
    const saved = localStorage.getItem(QUAKE_FETCH_LIMIT_STORAGE_KEY);
    if (saved != null) return clampQuakeFetchLimit(saved);
  } catch (err) {
    console.warn("地震の取得件数の設定を読み込めませんでした:", err);
  }
  return QUAKE_FETCH_LIMIT_DEFAULT;
}

function saveQuakeFetchLimit(limit) {
  try {
    localStorage.setItem(QUAKE_FETCH_LIMIT_STORAGE_KEY, String(clampQuakeFetchLimit(limit)));
  } catch (err) {
    console.warn("地震の取得件数の設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   震度観測点リスト(StationPointsList)の表示方法。
   "grouped" = 震度階級ごとに階層表示(既定)、"list" = 従来のフラット一覧。
   震度配色などと同様、localStorageに保存し次回起動時も覚えておく。
   ───────────────────────────────────────────────────── */
const STATION_LIST_DISPLAY_MODES = {
  grouped: { label: "階層表示" },
  list:    { label: "一覧表示" },
};
const STATION_LIST_DISPLAY_MODE_STORAGE_KEY = "stationListDisplayMode";

function loadStoredStationListDisplayMode() {
  try {
    const saved = localStorage.getItem(STATION_LIST_DISPLAY_MODE_STORAGE_KEY);
    if (saved && STATION_LIST_DISPLAY_MODES[saved]) return saved;
  } catch (err) {
    console.warn("震度観測点リストの表示設定を読み込めませんでした:", err);
  }
  return "list"; // 既定は一覧表示
}

function saveStationListDisplayMode(mode) {
  try {
    localStorage.setItem(STATION_LIST_DISPLAY_MODE_STORAGE_KEY, mode);
  } catch (err) {
    console.warn("震度観測点リストの表示設定を保存できませんでした:", err);
  }
}

// 指定したスキームオブジェクトについて、震度キーに対応する{ bg, fg, label }を返す。
// .map()のコールバック内などフックを呼べない場所からはこちらを直接使う
// (スキーム自体はコンポーネント側で useContext(QuakeColorSchemeContext) して渡す)。
function getIntensityStyleFromScheme(scheme, intensityKey) {
  // "5u"(震度5弱以上未入電)は独自の色を持たず、5弱(5-)の配色を流用する。
  // 「少なくとも5弱相当」という情報として扱うため。
  const colorKey = intensityKey === "5u" ? "5-" : intensityKey;
  const c = scheme.colors[colorKey] || scheme.colors["0"];
  const label = INTENSITY_LABEL[intensityKey] || INTENSITY_LABEL["0"];
  return { bg: c.bg, fg: c.fg, label };
}

// 指定した震度キー("1"〜"7","5-"などINTENSITY_LABELのキー)について、
// 現在選択中のスキームに沿った{ bg, fg, label }を返す。
function useIntensityStyle(intensityKey) {
  const schemeId = useContext(QuakeColorSchemeContext);
  const scheme = QUAKE_COLOR_SCHEMES[schemeId] || QUAKE_COLOR_SCHEMES.fill;
  return getIntensityStyleFromScheme(scheme, intensityKey);
}

// 表示用ラベルを「数字」と「弱/強」に分割する(バッジ内で2段組みにするため)
function splitIntensityLabel(label) {
  const m = /^([0-7])(弱|強)?$/.exec(label);
  if (!m) return { num: label, suffix: null };
  return { num: m[1], suffix: m[2] || null };
}

/* ─────────────────────────────────────────────────────
   P2P地震情報 JSON API (v2)
   https://api.p2pquake.net/v2/history?codes=551
   地震情報(code:551)を取得し、アプリ内で使う形に変換する。
   maxScale は 10刻みの震度コード(10=震度1 ... 70=震度7)で返ってくるため、
   INTENSITY_STYLE のキー("1"〜"7","5-","5+","6-","6+")に変換する。
   ───────────────────────────────────────────────────── */
const P2PQUAKE_HISTORY_URL_BASE = "https://api.p2pquake.net/v2/history?codes=551";

function maxScaleToIntensityKey(maxScale) {
  const map = {
    "-1": "0", "0": "0",
    "10": "1", "20": "2", "30": "3", "40": "4",
    "44": "5", "45": "5-", "50": "5+",
    "46": "5u", // 震度5弱以上未入電(観測点で震度計は検知したが、確定した震度をまだ入電できていない状態)
    "54": "6", "55": "6-", "60": "6+",
    "70": "7",
  };
  return map[String(maxScale)] ?? "?";
}

/* ─────────────────────────────────────────────────────
   地震情報の発表段階(issue.type)
   最大震度3以上等の地震では、気象庁の電文が段階的に発表される:
     ① ScalePrompt(震度速報)   … 震源はまだ不明。細分区域単位(isArea:true)の
                                   揺れの分布と最大震度だけが先に分かる。
     ② Destination(震源に関する情報) … 震源(位置・M・深さ)は判明したが、
                                   震度分布(points)はまだ無い(maxScale=-1)。
     ③ DetailScale(震度に関する情報) … 震源・市町村単位(isArea:false)の
                                   震度分布のどちらも確定。
   同じ地震について複数の段階の電文が別々に届くため、アプリ内では
   「これまでに届いた電文のうち最も進んだ段階」をstageとして保持し、
   一覧・詳細画面に「震度速報」「震源情報」等のバッジを出す。
   ③まで届けば全情報が揃うため、バッジは表示しない。
   ───────────────────────────────────────────────────── */
const QUAKE_STAGE_RANK = { prompt: 1, destination: 2, detail: 3 };
const QUAKE_STAGE_LABEL = {
  prompt: "震度速報",
  destination: "震源情報",
  // detail(確定)はバッジ無し
};
function quakeStageFromIssueType(issueType) {
  if (issueType === "ScalePrompt") return "prompt";
  if (issueType === "Destination") return "destination";
  return "detail"; // DetailScale・Foreign・その他は確定扱い
}

// API由来のISO風文字列("2024/01/01 12:34:56.789")を "YYYY/MM/DD HH:mm:ss" 表示用に整える
function formatQuakeTime(raw) {
  if (!raw) return "";
  return raw.split(".")[0]; // ミリ秒以下を切り捨てるだけで日本時間表記のまま使える
}

// 発生時刻を「YYYY/MM/DD HH:mm頃」の表示用に整形する(QuakeDetailCard用)。
// formatQuakeTime()済みの "YYYY/MM/DD HH:mm:ss" (または元のISO風文字列)どちらを渡しても動くよう、
// 空白で日付部分と時刻部分に分け、時刻はHH:mmだけ取り出して秒は切り捨てる。
function formatQuakeTimeShort(raw) {
  if (!raw) return "";
  const [datePart, timePart] = raw.split(" ");
  if (!timePart) return raw;
  const [hh, mm] = timePart.split(":");
  if (hh == null || mm == null) return raw;
  return `${datePart} ${hh}:${mm}頃`;
}

// 緊急地震速報の発生時刻用。通常の地震一覧(formatQuakeTimeShort)は分単位までだが、
// 緊急地震速報は速報性・精度が重要なため秒まで表示する。
function formatEewTimeShort(raw) {
  if (!raw) return "";
  const [datePart, timePart] = raw.split(" ");
  if (!timePart) return raw;
  const [hh, mm, ss] = timePart.split(":");
  if (hh == null || mm == null) return raw;
  return `${datePart} ${hh}:${mm}:${ss ?? "00"}頃`;
}

// 「最大波を観測した時刻」の表示用(エポックms→「24日 15:30」のような形式)。
function formatTsunamiMaxWaveTime(timeMs) {
  if (timeMs == null || !Number.isFinite(timeMs)) return "";
  const d = new Date(timeMs);
  const pad2 = n => String(n).padStart(2, "0");
  return `${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 津波情報の発表時刻は(地震の発生時刻と違って)推定ではなく確定した時刻なので、
// formatQuakeTimeShortの「頃」は付けない。
function formatTsunamiTimeShort(raw) {
  if (!raw) return "";
  const [datePart, timePart] = raw.split(" ");
  if (!timePart) return raw;
  const [hh, mm] = timePart.split(":");
  if (hh == null || mm == null) return raw;
  return `${datePart} ${hh}:${mm}`;
}

// P2P地震情報APIの1レコードを、QuakeDetailCardが使う形に変換する
function toQuakeCard(item) {
  const eq = item.earthquake;
  const hypo = eq?.hypocenter;
  const points = Array.isArray(item?.points) ? item.points : [];

  // 遠地地震(海外で発生し、国内で震度が観測されない地震)に関する情報かどうか。
  // issue.type === "Foreign" の場合、maxScaleは "-1"(観測なし)になる。
  // これを国内の「震度0(揺れなし)」と同じ扱いにしてしまうと紛らわしいため、区別する。
  const isForeign = item?.issue?.type === "Foreign";

  // earthquake.maxScaleが欠落/nullのレコードが稀に存在する
  // (震度速報→詳細への更新過程などで一時的に未設定のことがある)。
  // その場合はpoints[]の中の最大scaleから補完し、「震度0」の誤表示を防ぐ。
  // ただし遠地地震はそもそも国内観測点のpointsを持たないため、補完の対象外とする。
  let maxScale = eq?.maxScale;
  if (!isForeign && (maxScale == null || maxScale === -1) && points.length > 0) {
    maxScale = points.reduce((max, p) => (typeof p.scale === "number" && p.scale > max ? p.scale : max), -1);
  }
  // 震源に関する情報(issue.type: Destination)は、震源(位置・M・深さ)は判明した
  // ものの震度分布(points)がまだ無い段階のため、maxScaleは常に-1・pointsは
  // 常に空配列で届く。この-1は遠地地震の「国内で観測なし」とは意味が違い、
  // 「震度がまだ不明(調査中)」であって「震度0(揺れなし)」ではないため、
  // points補完もできない(=points.length===0のまま)場合は明示的に「不明」扱いにする。
  const maxScaleUnknown = !isForeign && maxScale === -1 && points.length === 0;

  // WebSocketのリアルタイム配信では、ごく最初の1通だけAPI上本来必須のはずの
  // idが未確定/欠落した状態で届くことがある(/historyで同じ地震を取得し直すと
  // idが付いている)。idがundefinedのままだと、selectedQuakeIdもundefinedに
  // なってしまい、UI側の「selectedQuakeId != null」のようなnullとの比較で
  // (undefined == nullがtrueになるため)「未選択」と区別が付かなくなる
  // ―― 具体的には、選択してもボタンバーが引っ込まず、戻るボタンも出ない
  // 不具合として現れる。そのため、idが無い場合はtime+placeから作った
  // 安定な代替idにフォールバックし、常にnull/undefinedにならないようにする。
  // (本物のidを持つレコードが後から届いた場合は、既存のtime+place一致による
  // 「後継への選択引き継ぎ」ロジックがそのまま機能する)
  const id = item.id || `noid_${eq?.time || "?"}_${hypo?.name || "?"}`;
  const stage = quakeStageFromIssueType(item?.issue?.type);

  return {
    id,
    time: formatQuakeTime(eq?.time),
    // 電文の発表時刻(issue.time)。同じ地震の複数電文をフィールド単位でマージする際、
    // どちらが新しい電文かを判定するのに使う(mergeQuakeCards参照)。
    issueTime: item?.issue?.time || null,
    // 発表段階(震度速報/震源に関する情報/確定)。バッジ表示・マージ時の情報量比較に使う。
    stage,
    // 震度速報(prompt)の段階では、震源はまだ「分からない」のではなく「調査中」
    // なので、他の段階と同じ「震源地不明」ではなく、より実態に合った文言にする。
    place: hypo?.name || (stage === "prompt" ? "震源調査中" : "震源地不明"),
    maxIntensity: isForeign ? "?" : (maxScaleUnknown ? "?" : maxScaleToIntensityKey(maxScale)),
    isForeign,
    magnitude: typeof hypo?.magnitude === "number" && hypo.magnitude > 0 ? hypo.magnitude : null,
    depth: typeof hypo?.depth === "number" && hypo.depth >= 0 ? hypo.depth : null,
    longPeriod: null, // P2P地震情報APIには長周期地震動階級は含まれないため常に非表示
    // -200は「震源がまだ確定していない」ことを示す番兵値(震度速報の段階で使われる)。
    // 数値ではあるが実在の座標ではないため、通常のnullチェックと同様に除外する
    // (これが無いと、震源不明のはずの地震が地図上のあり得ない位置に表示されてしまう)。
    latitude: typeof hypo?.latitude === "number" && hypo.latitude !== -200 ? hypo.latitude : null,
    longitude: typeof hypo?.longitude === "number" && hypo.longitude !== -200 ? hypo.longitude : null,
    // 観測点ごとの震度。{ pref, addr, scale, isArea }の配列(無ければ空配列)。
    // 注意: pointsは`earthquake`オブジェクトの中ではなく、レコード直下(item.points)にある。
    // scaleは10刻みのJMAコード(10=震度1 ... 70=震度7)のまま保持しておき、
    // 表示側(観測点マッチング後)でINTENSITY_STYLEのキーに変換する。
    points,
    // 国内津波の有無・程度。"None"(心配なし) / "Unknown" / "Checking"(調査中) /
    // "NonEffective"(若干の海面変動) / "Watch"(注意報) / "Warning"(警報) / "MajorWarning"(大津波警報)
    // フィールド自体が無い場合(震度速報・震源に関する情報など、津波の判定が
    // まだ行われていない段階のレコード)は、「心配なし」ではなく「調査中」を
    // 既定値にする。"None"を既定にしてしまうと、実際にはまだ判定されていない
    // だけなのに「津波の心配はありません」と誤って表示されてしまうため。
    domesticTsunami: eq?.domesticTsunami || "Unknown",
    // 気象庁が付加する自由記述コメント(あれば)
    freeFormComment: item?.comments?.freeFormComment || null,
  };
}

/* ─────────────────────────────────────────────────────
   電文(付加コメント)テキストの組み立て
   domesticTsunami(津波の有無)を基本の文言にし、freeFormComment(付加文)が
   あれば続けて表示する。津波の危険がある場合は色も変える。
   ───────────────────────────────────────────────────── */
const TSUNAMI_TEXT = {
  None:         { text: "この地震による津波の心配はありません。" },
  Unknown:      { text: "津波の有無について、現在調査中です。",                   color: "#FFD60A" },
  Checking:     { text: "津波の有無について、現在調査中です。",                   color: "#FFD60A" },
  NonEffective: { text: "若干の海面変動が予想されますが、被害の心配はありません。", color: "#FFD60A" },
  // 注意報・警報・大津波警報は、個別のグレードを言い切らず「等」でまとめた
  // 共通文言にする。同じ地震について、グレードが後から切り下げ/切り上げ
  // されることがあり、表示側が参照している電文のタイミングによっては
  // 実際のグレードと異なる文言を出してしまう恐れがあるため
  // (詳しい現在のグレードは津波タブ側の表示を確認してもらう)。
  Watch:        { text: "この地震により、津波警報・注意報等が発表されています。", color: "#FF453A" },
  Warning:      { text: "この地震により、津波警報・注意報等が発表されています。", color: "#FF453A" },
  MajorWarning: { text: "この地震により、津波警報・注意報等が発表されています。", color: "#FF453A" },
};

function buildQuakeMessage(quake) {
  const { tokens } = useContext(ThemeContext);

  const tsunami = TSUNAMI_TEXT[quake.domesticTsunami] || TSUNAMI_TEXT.None;
  const lines = [{ label: "津波情報", text: tsunami.text, color: tsunami.color || tokens.textSecondary }];
  if (quake.freeFormComment) {
    lines.push({ label: "付加文", text: quake.freeFormComment, color: `rgba(${tokens.ink},0.75)` });
  }
  return lines;
}

// 直近の地震情報一覧を取得する。取得失敗時はエラーを投げる(呼び出し側でハンドリング)。
/* ─────────────────────────────────────────────────────
   重複レコードの除外・段階マージ
   同じ地震について、気象庁から複数の電文(①震度速報→②震源に関する情報→
   ③震度に関する情報)が段階的に配信される。①は震源不明・地域単位の震度分布、
   ②は震源確定・震度分布なし、③は震源・市町村単位の震度分布のどちらも確定、
   というように電文ごとに持っている情報が異なるため、単純に「1グループ1件を
   丸ごと選ぶ」のではなく、フィールドごとに「その時点で一番情報量が多いもの」を
   組み合わせてマージする(mergeQuakeCards参照)。
   グループ化のキーはearthquake.time(発生時刻)のみを使う。以前はplace(震源地)
   も条件に含めていたが、①→②③の間でplaceが「震源地不明」→実際の地名に
   変わるため、それだと同じ地震が2件に分かれてしまう。時刻は①②③を通じて
   変化しないため、キーとして安定している。
   ───────────────────────────────────────────────────── */

// 観測点(points)の「情報の詳しさ」を比較するためのランク。
// 市町村単位(isAreaがfalseの点を含む) > 地域単位(震度速報, isArea:trueのみ) > 無し(空配列)
function pointsRichness(card) {
  if (!Array.isArray(card.points) || card.points.length === 0) return 0;
  return card.points.some(p => p.isArea === false) ? 2 : 1;
}

// 震源(震源地名)が判明しているかどうか。"震源地不明"「震源調査中」はどちらも
// toQuakeCardが付ける既定値(震源がまだ判明していないことを示す)。
function hasKnownHypocenter(card) {
  return card.place !== "震源地不明" && card.place !== "震源調査中";
}

// 同じ地震(同じ発生時刻)について、2件のカードをフィールド単位でマージする。
// a・bどちらが渡されても結果が変わらないよう、常にissueTime(電文の発表時刻)を
// 見てどちらが新しい電文かを判定してから、フィールドごとに採用元を決める。
function mergeQuakeCards(a, b) {
  if (!a) return b;
  if (!b) return a;

  const bIsNewer = (b.issueTime || "") >= (a.issueTime || "");
  const newer = bIsNewer ? b : a;
  const older = bIsNewer ? a : b;

  // 震源(震源地名・緯度経度・M・深さ): 判明している方を優先。両方判明していれば新しい方。
  const hypoSrc = hasKnownHypocenter(newer) ? newer : (hasKnownHypocenter(older) ? older : newer);

  // 震度分布(points・maxIntensity): より詳しい方を優先。同格なら新しい方
  // (件数が増えている・確定値に更新されている可能性が高いため)。
  const newerRichness = pointsRichness(newer);
  const olderRichness = pointsRichness(older);
  const pointsSrc = newerRichness >= olderRichness ? newer : older;

  // 発表段階(バッジ表示用): これまでに届いた電文のうち最も進んだ段階を保持する
  // (震度速報だけ→震源情報が届いた後に、また震度速報の段階に戻ることはないため)。
  const stageRank = s => QUAKE_STAGE_RANK[s] || 0;
  const finalStage = stageRank(a.stage) >= stageRank(b.stage) ? a.stage : b.stage;

  // id: 本物のid(noid_で始まらないもの)を優先。新しい方の電文がまだidを
  // 確定できていない場合に備えて、古い方が本物のidを持っていればそちらを使う。
  const isRealId = id => typeof id === "string" && !id.startsWith("noid_");
  const id = isRealId(newer.id) ? newer.id : (isRealId(older.id) ? older.id : newer.id);

  return {
    id,
    time: a.time, // グループ化キーなので両者で同じ
    issueTime: newer.issueTime,
    stage: finalStage,
    place: hypoSrc.place,
    magnitude: hypoSrc.magnitude,
    depth: hypoSrc.depth,
    latitude: hypoSrc.latitude,
    longitude: hypoSrc.longitude,
    longPeriod: hypoSrc.longPeriod,
    maxIntensity: pointsSrc.maxIntensity,
    points: pointsSrc.points,
    isForeign: newer.isForeign,
    // 津波判定・付加文は、その時点で最新の電文の内容が常に正しい(後から
    // 警報→注意報に切り下がる、付加文が追記される、といった更新がありうるため)。
    domesticTsunami: newer.domesticTsunami,
    freeFormComment: newer.freeFormComment ?? older.freeFormComment ?? null,
    // テスト配信(地震情報テスト配信機能)由来かどうか。どちらか一方でもテストなら
    // テスト扱いにする(実運用でテストと実データが混ざることは無いが念のため)。
    isTest: !!(newer.isTest || older.isTest),
  };
}

function dedupeQuakeList(list) {
  // listは常に新しい順(newest-first)で渡ってくるが、mergeQuakeCards自体は
  // 渡す順序に依存せず正しい結果になるようissueTimeで新旧を判定しているため、
  // ここでは単に同じグループのカードを順にマージしていくだけでよい。
  const order = []; // グループの初出順(=一覧の表示順)を保つ
  const merged = new Map(); // time -> マージ済みカード
  for (const q of list) {
    const key = q.time;
    if (!merged.has(key)) {
      order.push(key);
      merged.set(key, q);
    } else {
      merged.set(key, mergeQuakeCards(merged.get(key), q));
    }
  }
  return order.map(key => merged.get(key));
}


/* ─────────────────────────────────────────────────────
   津波情報(P2P地震情報 JMATsunami, code:552)
   https://api.p2pquake.net/v2/history?codes=552
   気象庁が発表する津波予報区ごとの津波予報・警報を取得する。
   区分(grade)は MajorWarning(大津波警報) > Warning(津波警報) >
   Watch(津波注意報) > NonEffective(津波予報・若干の海面変動) > Unknown(調査中)
   の順に危険度が高い。1件のレコードに複数の予報区(areas)が含まれるため、
   一覧には「その時点で最も危険度が高いgrade」を代表として表示する。
   ───────────────────────────────────────────────────── */
const P2PQUAKE_TSUNAMI_HISTORY_URL_BASE = "https://api.p2pquake.net/v2/history?codes=552";
const TSUNAMI_FETCH_LIMIT = 50; // 地震に比べて発表頻度が低いため、地震ほど多くの件数は要らない

const TSUNAMI_GRADE_INFO = {
  MajorWarning: { label: "大津波警報", weight: 4, color: "#BF5AF2" },
  Warning:      { label: "津波警報",   weight: 3, color: "#FF453A" },
  Watch:        { label: "津波注意報", weight: 2, color: "#FFD60A" },
  NonEffective: { label: "津波予報",   weight: 1, color: "#64D2FF" },
  Unknown:      { label: "調査中",     weight: 0, color: "#8E8E93" },
};
const TSUNAMI_GRADE_FALLBACK = { label: "情報", weight: 0, color: "#8E8E93" };

function tsunamiGradeInfo(grade) {
  return TSUNAMI_GRADE_INFO[grade] || TSUNAMI_GRADE_FALLBACK;
}

// 観測点の丸・観測された津波の高さバーの色は、予報区の公式なグレード(警報等の
// 種類)ではなく、実際に観測された高さの大小そのものに応じて塗り分ける
// (0.2〜1m=注意報色、1〜3m=警報色、3m以上=大津波警報色、それ未満・未観測は薄グレー)。
// 「観測点」欄の丸は今どれくらいの実況かが一目で分かるように、という考え方。
const TSUNAMI_DOT_DEFAULT_COLOR = "#B9B9C0"; // 観測なし・微弱の間の薄グレー
// 観測された津波の高さ(m)から、相当する警報グレードのキーを求める
// (0.2m未満はnull=グレード相当なし)。地図の観測点の丸・バーの色分けと、
// 右上の凡例のラダー表示(TsunamiGradeLegend)の両方で、しきい値を1箇所に
// まとめておくために使う。
function tsunamiHeightBandGrade(heightM) {
  if (heightM == null) return null;
  const abs = Math.abs(heightM);
  if (abs >= 3) return "MajorWarning";
  if (abs >= 1) return "Warning";
  if (abs >= 0.2) return "Watch";
  return null;
}
function tsunamiHeightBandColor(heightM) {
  const grade = tsunamiHeightBandGrade(heightM);
  return grade ? tsunamiGradeInfo(grade).color : TSUNAMI_DOT_DEFAULT_COLOR;
}

// tsunami-areas.json(津波予報区の海岸線)の各featureは properties.name に
// 予報区名を持つ。表示中の津波情報のareas(name+grade)を突き合わせて、
// 該当する予報区だけをgradeの色で塗り、それ以外は透明にするmatch式を作る。
function buildTsunamiAreaColorExpr(areas) {
  if (!areas || areas.length === 0) return "rgba(0,0,0,0)";
  const expr = ["match", ["get", "name"]];
  const seen = new Set();
  for (const a of areas) {
    if (!a.name || seen.has(a.name)) continue; // 同名予報区が重複していたら最初の1件を優先
    seen.add(a.name);
    expr.push(a.name, tsunamiGradeInfo(a.grade).color);
  }
  if (seen.size === 0) return "rgba(0,0,0,0)";
  expr.push("rgba(0,0,0,0)"); // 対象外の予報区は透明(=非表示)
  return expr;
}

// P2P地震情報APIの1レコード(JMATsunami)を、アプリ内で使う形に変換する
function toTsunamiCard(item) {
  const areas = Array.isArray(item.areas) ? item.areas.map(a => ({
    name: a.name || "不明な予報区",
    grade: a.grade || "Unknown",
    immediate: !!a.immediate,
    firstHeightCondition: a.firstHeight?.condition || null,
    firstHeightTime: a.firstHeight?.arrivalTime || null,
    maxHeightDescription: a.maxHeight?.description || null,
  })) : [];

  // 全予報区の中で最も危険度が高いgradeを、一覧表示・バッジ色の代表として使う。
  let maxGrade = null;
  let maxWeight = -1;
  areas.forEach(a => {
    const w = tsunamiGradeInfo(a.grade).weight;
    if (w > maxWeight) { maxWeight = w; maxGrade = a.grade; }
  });

  return {
    id: item.id,
    time: formatQuakeTime(item.time),
    cancelled: !!item.cancelled,
    areas,
    maxGrade: item.cancelled ? null : maxGrade,
  };
}

// 同一idの重複を除いて、新しい順に並べ直す
function dedupeTsunamiList(list) {
  const byId = new Map();
  for (const t of list) byId.set(t.id, t);
  return Array.from(byId.values()).sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
}

// 直近の津波情報一覧を取得する。取得失敗時はエラーを投げる(呼び出し側でハンドリング)。
async function fetchRecentTsunamis(limit) {
  const res = await fetch(`${P2PQUAKE_TSUNAMI_HISTORY_URL_BASE}&limit=${limit}`);
  if (!res.ok) throw new Error(`P2P地震情報 津波情報の取得に失敗(HTTP ${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return dedupeTsunamiList(data.map(toTsunamiCard));
}

/* ─────────────────────────────────────────────────────
   過去の津波情報(津波タブ「過去」モード)

   【重要】直近一覧(fetchRecentTsunamis)や当初の実装では、地震・EEW等すべての
   コードを1つの領域(capped collection)で共有する/history?codes=552 を使っていたが、
   これは発表頻度の低い津波情報がすぐ押し出されてしまい、offsetで遡っても
   「過去の津波が見つかりません」になりやすい。
   → 津波予報だけを独立して保持している専用API /v2/jma/tsunami に切り替える
     (地震情報の/v2/jma/quakeに相当する、津波版のエンドポイント)。
   さらに気象庁自身が公開している一覧(list.json)も合わせて取得し、両方を
   統合することで、より確実に過去分を取得できるようにする。
     (以前作ったindex.html版アプリのfetchJMATsunamiHistory()と同じ考え方)。
   ───────────────────────────────────────────────────── */
const JMA_TSUNAMI_LIST_URL = "https://www.jma.go.jp/bosai/tsunami/data/list.json";
const JMA_TSUNAMI_HISTORY_LIMIT = 40; // list.json自体は新しい順に並んでいるため、先頭から取得する件数

// 気象庁のReportDateTime("2024-08-08T20:30:00+09:00"のようなISO風文字列、常にJST)を、
// アプリ内で使っている"YYYY/MM/DD HH:mm:ss"形式(P2P地震情報側と揃える。ソート・
// 表示(TsunamiListRowのslice(5,16)等)の両方でこの形式を前提にしているため)に変換する。
function jmaIsoToSlash(iso) {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}/${mo}/${d} ${h}:${mi}:${s}`;
}

// 気象庁の個別報(Head/Body形式のJSON)を、アプリ内の津波カード形式(toTsunamiCardと同じ形)に変換する。
function jmaTsunamiReportToCard(report, reportDatetime) {
  const head = report?.Head;
  const issueTime = head?.ReportDateTime || reportDatetime;
  const isCancel = head?.InfoType === "取消";
  const areas = [];
  const forecast = report?.Body?.Tsunami?.Forecast;
  if (forecast?.Item) {
    const items = Array.isArray(forecast.Item) ? forecast.Item : [forecast.Item];
    items.forEach(item => {
      const areaName = item?.Area?.Name || "";
      const kindName = item?.Category?.Kind?.Name || "";
      if (!areaName || kindName.includes("解除")) return;
      let grade = "Unknown";
      if (kindName.includes("大津波")) grade = "MajorWarning";
      else if (kindName.includes("警報")) grade = "Warning";
      else if (kindName.includes("注意報")) grade = "Watch";
      else if (kindName.includes("海面変動") || kindName.includes("予報")) grade = "NonEffective";
      if (grade === "Unknown") return;
      areas.push({
        name: areaName,
        grade,
        immediate: !!item?.FirstHeight?.Condition && item.FirstHeight.Condition.includes("ただちに"),
        firstHeightCondition: item?.FirstHeight?.Condition || null,
        firstHeightTime: item?.FirstHeight?.ArrivalTime || null,
        maxHeightDescription: item?.MaxHeight?.TsunamiHeight?.Description || null,
      });
    });
  }
  let maxGrade = null, maxWeight = -1;
  areas.forEach(a => {
    const w = tsunamiGradeInfo(a.grade).weight;
    if (w > maxWeight) { maxWeight = w; maxGrade = a.grade; }
  });
  return {
    id: `jma_${reportDatetime}`,
    time: jmaIsoToSlash(issueTime),
    cancelled: isCancel,
    areas,
    maxGrade: isCancel ? null : maxGrade,
  };
}

// 気象庁 津波情報一覧(list.json)を取得し、先頭(新しい順)からJMA_TSUNAMI_HISTORY_LIMIT件、
// 各個別報を取得して津波カードに変換する。1件でも取得に失敗した場合はその1件だけを
// null化して除外し、全体は継続する。
async function fetchJmaTsunamiHistory(limit = JMA_TSUNAMI_HISTORY_LIMIT) {
  const listRes = await fetch(JMA_TSUNAMI_LIST_URL);
  if (!listRes.ok) throw new Error(`気象庁 津波情報一覧の取得に失敗(HTTP ${listRes.status})`);
  const list = await listRes.json();
  if (!Array.isArray(list)) return [];
  const targets = list.slice(0, limit);
  const cards = await Promise.all(targets.map(async item => {
    try {
      const res = await fetch(`https://www.jma.go.jp/bosai/tsunami/data/${item.json}`);
      if (!res.ok) return null;
      return jmaTsunamiReportToCard(await res.json(), item.reportDatetime);
    } catch {
      return null;
    }
  }));
  return dedupeTsunamiList(cards.filter(Boolean));
}

// 直近一覧(fetchRecentTsunamis, /v2/history?codes=552)とは別の、津波予報専用のJSON API。
// /historyは地震情報等すべてのコードと容量を共有するcapped collectionのため、
// 発表頻度の低い津波情報はすぐ押し出されて過去に遡りにくいが、こちらは津波予報だけを
// 独立して保持しているため、より確実に過去分を取得できる
// (レート制限は/historyの60リクエスト/分より厳しい10リクエスト/分なので、
// 呼びすぎないよう「もっと見る」を押した時だけ叩く)。
const P2PQUAKE_JMA_TSUNAMI_URL = "https://api.p2pquake.net/v2/jma/tsunami";
const TSUNAMI_HISTORY_PAGE_SIZE = 100; // このAPIの1リクエストあたりの最大件数

async function fetchTsunamiHistoryPage(offset, limit = TSUNAMI_HISTORY_PAGE_SIZE) {
  const res = await fetch(`${P2PQUAKE_JMA_TSUNAMI_URL}?limit=${limit}&offset=${offset}`);
  if (!res.ok) throw new Error(`過去の津波情報の取得に失敗(HTTP ${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return dedupeTsunamiList(data.map(toTsunamiCard));
}

// 気象庁一覧(primary)とP2P地震情報一覧(supplementary)を統合する。同じ発表が
// 双方に出てくることがあるため、発表時刻が1時間以内に近い場合は重複とみなして
// supplementary側を捨てる(以前のindex.html版アプリと同じ判定基準)。
function mergeTsunamiSources(primary, supplementary) {
  const merged = [...primary];
  supplementary.forEach(s => {
    const sTime = new Date(s.time).getTime();
    const isDup = merged.some(p => Math.abs(new Date(p.time).getTime() - sTime) < 60 * 60 * 1000);
    if (!isDup) merged.push(s);
  });
  return dedupeTsunamiList(merged);
}


/* ─────────────────────────────────────────────────────
   気象庁 推計震度分布(estimated_intensity_map) 連携
   震度5弱以上の地震選択時、気象庁が発表する250mメッシュの推計震度分布画像を
   地図上に重ねて表示する。過去に別アプリ(index.html版)で実装済みのロジックを
   MapLibre GL JS向けに移植したもの。
   ───────────────────────────────────────────────────── */
const EST_INTENSITY_LIST_URL = "https://www.jma.go.jp/bosai/estimated_intensity_map/data/list.json";
// 一覧データの発生時刻とP2P地震情報側の発生時刻がぴったり一致しないことがあるため、
// 差がこの範囲内(1分以内)なら同じ地震とみなす。
const EST_INTENSITY_MATCH_TOLERANCE_MS = 60 * 1000;
// この震度分布は震度5弱以上の地震でのみ気象庁から発表される。
const EST_INTENSITY_MIN_INTENSITY_KEYS = ["5-", "5+", "6-", "6+", "7"];

// 気象庁の1次地域メッシュコード(4桁)から、画像を貼り付ける緯度経度範囲(矩形)を計算する。
// 上2桁が緯度方向・下2桁が経度方向のメッシュ番号で、1次メッシュは緯度2/3度×経度1度。
function meshCodeToBounds(meshCode) {
  const latStart = parseInt(meshCode.substring(0, 2), 10) / 1.5;
  const lonStart = parseInt(meshCode.substring(2, 4), 10) + 100;
  const latEnd = latStart + 2 / 3;
  const lonEnd = lonStart + 1;
  return { latStart, lonStart, latEnd, lonEnd };
}

// 選択中の地震の発生時刻・最大震度から、該当する推計震度分布データを検索する。
// 対象外(震度5弱未満)・該当データなし・取得失敗の場合はnullを返す
// (呼び出し側では「表示しない」扱いにするだけで、エラー扱いにはしない)。
async function fetchEstimatedIntensityMatch(quakeTimeStr, maxIntensityKey) {
  if (!EST_INTENSITY_MIN_INTENSITY_KEYS.includes(maxIntensityKey)) return null;
  if (!quakeTimeStr) return null;

  const targetTimeMs = new Date(quakeTimeStr).getTime();
  if (Number.isNaN(targetTimeMs)) return null;

  const res = await fetch(EST_INTENSITY_LIST_URL);
  if (!res.ok) throw new Error(`推計震度分布一覧の取得に失敗しました (${res.status})`);
  const list = await res.json();
  if (!Array.isArray(list)) return null;

  for (const item of list) {
    const at = item?.hypo?.at;
    if (!at) continue;
    const itemTimeMs = new Date(at).getTime();
    if (Number.isNaN(itemTimeMs)) continue;
    if (Math.abs(itemTimeMs - targetTimeMs) <= EST_INTENSITY_MATCH_TOLERANCE_MS) {
      if (Array.isArray(item.mesh_num) && item.url) return item;
      return null;
    }
  }
  return null;
}

/* ─────────────────────────────────────────────────────
   推計震度分布 画像 → ベクター(GeoJSON)変換
   参考: 【気象庁HP】推計震度分布図のGeoJSONデータを無料で取得したい！！
         https://qiita.com/ZeroQuake/items/e6dd2691fe8fa5e2b3b2
   気象庁の画像(800×800px)は250mメッシュ(1メッシュ=2.5px)を表現しているため、
   拡大するとアンチエイリアスで境界がぼやける。ズームしても輪郭が鮮明なままになるよう、
   画像を1度だけピクセル解析し、320×320の格子(メッシュ)ごとに震度階級を判定して
   ポリゴン(塗り)・境界線(隣接メッシュと震度階級が異なる辺のみ)に変換する。
   ───────────────────────────────────────────────────── */
const EST_INTENSITY_GRID_SIZE = 320;

// 気象庁の公式配色(推計震度分布画像で使われている色)と震度階級の対応。
// 画像は圧縮等で色が微妙にずれることがあるため、RGB各値の差分16未満を許容して判定する
// (元記事の閾値をそのまま採用)。
const EST_INTENSITY_COLOR_TABLE = [
  { key: "4",  r: 250, g: 230, b: 150 },
  { key: "5-", r: 255, g: 230, b: 0   },
  { key: "5+", r: 255, g: 153, b: 0   },
  { key: "6-", r: 255, g: 40,  b: 0   },
  { key: "6+", r: 165, g: 0,   b: 33  },
  { key: "7",  r: 180, g: 0,   b: 104 },
];

// ピクセルの色から、最も近い震度階級を選ぶ(周囲から推測するのではなく、
// あくまでそのピクセル自身の色を根拠にする)。
// 境界(色の変わり目)は元画像でアンチエイリアスがかかっており、6色のどれとも
// 「ぴったり一致」しない中間色になっていることがある。以前は許容誤差(閾値)を
// 決めて外れたものを「データなし」にしていたが、それだと本来は震度が付いている
// はずのメッシュまで欠落して見えてしまう。実際にはその中間色は隣り合う2つの
// 震度色のどちらかに近いはずなので、6色のうち最も色が近いものを選ぶ方が、
// 周囲のメッシュから推測するよりも本来のデータに忠実。
function classifyEstIntensityColor(r, g, b, a) {
  if (a <= 50) return null; // 透明(=本当にデータが無い場所)
  let best = null;
  let bestDist = Infinity;
  for (const c of EST_INTENSITY_COLOR_TABLE) {
    const dist = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
    if (dist < bestDist) { bestDist = dist; best = c.key; }
  }
  return best;
}

// 画像を読み込む。getImageData()でピクセルを読み取るため、crossOriginを明示的に指定し、
// キャンバスが「汚染」されて読み取り不能にならないようにする。
function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`画像の読み込みに失敗しました: ${url}`));
    img.src = url;
  });
}

// 気象庁の1次地域メッシュコードから、東隣・北隣など指定方向に1つずれたメッシュコードを計算する。
// (上2桁=緯度方向のメッシュ番号、下2桁=経度方向のメッシュ番号。それぞれ±1が隣接メッシュにあたる)
// 範囲外(0〜99を超える)になる場合はnullを返す。
function offsetMeshCode(meshCode, dLatCode, dLonCode) {
  const latCode = parseInt(meshCode.substring(0, 2), 10) + dLatCode;
  const lonCode = parseInt(meshCode.substring(2, 4), 10) + dLonCode;
  if (latCode < 0 || latCode > 99 || lonCode < 0 || lonCode > 99) return null;
  return String(latCode).padStart(2, "0") + String(lonCode).padStart(2, "0");
}

// 1枚の推計震度分布画像(1次メッシュ分)を、250mメッシュ単位の格子(320×320、
// grid[i][j] = 震度キー or 該当なしはnull)に分解する。
function buildEstIntensityGridFromImage(img) {
  const GRID = EST_INTENSITY_GRID_SIZE;

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 800;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, 800, 800);
  // クロスオリジンで汚染されたcanvasの場合、ここでSecurityErrorが投げられる
  // (呼び出し側でtry/catchして「表示しない」扱いにフォールバックする)。
  const imgData = ctx.getImageData(0, 0, 800, 800).data;

  // アンチエイリアスの影響を受けない「元の色を完全に反映するピクセル」だけを
  // 参照する(x: 5n+1,5n+3 / y: 5m+1,5m+4 のパターンで交互に2px・3pxずつ進む)。
  const grid = Array.from({ length: GRID }, () => new Array(GRID).fill(null));
  let y = 1;
  for (let i = 0; i < GRID; i++) {
    let x = 1;
    for (let j = 0; j < GRID; j++) {
      const idx = (y * 800 + x) * 4;
      grid[i][j] = classifyEstIntensityColor(
        imgData[idx], imgData[idx + 1], imgData[idx + 2], imgData[idx + 3]
      );
      x += (j % 2 === 0) ? 3 : 2;
    }
    y += (i % 2 === 0) ? 2 : 3;
  }
  return grid;
}

// 250mメッシュの格子(grid)から塗り用ポリゴンを作る。
// 同じ震度階級が隣接するメッシュを1枚の四角形にまとめる(矩形統合)ことで、
// 250mメッシュ1枚ごとにポリゴンを作った場合(広い震度5弱の範囲などで数万枚になり、
// MapLibre側の描画処理が重くフリーズの原因になる)と比べ、ポリゴン数を大幅に減らす。
// 同じ色のポリゴン同士が隣接する境目にGPU描画特有の細い隙間が出る問題もあわせて解消する。
function buildEstIntensityFillFeatures(grid, meshBounds) {
  const { latStart: lat, lonStart: lng, latEnd: lat2, lonEnd: lng2 } = meshBounds;
  const GRID = EST_INTENSITY_GRID_SIZE;

  const rectangles = mergeGridIntoRectangles(grid, GRID);
  return rectangles.map(rect => {
    const North = lat2 + ((lat - lat2) / GRID) * rect.i0;
    const South = lat2 + ((lat - lat2) / GRID) * (rect.i1 + 1);
    const West = lng + ((lng2 - lng) / GRID) * rect.j0;
    const East = lng + ((lng2 - lng) / GRID) * (rect.j1 + 1);
    return {
      type: "Feature",
      properties: { intensity: rect.intensity },
      geometry: {
        type: "Polygon",
        coordinates: [[[West, North], [East, North], [East, South], [West, South], [West, North]]],
      },
    };
  });
}

// 250mメッシュの格子(grid)から、震度階級が変わる境目だけの線分を作る。
// 1次メッシュ画像は複数枚(mesh_num)を並べて1つの地震の範囲を表すため、画像の端(=1次メッシュの
// 継ぎ目)をそのまま「データなし」として扱うと、実際は同じ震度が続いているだけの場所にも
// 誤って境界線を引いてしまう(隣の画像との継ぎ目に黒い線が入って見える不具合の原因)。
// これを避けるため、東隣・南隣のメッシュの格子(あれば)を渡してもらい、画像の端では
// そちらの値を参照して判定する。
//
// 境界線は2種類に分けて返す。
// ・outerCoords: 色が付いた範囲と「データなし(=地図の背景)」との境目。
//   暗い地図の背景に対して黒線だと見えにくいため、呼び出し側で白線にする。
// ・innerCoords: 震度階級同士(4と5-など)の境目。両側とも明るい色なので、
//   今まで通り黒線のままでよい。
function buildEstIntensityLineCoords(grid, meshBounds, neighborGrids = {}) {
  const { latStart: lat, lonStart: lng, latEnd: lat2, lonEnd: lng2 } = meshBounds;
  const GRID = EST_INTENSITY_GRID_SIZE;
  const { eastGrid, southGrid } = neighborGrids;

  const outerCoords = [];
  const innerCoords = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const intensity = grid[i][j];
      if (!intensity) continue;

      const North = lat2 + ((lat - lat2) / GRID) * i;
      const South = lat2 + ((lat - lat2) / GRID) * (i + 1);
      const West = lng + ((lng2 - lng) / GRID) * j;
      const East = lng + ((lng2 - lng) / GRID) * (j + 1);

      // 右隣: 同じ画像内ならgrid[i][j+1]、画像の右端(j+1がGRID)なら東隣メッシュの
      // 同じ行・左端(列0)を参照する(東隣メッシュが無ければ本当にデータなし=null)。
      const rightIntensity = j + 1 < GRID ? grid[i][j + 1] : (eastGrid ? eastGrid[i][0] : null);
      if (rightIntensity !== intensity) {
        (rightIntensity ? innerCoords : outerCoords).push([[East, North], [East, South]]);
      }
      // 下隣: 同じ画像内ならgrid[i+1][j]、画像の下端(i+1がGRID)なら南隣メッシュの
      // 同じ列・上端(行0)を参照する(南隣メッシュが無ければ本当にデータなし=null)。
      const bottomIntensity = i + 1 < GRID ? grid[i + 1][j] : (southGrid ? southGrid[0][j] : null);
      if (bottomIntensity !== intensity) {
        (bottomIntensity ? innerCoords : outerCoords).push([[West, South], [East, South]]);
      }
    }
  }
  return { outerCoords, innerCoords };
}

// 格子(grid[i][j] = 震度キー or null)を、同じ震度階級が連続する矩形の集まりに変換する。
// 手順: ① 各行ごとに横方向へ連続する同じ値をひとまとめの区間(ラン)にする
//       ② 上の行から縦方向に伸ばせる区間(j0・j1・intensityが完全一致)は1つの矩形として延長し、
//          伸ばせなくなった時点で確定させる
// (震源付近のような大きな塊はこれでほぼ1枚〜数枚の矩形にまとまり、ポリゴン数が劇的に減る)
function mergeGridIntoRectangles(grid, GRID) {
  const finished = [];
  let openRects = []; // 直前の行まで伸びている矩形: { j0, j1, intensity, i0, i1 }

  for (let i = 0; i < GRID; i++) {
    // この行の横方向のラン(連続区間)を作る
    const runs = [];
    let j = 0;
    while (j < GRID) {
      const intensity = grid[i][j];
      if (!intensity) { j++; continue; }
      let j1 = j;
      while (j1 + 1 < GRID && grid[i][j1 + 1] === intensity) j1++;
      runs.push({ j0: j, j1, intensity });
      j = j1 + 1;
    }

    const nextOpenRects = [];
    for (const run of runs) {
      // 直前の行で同じ範囲・同じ震度階級の矩形が伸びてきていれば、そのまま延長する
      const match = openRects.find(r => r.j0 === run.j0 && r.j1 === run.j1 && r.intensity === run.intensity && r.i1 === i - 1);
      if (match) {
        match.i1 = i;
        nextOpenRects.push(match);
      } else {
        nextOpenRects.push({ j0: run.j0, j1: run.j1, intensity: run.intensity, i0: i, i1: i });
      }
    }

    // 今回延長されなかった(=これ以上下に続かない)矩形は確定させる
    for (const r of openRects) {
      if (!nextOpenRects.includes(r)) finished.push(r);
    }
    openRects = nextOpenRects;
  }
  finished.push(...openRects); // 最後の行まで伸びていた分を確定させる

  return finished;
}

// 現在の震度配色スキームから、MapLibreの"fill-color"に使うmatch式を組み立てる。
// (推計震度分布も、他の震度表示と同じアプリ内配色に合わせて塗るため)
function buildEstIntensityFillColorExpr(colorScheme) {
  const expr = ["match", ["get", "intensity"]];
  for (const c of EST_INTENSITY_COLOR_TABLE) {
    expr.push(c.key, (colorScheme.colors[c.key] || colorScheme.colors["0"]).bg);
  }
  expr.push("rgba(0,0,0,0)"); // 該当なし(通常は発生しない)
  return expr;
}

// 震央分布(circleレイヤー)の色分けに使う、震度キーの全パターン。
// "5"/"6"(弱/強の区分が無い旧震度階級)も含める。QUAKE_COLOR_SCHEMESの各配色は
// これらを既にスキーム内の色(5弱/6弱と同じ色)として持っているため、そのまま
// 拾えば「今ある配色に従う」ことになる。
const QUAKE_INTENSITY_KEYS = ["0", "1", "2", "3", "4", "5", "5-", "5+", "6", "6-", "6+", "7", "?"];

// 震央分布を「最大震度が大きいものほど上(=後から描画)」にするための重み。
// 数字が大きいほど後で描画される=他の丸に重なった時に上に来る。
// "5"/"6"(旧震度階級)は、実際の強さとしては5弱/6弱相当なのでそこに合わせておく。
// "?"(不明)は最も弱い扱いにする。
const QUAKE_INTENSITY_RANK = {
  "?": -1, "0": 0, "1": 1, "2": 2, "3": 3, "4": 4,
  "5": 5, "5-": 5, "5+": 6, "6": 7, "6-": 7, "6+": 8, "7": 9,
};

// 現在の震度配色スキームから、震央分布(circle-color)の塗り用match式を組み立てる。
// P2P地震一覧・近傍地震検索・データベース検索、どの震央分布も同じ配色ルールで塗る。
function buildEpicenterCircleColorExpr(colorScheme) {
  const expr = ["match", ["get", "scaleKey"]];
  for (const key of QUAKE_INTENSITY_KEYS) {
    expr.push(key, (colorScheme.colors[key] || colorScheme.colors["0"]).bg);
  }
  expr.push((colorScheme.colors["?"] || colorScheme.colors["0"]).bg);
  return expr;
}

// 震央分布(circle-stroke-color)用のmatch式。基本は塗りと同じ色だが、
// 気象庁配色の震度1はほぼ白(#F2F2FF)のため、塗りと同色の縁だとライトモードの
// (白系の)地図に溶け込んでしまう。ライトモードの時だけ縁を薄いグレーにする
// (ダークモードは暗い地図に対してそのままでも十分見えるため据え置き)。
function buildEpicenterCircleStrokeColorExpr(colorScheme, mode) {
  const expr = ["match", ["get", "scaleKey"]];
  for (const key of QUAKE_INTENSITY_KEYS) {
    const useGray = colorScheme.id === "jma" && key === "1" && mode === "light";
    expr.push(key, useGray ? "#C7C7CC" : (colorScheme.colors[key] || colorScheme.colors["0"]).bg);
  }
  expr.push((colorScheme.colors["?"] || colorScheme.colors["0"]).bg);
  return expr;
}

// 直近の地震情報一覧を取得する。取得失敗時はエラーを投げる(呼び出し側でハンドリング)。
// limit: 設定画面で指定された取得件数(1〜1000、デフォルト100)。
//
// 注意1: P2P地震情報APIの /history は1回のリクエストにつき limit を1〜100までしか
// 指定できない(仕様: https://www.p2pquake.net/develop/json_api_v2/ の /history 参照)。
// 100件を超える件数が設定されている場合、limit=100 のリクエストを offset をずらしながら
// 複数回叩いて必要件数を積み上げる(例: 300件なら3回)。
//
// 注意2: 同APIの offset は「1週間以上古い情報は取得できない場合がある」仕様のため、
// 直近1週間の地震が指定件数に満たない場合、それ以上ページを進めても同じ内容が
// 返ってくることがある。これを区別せずに積み上げると、後段の重複排除で結局同じ
// 件数に収束してしまい「件数を増やしても表示が変わらない」ように見えてしまう。
// → 各ページのidをseenIdsで追跡し、新規idが1件も無いページに当たった時点で
//   「これ以上遡れない」とみなして打ち切る。
const P2PQUAKE_API_PAGE_SIZE = 100;

async function fetchRecentQuakes(limit = QUAKE_FETCH_LIMIT_DEFAULT) {
  const target = clampQuakeFetchLimit(limit);
  const results = [];
  const seenIds = new Set();
  let offset = 0;

  while (results.length < target) {
    const pageSize = Math.min(P2PQUAKE_API_PAGE_SIZE, target - results.length);
    const res = await fetch(`${P2PQUAKE_HISTORY_URL_BASE}&limit=${pageSize}&offset=${offset}`);
    if (!res.ok) throw new Error(`地震情報の取得に失敗しました (${res.status})`);
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break; // これ以上遡れる情報が無い

    const newItems = page.filter(item => item?.id != null && !seenIds.has(item.id));
    if (newItems.length === 0) break; // 新規レコードが無い = 同じ内容が返ってきている(offsetの限界に到達)
    for (const item of newItems) seenIds.add(item.id);
    results.push(...newItems);

    offset += page.length;

    // 返ってきた件数がリクエストしたページサイズより少なければ、これ以上古い情報は無い
    if (page.length < pageSize) break;
  }

  // 以前は「震源(hypocenter.name)が無いレコード」を丸ごと除外していたが、
  // これだと震度速報(ScalePrompt, 震源不明)や震源に関する情報(Destination,
  // 震度分布なし)がまるごと一覧から消えてしまい、確定報(DetailScale)が
  // 出るまでその地震自体が見えなくなってしまっていた。
  // → earthquakeオブジェクト自体が無いレコード(不完全なデータ)だけ除外し、
  //   段階ごとの情報の組み合わせはdedupeQuakeList(mergeQuakeCards)に任せる。
  const list = results
    .filter(item => item.earthquake)
    .map(toQuakeCard);
  return dedupeQuakeList(list);
}

// 「津波を引き起こした地震」検索のフォールバック用。気象庁 震度データベース(eqdb)は
// 直近の地震(発表から3日程度)がまだ反映されていないことがあるため、その場合の
// 代わりに、直近の地震情報一覧(P2P地震情報, /history?codes=551)を遡って同じ
// 時間窓[winStart, winEnd]の地震を探す。fetchRecentQuakesと同じoffsetページング
// 方式を使う(P2P地震情報のoffsetは「1週間以上古い情報は取得できない場合がある」
// 仕様のため、3日以内という前提の呼び出しと相性が良い)。
// 該当する中でМ(マグニチュード)が最大のものを1件返す(無ければnull)。
async function findCausingQuakeFromP2p(winStart, winEnd) {
  const winStartMs = winStart.getTime();
  const winEndMs = winEnd.getTime();
  let offset = 0;
  const matches = [];
  const seenIds = new Set();

  for (let page = 0; page < 10; page++) { // 安全のため最大10ページ(1000件)までで打ち切る
    const res = await fetch(`${P2PQUAKE_HISTORY_URL_BASE}&limit=${P2PQUAKE_API_PAGE_SIZE}&offset=${offset}`);
    if (!res.ok) break;
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) break;

    let sawAnyAtOrAfterWindowStart = false;
    for (const item of items) {
      if (item?.id == null || seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      const eq = item.earthquake;
      if (!eq?.hypocenter?.name || !eq?.time) continue;
      const t = new Date(eq.time).getTime();
      if (!Number.isFinite(t)) continue;
      if (t >= winStartMs) sawAnyAtOrAfterWindowStart = true;
      if (t >= winStartMs && t <= winEndMs) matches.push(item);
    }

    offset += items.length;
    if (items.length < P2PQUAKE_API_PAGE_SIZE) break; // これ以上遡れる情報が無い
    // このページに窓の開始時刻以降のレコードが1件も無かった(=全部それより古かった)
    // なら、これ以上遡っても窓に入るものは無いので打ち切る。
    if (!sawAnyAtOrAfterWindowStart) break;
  }

  if (matches.length === 0) return null;
  const cards = matches
    .filter(item => item.earthquake && item.earthquake.hypocenter && item.earthquake.hypocenter.name)
    .map(toQuakeCard);
  if (cards.length === 0) return null;
  cards.sort((a, b) => (b.magnitude ?? -Infinity) - (a.magnitude ?? -Infinity));
  return cards[0];
}

/* ─────────────────────────────────────────────────────
   緊急地震速報(警報) (P2P地震情報 EEW, code:556)
   https://api.p2pquake.net/v2/history?codes=556 相当のスキーマがWebSocketで届く。
   気象庁の「緊急地震速報(警報)」の内容そのものであり、本アプリではこれを
   ライブ受信のみで扱う(過去ログを一覧表示する意味が薄いため /history は叩かない)。

   P2P地震情報のEEWスキーマには、kmoni直叩き版(index.html)にあった
   report_num・is_final・alertflgに相当するフィールドが無い。そのため:
     ・「第◯報」相当は issue.serial をそのまま使う
     ・「最終報」の判定はできないため、一定時間(EEW_STALE_MS)続報が
       来なければ自動的に消すタイムアウト方式でライフサイクルを管理する
     ・警報級以外(予報のみ)のEEWはこのAPIには流れてこないため、
       kmoni版にあった「警報/予報」の区別は行わない(常に警報級として扱う)
   ───────────────────────────────────────────────────── */
const EEW_STALE_MS = 90000;        // 最終報(とみなせる、最後に届いた続報)から、この時間表示を残してから自動的に消す
const EEW_CANCEL_LINGER_MS = 8000; // 取消受信後、この時間はパネルに「取消」表示を残してから消す
const EEW_MAX_CONCURRENT = 3;      // 同時に画面へ出すEEWの最大件数(UIが煩雑にならないよう抑える)
const EEW_P_WAVE_SPEED_KM_S = 6.0; // P波の伝播速度(kmoni版index.htmlと同じ簡易値)
const EEW_S_WAVE_SPEED_KM_S = 3.5; // S波の伝播速度

// 起動直後、既に発表中のEEWがあれば取りこぼさないよう、/historyを1回だけ
// 見に行くための設定。WebSocketは「接続した後に届いたもの」しか拾えないため、
// アプリを開いた時点で既に緊急地震速報が発表されていた場合、WebSocketだけでは
// 次の続報が来るまで何も表示されない、という抜けが起きる。それを防ぐための
// 起動時バックフィル。ただし本当に「今起きている」ものだけを拾いたいので、
// 受信時刻がこの新しさ(ミリ秒)以内のものだけを反映し、古いものは無視する。
const EEW_HISTORY_URL = "https://api.p2pquake.net/v2/history?codes=556&limit=1";
const EEW_HISTORY_FRESHNESS_MS = 90000;

// areas[]のscaleFrom/scaleToから、この地震の「最大予測震度」をINTENSITY_LABELの
// キー形式に変換する。99("〜程度以上")は震度7相当として扱う。
function eewMaxScaleKey(areas) {
  let max = -Infinity;
  for (const a of areas) {
    const s = typeof a.scaleTo === "number" ? a.scaleTo : (typeof a.scaleFrom === "number" ? a.scaleFrom : null);
    if (s != null && s > max) max = s;
  }
  if (max === -Infinity || max < 0) return "?";
  if (max >= 99) return "7";
  return maxScaleToIntensityKey(max);
}

// P2P地震情報APIの1レコード(EEW, code:556)を、アプリ内で使う形に変換する
function toEewCard(item) {
  const eq = item.earthquake || {};
  const hypo = eq.hypocenter || {};
  const areas = Array.isArray(item.areas) ? item.areas.map(a => {
    const scaleFrom = typeof a.scaleFrom === "number" ? a.scaleFrom : null;
    const scaleTo = typeof a.scaleTo === "number" ? a.scaleTo : null;
    return {
      pref: a.pref || "",
      name: a.name || "",
      scaleFrom,
      scaleTo,
      // 地図の塗りつぶし用に、この地域の予測震度を内部キー("5-"等)に変換しておく。
      // scaleTo(上限側)を優先し、無ければscaleFromを使う。
      maxIntensityKey: eewMaxScaleKey([{ scaleFrom, scaleTo }]),
      // kindCode: 10/11=通常(到達予測あり)、19=PLUM法(主要動の到達予想なし)
      isPlum: a.kindCode === "19",
    };
  }) : [];

  return {
    id: item.id,
    // eventId(issue.eventId)を同一地震の識別キーとして使う。続報は同じeventIdで届く。
    eventId: item.issue?.eventId || item.id,
    serial: item.issue?.serial || null,
    cancelled: !!item.cancelled,
    isTraining: !!item.test,
    originTime: eq.originTime || null,
    arrivalTime: eq.arrivalTime || null,
    isAssumedHypocenter: eq.condition === "仮定震源要素",
    place: hypo.name || "震源地不明",
    reducedPlace: hypo.reduceName || null,
    latitude: typeof hypo.latitude === "number" && hypo.latitude !== -200 ? hypo.latitude : null,
    longitude: typeof hypo.longitude === "number" && hypo.longitude !== -200 ? hypo.longitude : null,
    depth: typeof hypo.depth === "number" && hypo.depth >= 0 ? Math.round(hypo.depth) : null,
    magnitude: typeof hypo.magnitude === "number" && hypo.magnitude > 0 ? hypo.magnitude : null,
    areas,
    maxIntensityKey: eewMaxScaleKey(areas),
    // areas[]全件がPLUM法(kindCode:19)の場合のみPLUM法発表とみなす(1件でも通常判定が
    // 混じっていれば、通常の到達予測ありとして扱う)。areas未着の初回はfalse。
    isPlum: areas.length > 0 && areas.every(a => a.isPlum),
    // 複数ソース併用(Wolfx優先)のための出どころ情報。P2P地震情報には「最終報」
    // フィールドが無いため、isFinalは常にfalse(タイムアウト方式で最終扱いする)。
    // また、P2P地震情報のEEW(code:556)は警報級しか配信されないため、
    // isWarnLevelは常にtrue。
    source: "p2pquake",
    isFinal: false,
    isWarnLevel: true,
  };
}

// 緯度・経度・半径(km)から、地図に描く円(GeoJSON Polygon)の頂点座標を作る。
// 球面上の測地線オフセット(標準的な"destination point"の公式)を使っており、
// 日本周辺の震源から数百km程度の範囲であれば十分な精度で円になる。
function eewCirclePolygon(lat, lon, radiusKm, steps = 64) {
  if (!(radiusKm > 0) || lat == null || lon == null) return null;
  const R = 6371; // 地球の平均半径(km)
  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;
  const angularDist = radiusKm / R;
  const coords = [];
  for (let i = 0; i <= steps; i++) {
    const bearing = (i / steps) * 2 * Math.PI;
    const destLat = Math.asin(
      Math.sin(latRad) * Math.cos(angularDist) +
      Math.cos(latRad) * Math.sin(angularDist) * Math.cos(bearing)
    );
    const destLon = lonRad + Math.atan2(
      Math.sin(bearing) * Math.sin(angularDist) * Math.cos(latRad),
      Math.cos(angularDist) - Math.sin(latRad) * Math.sin(destLat)
    );
    coords.push([destLon * 180 / Math.PI, destLat * 180 / Math.PI]);
  }
  return coords;
}

// 発生時刻からの経過秒・震源の深さ・波の伝播速度(km/s)から、
// 地表面での円の半径(km)を求める(斜距離→水平距離への変換込み)。
// 経過前(elapsedSec<=0)や、まだ波が地表に届いていない(slant<=depth)場合は0を返す。
function eewWaveSurfaceRadiusKm(elapsedSec, depthKm, speedKmS) {
  if (!(elapsedSec > 0)) return 0;
  const slant = speedKmS * elapsedSec;
  const depth = depthKm != null && depthKm >= 0 ? depthKm : 10;
  if (slant <= depth) return 0;
  return Math.sqrt(slant * slant - depth * depth);
}

// 起動時バックフィル用: /historyから直近のEEWを1件だけ取得し、それが
// 「十分新しい(EEW_HISTORY_FRESHNESS_MS以内)」場合だけtoEewCard()して返す。
// 訓練配信(test:true)や、取得自体に失敗した場合、十分新しくない場合はnullを返す。
async function fetchLatestFreshEew() {
  const res = await fetch(EEW_HISTORY_URL);
  if (!res.ok) return null;
  const list = await res.json();
  const latest = Array.isArray(list) ? list[0] : null;
  if (!latest || latest.test) return null;
  // "time"(受信時刻)は"YYYY/MM/DD HH:mm:ss.SSS"想定だが、念のため"-"区切りも
  // "/"に正規化してから解釈する(他のJMA系フィールドと表記ゆれがあるため)。
  const receivedMs = latest.time ? new Date(latest.time.replace(/-/g, "/")).getTime() : NaN;
  if (!Number.isFinite(receivedMs)) return null;
  if (Date.now() - receivedMs > EEW_HISTORY_FRESHNESS_MS) return null; // 既に終わっていそうな古い発表は無視
  return toEewCard(latest);
}

/* ─────────────────────────────────────────────────────
   Wolfx Open API — JMA緊急地震速報 (jma_eew)
   https://wolfx.jp/apidoc
   P2P地震情報のEEW(code:556)には無い、isFinal(最終報かどうか)・
   isWarn(警報/予報の区別)・isAssumption(PLUM法かどうか)を直接持っている。
   そのため、両方を受信しつつWolfxを優先する(同じeventIdについて、Wolfx由来の
   データがあればP2P地震情報側の更新では上書きしない)方針にしている。
   実際のJMA配信を中継しているだけの非公式プロジェクトである点はP2P地震情報と
   同様。専用のWebSocket接続がもう1本必要になる。
   ───────────────────────────────────────────────────── */
const WOLFX_EEW_WS_URL = "wss://ws-api.wolfx.jp/jma_eew";
const WOLFX_EEW_HTTP_URL = "https://api.wolfx.jp/jma_eew.json";

// Wolfxの1レコード(jma_eew)を、アプリ内で使う共通のEEWカード形式(toEewCardと
// 同じ形)に変換する。WarnArea[]のShindo1/Shindo2・MaxIntensityは"5弱"のような
// 表示用文字列で来るため、intensityLabelToKey()で内部キーへ変換する。
function toEewCardFromWolfx(data) {
  const areas = Array.isArray(data.WarnArea) ? data.WarnArea.map(a => ({
    pref: "", // Wolfxは都道府県単位を分けて返さないため空にしておく
    name: a.Chiiki || "",
    scaleFrom: null, // 内部的にはscaleコードではなくmaxIntensityKeyを直接使うため未使用
    scaleTo: null,
    // Wolfxは震度を"5弱"のような表示用文字列で返してくる。Shindo2(上限側)を
    // 優先し、無ければShindo1を使って内部キーへ変換する(P2P地震情報のscaleTo優先と同じ考え方)。
    maxIntensityKey: intensityLabelToKey(a.Shindo2 || a.Shindo1),
    isPlum: !!data.isAssumption,
  })) : [];

  return {
    id: `wolfx_${data.EventID}_${data.Serial}`,
    // EventIDは気象庁が発表した地震そのものの識別子であり、P2P地震情報の
    // issue.eventIdと同一の値になる(どちらも気象庁の原情報をそのまま中継して
    // いるため)。これを共通の識別キーとして使い、2つのソースを統合する。
    eventId: String(data.EventID),
    serial: data.Serial != null ? String(data.Serial) : null,
    cancelled: !!data.isCancel,
    isTraining: !!data.isTraining,
    originTime: data.OriginTime || null,
    arrivalTime: null,
    isAssumedHypocenter: !!data.isAssumption,
    place: data.Hypocenter || "震源地不明",
    reducedPlace: null,
    latitude: typeof data.Latitude === "number" ? data.Latitude : null,
    longitude: typeof data.Longitude === "number" ? data.Longitude : null,
    depth: typeof data.Depth === "number" && data.Depth >= 0 ? Math.round(data.Depth) : null,
    magnitude: typeof data.Magunitude === "number" && data.Magunitude > 0 ? data.Magunitude : null,
    areas,
    maxIntensityKey: intensityLabelToKey(data.MaxIntensity),
    isPlum: !!data.isAssumption,
    source: "wolfx",
    // Wolfxは「最終報かどうか」を直接教えてくれる。第1報などisFinal:falseの間は
    // 通常どおりEEW_STALE_MSのタイムアウトで生存管理されるが、真の最終報が来た
    // ことが分かっている点が、P2P地震情報だけの場合との一番の違い。
    isFinal: !!data.isFinal,
    // isWarn:trueなら警報、falseなら予報。Wolfxは予報段階から配信してくれる
    // ため、P2P地震情報より早いタイミングで拾える。UI側で警報/予報を出し分ける。
    isWarnLevel: data.isWarn !== false,
  };
}

// WebSocketで受信した1件を、JMA緊急地震速報(type:"jma_eew")であれば変換して返す。
// 訓練報(isTraining)は対象外。警報・予報のどちらも表示対象とする
// (Wolfxならではの予報段階の速報も活かすため)。
function wolfxMessageToEewCard(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data.type !== "jma_eew") return null; // ハートビート等を除外
  if (data.isTraining) return null;
  return toEewCardFromWolfx(data);
}

// 起動時バックフィル用(Wolfx版)。HTTP GETは直近1件のスナップショットを返す
// ため、それが十分新しければ取り込む。P2P地震情報側のfetchLatestFreshEew()と
// 同時に叩き、どちらが先に届いてもhandleIncomingEew側のマージロジックが
// Wolfx優先で正しく解決する。
async function fetchLatestFreshEewFromWolfx() {
  const res = await fetch(WOLFX_EEW_HTTP_URL);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || data.isTraining) return null;
  const announcedMs = data.AnnouncedTime ? new Date(data.AnnouncedTime.replace(/-/g, "/")).getTime() : NaN;
  if (!Number.isFinite(announcedMs)) return null;
  if (Date.now() - announcedMs > EEW_HISTORY_FRESHNESS_MS) return null;
  return toEewCardFromWolfx(data);
}

/**
 * Wolfxの緊急地震速報WebSocketに接続し、受信するたびにonEewを呼ぶ。
 * P2P地震情報のconnectQuakeWebSocket()とは完全に独立した、別のWebSocket接続。
 * 接続が切れた場合は一定間隔で自動的に再接続を試みる。
 * 戻り値のclose()を呼ぶと再接続をやめて確実に切断する。
 */
function connectWolfxEewWebSocket(onEew, onStatusChange) {
  let ws = null;
  let closedByCaller = false;
  let reconnectTimer = null;

  function connect() {
    if (closedByCaller) return;
    ws = new WebSocket(WOLFX_EEW_WS_URL);

    ws.onopen = () => {
      onStatusChange?.("open");
    };

    ws.onmessage = (event) => {
      const eew = wolfxMessageToEewCard(event.data);
      if (eew) onEew?.(eew);
    };

    ws.onerror = (e) => {
      console.error("Wolfx緊急地震速報WebSocketエラー:", e);
    };

    ws.onclose = () => {
      onStatusChange?.("closed");
      if (closedByCaller) return;
      reconnectTimer = setTimeout(connect, 5000);
    };
  }

  connect();

  return {
    close() {
      closedByCaller = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    },
  };
}

/* ─────────────────────────────────────────────────────
   P2P地震情報 WebSocket API (v2)
   wss://api.p2pquake.net/v2/ws
   地震情報(code:551)・津波情報(code:552)・緊急地震速報(code:556)を含む
   全情報がリアルタイムでpushされてくる。
   地震・津波の最新一覧は起動時に /history で1回だけ取得し(履歴はWebSocketでは
   遡れないため)、以降はこのWebSocketで届いた新着分だけを一覧に追加していく。
   緊急地震速報(EEW)は履歴を扱わず、WebSocketのライブ受信のみで管理する。
   ───────────────────────────────────────────────────── */
const P2PQUAKE_WS_URL = "wss://api.p2pquake.net/v2/ws";

// WebSocketで受信した1件を、地震情報(code:551)であれば変換して返す。
// 対象外(津波予報や緊急地震速報など、このアプリでまだ扱っていない種別)はnullを返す。
// 以前は震源(hypocenter.name)が無いレコード(震度速報・震源に関する情報)を
// ここで弾いていたが、それだと確定報が出るまでその地震自体が見れなかったため、
// earthquakeオブジェクト自体が無い(不完全な)レコードだけを除外するようにした。
function wsMessageToQuakeCard(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data.code !== 551) return null;
  if (!data.earthquake) return null;
  return toQuakeCard(data);
}

// WebSocketで受信した1件を、津波情報(code:552)であれば変換して返す。
function wsMessageToTsunamiCard(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data.code !== 552) return null;
  return toTsunamiCard(data);
}

// WebSocketで受信した1件を、緊急地震速報(code:556)であれば変換して返す。
// test:true(訓練・切替試験の配信)は実際の地震と紛らわしいため対象外にする。
function wsMessageToEewCard(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data.code !== 556) return null;
  if (data.test) return null;
  return toEewCard(data);
}

/**
 * P2P地震情報のWebSocketに接続し、地震情報(code:551)を受信するたびにonQuakeを、
 * 津波情報(code:552)を受信するたびにonTsunamiを、緊急地震速報(code:556)を
 * 受信するたびにonEewを呼ぶ。1本の接続で全部を賄う
 * (種別ごとに別々の接続を開くと無駄にコネクション数が増えてしまうため)。
 * 接続が切れた場合は一定間隔で自動的に再接続を試みる。
 * 戻り値のclose()を呼ぶと再接続をやめて確実に切断する。
 */
function connectQuakeWebSocket(onQuake, onTsunami, onEew, onStatusChange) {
  let ws = null;
  let closedByCaller = false;
  let reconnectTimer = null;

  function connect() {
    if (closedByCaller) return;
    ws = new WebSocket(P2PQUAKE_WS_URL);

    ws.onopen = () => {
      onStatusChange?.("open");
    };

    ws.onmessage = (event) => {
      const quake = wsMessageToQuakeCard(event.data);
      if (quake) { onQuake(quake); return; }
      const tsunami = wsMessageToTsunamiCard(event.data);
      if (tsunami) { onTsunami?.(tsunami); return; }
      const eew = wsMessageToEewCard(event.data);
      if (eew) onEew?.(eew);
    };

    ws.onerror = (e) => {
      console.error("P2P地震情報WebSocketエラー:", e);
    };

    ws.onclose = () => {
      onStatusChange?.("closed");
      if (closedByCaller) return;
      // 5秒後に再接続を試みる(サーバー再起動・回線切断などからの復帰用)
      reconnectTimer = setTimeout(connect, 5000);
    };
  }

  connect();

  return {
    close() {
      closedByCaller = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    },
  };
}

/* ─────────────────────────────────────────────────────
   観測点マスタ (stations_with_amp_revised.json)
   気象庁 観測点コード・地点名・緯度経度のマスタデータ。
   ファイル構成:
     public/
     └─ map/
        └─ stations_with_amp_revised.json
   ───────────────────────────────────────────────────── */
let stationsPromise = null;
function loadStations() {
  if (stationsPromise) return stationsPromise;
  stationsPromise = cachedFetchJSON(`${import.meta.env.BASE_URL}map/stations_with_amp_revised.json`);
  return stationsPromise;
}

/* ─────────────────────────────────────────────────────
   観測点マッチング
   P2P地震情報APIの points[] (各要素は { pref, addr, scale, isArea }) を、
   観測点マスタ(stations)の地点と突き合わせて緯度経度を割り当てる。
   addr(地点名)とpref(都道府県名)の組み合わせだけが手がかりで、観測点コードが
   直接返ってこないため、以下の2段階でマッチングする(参考にした既存実装と同じ方針):
     1. 地点名が完全一致 かつ 都道府県名が一致
     2. 見つからなければ、都道府県名が一致するものの中から、
        地点名が部分一致(どちらかがどちらかを含む)するものを探す
   複数ヒットした場合は先頭の1件を採用する。
   ───────────────────────────────────────────────────── */
function matchStation(stations, point) {
  const exact = stations.find(s => s.name === point.addr && s.pref.name === point.pref);
  if (exact) return exact;

  const partial = stations.find(s =>
    s.pref.name === point.pref &&
    (s.name.includes(point.addr) || point.addr.includes(s.name) ||
     (s.city && s.city.name && point.addr.includes(s.city.name)))
  );
  return partial || null;
}

// points[]と観測点マスタを突き合わせ、地図・一覧で使える形(緯度経度+震度キー付き)に変換する。
// マスタに見つからなかった観測点は、地図には出せないが一覧には残すため latitude/longitude が null のまま返す。
// areaCodes(気象庁の細分区域コード。通常1件だが、同名区域が複数featureに分かれている場合は複数)
// も一緒に引いておき、区域単位の震度分布の塗り分けに使う。
//
// 震度速報(isArea:true)の点は、観測点マスタではなく「岩手県沿岸北部」のような
// 細分区域名そのものなので、matchStation(観測点名の突き合わせ)は使えない。
// 代わりにEEWで使っているfindAreaCodesByName(areasGeoJSON=細分区域.jsonを
// 地域名で引く)で区域コードを求め、個別のピンではなく区域の塗り分けだけで表示する
// (個々の観測点の緯度経度はそもそも震度速報には含まれないため、ピンは立てられない)。
function resolveStationPoints(points, stations, areasGeoJSON) {
  return points.map(p => {
    if (p.isArea) {
      const features = findAreaFeaturesByName(areasGeoJSON, p.addr);
      if (features.length === 0) {
        // eslint-disable-next-line no-console
        console.warn(`[細分区域未一致] ${p.pref} ${p.addr} — 細分区域.jsonに無い地域名表記かもしれません(震度速報)`);
      }
      const areaCodes = features.map(f => f.properties?.code).filter(c => c != null);
      // 地図上にこの区域のアイコンを置くための代表点(区域ポリゴンの重心)。
      // 同じ区域名が複数のポリゴンに分かれている場合は、それぞれの重心を平均する。
      // 個々の観測点座標が無い震度速報でも、区域アイコンとして地図上に表示できるようにする。
      let latitude = null, longitude = null;
      const centroids = features.map(f => polygonRoughCentroid(f.geometry)).filter(Boolean);
      if (centroids.length > 0) {
        latitude = centroids.reduce((sum, c) => sum + c.lat, 0) / centroids.length;
        longitude = centroids.reduce((sum, c) => sum + c.lon, 0) / centroids.length;
      }
      return {
        pref: p.pref,
        addr: p.addr,
        city: null,
        intensityKey: maxScaleToIntensityKey(p.scale),
        latitude,
        longitude,
        areaCode: areaCodes[0] || null,
        areaCodes,
        isArea: true,
      };
    }

    const station = matchStation(stations, p);
    if (!station) {
      // eslint-disable-next-line no-console
      console.warn(`[観測点マスタ未一致] ${p.pref} ${p.addr} — stations_with_amp_revised.jsonに追加が必要かもしれません`);
    }
    return {
      pref: p.pref,
      addr: p.addr,
      city: station?.city?.name || null,
      intensityKey: maxScaleToIntensityKey(p.scale),
      latitude: station ? parseFloat(station.lat) : null,
      longitude: station ? parseFloat(station.lon) : null,
      areaCode: station?.area?.code || null,
      areaCodes: station?.area?.code ? [station.area.code] : [],
      isArea: false,
    };
  });
}

// 観測点(緯度経度+震度キー付き)の配列を、細分区域コードごとに集計する。
// 各区域には、その区域内の観測点で観測された「最大震度」を割り当てる
// (気象庁の震度分布図と同じ考え方: 区域内で一番揺れが大きかった地点の震度で塗る)。
// areaCodes(複数)があればそちらを使い、無ければ従来のareaCode(単数)にフォールバックする
// (buildEqdbQuakeCard等、areaCodesを持たない古い形式のresolvedPointsとの互換のため)。
function aggregateByArea(resolvedPoints) {
  const INTENSITY_ORDER = ["0","1","2","3","4","5","5-","5u","5+","6","6-","6+","7"];
  const maxByArea = new Map(); // areaCode -> intensityKey

  for (const p of resolvedPoints) {
    const codes = (p.areaCodes && p.areaCodes.length > 0) ? p.areaCodes : (p.areaCode ? [p.areaCode] : []);
    for (const code of codes) {
      const current = maxByArea.get(code);
      if (!current || INTENSITY_ORDER.indexOf(p.intensityKey) > INTENSITY_ORDER.indexOf(current)) {
        maxByArea.set(code, p.intensityKey);
      }
    }
  }
  return maxByArea;
}

/* ─────────────────────────────────────────────────────
   気象庁 震度データベース(eqdb) 検索API
   https://www.data.jma.go.jp/eqdb/data/shindo/
   過去の地震を期間・マグニチュード・最大震度で検索する(mode=search)、
   および1件の地震の観測点別震度を取得する(mode=event)ためのAPI。
   このAPIはP2P地震情報と違い、観測点の緯度経度(lat/lon)を直接返してくるため、
   自前の観測点マスタ(stations)との突き合わせをしなくても地図に描画できる。
   ───────────────────────────────────────────────────── */
const EQDB_API_URL = "https://www.data.jma.go.jp/eqdb/data/shindo/api/";

// 検索フォーム「最大震度」欄の選択肢。値はeqdb APIのmaxIntパラメータそのもの。
const EQDB_MAX_INT_OPTIONS = [
  { value: "1", label: "指定なし（震度1以上）" },
  { value: "2", label: "震度2以上" },
  { value: "3", label: "震度3以上" },
  { value: "4", label: "震度4以上" },
  { value: "A", label: "震度5弱以上" },
  { value: "B", label: "震度5強以上" },
  { value: "C", label: "震度6弱以上" },
  { value: "D", label: "震度6強以上" },
  { value: "7", label: "震度7" },
];
// 検索の「震度◯以上」フィルターで比較する際に使うスケール値。
// eqdbIntensityStringToScale()は表示用に、旧震度階級(弱/強の区分が無い震度5・6)を
// 現行の5弱(45)/6弱(55)とは別のスケール値(44/54)として返すが、そのままだと
// 「5弱以上」「6弱以上」で検索した際に旧震度階級の地震がヒットしなくなってしまう。
// 実際の震度は5弱〜5強(または6弱〜6強)のいずれかだったはずなので、
// 「◯弱以上」の条件は満たすとみなして45/55に読み替える。
function eqdbIntensityThresholdScale(raw) {
  const scale = eqdbIntensityStringToScale(raw);
  if (scale === 44) return 45;
  if (scale === 54) return 55;
  return scale;
}

const EQDB_MAX_INT_SCALE = { "1": 10, "2": 20, "3": 30, "4": 40, "A": 45, "B": 50, "C": 55, "D": 60, "7": 70 };

// 「この震源の近傍で発生した地震」ボタンを出す条件。
// P2P地震情報(リアルタイム)側の地震であれば、震度・マグニチュードに関わらず表示する。
// ただし震源がまだ判明していない段階(震度速報「震源調査中」・稀な「震源地不明」)は、
// 検索条件になる震源地名そのものが無いため、気象庁震度データベースを検索しても
// 一致するはずがない(=ボタンを出しても必ず0件になる)。そのため震源が判明してから
// (震源に関する情報 or 確定報が届いてから)だけボタンを表示するようにする。
function shouldShowNearbyQuakeButton(quake) {
  return !!quake && !quake.isEqdb && hasKnownHypocenter(quake);
}

const EQDB_SORT_OPTIONS = [
  { value: "S0", label: "新しい順" },
  { value: "S1", label: "古い順" },
  { value: "S2", label: "最大震度の大きい順" },
  { value: "S3", label: "地震の規模の大きい順" },
];

// 震源地名プルダウンの初期値(ep.jsonの読み込みが終わるまでの間)。
const EQDB_EPICENTER_NAME_OPTIONS_DEFAULT = [{ value: "", label: "指定なし" }];

// 最小マグニチュードの選択肢("1.0"〜"9.9")
const EQDB_MIN_MAG_OPTIONS = [
  { value: "0.0", label: "指定なし" },
  ...Array.from({ length: 90 }, (_, i) => {
    const v = ((i + 10) / 10).toFixed(1);
    return { value: v, label: `M${v}以上` };
  }),
];

// "震度５弱"/"５弱"/"震度７"/"5弱(推定)" のような文字列(全角数字・「震度」接頭辞・
// 前後の余分な文字の有無を問わない)を、10刻みのJMAスケール
// (10=震度1 ... 70=震度7、47=旧震度5、57=旧震度6)に変換する。
// 完全一致ではなく部分一致で判定しているのは、eqdb側が返す文字列に
// "(推定)"などの注記が付くことがあり、完全一致だと本来有効な観測点まで
// 判定漏れして震度の塗りつぶしから抜け落ちてしまうことがあったため。
function eqdbIntensityStringToScale(raw) {
  if (!raw) return 0;
  const str = raw
    .replace(/震度/g, "")
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  if (str.includes("7")) return 70;
  // 1996年10月の震度階級改定より前は「弱」「強」の区分が無く、単に「震度6」
  // 「震度5」とだけ記録されている(旧震度階級)。これらは現在の「5弱」「6弱」とは
  // 区別して、そのまま「5」「6」として表示したいので、専用のスケール値(44/54)を
  // 割り当てる(45=5弱, 55=6弱と衝突しないようにするため)。
  if (str.includes("6")) return str.includes("強") ? 60 : str.includes("弱") ? 55 : 54;
  if (str.includes("5")) return str.includes("強") ? 50 : str.includes("弱") ? 45 : 44;
  if (str.includes("4")) return 40;
  if (str.includes("3")) return 30;
  if (str.includes("2")) return 20;
  if (str.includes("1")) return 10;
  return 0;
}

// eqdbのid(dbid)は "YYYYMMDDHHMMSS..." 形式の発生時刻エンコード文字列。
// アプリ内の他の地震カードと表示を揃えるため "YYYY/MM/DD HH:MM:SS" に変換する。
function eqdbIdToTimeDisplay(id) {
  if (!id || id.length < 14) return "";
  return `${id.slice(0,4)}/${id.slice(4,6)}/${id.slice(6,8)} ${id.slice(8,10)}:${id.slice(10,12)}:${id.slice(12,14)}`;
}

// mode=search: 期間・M・最大震度・(任意で)震央地名で地震を検索する。
// 観測点別の詳細は含まない一覧のみを返す。
// epi: 震央地名(例:"神奈川県西部")をそのまま渡すと、サーバー側でその震央地名に
// 完全一致する地震だけに絞り込んで返してくれる(実際のeqdb検索フォームの挙動と同じ)。
// 指定が無い場合は"99"(絞り込みなし)を使う。
async function fetchEqdbSearch({ startDate, endDate, startTime = "00:00", endTime = "23:59", minMag, maxInt, sort, epi }) {
  const epiValue = epi || "99";
  const isFiltered = minMag > 0 || maxInt !== "1" || epiValue !== "99";
  const fd = new FormData();
  fd.append("mode", "search");
  fd.append("dateTimeF[]", startDate); fd.append("dateTimeF[]", startTime);
  fd.append("dateTimeT[]", endDate);   fd.append("dateTimeT[]", endTime);
  fd.append("mag[]", minMag.toFixed(1)); fd.append("mag[]", "9.9");
  fd.append("dep[]", "000"); fd.append("dep[]", "999");
  fd.append("epi[]", epiValue); fd.append("pref[]", "99"); fd.append("city[]", "99"); fd.append("station[]", "99");
  fd.append("obsInt", "1");
  fd.append("maxInt", maxInt);
  fd.append("additionalC", isFiltered ? "true" : "false");
  fd.append("Sort", sort);
  fd.append("Comp", "C0");
  fd.append("seisCount", "false");
  fd.append("observed", "false");
  fd.append("strParam", "[object Object]");

  const res = await fetch(EQDB_API_URL, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data.res) ? data.res : [];
  const strMsgs = Array.isArray(data.str) ? data.str : [];
  const errMsg = strMsgs.find(s => s.includes("ありません") || s.includes("エラー") || s.includes("見直し"));
  return { list, errMsg, summary: strMsgs[1] || "" };
}

// mode=event: 1件の地震について、観測点ごとの震度(int[], lat/lon付き)を含む詳細を取得する。
async function fetchEqdbEvent(id) {
  const fd = new FormData();
  fd.append("mode", "event");
  fd.append("id", id);
  const res = await fetch(EQDB_API_URL, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.res && Array.isArray(data.res.hyp) && data.res.hyp.length > 0) return data.res;
  return null;
}

/* ─────────────────────────────────────────────────────
   震央分布(地図上の丸)用: 気象庁 震度データベース(eqdb)の座標プリフェッチ。
   eqdbの一覧検索(mode=search、近傍地震検索・データベース検索で使用)は
   震央の緯度経度を返さない。座標が分かるのは1件ごとの詳細(mode=event)
   だけなので、一覧が決まったらバックグラウンドで少しずつ詳細を取得し、
   震央分布に反映していく。
   取得済みの詳細はモジュールスコープのキャッシュ(id→detail)に載せておき、
   一覧をタップして選択する時にも同じデータをそのまま使い回せるようにする
   (二重に同じ地震を取得しないため)。
   ───────────────────────────────────────────────────── */
const eqdbEventDetailCache = new Map();

async function fetchEqdbEventCached(id) {
  if (eqdbEventDetailCache.has(id)) return eqdbEventDetailCache.get(id);
  const detail = await fetchEqdbEvent(id);
  if (detail) eqdbEventDetailCache.set(id, detail);
  return detail;
}

// eqdbのmode=event詳細(+検索一覧の元データ)から、震央分布1点分の情報を作る。
// 選択(タップ)時にそのままbuildEqdbQuakeCardへ渡せるよう、元データも持たせておく。
function eqdbDetailToEpicenterPoint(detail, listItem) {
  if (!detail || !Array.isArray(detail.hyp) || !detail.hyp[0]) return null;
  const hyp = detail.hyp[0];
  const lat = parseFloat(hyp.lat), lon = parseFloat(hyp.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const scale = eqdbIntensityStringToScale(hyp.maxI || "");
  const mag = parseFloat(hyp.mag);
  const depMatch = (hyp.dep || "").match(/\d+/);
  return {
    id: `eqdb_${listItem?.id || hyp.name}`,
    latitude: lat,
    longitude: lon,
    magnitude: Number.isFinite(mag) && mag > 0 ? mag : null,
    maxIntensityKey: scale > 0 ? maxScaleToIntensityKey(scale) : "?",
    time: eqdbIdToTimeDisplay(listItem?.id) || (listItem?.ot || ""),
    depth: depMatch ? parseInt(depMatch[0], 10) : null,
    place: hyp.name || listItem?.name || "震源地不明",
    _eqdbListItem: listItem,
    _eqdbDetail: detail,
  };
}

// 近傍地震検索・データベース検索の結果一覧(rawList、座標を持たない生のeqdb一覧項目)
// から、震央分布用の点をバックグラウンドで少しずつ解決していくフック。
// 同時に取得するのは3件までにして、APIへの負荷と表示までの速さのバランスを取る。
// キャッシュ済みの分は即座に反映され、未取得の分は取得でき次第、順次追加されていく。
// 震央分布の設定がOFFの時、useEqdbEpicenterPointsに毎回新しい[]を渡すと
// (依存配列の参照比較で)無駄にeffectが再実行されてしまうため、固定の空配列を使う。
const EMPTY_EQDB_LIST = [];

/* ─────────────────────────────────────────────────────
   潮位計(津波タブ「潮位計」モード)
   気象庁 統合地図ページ(map.html#contents=tidelevel)が使っている非公式JSON API。
   ・観測点一覧(静的、めったに変わらない): tide_area.json
   ・観測値(1地点1日1ファイル、15秒間隔): tide_obs_{YYYYMMDD}_{地点コード}.json
   ───────────────────────────────────────────────────── */
const TIDE_AREA_URL = "https://www.jma.go.jp/bosai/tidelevel/const/tide_area.json";

function tideObsUrl(dateStr, stationCode) {
  return `https://www.jma.go.jp/bosai/tidelevel/data/tide/tide_obs_${dateStr}_${stationCode}.json`;
}

// Dateオブジェクトを、tide_obsのURLで使うYYYYMMDD形式(JST基準)に変換する。
function toTideDateStr(d) {
  const pad2 = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

// tide_area.json(地域コード→潮位区→地点、の階層構造)を、地図にピンを立てやすい
// フラットな地点一覧に展開する。

// 2点間の距離の2乗(km²相当)を求める、比較専用の簡易距離関数。
// 経度方向は緯度に応じてcos補正する(日本付近ではこれで十分な精度)。
function fastDist2(lat1, lon1, lat2, lon2) {
  const latScale = 111; // 緯度1度あたりのおおよそのkm数
  const lonScale = 111 * Math.cos((lat1 * Math.PI) / 180); // この緯度での経度1度あたりのkm数
  const dLat = (lat1 - lat2) * latScale;
  const dLon = (lon1 - lon2) * lonScale;
  return dLat * dLat + dLon * dLon;
}

// ポリゴン(Polygon/MultiPolygon)の外周リング頂点の単純平均から、地域の代表点(概算の中心)を
// 求める。面積で重み付けした厳密な重心ではないが、震源からの距離を見積もる用途には十分な精度。
// MultiPolygonは頂点数が最も多い(=主要な陸地側とみなせる)外周リングを代表に使う。
function polygonRoughCentroid(geometry) {
  if (!geometry) return null;
  let ring = null;
  if (geometry.type === "Polygon") {
    ring = geometry.coordinates?.[0];
  } else if (geometry.type === "MultiPolygon") {
    let bestLen = -1;
    for (const poly of geometry.coordinates || []) {
      const r = poly?.[0];
      if (r && r.length > bestLen) { bestLen = r.length; ring = r; }
    }
  }
  if (!ring || ring.length === 0) return null;
  let sumLat = 0, sumLon = 0;
  for (const pt of ring) { sumLon += pt[0]; sumLat += pt[1]; }
  return { lat: sumLat / ring.length, lon: sumLon / ring.length };
}

/* ─────────────────────────────────────────────────────
   市区町村境界データ(map/warning_areas.json、気象庁の警報等発表区域と同じ単位の
   市区町村ポリゴン、1,821件)。次の2つの用途に使う。
     1. 現在地(緯度経度)から、その地点を含む市区町村を逆引きして表示名を出す
        (点がポリゴンの内側にあるかのレイキャスティング判定)。
     2. 地点登録の五十音順選択(あかさたなはまやらわ→あいうえお→一覧)用の
        市区町村名・読みの一覧を作る。
   ───────────────────────────────────────────────────── */
const WARNING_AREAS_URL = `${import.meta.env.BASE_URL}map/warning_areas.json`;

// warning_areas.jsonの生データを1回だけfetch+JSON.parseして使い回すための共有
// キャッシュ。以前はloadWarningAreas()(逆引き・五十音ピッカー用)と
// loadWarningAreasFullGeoJson()(地図の塗り分け用)がそれぞれ個別に
// cachedFetchJSON(同じURL)を呼んでいたため、警報タブを開いた瞬間に同じ
// 大きめのファイルを2回fetch+parseしてしまい、体感の重さの一因になっていた。
let warningAreasRawPromise = null;
function loadWarningAreasRaw() {
  if (!warningAreasRawPromise) {
    warningAreasRawPromise = cachedFetchJSON(WARNING_AREAS_URL);
  }
  return warningAreasRawPromise;
}

function computeGeoJsonBBox(geometry) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const visit = (coords) => {
    if (typeof coords[0] === "number") {
      const [lon, lat] = coords;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    } else {
      for (const c of coords) visit(c);
    }
  };
  visit(geometry.coordinates);
  return [minLon, minLat, maxLon, maxLat];
}

// 標準的なレイキャスティング(交差数)判定による点-in-リング判定。
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function pointInPolygonRings(lon, lat, rings) {
  if (!rings || rings.length === 0 || !pointInRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lon, lat, rings[i])) return false; // 穴(内側のリング)の中は除外
  }
  return true;
}
function pointInGeoJsonGeometry(lon, lat, geometry) {
  if (!geometry) return false;
  if (geometry.type === "Polygon") return pointInPolygonRings(lon, lat, geometry.coordinates);
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates || []).some(rings => pointInPolygonRings(lon, lat, rings));
  }
  return false;
}

let warningAreasPromise = null;
function loadWarningAreas() {
  if (!warningAreasPromise) {
    warningAreasPromise = loadWarningAreasRaw().then(data =>
      (data.features || []).map(f => ({
        properties: f.properties,
        geometry: f.geometry,
        bbox: computeGeoJsonBBox(f.geometry),
      }))
    );
  }
  return warningAreasPromise;
}

// 地点登録の五十音ピッカー用に、市区町村名・読み・代表座標(ポリゴン頂点の
// 単純平均)だけの軽量な一覧を作る(ジオメトリ自体は逆引き判定にしか使わないため
// 持ち回らない)。1,821件全部のcentroidを毎回計算するので、五十音ピッカーを
// 開いた時など「本当に全件必要な場面」でだけ呼ぶこと。警報タブの一覧・詳細表示
// のように「発表中の数件だけ座標が要る」場面ではloadWarningAreaNameIndex()の方を使う。
async function loadWarningAreaMunicipalities() {
  const features = await loadWarningAreas();
  return features.map(f => {
    const centroid = polygonRoughCentroid(f.geometry);
    return {
      regioncode: f.properties.regioncode,
      name: f.properties.name,
      regionname: f.properties.regionname,
      namekana: f.properties.namekana || "",
      lat: centroid?.lat ?? null,
      lon: centroid?.lon ?? null,
    };
  }).filter(m => m.lat != null && m.lon != null);
}

// 警報タブ用の軽量インデックス: regioncode → {name, geometry}。
// loadWarningAreaMunicipalities()と違い、ここでは1,821件分のcentroidを
// 前もって計算しない(名前とジオメトリの受け渡しだけなのでO(1,821)の軽い
// オブジェクト構築のみ)。実際に発表中のエリアの代表座標は、呼び出し側
// (App本体)で発表中の数件分だけpolygonRoughCentroid()を遅延計算する。
async function loadWarningAreaNameIndex() {
  const features = await loadWarningAreas();
  const index = {};
  for (const f of features) {
    // regionnameは「東京都千代田区」のように都道府県名を前方に含む表記のため、
    // 警報タブの一覧で都道府県ごとの小見出しを作る際にderivePrefFromEewAreaName()
    // へそのまま渡せる(EEWの細分区域名と同じ判定ロジックを使い回せる)。
    index[f.properties.regioncode] = { name: f.properties.name, regionname: f.properties.regionname, geometry: f.geometry };
  }
  return index;
}

// 緯度経度からその地点を含む市区町村を逆引きする。まずbboxで簡易に絞り込んでから
// レイキャスティング判定を行う(1,821件全部に対してリング判定するのは無駄なため)。
async function findMunicipalityAtPoint(lat, lon) {
  const features = await loadWarningAreas();
  for (const f of features) {
    const [minLon, minLat, maxLon, maxLat] = f.bbox;
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
    if (pointInGeoJsonGeometry(lon, lat, f.geometry)) return f.properties;
  }
  return null;
}

/* ─────────────────────────────────────────────────────
   警報タブ: 気象警報・注意報レイヤー
   気象庁の警報・注意報API(bosai/warning/data/r8/{都道府県コード}.json、全国)と
   洪水警報API(bosai/warning/data/l_flood/{都道府県コード}.json)を取得し、
   市区町村コード(regioncode。warning_areas.jsonのproperties.regioncodeと同じ単位)
   ごとに発表中の警報・注意報種別をまとめる。
   地図側は既存のwarning-areas境界(WARNING_AREAS_URL)をそのまま塗り分けに使う
   (逆引き用のloadWarningAreas()とは別に、フルGeoJSONをそのままsetDataできる
    形でも読み込む → loadWarningAreasGeoJson()参照)。
   ───────────────────────────────────────────────────── */

// 気象庁 offices コード(warning_areas.jsonのregioncodeとは別の、都道府県予報区単位のコード)
const WARNING_OFFICE_CODES = [
  "011000", "012000", "013000", "014030", "014100", "015000", "016000", "017000", // 北海道
  "020000", "030000", "040000", "050000", "060000", "070000",                     // 東北
  "080000", "090000", "100000", "110000", "120000", "130000", "140000", "190000", "200000", // 関東甲信
  "210000", "220000", "230000", "240000",                                          // 東海
  "150000", "160000", "170000", "180000",                                          // 北陸
  "250000", "260000", "270000", "280000", "290000", "300000",                     // 近畿
  "310000", "320000", "330000", "340000", "350000",                               // 中国
  "360000", "370000", "380000", "390000",                                         // 四国
  "400000", "410000", "420000", "430000", "440000",                               // 九州北部
  "450000", "460040", "460100",                                                    // 九州南部・奄美
  "471000", "472000", "473000", "474000",                                         // 沖縄
];

// 新API(r8)の警報種別コード(2桁文字列) → {name, level}
// level: "chui"(注意報) < "keiho"(警報) < "kiken"(危険警報) < "tokubetsu"(特別警報)
const WARNING_KIND_MAP = {
  // 注意報
  "10": { name: "大雨注意報",     level: "chui" },
  "12": { name: "大雪注意報",     level: "chui" },
  "13": { name: "風雪注意報",     level: "chui" },
  "14": { name: "雷注意報",       level: "chui" },
  "15": { name: "強風注意報",     level: "chui" },
  "16": { name: "波浪注意報",     level: "chui" },
  "17": { name: "融雪注意報",     level: "chui" },
  "18": { name: "洪水注意報",     level: "chui" },
  "19": { name: "高潮注意報",     level: "chui" },
  "20": { name: "濃霧注意報",     level: "chui" },
  "21": { name: "乾燥注意報",     level: "chui" },
  "22": { name: "なだれ注意報",   level: "chui" },
  "23": { name: "低温注意報",     level: "chui" },
  "24": { name: "霜注意報",       level: "chui" },
  "25": { name: "着氷注意報",     level: "chui" },
  "26": { name: "着雪注意報",     level: "chui" },
  "27": { name: "その他の注意報", level: "chui" },
  "29": { name: "土砂災害注意報", level: "chui" },
  // 警報
  "02": { name: "暴風雪警報",     level: "keiho" },
  "03": { name: "大雨警報",       level: "keiho" },
  "04": { name: "洪水警報",       level: "keiho" },
  "05": { name: "暴風警報",       level: "keiho" },
  "06": { name: "大雪警報",       level: "keiho" },
  "07": { name: "波浪警報",       level: "keiho" },
  "08": { name: "高潮警報",       level: "keiho" },
  "09": { name: "土砂災害警報",   level: "keiho" },
  // 危険警報(2026年5月新設)
  "43": { name: "大雨危険警報",     level: "kiken" },
  "48": { name: "高潮危険警報",     level: "kiken" },
  "49": { name: "土砂災害危険警報", level: "kiken" },
  // 特別警報
  "32": { name: "暴風雪特別警報",   level: "tokubetsu" },
  "33": { name: "大雨特別警報",     level: "tokubetsu" },
  "35": { name: "暴風特別警報",     level: "tokubetsu" },
  "36": { name: "大雪特別警報",     level: "tokubetsu" },
  "37": { name: "波浪特別警報",     level: "tokubetsu" },
  "38": { name: "高潮特別警報",     level: "tokubetsu" },
  "39": { name: "土砂災害特別警報", level: "tokubetsu" },
};
// 洪水警報API(l_flood)のcode → 対応するWARNING_KIND_MAPのキー
const WARNING_LEVEL_PRIORITY = { chui: 1, keiho: 2, kiken: 3, tokubetsu: 4 };
const WARNING_LEVEL_LABEL = { chui: "注意報", keiho: "警報", kiken: "危険警報", tokubetsu: "特別警報" };
const WARNING_LEVEL_COLOR = {
  tokubetsu: "#1A1A1A",
  kiken:     "#AA00AA",
  keiho:     "#FF2800",
  chui:      "#FFEF00",
};

// regioncode(市区町村コード) → { level, kinds:[{code,name,level}] } のマージ処理。
// 複数ソース(警報・注意報API/河川氾濫API)から同じ地域に複数種別が来る前提でマージする。
// kind自体({code,name,level})を直接渡す形にしている(氾濫系はWARNING_KIND_MAPに
// 無い動的な名称になるため、コード引きではなく呼び出し側で組み立てる)。
function mergeWarningKind(map, regioncode, kind) {
  if (!kind || !regioncode) return;
  const existing = map[regioncode];
  const kinds = existing ? [...existing.kinds] : [];
  if (!kinds.some(k => k.code === kind.code && k.name === kind.name)) {
    kinds.push(kind);
  }
  const topLevel = kinds.reduce(
    (best, k) => (WARNING_LEVEL_PRIORITY[k.level] > WARNING_LEVEL_PRIORITY[best] ? k.level : best),
    kinds[0].level
  );
  map[regioncode] = { level: topLevel, kinds };
}

// 気象警報・注意報(暴風/大雨/波浪/雷/土砂災害/危険警報/特別警報 等)を取得し、
// regioncode(7桁市区町村コード)単位でmapにマージする。
// 使用するのは新形式(令和8年5月29日運用開始)の r8 エンドポイント。
// 注意: 似た名前の別エンドポイント(data/warning/{code}.json)は「警戒レベル相当情報
// 4要素(大雨・土砂災害・河川氾濫・高潮)」専用かつ更新が反映されないことがあり、
// これを使うと警報級以上が全く出てこない不具合になる(実際に発生した問題)。
// 必ずこちらのr8エンドポイントを使うこと。
// レスポンスは配列で、各要素の entry.warning.class20Items[] に
// { areaCode(7桁regioncode), kinds:[{code, status}] } が入っている。
async function fetchWarningLevelMap(map) {
  const results = await Promise.allSettled(
    WARNING_OFFICE_CODES.map(code =>
      fetch(`https://www.jma.go.jp/bosai/warning/data/r8/${code}.json`, { cache: "no-store" })
        .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
    )
  );
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      console.warn(`[警報] ${WARNING_OFFICE_CODES[i]} の取得に失敗しました:`, r.reason);
      return;
    }
    const dataArr = Array.isArray(r.value) ? r.value : [r.value];
    dataArr.forEach(entry => {
      const items = entry?.warning?.class20Items ?? [];
      items.forEach(item => {
        const regioncode = String(item.areaCode ?? "").trim();
        if (!regioncode) return;
        (item.kinds ?? []).forEach(k => {
          const s = String(k.status ?? "").trim();
          if (s === "" || s === "解除") return;
          // コードは数値の場合もあるので2桁ゼロ埋め文字列に正規化
          const codeStr = String(k.code ?? "").trim().padStart(2, "0");
          const def = WARNING_KIND_MAP[codeStr];
          if (!def) return;
          mergeWarningKind(map, regioncode, { code: codeStr, name: def.name, level: def.level });
        });
      });
    });
  });
}

// 氾濫系警報コード(気象庁 flood_xml.json の item.code)→ {name, level} に変換する。
// 十の位でレベルが決まる: 1x=解除 / 2x=氾濫注意報 / 3x=氾濫警報 / 4x=氾濫危険警報 / 5x=氾濫特別警報
// (指定河川洪水予報。令和8年5月の改定で「洪水注意報・警報」自体は廃止され、
//  指定河川はこちらの氾濫情報、それ以外の河川は大雨警報の枠組みに統合された)。
function getFloodWarningKind(codeStr) {
  const n = parseInt(codeStr, 10);
  if (n >= 20 && n < 30) return { code: `flood-${n}`, name: "氾濫注意報",   level: "chui" };
  if (n >= 30 && n < 40) return { code: `flood-${n}`, name: "氾濫警報",     level: "keiho" };
  if (n >= 40 && n < 50) return { code: `flood-${n}`, name: "氾濫危険警報", level: "kiken" };
  if (n >= 50)           return { code: `flood-${n}`, name: "氾濫特別警報", level: "tokubetsu" };
  return null; // 1x = 解除, その他 = 不明 → スキップ
}

// 指定河川の氾濫警報等(氾濫危険警報など)を取得し、regioncode単位でmapにマージする。
async function fetchFloodWarningLevelMap(map) {
  try {
    const res = await fetch("https://www.jma.go.jp/bosai/flood/data/r8/flood_xml.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) return;
    data.forEach(entry => {
      const kind = getFloodWarningKind(String(entry?.item?.code ?? "").trim());
      if (!kind) return; // 解除または不明コードはスキップ
      // class20Codesは7桁の市区町村コードで、warningLevelMapのregioncodeと同じ単位
      (entry?.class20Codes ?? []).forEach(rc => {
        const regioncode = String(rc).trim();
        if (regioncode) mergeWarningKind(map, regioncode, kind);
      });
    });
  } catch (err) {
    console.warn("[河川氾濫警報] flood_xml.jsonの取得に失敗しました:", err);
  }
}

// 気象警報・注意報+河川氾濫警報の両方を取得し、regioncode(市区町村コード)単位の
// マップにまとめる。ライブデータのため cachedFetchJSON(Cache API長期保存)は使わず、
// no-storeの素のfetchにする(warning_areas.json等の静的境界データとは性質が違う)。
async function fetchWarningLevelMap_combined() {
  const map = {};
  await Promise.all([fetchWarningLevelMap(map), fetchFloodWarningLevelMap(map)]);
  console.log(`[警報] warningLevelMap件数: ${Object.keys(map).length}`);
  return map;
}

// 境界データ(public/map/warning_areas.json)をそのままGeoJSONとして読み込む。
// loadWarningAreas()(逆引き・五十音ピッカー用の軽量版)とは処理内容は別だが、
// 生データの取得自体はloadWarningAreasRaw()を共有しているので、どちらが先に
// 呼ばれても実際のfetch+JSON.parseは1回で済む。
let warningAreasFullGeoJsonPromise = null;
function loadWarningAreasFullGeoJson() {
  if (!warningAreasFullGeoJsonPromise) {
    warningAreasFullGeoJsonPromise = loadWarningAreasRaw();
  }
  return warningAreasFullGeoJsonPromise;
}

// warningLevelMapを使って、warning-areasの各featureにwarnLevelプロパティを
// 埋め込んだGeoJSONを作る(mapのpaintはこのプロパティをmatch式で参照する)。
function buildWarningAreasGeoJson(baseGeoJson, warningLevelMap) {
  if (!baseGeoJson) return { type: "FeatureCollection", features: [] };
  return {
    ...baseGeoJson,
    features: baseGeoJson.features.map(f => {
      const entry = warningLevelMap[f.properties.regioncode];
      return {
        ...f,
        // 移植元ツールと同じく、warnLevel(文字列)とwarnColor(ベタ色/transparent)の
        // 両方をfeature propertiesに埋め込む。fill-colorはこのwarnColorをそのまま参照する。
        properties: {
          ...f.properties,
          warnLevel: entry ? entry.level : "",
          warnColor: entry ? WARNING_LEVEL_COLOR[entry.level] : "transparent",
        },
      };
    }),
  };
}

// fill-colorは["get","warnColor"](移植元ツールと同じ、match式は使わない)。
function buildWarningAreaColorExpr() {
  return ["get", "warnColor"];
}

// 五十音(あかさたなはまやらわ)の行・段の定義。「あかさたなはまやらわ」の
// ボタン(1段目)→選んだ行の中の段(例: あいうえお)(2段目)→一覧、の
// 2段階の絞り込みに使う。
const KANA_ROWS = [
  { key: "あ", columns: ["あ", "い", "う", "え", "お"] },
  { key: "か", columns: ["か", "き", "く", "け", "こ"] },
  { key: "さ", columns: ["さ", "し", "す", "せ", "そ"] },
  { key: "た", columns: ["た", "ち", "つ", "て", "と"] },
  { key: "な", columns: ["な", "に", "ぬ", "ね", "の"] },
  { key: "は", columns: ["は", "ひ", "ふ", "へ", "ほ"] },
  { key: "ま", columns: ["ま", "み", "む", "め", "も"] },
  { key: "や", columns: ["や", "ゆ", "よ"] },
  { key: "ら", columns: ["ら", "り", "る", "れ", "ろ"] },
  { key: "わ", columns: ["わ", "を", "ん"] },
];
// 濁音・半濁音・拗音・促音・小書き文字を、五十音表での分類上の基本の文字に正規化する
// (例: 「が」は「か」行「か」段として分類する、辞書の見出し語順と同じ考え方)。
const KANA_BASE_MAP = {
  "が": "か", "ぎ": "き", "ぐ": "く", "げ": "け", "ご": "こ",
  "ざ": "さ", "じ": "し", "ず": "す", "ぜ": "せ", "ぞ": "そ",
  "だ": "た", "ぢ": "ち", "づ": "つ", "で": "て", "ど": "と",
  "ば": "は", "び": "ひ", "ぶ": "ふ", "べ": "へ", "ぼ": "ほ",
  "ぱ": "は", "ぴ": "ひ", "ぷ": "ふ", "ぺ": "へ", "ぽ": "ほ",
  "ゃ": "や", "ゅ": "ゆ", "ょ": "よ", "っ": "つ",
  "ぁ": "あ", "ぃ": "い", "ぅ": "う", "ぇ": "え", "ぉ": "お",
};
// 「段の文字」→{行key, 段文字}のフラットな逆引きマップを1回だけ作る。
const KANA_CHAR_TO_ROWCOL = (() => {
  const map = {};
  for (const row of KANA_ROWS) {
    for (const col of row.columns) map[col] = { rowKey: row.key, colChar: col };
  }
  return map;
})();
function classifyKanaChar(ch) {
  if (!ch) return null;
  const base = KANA_BASE_MAP[ch] || ch;
  return KANA_CHAR_TO_ROWCOL[base] || null;
}
// 市区町村一覧(loadWarningAreaMunicipalities()の結果)を、行→段→(その段に属する
// 市区町村の配列、namekana昇順)の入れ子オブジェクトに分類する。
function groupMunicipalitiesByKana(municipalities) {
  const grouped = {};
  for (const m of municipalities) {
    const cls = classifyKanaChar((m.namekana || "")[0]);
    if (!cls) continue;
    grouped[cls.rowKey] = grouped[cls.rowKey] || {};
    grouped[cls.rowKey][cls.colChar] = grouped[cls.rowKey][cls.colChar] || [];
    grouped[cls.rowKey][cls.colChar].push(m);
  }
  for (const rowKey in grouped) {
    for (const colChar in grouped[rowKey]) {
      grouped[rowKey][colChar].sort((a, b) => a.namekana.localeCompare(b.namekana, "ja"));
    }
  }
  return grouped;
}

// 計測震度(連続値)を気象庁の震度階級に変換する(「震度を知る」の計測震度→震度階級の対応表)。
function instrumentalIntensityToScaleKey(i) {
  if (i < 0.5) return "0";
  if (i < 1.5) return "1";
  if (i < 2.5) return "2";
  if (i < 3.5) return "3";
  if (i < 4.5) return "4";
  if (i < 5.0) return "5-";
  if (i < 5.5) return "5+";
  if (i < 6.0) return "6-";
  if (i < 6.5) return "6+";
  return "7";
}

// 緊急地震速報テスト配信専用: 震源(緯度・経度・M・深さ)から、細分区域.json(areasGeoJSON)の
// 各地域の予測最大震度を距離減衰式で計算する。気象庁「緊急地震速報の概要や処理手法に関する
// 技術的参考資料」(令和6年4月版)の予測震度算出処理をベースにしている:
//   1. Mjma→Mw変換(宇津[1982]等): Mw = M - 0.171
//   2. 断層長(宇津[1977]): log10(L) = 0.5*Mw - 1.85 半分を震源球の半径とし、最短距離から差し引く
//      (下限3km)
//   3. 司・翠川[1999]の距離減衰式で基準基盤(Vs600m/s)上の最大速度PGV600を算出
//   4. 地表への換算。本来は基準基盤→工学的基盤(≒0.90倍)→地点ごとの地盤増幅度、と
//      2段階だが、地点別の地盤増幅度データは持たないため、代わりに市街地の軟弱地盤を
//      想定した簡易増幅係数(SITE_AMPLIFICATION_FACTOR)を掛けている。この値は気象庁の
//      実運用の平均値より高め(＝震度がやや過大気味)に寄せてある。
//   5. 翠川ほか[1999]の換算式で計測震度に変換する。
// 気象庁は震度4未満の予測でも緊急地震速報(予報)自体は発表し、最大震度の予測値も含めて
// いる(警報になるのは震度5弱以上の予測の時)。そのため、地図に塗り潰す地域(areas)は
// 従来通り震度4以上のみに絞る一方、カードの「最大震度」表示に使うmaxIntensityKeyは
// 震度4未満だった場合も含めた全地域中の最大値から求め、震度4未満の震源でも「?」に
// ならず正しい予測震度が表示されるようにしている。
const SITE_AMPLIFICATION_FACTOR = 2.0;
// 震度キー→気象庁の震度階級コード(数値。大きいほど強い)の対応。eewMaxScaleKey等で
// 使われているものと同じ体系。
const INTENSITY_SCALE_CODE = { "7": 70, "6+": 60, "6-": 55, "6": 54, "5+": 50, "5-": 45, "5": 44, "4": 40, "3": 30, "2": 20, "1": 10, "0": 0 };
// テスト配信専用: 震度5弱(気象庁の実運用で警報の基準となる階級)以上を警報級とみなす。
function isTestWarnLevel(intensityKey) {
  return (INTENSITY_SCALE_CODE[intensityKey] ?? -1) >= 45;
}
function calcTestEewAreasByAttenuation(areasGeoJSON, lat, lon, magnitude, depthKm, isPlum) {
  if (!areasGeoJSON || !Array.isArray(areasGeoJSON.features)) return { areas: [], maxIntensityKey: "?" };
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(magnitude)) {
    return { areas: [], maxIntensityKey: "?" };
  }
  const D = Number.isFinite(depthKm) ? Math.max(0, depthKm) : 10;
  const Mw = magnitude - 0.171;
  const faultLengthKm = Math.pow(10, 0.5 * Mw - 1.85);
  const sourceRadiusKm = faultLengthKm / 2;

  const areas = []; // 地図の塗り潰し用(震度4以上のみ)
  let overallMaxValue = -Infinity;
  let overallMaxKey = null;

  for (const feature of areasGeoJSON.features) {
    const name = feature.properties?.name;
    if (!name) continue;
    const center = polygonRoughCentroid(feature.geometry);
    if (!center) continue;

    const epicentralKm = Math.sqrt(fastDist2(lat, lon, center.lat, center.lon));
    const hypocentralKm = Math.sqrt(epicentralKm * epicentralKm + D * D);
    const shortestKm = Math.max(3, hypocentralKm - sourceRadiusKm);

    const logPGV600 = 0.58 * Mw + 0.0038 * D - 1.29
      - Math.log10(shortestKm + 0.0028 * Math.pow(10, 0.5 * Mw))
      - 0.002 * shortestKm;
    const PGV600 = Math.pow(10, logPGV600);
    const PGVs = PGV600 * SITE_AMPLIFICATION_FACTOR;

    const instrIntensity = 2.68 + 1.72 * Math.log10(PGVs);
    if (!Number.isFinite(instrIntensity)) continue;

    const key = instrumentalIntensityToScaleKey(instrIntensity);
    if (instrIntensity > overallMaxValue) {
      overallMaxValue = instrIntensity;
      overallMaxKey = key;
    }
    if (instrIntensity < 4) continue; // 塗り潰し対象は震度4以上のみ

    const code = INTENSITY_SCALE_CODE[key] ?? 40;
    areas.push({ pref: "", name, scaleFrom: code, scaleTo: code, maxIntensityKey: key, isPlum: !!isPlum });
  }
  return { areas, maxIntensityKey: overallMaxKey || "?" };
}

/* ─────────────────────────────────────────────────────
   地震情報テスト配信専用: 震源(緯度・経度・M・深さ)から、震度速報・震度に関する情報の
   段階で使うダミーの観測点分布(points)を作る。
   calcTestEewAreasByAttenuationと同じ距離減衰式をそのまま使い回すが、EEW側は
   「地図に塗る震度4以上の地域」だけに絞っているのに対し、こちらは震度速報の
   雰囲気を再現するため震度1以上の地域も含める(細分区域.json全域を計算するため、
   通常の震源だとEEWよりだいぶ多い件数になる)。
   本来のP2P地震情報の観測点(points)は市町村・観測点単位(isArea:false)だが、
   このテスト機能では細分区域単位(isArea:true)の粒度で簡易的に生成する
   (震度速報と同じ粒度。実際の詳細報もこの粒度で代用する簡略化版)。
   ───────────────────────────────────────────────────── */
function calcTestQuakePointsByAttenuation(areasGeoJSON, lat, lon, magnitude, depthKm) {
  if (!areasGeoJSON || !Array.isArray(areasGeoJSON.features)) return { points: [], maxIntensityKey: "?" };
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(magnitude)) {
    return { points: [], maxIntensityKey: "?" };
  }
  const D = Number.isFinite(depthKm) ? Math.max(0, depthKm) : 10;
  const Mw = magnitude - 0.171;
  const faultLengthKm = Math.pow(10, 0.5 * Mw - 1.85);
  const sourceRadiusKm = faultLengthKm / 2;

  const points = [];
  let overallMaxValue = -Infinity;
  let overallMaxKey = null;

  for (const feature of areasGeoJSON.features) {
    const name = feature.properties?.name;
    if (!name) continue;
    const center = polygonRoughCentroid(feature.geometry);
    if (!center) continue;

    const epicentralKm = Math.sqrt(fastDist2(lat, lon, center.lat, center.lon));
    const hypocentralKm = Math.sqrt(epicentralKm * epicentralKm + D * D);
    const shortestKm = Math.max(3, hypocentralKm - sourceRadiusKm);

    const logPGV600 = 0.58 * Mw + 0.0038 * D - 1.29
      - Math.log10(shortestKm + 0.0028 * Math.pow(10, 0.5 * Mw))
      - 0.002 * shortestKm;
    const PGV600 = Math.pow(10, logPGV600);
    const PGVs = PGV600 * SITE_AMPLIFICATION_FACTOR;

    const instrIntensity = 2.68 + 1.72 * Math.log10(PGVs);
    if (!Number.isFinite(instrIntensity)) continue;

    const key = instrumentalIntensityToScaleKey(instrIntensity);
    if (instrIntensity > overallMaxValue) {
      overallMaxValue = instrIntensity;
      overallMaxKey = key;
    }
    if (instrIntensity < 1) continue; // 震度1未満の地域は載せない(震度速報の実際の見え方に合わせる)

    points.push({ pref: "", addr: name, scale: INTENSITY_SCALE_CODE[key] ?? 10, isArea: true });
  }
  return { points, maxIntensityKey: overallMaxKey || "?" };
}

// 地震情報テスト配信: 発表段階(stage)ごとに、実際のtoQuakeCard()と同じ形のカードを作る。
// ①震度速報(prompt): 震源不明、地域単位の震度分布あり、津波は調査中。
// ②震源に関する情報(destination): 震源は判明、震度分布はまだ無い(maxIntensityは"?")。
// ③震度に関する情報(detail): 震源・震度分布ともに確定。津波はフォームの指定値。
// time(発生時刻)は同じ地震の複数段階を通じて固定し、issueTimeStrだけ毎回「今」を渡す
// ことで、実際のmergeQuakeCards(dedupeQuakeList)と同じ仕組みでApp側が段階的に統合できる。
function buildTestQuakeStageCard(stage, form, time, issueTimeStr, areasGeoJSON) {
  const { points, maxIntensityKey } = calcTestQuakePointsByAttenuation(
    areasGeoJSON, form.latitude, form.longitude, form.magnitude, form.depth
  );

  if (stage === "prompt") {
    return {
      id: `test_${time}_prompt`,
      time, issueTime: issueTimeStr, stage: "prompt",
      place: "震源調査中",
      maxIntensity: maxIntensityKey,
      isForeign: false,
      magnitude: null, depth: null, latitude: null, longitude: null, longPeriod: null,
      points,
      domesticTsunami: "Checking",
      freeFormComment: null,
      isTest: true,
    };
  }
  if (stage === "destination") {
    return {
      id: `test_${time}_destination`,
      time, issueTime: issueTimeStr, stage: "destination",
      place: form.place || "震源地不明",
      maxIntensity: "?",
      isForeign: false,
      magnitude: form.magnitude, depth: form.depth, latitude: form.latitude, longitude: form.longitude, longPeriod: null,
      points: [],
      domesticTsunami: "Checking",
      freeFormComment: null,
      isTest: true,
    };
  }
  // detail(確定)
  return {
    id: `test_${time}_detail`,
    time, issueTime: issueTimeStr, stage: "detail",
    place: form.place || "震源地不明",
    maxIntensity: maxIntensityKey,
    isForeign: false,
    magnitude: form.magnitude, depth: form.depth, latitude: form.latitude, longitude: form.longitude, longPeriod: null,
    points,
    domesticTsunami: form.domesticTsunami || "None",
    freeFormComment: null,
    isTest: true,
  };
}

// 潮位観測点(1点)から一番近い津波予報区を、tsunami-areas.json(海岸線の座標データ、
// 都道府県名などのあいまいな情報に頼らず地図描画に実際使っている正式なデータ)との
// 距離計算で求める。各予報区のMultiLineStringの頂点との最短距離で近似している
// (頂点間隔は密なため、線分内挿までは行わずとも十分な精度が出る)。
function findNearestTsunamiArea(lat, lon, tsunamiAreasGeoJSON) {
  if (lat == null || lon == null || !tsunamiAreasGeoJSON || !Array.isArray(tsunamiAreasGeoJSON.features)) return null;
  let best = null;
  let bestDist2 = Infinity;
  for (const feature of tsunamiAreasGeoJSON.features) {
    const multiLine = feature.geometry?.coordinates;
    if (!Array.isArray(multiLine)) continue;
    for (const line of multiLine) {
      for (const pt of line) {
        const d2 = fastDist2(lat, lon, pt[1], pt[0]);
        if (d2 < bestDist2) {
          bestDist2 = d2;
          best = feature.properties;
        }
      }
    }
  }
  return best; // { code, name } | null
}

// findNearestTsunamiAreaと同じ距離計算だが、地図タップでの予報区選択用に
// 「どれだけ近かったか(km)」も一緒に返す。海上の何もない場所や地図の範囲外を
// 誤ってタップした場合に、呼び出し側で距離が遠すぎる結果を弾けるようにするため。
function findNearestTsunamiAreaWithDistance(lat, lon, tsunamiAreasGeoJSON) {
  if (lat == null || lon == null || !tsunamiAreasGeoJSON || !Array.isArray(tsunamiAreasGeoJSON.features)) return null;
  let best = null;
  let bestDist2 = Infinity;
  for (const feature of tsunamiAreasGeoJSON.features) {
    const multiLine = feature.geometry?.coordinates;
    if (!Array.isArray(multiLine)) continue;
    for (const line of multiLine) {
      for (const pt of line) {
        const d2 = fastDist2(lat, lon, pt[1], pt[0]);
        if (d2 < bestDist2) {
          bestDist2 = d2;
          best = feature.properties;
        }
      }
    }
  }
  if (!best) return null;
  return { ...best, distanceKm: Math.sqrt(bestDist2) }; // { code, name, distanceKm } | null
}

/* ─────────────────────────────────────────────────────
   天気タブ「地点」モード — 現在地(GPS)または登録地点の天気予報。
   気象庁の天気予報(forecast.json)は府県予報区(office)単位、天気・降水確率は
   一次細分区域(class10s)単位、気温はアメダス観測所単位で提供されており、
   緯度経度から直接これらを引く手段は無い。そこでここでは、
     1. アメダス観測点一覧(amedastable.json、緯度経度あり)から一番近い観測点を探す
     2. その観測点が属する一次細分区域・オフィスを、天気予報で使うアメダス地点だけを
        まとめたforecast_area.json(office→class10→amedasの対応表)から逆引きする
   という2段階でlat/lngから予報の取得先(office・class10・amedas)を決める。
   ───────────────────────────────────────────────────── */
const AMEDAS_TABLE_URL = "https://www.jma.go.jp/bosai/amedas/const/amedastable.json";
const FORECAST_AREA_URL = "https://www.jma.go.jp/bosai/forecast/const/forecast_area.json";
function forecastDataUrl(officeCode) {
  return `https://www.jma.go.jp/bosai/forecast/data/forecast/${officeCode}.json`;
}

// area.json上の行政区分(office)としては存在するのに、forecast.json自体は
// 気象庁側に用意されておらず、実際には別のofficeのデータで代用されている
// コードがいくつかある(気象庁の天気予報ページ自身もこの読み替えを内部で
// 行っている)。判明しているもの:
//   460040(奄美地方)      → 460100(鹿児島県) のforecast.jsonを使う
//   014030(十勝地方)      → 014100            のforecast.jsonを使う
// 該当する地域(class10Code)自体は代用先のforecast.json内にareaの1つとして
// ちゃんと含まれているため、officeCodeだけこちらに差し替えてfetchし、
// class10Code/amedasCodeでの絞り込みはそのまま行えばよい。
const FORECAST_OFFICE_CODE_REDIRECTS = {
  "014030": "014100",
  "460040": "460100",
};
function resolveForecastFetchOfficeCode(officeCode) {
  return FORECAST_OFFICE_CODE_REDIRECTS[officeCode] || officeCode;
}

// amedastable.jsonの緯度経度は[度, 分]の配列で入っているため、10進度に変換する。
function amedasDegMinToDecimal(pair) {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const [deg, min] = pair;
  if (!Number.isFinite(deg) || !Number.isFinite(min)) return null;
  return deg + min / 60;
}

let amedasPointsCache = null;      // [{code, lat, lon, name}] | null(未取得)
let forecastAreaDataCache = null;  // { index: {amedasコード:{officeCode,class10Code}}, byOffice: {officeCode:[amedasコード]} } | null(未取得)

async function loadAmedasPoints() {
  if (amedasPointsCache) return amedasPointsCache;
  const res = await fetch(AMEDAS_TABLE_URL);
  if (!res.ok) throw new Error(`アメダス観測点一覧の取得に失敗(HTTP ${res.status})`);
  const data = await res.json();
  const points = [];
  for (const code of Object.keys(data)) {
    const entry = data[code];
    const lat = amedasDegMinToDecimal(entry.lat);
    const lon = amedasDegMinToDecimal(entry.lon);
    if (lat == null || lon == null) continue;
    points.push({ code, lat, lon, name: entry.kjName || "" });
  }
  amedasPointsCache = points;
  return points;
}

async function loadForecastAreaData() {
  if (forecastAreaDataCache) return forecastAreaDataCache;
  const res = await fetch(FORECAST_AREA_URL);
  if (!res.ok) throw new Error(`天気予報エリア対応表の取得に失敗(HTTP ${res.status})`);
  const data = await res.json();
  const index = {};    // amedasコード → {officeCode, class10Code}
  const byOffice = {};  // officeCode → そのofficeに属するamedasコードの配列
  for (const officeCode of Object.keys(data)) {
    byOffice[officeCode] = [];
    for (const entry of data[officeCode]) {
      for (const amedasCode of entry.amedas || []) {
        index[amedasCode] = { officeCode, class10Code: entry.class10 };
        byOffice[officeCode].push(amedasCode);
      }
    }
  }
  forecastAreaDataCache = { index, byOffice };
  return forecastAreaDataCache;
}

// 気象庁の公式な行政区分階層(common/const/area.json、centers→offices→
// class10s→class15s→class20s)。class20sのコードは、市区町村境界データ
// (warning_areas.json)のregioncodeと同じJIS X 0402ベースの7桁コードなので、
// これをキーに辿ればofficeCode・class10Codeを距離ではなく行政区分そのものから
// 正確に求められる。
const AREA_HIERARCHY_URL = "https://www.jma.go.jp/bosai/common/const/area.json";
let areaHierarchyPromise = null;
function loadAreaHierarchy() {
  if (!areaHierarchyPromise) areaHierarchyPromise = cachedFetchJSON(AREA_HIERARCHY_URL);
  return areaHierarchyPromise;
}
async function resolveForecastAreaFromMunicipalityCode(regioncode) {
  const area = await loadAreaHierarchy();
  const class20 = area.class20s?.[regioncode];
  const class15 = class20 && area.class15s?.[class20.parent];
  const class10Code = class15?.parent;
  const class10 = class10Code && area.class10s?.[class10Code];
  const officeCode = class10?.parent;
  if (!officeCode || !area.offices?.[officeCode]) return null;
  return { officeCode, class10Code };
}

// 緯度・経度から、天気予報の取得に必要な情報(所属オフィス・一次細分区域・
// 気温用の最寄りアメダス観測点)をまとめて求める。
//
// まず市区町村境界データ(warning_areas.json)でその地点を含む市区町村を特定し、
// 気象庁の公式な行政区分階層からofficeCode・class10Codeを求める(都県境付近だと、
// 直線距離では隣の都県のアメダス観測点の方が近いことがあり、距離だけで推定すると
// 隣県の予報が出てしまうことがあるため)。市区町村が特定できなかった場合(海上など)
// のみ、全国のアメダス観測点から単純に最寄りを探すやり方にフォールバックする。
// 気温を取る観測点(amedasCode)は、officeCodeが判明していればその予報区に属する
// 観測点の中だけから最寄りを探す(そうしないと気温だけ隣県の観測点になりうるため)。
async function resolveForecastLocation(lat, lon, opts = {}) {
  let officeCode = null;
  let class10Code = null;
  if (!opts.ignoreMunicipality) {
    try {
      const muni = await findMunicipalityAtPoint(lat, lon);
      if (muni?.regioncode) {
        const resolved = await resolveForecastAreaFromMunicipalityCode(muni.regioncode);
        if (resolved) {
          officeCode = resolved.officeCode;
          class10Code = resolved.class10Code;
        }
      }
    } catch (err) {
      console.error("市区町村境界からの予報エリア解決に失敗。距離ベースの推定にフォールバックします:", err);
    }
  }

  const [points, areaData] = await Promise.all([loadAmedasPoints(), loadForecastAreaData()]);
  const { index: areaIndex, byOffice } = areaData;
  // area.jsonとforecast_area.jsonでコードの型(文字列/数値)が食い違っていても
  // 一致判定できるよう、Setに入れる側・検索する側の両方を文字列に揃えておく
  // (離島など特定の地域だけ突き合わせが崩れる不具合の予防策)。
  let candidateSet = officeCode ? new Set((byOffice[officeCode] || []).map(String)) : null;
  // area.jsonとforecast_area.jsonでofficeコードの対応が取れず、絞り込んだ結果
  // 候補が1件も無い場合は、行政区分による解決自体を諦めて全国検索にフォールバック
  // する(「予報が全く出ない」よりは、多少不正確でも予報が出る方が良いため)。
  if (candidateSet && candidateSet.size === 0) {
    officeCode = null;
    class10Code = null;
    candidateSet = null;
  }

  let best = null;
  let bestDist2 = Infinity;
  for (const pt of points) {
    const isCandidate = candidateSet ? candidateSet.has(String(pt.code)) : !!areaIndex[pt.code];
    if (!isCandidate) continue;
    const d2 = fastDist2(lat, lon, pt.lat, pt.lon);
    if (d2 < bestDist2) {
      bestDist2 = d2;
      best = pt;
    }
  }
  if (!best) return null;

  if (!officeCode) {
    const fallback = areaIndex[best.code];
    officeCode = fallback.officeCode;
    class10Code = fallback.class10Code;
  }
  return { officeCode, class10Code, amedasCode: best.code, stationName: best.name };
}

// weatherCode → { icon(気象庁のSVGファイル名の数字部分), telop(短い天気表現) }。
// 出典: 気象庁の天気予報JSON内で使われているコード表。
const WEATHER_CODE_INFO = {
  "100": { icon: "100", telop: "晴" }, "101": { icon: "101", telop: "晴時々曇" },
  "102": { icon: "102", telop: "晴一時雨" }, "103": { icon: "102", telop: "晴時々雨" },
  "104": { icon: "104", telop: "晴一時雪" }, "105": { icon: "104", telop: "晴時々雪" },
  "106": { icon: "102", telop: "晴一時雨か雪" }, "107": { icon: "102", telop: "晴時々雨か雪" },
  "108": { icon: "102", telop: "晴一時雨か雷雨" }, "110": { icon: "110", telop: "晴後時々曇" },
  "111": { icon: "110", telop: "晴後曇" }, "112": { icon: "112", telop: "晴後一時雨" },
  "113": { icon: "112", telop: "晴後時々雨" }, "114": { icon: "112", telop: "晴後雨" },
  "115": { icon: "115", telop: "晴後一時雪" }, "116": { icon: "115", telop: "晴後時々雪" },
  "117": { icon: "115", telop: "晴後雪" }, "118": { icon: "112", telop: "晴後雨か雪" },
  "119": { icon: "112", telop: "晴後雨か雷雨" }, "120": { icon: "102", telop: "晴朝夕一時雨" },
  "121": { icon: "102", telop: "晴朝の内一時雨" }, "122": { icon: "112", telop: "晴夕方一時雨" },
  "123": { icon: "100", telop: "晴山沿い雷雨" }, "124": { icon: "100", telop: "晴山沿い雪" },
  "125": { icon: "112", telop: "晴午後は雷雨" }, "126": { icon: "112", telop: "晴昼頃から雨" },
  "127": { icon: "112", telop: "晴夕方から雨" }, "128": { icon: "112", telop: "晴夜は雨" },
  "130": { icon: "100", telop: "朝の内霧後晴" }, "131": { icon: "100", telop: "晴明け方霧" },
  "132": { icon: "101", telop: "晴朝夕曇" }, "140": { icon: "102", telop: "晴時々雨で雷を伴う" },
  "160": { icon: "104", telop: "晴一時雪か雨" }, "170": { icon: "104", telop: "晴時々雪か雨" },
  "181": { icon: "115", telop: "晴後雪か雨" },
  "200": { icon: "200", telop: "曇" }, "201": { icon: "201", telop: "曇時々晴" },
  "202": { icon: "202", telop: "曇一時雨" }, "203": { icon: "202", telop: "曇時々雨" },
  "204": { icon: "204", telop: "曇一時雪" }, "205": { icon: "204", telop: "曇時々雪" },
  "206": { icon: "202", telop: "曇一時雨か雪" }, "207": { icon: "202", telop: "曇時々雨か雪" },
  "208": { icon: "202", telop: "曇一時雨か雷雨" }, "209": { icon: "200", telop: "霧" },
  "210": { icon: "210", telop: "曇後時々晴" }, "211": { icon: "210", telop: "曇後晴" },
  "212": { icon: "212", telop: "曇後一時雨" }, "213": { icon: "212", telop: "曇後時々雨" },
  "214": { icon: "212", telop: "曇後雨" }, "215": { icon: "215", telop: "曇後一時雪" },
  "216": { icon: "215", telop: "曇後時々雪" }, "217": { icon: "215", telop: "曇後雪" },
  "218": { icon: "212", telop: "曇後雨か雪" }, "219": { icon: "212", telop: "曇後雨か雷雨" },
  "220": { icon: "202", telop: "曇朝夕一時雨" }, "221": { icon: "202", telop: "曇朝の内一時雨" },
  "222": { icon: "212", telop: "曇夕方一時雨" }, "223": { icon: "201", telop: "曇日中時々晴" },
  "224": { icon: "212", telop: "曇昼頃から雨" }, "225": { icon: "212", telop: "曇夕方から雨" },
  "226": { icon: "212", telop: "曇夜は雨" }, "228": { icon: "215", telop: "曇昼頃から雪" },
  "229": { icon: "215", telop: "曇夕方から雪" }, "230": { icon: "215", telop: "曇夜は雪" },
  "231": { icon: "200", telop: "曇海上海岸は霧か霧雨" }, "240": { icon: "202", telop: "曇時々雨で雷を伴う" },
  "250": { icon: "204", telop: "曇時々雪で雷を伴う" }, "260": { icon: "204", telop: "曇一時雪か雨" },
  "270": { icon: "204", telop: "曇時々雪か雨" }, "281": { icon: "215", telop: "曇後雪か雨" },
  "300": { icon: "300", telop: "雨" }, "301": { icon: "301", telop: "雨時々晴" },
  "302": { icon: "302", telop: "雨時々止む" }, "303": { icon: "303", telop: "雨時々雪" },
  "304": { icon: "300", telop: "雨か雪" }, "306": { icon: "300", telop: "大雨" },
  "308": { icon: "308", telop: "雨で暴風を伴う" }, "309": { icon: "303", telop: "雨一時雪" },
  "311": { icon: "311", telop: "雨後晴" }, "313": { icon: "313", telop: "雨後曇" },
  "314": { icon: "314", telop: "雨後時々雪" }, "315": { icon: "314", telop: "雨後雪" },
  "316": { icon: "311", telop: "雨か雪後晴" }, "317": { icon: "313", telop: "雨か雪後曇" },
  "320": { icon: "311", telop: "朝の内雨後晴" }, "321": { icon: "313", telop: "朝の内雨後曇" },
  "322": { icon: "303", telop: "雨朝晩一時雪" }, "323": { icon: "311", telop: "雨昼頃から晴" },
  "324": { icon: "311", telop: "雨夕方から晴" }, "325": { icon: "311", telop: "雨夜は晴" },
  "326": { icon: "314", telop: "雨夕方から雪" }, "327": { icon: "314", telop: "雨夜は雪" },
  "328": { icon: "300", telop: "雨一時強く降る" }, "329": { icon: "300", telop: "雨一時みぞれ" },
  "340": { icon: "400", telop: "雪か雨" }, "350": { icon: "300", telop: "雨で雷を伴う" },
  "361": { icon: "411", telop: "雪か雨後晴" }, "371": { icon: "413", telop: "雪か雨後曇" },
  "400": { icon: "400", telop: "雪" }, "401": { icon: "401", telop: "雪時々晴" },
  "402": { icon: "402", telop: "雪時々止む" }, "403": { icon: "403", telop: "雪時々雨" },
  "405": { icon: "400", telop: "大雪" }, "406": { icon: "406", telop: "風雪強い" },
  "407": { icon: "406", telop: "暴風雪" }, "409": { icon: "403", telop: "雪一時雨" },
  "411": { icon: "411", telop: "雪後晴" }, "413": { icon: "413", telop: "雪後曇" },
  "414": { icon: "414", telop: "雪後雨" }, "420": { icon: "411", telop: "朝の内雪後晴" },
  "421": { icon: "413", telop: "朝の内雪後曇" }, "422": { icon: "414", telop: "雪昼頃から雨" },
  "423": { icon: "414", telop: "雪夕方から雨" }, "425": { icon: "400", telop: "雪一時強く降る" },
  "426": { icon: "400", telop: "雪後みぞれ" }, "427": { icon: "400", telop: "雪一時みぞれ" },
  "450": { icon: "400", telop: "雪で雷を伴う" },
};
function weatherTelop(code) {
  const info = WEATHER_CODE_INFO[String(code)];
  return info ? info.telop : "不明";
}

/* ─────────────────────────────────────────────────────
   天気アイコン(https://github.com/ciscorn/jma-weather-images, license: CC0)

   あのリポジトリは「基本アイコン(晴・くもり・雨…)+のちサイン」の少数の
   部品画像を、weathercodeごとの指定(b=ベース, m=修飾子, t=対象)に従って
   PILで合成し、weathercodeごとの画像を書き出す、という仕組みになっている
   (generate.py参照)。
   今回は事前に静止画として書き出す代わりに、同じ合成ロジックをそのまま
   このコンポーネントに移植し、部品SVG(public/srcimgs_refs/に配置)を
   CSSの絶対配置で重ねることでブラウザ側で合成する。これなら部品SVGを
   1セット(16個程度)用意するだけで済み、weathercodeが増えても新しい
   組み合わせを追加するだけでよい。

   generate.pyの座標算出(WIDTH=260, HEIGHT=145のキャンバス基準)をそのまま
   %に変換してある。ロジックの対応関係:
   - make_one            → ICON_LAYOUT.single
   - make_two (mod=="tr" のときの d=0 の大きめレイアウト)
                         → ICON_LAYOUT.trTarget / trBase
   - make_two (mod!="tr" のときの d=HEIGHT//8 の縮小・右上寄せレイアウト。
     "st"/"te"だけでなく"trst"/"trte"もこちら側に入る点はgenerate.py通り)
                         → ICON_LAYOUT.cornerTarget / cornerBase
   - draw_modifier(mod=="tr"のときだけ、のち矢印を重ねる)
                         → ICON_LAYOUT.trArrow
   PILのcomposite()は後から描いた画像が上に乗るため、DOM上の描画順も
   target→base→(のち矢印) の順にして同じ重なりにしている。 */

// codes.json (ciscorn/jma-weather-images) から、このアプリが実際に使う
// weathercodeの分だけ抜き出したもの。b=ベースアイコン、m=修飾子
// (tr=のち, st=時々, te=一時, trst/trte=のち+時々/一時), t=対象アイコン。
const WEATHER_ICON_SPEC = {
  "100": { b: "sun" }, "101": { b: "sun", m: "st", t: "cloud" },
  "102": { b: "sun", m: "te", t: "rain" }, "103": { b: "sun", m: "st", t: "rain" },
  "104": { b: "sun", m: "te", t: "snow" }, "105": { b: "sun", m: "st", t: "snow" },
  "106": { b: "sun", m: "te", t: "rain_or_snow" }, "107": { b: "sun", m: "st", t: "rain_or_snow" },
  "108": { b: "sun", m: "te", t: "rain_thunder" }, "110": { b: "sun", m: "trst", t: "cloud" },
  "111": { b: "sun", m: "tr", t: "cloud" }, "112": { b: "sun", m: "trst", t: "rain" },
  "113": { b: "sun", m: "trte", t: "rain" }, "114": { b: "sun", m: "tr", t: "rain" },
  "115": { b: "sun", m: "trte", t: "snow" }, "116": { b: "sun", m: "trst", t: "snow" },
  "117": { b: "sun", m: "tr", t: "snow" }, "118": { b: "sun", m: "tr", t: "rain_or_snow" },
  "119": { b: "sun", m: "tr", t: "rain_thunder" }, "120": { b: "sun", m: "te", t: "rain" },
  "121": { b: "sun", m: "te", t: "rain" }, "122": { b: "sun", m: "te", t: "rain" },
  "123": { b: "sun" }, "124": { b: "sun" },
  "125": { b: "sun", m: "tr", t: "rain_thunder" }, "126": { b: "sun", m: "tr", t: "rain" },
  "127": { b: "sun", m: "tr", t: "rain" }, "128": { b: "sun", m: "tr", t: "rain" },
  "130": { b: "mist", m: "tr", t: "sun" }, "131": { b: "sun", m: "tr", t: "mist" },
  "132": { b: "sun", m: "st", t: "cloud" }, "140": { b: "sun", m: "st", t: "rain_thunder" },
  "160": { b: "sun", m: "te", t: "snow_or_rain" }, "170": { b: "sun", m: "st", t: "snow_or_rain" },
  "181": { b: "sun", m: "tr", t: "snow_or_rain" },
  "200": { b: "cloud" }, "201": { b: "cloud", m: "st", t: "sun" },
  "202": { b: "cloud", m: "te", t: "rain" }, "204": { b: "cloud", m: "te", t: "snow" },
  "209": { b: "mist" }, "210": { b: "cloud", m: "trst", t: "sun" },
  "212": { b: "cloud", m: "trte", t: "rain" }, "215": { b: "cloud", m: "trte", t: "snow" },
  "300": { b: "rain" }, "301": { b: "rain", m: "st", t: "sun" },
  "302": { b: "rain", m: "st", t: "cloud" }, "303": { b: "rain", m: "st", t: "snow" },
  "308": { b: "rain_wind" },
  "311": { b: "rain", m: "tr", t: "sun" }, "313": { b: "rain", m: "tr", t: "cloud" },
  "314": { b: "rain", m: "trst", t: "snow" },
  "400": { b: "snow" }, "401": { b: "snow", m: "st", t: "sun" },
  "402": { b: "snow", m: "st", t: "cloud" }, "403": { b: "snow", m: "st", t: "rain" },
  "406": { b: "snow_wind" },
  "411": { b: "snow", m: "tr", t: "sun" }, "413": { b: "snow", m: "tr", t: "cloud" },
  "414": { b: "snow", m: "tr", t: "rain" },
};

// codes.jsonの意味的なキー(rain_or_snowなど)→実ファイル名。generate.pyの
// BASE_IMAGESで複数のキーが同じ画像ファイルを指しているのに合わせてある。
const WEATHER_ICON_FILE = {
  sun: "sun", cloud: "cloud", rain: "rain", snow: "snow", mist: "mist",
  rain_thunder: "rain_thunder", snow_thunder: "snow_thunder",
  rain_heavy: "rain_heavy", snow_heavy: "snow_heavy",
  rain_wind: "rain_wind", snow_wind: "snow_wind", rain_heavy_wind: "rain_heavy_wind",
  rain_or_snow: "rain_and_snow", snow_or_rain: "rain_and_snow", rain_and_snow: "rain_and_snow",
  night_fair: "fair_night", tr: "tr",
};

function weatherIconAssetUrl(name) {
  const file = WEATHER_ICON_FILE[name] || name;
  return `${import.meta.env.BASE_URL}srcimgs_refs/${file}.svg`;
}

// generate.pyのWIDTH=260, HEIGHT=145キャンバス上の座標・サイズを%に変換。
const ICON_LAYOUT = {
  single:       { left: (57 / 260) * 100, top: 0, width: (145 / 260) * 100, height: 100 },
  trTarget:     { left: (115 / 260) * 100, top: 0, width: (145 / 260) * 100, height: 100 },
  trBase:       { left: 0, top: 0, width: (145 / 260) * 100, height: 100 },
  trArrow:      { left: (57 / 260) * 100, top: 0, width: (145 / 260) * 100, height: 100 },
  cornerTarget: { left: (124 / 260) * 100, top: (18 / 145) * 100, width: (109 / 260) * 100, height: (109 / 145) * 100 },
  cornerBase:   { left: (27 / 260) * 100, top: 0, width: (145 / 260) * 100, height: 100 },
};

function WeatherIconLayer({ name, layout }) {
  if (!name) return null;
  return (
    <img
      src={weatherIconAssetUrl(name)}
      alt=""
      style={{
        position: "absolute",
        left: `${layout.left}%`, top: `${layout.top}%`,
        width: `${layout.width}%`, height: `${layout.height}%`,
        objectFit: "contain",
      }}
    />
  );
}

// WIDTH:HEIGHT = 260:145 のキャンバス比率(部品アイコンの配置がこの比率を
// 前提にしているため、正方形に押し込めると位置がずれる)。
const WEATHER_ICON_ASPECT = 260 / 145;

function WeatherIcon({ code, size = 68, alt = "", style }) {
  const spec = WEATHER_ICON_SPEC[String(code)] || WEATHER_ICON_SPEC["200"];
  const height = size;
  const width = Math.round(size * WEATHER_ICON_ASPECT);

  let content;
  if (spec.t) {
    // generate.pyのmake_two: mod=="tr"(完全一致)のときだけ「大きい二枚を
    // 並べて、のち矢印を重ねる」レイアウトになり、st/te/trst/trteはすべて
    // 「ベースを大きく、対象を右上に小さく」のレイアウトになる。
    const isTr = spec.m === "tr";
    const targetLayout = isTr ? ICON_LAYOUT.trTarget : ICON_LAYOUT.cornerTarget;
    const baseLayout = isTr ? ICON_LAYOUT.trBase : ICON_LAYOUT.cornerBase;
    content = (
      <>
        <WeatherIconLayer name={spec.t} layout={targetLayout} />
        <WeatherIconLayer name={spec.b} layout={baseLayout} />
        {isTr && <WeatherIconLayer name="tr" layout={ICON_LAYOUT.trArrow} />}
      </>
    );
  } else {
    content = <WeatherIconLayer name={spec.b} layout={ICON_LAYOUT.single} />;
  }

  return (
    <div
      role="img"
      aria-label={alt}
      style={{ position: "relative", width, height, flexShrink: 0, ...style }}
    >
      {content}
    </div>
  );
}
// 地域時系列予報(VPFD)は天気をweatherCodesではなく「くもり」「雨」のような短い
// テキストでしか返さない。3時間ごとの1コマにつき単一の天気語(「時々」「後」の
// ような複合表現は含まない)なので、キーワードを含むかどうかの単純な判定で
// weatherCode(100/200/300/400系)に割り当て、既存のweatherIconUrlでアイコン化する。
// 気になる点の優先順位は雷>雪>雨>霧>曇>晴(荒天要素を優先して見せる)。
function weatherTextToCode(text) {
  if (!text) return null;
  if (text.includes("雷")) return "300";
  if (text.includes("雪") || text.includes("あられ") || text.includes("ひょう")) return "400";
  if (text.includes("雨")) return "300";
  if (text.includes("霧")) return "200";
  if (text.includes("曇") || text.includes("くもり")) return "200";
  if (text.includes("晴")) return "100";
  return null;
}
const FORECAST_WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];
// timeDefines(例: "2026-08-04T00:00:00+09:00")を"8/4(火)"のような短い表示に変換する。
function formatForecastDayLabel(iso, index) {
  if (index === 0) return "今日";
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}(${FORECAST_WEEKDAY_JA[d.getDay()]})`;
}
// 地域時系列予報(3時間ごと)の時刻ラベル。日付が変わる最初のコマだけ「M/D」を
// 添える(それ以外は「時」だけで十分読める)。
function formatTimeSeriesHour(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getHours()}時`;
}
function formatTimeSeriesDateChanged(iso, prevIso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  if (!prevIso) return true;
  const prev = new Date(prevIso);
  return d.getDate() !== prev.getDate();
}

// 16方位の日本語表記(地域時系列予報のwind.direction)→北を0度とした角度。
const WIND_DIRECTION_DEGREES = {
  "北": 0, "北北東": 22.5, "北東": 45, "東北東": 67.5,
  "東": 90, "東南東": 112.5, "南東": 135, "南南東": 157.5,
  "南": 180, "南南西": 202.5, "南西": 225, "西南西": 247.5,
  "西": 270, "西北西": 292.5, "北西": 315, "北北西": 337.5,
};
function windDirectionToDegrees(direction) {
  return WIND_DIRECTION_DEGREES[direction] ?? 0;
}

// forecast.json(office単位)から、指定class10Code(天気・降水確率用)・
// amedasCode(気温用)に対応する「今日の天気予報」をまとめて取り出す。
// forecast.jsonは [0]=今日・明日の短期予報, [1]=週間予報 の2要素配列。
function extractTodayForecast(forecastJson, class10Code, amedasCode) {
  if (!Array.isArray(forecastJson) || forecastJson.length === 0) return null;
  const shortTerm = forecastJson[0];
  const weekly = forecastJson[1];

  let weatherCode = null;
  let areaName = null;
  const weatherSeries = shortTerm?.timeSeries?.[0];
  if (weatherSeries) {
    const area = weatherSeries.areas?.find(a => a.area?.code === class10Code);
    if (area?.weatherCodes?.[0]) {
      weatherCode = area.weatherCodes[0];
      areaName = area.area?.name || null;
    }
  }
  if (weatherCode == null && weekly?.timeSeries?.[0]) {
    const area = weekly.timeSeries[0].areas?.find(a => a.area?.code === class10Code);
    if (area?.weatherCodes?.[0]) {
      weatherCode = area.weatherCodes[0];
      areaName = area.area?.name || areaName;
    }
  }

  // 降水確率(短期予報のtimeSeries[1]、6時間ごと。今日時点でまだ発表されていない
  // コマは空文字が入っているため、最初に値が入っているものを代表値として使う)。
  let pop = null;
  const popSeries = shortTerm?.timeSeries?.[1];
  if (popSeries) {
    const area = popSeries.areas?.find(a => a.area?.code === class10Code);
    const p = area?.pops?.find(v => v !== "");
    if (p != null) pop = Number(p);
  }

  // 気温(週間予報のtimeSeries[1]、アメダス単位。今日の最高・最低)。
  let tempMin = null, tempMax = null;
  const weeklyTempSeries = weekly?.timeSeries?.[1];
  if (weeklyTempSeries) {
    const area = weeklyTempSeries.areas?.find(a => a.area?.code === amedasCode);
    if (area) {
      if (area.tempsMin?.[0]) tempMin = Number(area.tempsMin[0]);
      if (area.tempsMax?.[0]) tempMax = Number(area.tempsMax[0]);
    }
  }
  // 週間予報にまだ無ければ、短期予報のtimeSeries[2](当日〜翌日の気温)から拾う。
  if ((tempMin == null || tempMax == null) && shortTerm?.timeSeries?.[2]) {
    const area = shortTerm.timeSeries[2].areas?.find(a => a.area?.code === amedasCode);
    if (area?.temps) {
      const nums = area.temps.filter(v => v !== "").map(Number);
      if (nums.length) {
        if (tempMin == null) tempMin = Math.min(...nums);
        if (tempMax == null) tempMax = Math.max(...nums);
      }
    }
  }

  if (weatherCode == null && pop == null && tempMin == null && tempMax == null) return null;
  return {
    areaName,
    weatherCode,
    telop: weatherCode != null ? weatherTelop(weatherCode) : null,
    pop, tempMin, tempMax,
  };
}

// 週間予報(forecastJson[1])から、1日ごとの{日付・天気・降水確率・最高/最低気温}の
// 配列を作る(index 0=今日 〜 6=1週間後、最大7日分)。3日間表示・週間表示どちらも
// この配列をスライスするだけで作れる。天気・降水確率はclass10Code、気温はamedasCode
// で該当エリアを探す(extractTodayForecastと同じ考え方)。
function extractDailyForecasts(forecastJson, class10Code, amedasCode) {
  if (!Array.isArray(forecastJson) || forecastJson.length < 2) return [];
  const weekly = forecastJson[1];
  const weatherSeries = weekly?.timeSeries?.[0];
  if (!weatherSeries || !weatherSeries.areas || weatherSeries.areas.length === 0) return [];
  // 週間予報は、短期予報と同じ一次細分区域(class10s)コードでは無く、それより
  // 粗い単位(離島などで複数のclass10sをまとめた区域)で発表されることがある。
  // その場合はcodeが完全一致せず該当なし(=天気・気温が全部空欄)になってしまう
  // ため、一致しなければその予報区の代表区域(areas[0])にフォールバックする。
  // 気温側(amedasコード)も同様。
  const weatherArea = weatherSeries.areas.find(a => a.area?.code === class10Code) || weatherSeries.areas[0];
  const tempSeries = weekly?.timeSeries?.[1];
  const tempArea = tempSeries?.areas?.find(a => a.area?.code === amedasCode) || tempSeries?.areas?.[0] || null;
  const timeDefines = weatherSeries.timeDefines || [];

  return timeDefines.map((date, i) => {
    const codeRaw = weatherArea?.weatherCodes?.[i];
    const weatherCode = codeRaw && codeRaw !== "" ? codeRaw : null;
    const popRaw = weatherArea?.pops?.[i];
    const pop = popRaw && popRaw !== "" ? Number(popRaw) : null;
    const minRaw = tempArea?.tempsMin?.[i];
    const maxRaw = tempArea?.tempsMax?.[i];
    return {
      date,
      weatherCode,
      telop: weatherCode != null ? weatherTelop(weatherCode) : null,
      pop,
      tempMin: minRaw && minRaw !== "" ? Number(minRaw) : null,
      tempMax: maxRaw && maxRaw !== "" ? Number(maxRaw) : null,
    };
  });
}

// 緯度経度→今日の天気予報、までを一気通貫でまとめて行う。
async function fetchCurrentLocationForecast(lat, lon) {
  const resolved = await resolveForecastLocation(lat, lon);
  if (!resolved) throw new Error("最寄りの予報地点を特定できませんでした");

  let result;
  try {
    result = await fetchForecastForResolvedLocation(resolved);
  } catch (err) {
    // 市区町村の行政区分から解決したofficeCode/class10Codeで取得・解析できな
    // かった場合(奄美市など、行政区分の階層とforecast.json側の区域コードの
    // 対応がうまく取れない離島地域で起こりうる)、行政区分を無視して「単純に
    // 一番近いアメダス観測点」から素直に求め直すフォールバックを1回だけ試す。
    console.warn("行政区分ベースの予報取得に失敗。距離ベースの推定に切り替えます:", err);
    const fallbackResolved = await resolveForecastLocation(lat, lon, { ignoreMunicipality: true });
    if (!fallbackResolved) throw err;
    result = await fetchForecastForResolvedLocation(fallbackResolved);
  }
  return result;
}

async function fetchForecastForResolvedLocation(resolved) {
  const res = await fetch(forecastDataUrl(resolveForecastFetchOfficeCode(resolved.officeCode)));
  if (!res.ok) throw new Error(`天気予報の取得に失敗(HTTP ${res.status})`);
  const json = await res.json();
  const forecast = extractTodayForecast(json, resolved.class10Code, resolved.amedasCode);
  const daily = extractDailyForecasts(json, resolved.class10Code, resolved.amedasCode);
  if (!forecast && daily.length === 0) throw new Error("天気予報データを解析できませんでした");
  // 週間予報の1日目(今日)は6時間ごとの詳しい値を持つ短期予報側の値で上書きする
  // (降水確率・気温の精度が高いため)。
  if (daily.length > 0 && forecast) {
    daily[0] = {
      ...daily[0],
      weatherCode: forecast.weatherCode ?? daily[0].weatherCode,
      telop: forecast.telop ?? daily[0].telop,
      pop: forecast.pop ?? daily[0].pop,
      tempMin: forecast.tempMin ?? daily[0].tempMin,
      tempMax: forecast.tempMax ?? daily[0].tempMax,
    };
  }
  return {
    ...(forecast || daily[0] || {}),
    areaName: forecast?.areaName || resolved.stationName,
    stationName: resolved.stationName,
    officeCode: resolved.officeCode,
    class10Code: resolved.class10Code,
    daily,
  };
}

// 地域時系列予報(3時間ごとの天気・風、気温)。天気予報ページ下部の「地域時系列
// 予報を見る」に対応するjmatile版データで、一次細分区域(class10s)コード単位。
// 参考: https://qiita.com/tenpoul/items/f9e026597fcf8405680f
function areaTimeSeriesUrl(class10Code) {
  return `https://www.jma.go.jp/bosai/jmatile/data/wdist/VPFD/${class10Code}.json`;
}
// areaTimeSeries(天気・風、3時間ごと)とpointTimeSeries(気温、代表地点の1時間毎+
// 別立ての最高/最低)は、時刻の刻み方も配列の長さも違う。dateTime文字列をキーに
// 突き合わせて、時刻ごとに{天気・風・気温}をまとめた1本の配列にする。
function parseAreaTimeSeries(json) {
  const area = json?.areaTimeSeries;
  if (!area?.timeDefines) return [];
  const tempByTime = {};
  const point = json?.pointTimeSeries;
  if (point?.timeDefines) {
    point.timeDefines.forEach((td, i) => {
      const raw = point.temperature?.[i];
      tempByTime[td.dateTime] = raw != null && raw !== "" ? Number(raw) : null;
    });
  }
  return area.timeDefines.map((td, i) => {
    const weather = area.weather?.[i] || null;
    return {
      dateTime: td.dateTime,
      weather,
      weatherCode: weatherTextToCode(weather),
      wind: area.wind?.[i] || null,
      temperature: tempByTime[td.dateTime] ?? null,
    };
  });
}
async function fetchAreaTimeSeries(class10Code) {
  const res = await fetch(areaTimeSeriesUrl(class10Code));
  if (!res.ok) throw new Error(`地域時系列予報の取得に失敗(HTTP ${res.status})`);
  const json = await res.json();
  const entries = parseAreaTimeSeries(json);
  return { entries, pointName: json?.pointTimeSeries?.pointNameJP || null };
}

async function fetchTideStations() {
  const res = await fetch(TIDE_AREA_URL);
  if (!res.ok) throw new Error(`潮位観測点一覧の取得に失敗(HTTP ${res.status})`);
  const data = await res.json();
  const stations = [];
  Object.values(data || {}).forEach(class20 => {
    (class20.class30s || []).forEach(class30 => {
      (class30.stations || []).forEach(st => {
        if (st.lat == null || st.lon == null) return;
        stations.push({
          code: st.code,
          name: st.name,
          typeName: st.typeName,
          addr: st.addr,
          reference: st.reference,
          max: st.max || null,
          level4: class30.standard?.level4 ?? null,
          level5: class30.standard?.level5 ?? null,
          areaName: class20.name,
          class20Code: st.parents?.class20 ?? null,
          class30Code: st.parents?.class30 ?? null,
          lat: st.lat,
          lon: st.lon,
        });
      });
    });
  });
  return stations;
}

// 指定地点・指定日の観測値(15秒間隔のtide/departure配列)を取得する。
// dateStrはYYYYMMDD形式(toTideDateStr参照)。
async function fetchTideObs(dateStr, stationCode) {
  const res = await fetch(tideObsUrl(dateStr, stationCode));
  if (!res.ok) throw new Error(`潮位観測値の取得に失敗(HTTP ${res.status})`);
  return res.json();
}

// startDateの暦日〜endDateの暦日までの日数(両端含む)。月またぎ・時刻差は無視して
// 「YYYYMMDDが何日分あるか」だけを見る(fetchTideObsRangeのdaysにそのまま渡す用)。
function daysBetweenDates(startDate, endDate) {
  const s = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const e = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000) + 1);
}

// 指定地点について、当日を含む直近N日分(デフォルト2日=前日+当日)の観測値を取得し、
// 1本の連続した配列に結合する。日をまたぐ津波でも0時で表示が途切れないようにするため。
// 前日ファイルが欠測/取得失敗の場合は、当日から遡って「連続して取得できた分」だけを
// 採用する(=当日分さえ取れれば、以前と同じ1日分の挙動にフォールバックする)。
async function fetchTideObsRange(stationCode, days = 2) {
  const today = new Date();
  const dateStrs = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dateStrs.push(toTideDateStr(d));
  }
  const settled = await Promise.allSettled(dateStrs.map(ds => fetchTideObs(ds, stationCode)));

  const ordered = [];
  for (let i = settled.length - 1; i >= 0; i--) {
    if (settled[i].status !== "fulfilled") break; // 途切れた時点で遡るのをやめる(古い日だけ欠測でもOK)
    ordered.unshift(settled[i].value);
  }
  if (ordered.length === 0) throw new Error("潮位観測値の取得に失敗");

  return {
    ...ordered[ordered.length - 1], // interval等のメタ情報は当日分を踏襲
    time: ordered[0].time,          // 一番古い日の開始時刻を全体の起点にする
    tide: ordered.flatMap(d => Array.isArray(d.tide) ? d.tide : []),
    departure: ordered.flatMap(d => Array.isArray(d.departure) ? d.departure : []),
  };
}

// startDate〜endDateの暦日(両端含む)について、1地点分の観測値を1日ずつ取得し、
// 1本の配列に結合する。fetchTideObsRangeは「当日を含む直近N日」専用(常に今日を
// 終端にする)なので、過去の津波情報(履歴)を選んで見る時のために、任意の過去の
// 期間を扱えるこちらを別途用意する。取得できなかった日(欠測・レート制限等)は
// 読み飛ばし、取得できた日だけを時系列順に繋げる(最大波さえ拾えれば十分なため、
// fetchTideObsRangeのように欠測で即座に打ち切ることはしない)。
async function fetchTideObsForDateRange(stationCode, startDate, endDate) {
  const dateStrs = [];
  const cur = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const last = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  while (cur.getTime() <= last.getTime()) {
    dateStrs.push(toTideDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  const settled = await Promise.allSettled(dateStrs.map(ds => fetchTideObs(ds, stationCode)));
  const ordered = settled.filter(s => s.status === "fulfilled").map(s => s.value);
  if (ordered.length === 0) throw new Error("潮位観測値の取得に失敗");

  return {
    ...ordered[ordered.length - 1],
    time: ordered[0].time,
    tide: ordered.flatMap(d => Array.isArray(d.tide) ? d.tide : []),
    departure: ordered.flatMap(d => Array.isArray(d.departure) ? d.departure : []),
  };
}

// 観測された津波の高さ(推定)を、潮位観測データから計算する。
// 気象庁の解説(https://www.jma.go.jp/jma/kishou/know/jishin/joho/tsunamiinfo.html)の
// 「津波観測に関する情報」が示す考え方どおり、潮位の実測値から天文潮位(推算潮位)を
// 差し引いた値が津波による海面変動の高さにあたる。この値はtide_obsのdeparture配列に
// そのまま「潮位偏差」として入っている(このアプリのTideStationDetailで表示している
// ものと同じ値)ため、追加の逆算はせずdepartureをそのまま使う。
// startMs以降(=警報等の発表時刻以降)で、潮位偏差が正の値(山=海面上昇側)のうち
// 最大のものを返す。引き波による谷(負の値)は津波の「高さ」としては扱わない。
// データの終端は「取得できている最新時点まで」が自動的に上限になるため、終了時刻を
// 別途指定する必要はない。該当データ(正の値)が無ければnull。
function computeMaxTsunamiHeightCm(obsData, startMs) {
  if (!obsData || !Array.isArray(obsData.departure) || !obsData.time) return null;
  const dayStartMs = new Date(obsData.time).getTime();
  if (!Number.isFinite(dayStartMs) || !Number.isFinite(startMs)) return null;
  const intervalMs = (obsData.interval || 15) * 1000;
  let max = -Infinity;
  let timeMsAtMax = null;
  obsData.departure.forEach((v, i) => {
    if (v == null || v <= 0) return; // 正の値(山)のみを対象にする
    const t = dayStartMs + i * intervalMs;
    if (t < startMs) return; // 警報発表より前の値は対象外
    if (v > max) { max = v; timeMsAtMax = t; }
  });
  if (timeMsAtMax == null) return null;
  return { cm: max, timeMs: timeMsAtMax }; // cm(常に正の値)・観測時刻(エポックms)。該当データが1件も無ければnull
}


function useEqdbEpicenterPoints(rawList) {
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    function rebuildFromCache() {
      const next = [];
      for (const item of rawList || []) {
        const detail = eqdbEventDetailCache.get(item.id);
        const point = detail ? eqdbDetailToEpicenterPoint(detail, item) : null;
        if (point) next.push(point);
      }
      if (!cancelled) setPoints(next);
    }

    rebuildFromCache(); // まずキャッシュ済みの分だけ即座に反映する

    const total = (rawList || []).length;
    if (total === 0) {
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true);

    let nextIndex = 0;
    let completed = 0;
    async function worker() {
      while (!cancelled) {
        const i = nextIndex++;
        if (i >= total) return;
        const item = rawList[i];
        if (!eqdbEventDetailCache.has(item.id)) {
          try {
            await fetchEqdbEventCached(item.id);
          } catch (err) {
            // この1件は諦めて次へ(震央分布は「取れた分だけ表示」でよいため)
          }
          if (cancelled) return;
          rebuildFromCache();
        }
        completed++;
        if (!cancelled && completed >= total) setLoading(false);
      }
    }
    const CONCURRENCY = 3;
    for (let i = 0; i < CONCURRENCY; i++) worker();

    return () => { cancelled = true; };
  }, [rawList]);

  return { points, loading };
}

// 点(lat,lon)が、GeoJSONのリング(座標配列 [[lon,lat], ...])の内側にあるかどうかを
// レイキャスティング法で判定する。
function isPointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// 点(lat,lon)が、Polygon/MultiPolygonジオメトリの内側(穴を除く)にあるかどうかを判定する。
function isPointInPolygonGeometry(lat, lon, geometry) {
  if (!geometry) return false;
  const testRings = (rings) => {
    if (!rings.length || !isPointInRing(lat, lon, rings[0])) return false;
    for (let k = 1; k < rings.length; k++) {
      if (isPointInRing(lat, lon, rings[k])) return false; // 穴の内側
    }
    return true;
  };
  if (geometry.type === "Polygon") return testRings(geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some(testRings);
  return false;
}

// 細分区域(areasGeoJSON=細分区域.json)のポリゴンを実際に走査し、点(lat,lon)を
// 含む区域のcode(properties.code)を返す。名前によるあいまい照合と違い、
// 区域境界そのものに基づく判定なので、表記揺れや同名地点による誤判定が起きない。
function findAreaCodeByPoint(areasGeoJSON, lat, lon) {
  if (!areasGeoJSON || !Array.isArray(areasGeoJSON.features) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const feature of areasGeoJSON.features) {
    if (isPointInPolygonGeometry(lat, lon, feature.geometry)) {
      return feature.properties?.code ?? null;
    }
  }
  return null;
}

// 緊急地震速報のareas[].name(例:「神奈川県東部」「東京都２３区」)から、
// 細分区域.json(areasGeoJSON)側で同じ名前を持つfeatureのcode一覧を返す。
// EEWの地域名は気象庁の細分区域名と表記が一致することが多いため、まず完全一致を
// 試し、見つからなければ全角数字→半角などのゆらぎを吸収して再試行する。
// 該当が無ければ(=地図側に該当ポリゴンが見つからなければ)空配列を返し、
// その地域の塗りつぶしはあきらめる(誤った区域を塗るよりは安全)。
function normalizeAreaNameForMatch(name) {
  if (!name) return "";
  // 全角数字を半角に変換してから比較する(「２３区」→「23区」)
  return name.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
}
// 細分区域.jsonのfeatureを地域名で探す(完全一致優先、無ければ表記ゆれを吸収した
// あいまい一致)。同名の区域が複数のポリゴンに分かれていることがあるため、
// 該当するfeatureをすべて返す。
function findAreaFeaturesByName(areasGeoJSON, name) {
  if (!areasGeoJSON || !Array.isArray(areasGeoJSON.features) || !name) return [];
  const exact = areasGeoJSON.features.filter(f => f.properties?.name === name);
  if (exact.length > 0) return exact;
  const normalizedTarget = normalizeAreaNameForMatch(name);
  return areasGeoJSON.features.filter(f => normalizeAreaNameForMatch(f.properties?.name) === normalizedTarget);
}

function findAreaCodesByName(areasGeoJSON, name) {
  return findAreaFeaturesByName(areasGeoJSON, name).map(f => f.properties?.code).filter(c => c != null);
}

// ep.json(気象庁の震央地名区域)のポリゴンを走査し、点(lat,lon)を
// 含む区域の名前(properties.name)を返す。緊急地震速報テスト配信で「地図をタップ
// して震源を指定」した時、タップ地点から震源地名を自動判定するのに使う。
// 該当する区域が無い(海洋の詳細区分に含まれない・データ範囲外など)場合はnull。
function findEpicenterNameByPoint(epicenterNamesGeoJSON, lat, lon) {
  if (!epicenterNamesGeoJSON || !Array.isArray(epicenterNamesGeoJSON.features) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const feature of epicenterNamesGeoJSON.features) {
    if (isPointInPolygonGeometry(lat, lon, feature.geometry)) {
      return feature.properties?.name ?? null;
    }
  }
  return null;
}

// 観測点マスタ(stations)から、eqdbの観測点名(name)に対応する地点を探し、
// 区域コード(area.code)を補完する。
// eqdbは観測点の緯度経度(lat/lon)を直接返してくるため、まずareasGeoJSON(細分区域の
// ポリゴン)に対する点-in-多角形判定で区域を確定させる。これは区域境界そのものに
// 基づく判定なので、観測点名の表記揺れや同名地点があっても誤判定しない。
// (以前は観測点マスタとの名前照合だけで区域を推定しており、名前が一致しない/
//  複数の地点に一致してしまうケースで「区域が塗られない」「違う区域の色が塗られる」
//  ことがあった。)
// areasGeoJSONが無い、または該当ポリゴンが見つからない場合のみ、次点として
// 観測点マスタとの名前照合(ベストエフォート)にフォールバックする:
//   1. 地点名が完全一致
//   2. 見つからなければ、地点名が部分一致(どちらかがどちらかを含む)するもの
//   3. それでも見つからなければ、緯度経度が最も近い観測点を採用する
//      (ただしあまりに離れた地点を誤って採用しないよう、約0.05度以内という上限を設ける)
// 観測点マスタ(stations)から、eqdbの観測点名(name)に最も一致する地点を探す。
// findAreaCodeByStationNameと同じマッチング方針(名前の完全一致→部分一致→
// 緯度経度が最も近い地点、の順)を使うが、区域コードだけでなく都道府県名・
// 市区町村名も一緒に取り出したいため、マッチング処理そのものを共通化している。
//
// 【重要】eqdbの観測点名(例: "苫前町旭＊")は市区町村名から始まり、都道府県名は
// 含まれない(気象庁 震度データベースAPIの実際のレスポンスで確認済み)。
// そのため都道府県は文字列解析では判別できず、緯度経度・地点名を観測点マスタと
// 突き合わせて、マスタ側が持つpref.name(都道府県名)を借りてくる必要がある。
function findBestStationMatch(stations, name, lat, lon) {
  if (!stations || stations.length === 0) return null;

  let candidates = name ? stations.filter(s => s.name === name) : [];

  if (candidates.length === 0 && name) {
    candidates = stations.filter(s =>
      s.name.includes(name) || name.includes(s.name) ||
      (s.city && s.city.name && name.includes(s.city.name))
    );
  }

  let fellBackToAll = false;
  if (candidates.length === 0) {
    if (lat == null || lon == null) return null;
    candidates = stations;
    fellBackToAll = true;
  }

  if (candidates.length === 1) return candidates[0];
  if (lat == null || lon == null) return candidates[0] || null;

  let best = null, bestDist = Infinity;
  for (const c of candidates) {
    const cLat = parseFloat(c.lat), cLon = parseFloat(c.lon);
    if (!Number.isFinite(cLat) || !Number.isFinite(cLon)) continue;
    const dLat = cLat - lat, dLon = cLon - lon;
    const dist = dLat * dLat + dLon * dLon;
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  if (!best) return null;
  if (fellBackToAll) {
    const cLat = parseFloat(best.lat), cLon = parseFloat(best.lon);
    if (Math.abs(cLat - lat) > 0.05 || Math.abs(cLon - lon) > 0.05) return null;
  }
  return best;
}

function findAreaCodeByStationName(stations, name, lat, lon, areasGeoJSON) {
  const byPoint = findAreaCodeByPoint(areasGeoJSON, lat, lon);
  if (byPoint) return byPoint;

  const match = findBestStationMatch(stations, name, lat, lon);
  return match?.area?.code || null;
}

// eqdbの観測点名(name)・緯度経度から、観測点マスタ上の都道府県名・市区町村名を
// 借りてくる。マッチした市区町村名がnameの先頭に含まれていれば、見出しと
// 二重表示にならないようそこを取り除いた残りをaddrとして一緒に返す
// (例: マスタ側city.name="苫前町"、name="苫前町旭＊" → addr="旭＊")。
// マッチしなかった場合はpref/cityともnullとし、addrは元のnameのまま返す。
function resolvePrefCityForEqdbPoint(stations, name, lat, lon) {
  const match = findBestStationMatch(stations, name, lat, lon);
  const pref = match?.pref?.name || null;
  const city = match?.city?.name || null;
  let addr = name;
  if (city && name && name.startsWith(city)) {
    const rest = name.slice(city.length);
    if (rest) addr = rest;
  }
  return { pref, city, addr };
}

// eqdbのmode=eventレスポンスを、アプリ内の「地震カード」共通形式に変換する。
// P2P地震情報由来のカードと違い、resolvedPointsとして緯度経度・震度キーまで
// 解決済みの状態を直接持たせる。selectedQuakePoints側は、resolvedPointsが
// あればそれをそのまま使い、無ければ従来通り観測点マスタで解決する。
function buildEqdbQuakeCard(detail, listItem, stations, areasGeoJSON) {
  const hyp = detail.hyp[0];
  const intPoints = Array.isArray(detail.int) ? detail.int : [];

  // ごく稀に、1つの地震(event)に対して震源が複数記録されていることがある
  // (例: 群発地震をまとめて1件として扱っている場合など)。detail.hypは配列な
  // ので、先頭だけでなく全件を拾って地図上にバツ印を複数表示できるようにする。
  // 代表値(震源地名・M・深さなど)は従来通り先頭(hyp = detail.hyp[0])を使う。
  const hypocenters = detail.hyp
    .map(h => ({ latitude: parseFloat(h.lat), longitude: parseFloat(h.lon) }))
    .filter(h => Number.isFinite(h.latitude) && Number.isFinite(h.longitude));

  const lat = parseFloat(hyp.lat);
  const lon = parseFloat(hyp.lon);
  const mag = parseFloat(hyp.mag);
  const depMatch = (hyp.dep || "").match(/\d+/);
  const depth = depMatch ? parseInt(depMatch[0], 10) : 0;
  const maxScale = eqdbIntensityStringToScale(hyp.maxI || "");

  const resolvedPoints = intPoints.map(pt => {
    const scale = eqdbIntensityStringToScale(pt.int || "");
    if (scale <= 0) return null;
    const pLat = parseFloat(pt.lat), pLon = parseFloat(pt.lon);
    // eqdbは観測点名(pt.name。例: "苫前町旭＊")しか返さず、都道府県名は
    // 含まれない(市区町村名から始まる)。そのため観測点マスタ(stations)と
    // 名前・緯度経度で突き合わせて、マスタ側が持つ都道府県名・市区町村名を
    // 借りてくる(通常のP2P地震情報由来の地点と同じ「都道府県ごとの階層表示」に
    // 乗せられるようにするため)。マスタに見つからなければpref/cityともnullのまま
    // (今まで通り、階層表示では「その他」等の扱いにフォールバックする)。
    const { pref, city, addr } = resolvePrefCityForEqdbPoint(stations, pt.name, pLat, pLon);
    return {
      pref,
      city,
      addr,
      intensityKey: maxScaleToIntensityKey(scale),
      latitude: Number.isFinite(pLat) ? pLat : null,
      longitude: Number.isFinite(pLon) ? pLon : null,
      areaCode: findAreaCodeByStationName(stations, pt.name, pLat, pLon, areasGeoJSON),
    };
  }).filter(Boolean);

  // 1996年10月の震度階級改定(弱/強区分の導入)より前の地震かどうか。
  // 震度7の地震であっても、旧震度階級の期間のものは内部の5・6も区分の無い
  // 「5」「6」のはずなので、凡例側で5弱/5強・6弱/6強を出さないための目印にする。
  const eventDateStr = (listItem?.id || "").slice(0, 8);
  const legacyIntensityScale = eventDateStr.length === 8 && eventDateStr < "19961001";

  return {
    id: `eqdb_${listItem?.id || hyp.name}`,
    time: eqdbIdToTimeDisplay(listItem?.id) || (listItem?.ot || ""),
    place: hyp.name || listItem?.name || "震源地不明",
    maxIntensity: maxScaleToIntensityKey(maxScale),
    legacyIntensityScale,
    isForeign: false,
    isEqdb: true, // 一覧表示で日時を「YYYY/MM/DD」形式にするための目印
    magnitude: Number.isFinite(mag) && mag > 0 ? mag : null,
    depth: Number.isFinite(depth) ? depth : null,
    longPeriod: null,
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lon) ? lon : null,
    hypocenters, // 複数震源対応。地図には1件以上のバツ印として全て表示する。
    points: [],
    resolvedPoints,
    // eqdbには津波情報が含まれないため、津波の心配なし文言をデフォルトにしておく
    domesticTsunami: "None",
    freeFormComment: "気象庁 震度データベースより取得",
  };
}

/* ─────────────────────────────────────────────────────
   発震機構解(CMT解) — 「この地震の詳細」用

   気象庁の発震機構解(精査後)ページ(data.jma.go.jp/eqev/data/mech/cmt/…)は
   正式なJSON APIではなく、月別の一覧HTMLページと、地震ごとの詳細HTMLページから
   なる。fetchでの取得(CORS)自体は実機で確認済み。
   
   1. 対象地震の発生月から一覧ページ(cmtYYYYMM.html)を取得し、時刻・位置が
      近い行を探す(=CMT解が求まっている地震かどうか、どれに対応するかを判別)。
   2. 一致した行の発生時刻から、詳細ページのURL(cmtYYYYMMDDHHMMSS.html)を
      組み立てて取得し、震源球画像・モーメントテンソル・P/T/N軸などの
      詳しい情報を得る。
   ───────────────────────────────────────────────────── */

const CMT_LIST_BASE = "https://www.data.jma.go.jp/eqev/data/mech/cmt/";
const CMT_FIG_BASE = "https://www.data.jma.go.jp/eqev/data/mech/cmt/fig/";

// "33度17.8分N" のような度分表記を10進の度(符号付き)に変換する。
// S(南緯)・W(西経)の場合は負の値にする。
function cmtParseDegMin(str) {
  if (!str) return null;
  const m = String(str).match(/([\d.]+)度([\d.]+)分([NSEW])/);
  if (!m) return null;
  const deg = parseFloat(m[1]) + parseFloat(m[2]) / 60;
  return (m[3] === "S" || m[3] === "W") ? -deg : deg;
}

// "2026-07-09 21:58:58.8" のような気象庁側の時刻文字列(日本時間)を、
// 比較に使えるエポックミリ秒に変換する。
function cmtParseTimeToEpochMs(str) {
  if (!str) return null;
  const m = String(str).trim().match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m.map(Number);
  // 気象庁のページはすべて日本時間(UTC+9)表記のため、UTCとして組み立ててから9時間引く。
  return Date.UTC(y, mo - 1, d, hh, mm, ss) - 9 * 3600 * 1000;
}

// アプリ内の地震オブジェクトが持つ time("YYYY/MM/DD HH:mm[:ss]"、日本時間)を
// 同じくエポックミリ秒に変換する。cmtParseTimeToEpochMsと単位を揃えるための対。
function quakeTimeToEpochMs(timeStr) {
  if (!timeStr) return null;
  const m = String(timeStr).trim().match(/(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const hh = Number(m[4]), mm = Number(m[5]), ss = m[6] ? Number(m[6]) : 0;
  return Date.UTC(y, mo - 1, d, hh, mm, ss) - 9 * 3600 * 1000;
}

// 発生時刻(気象庁ページの文字列)から、詳細ページのURLに使うタイムスタンプ
// (YYYYMMDDHHMMSS)を組み立てる。
function cmtTimeToUrlStamp(str) {
  const m = String(str).trim().match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return m[1] + m[2] + m[3] + m[4] + m[5] + m[6];
}

// 月別一覧ページ(cmtYYYYMM.html)を取得し、行ごとに構造化データへ変換する。
// 同じ月内で複数回この一覧が必要になることがあるため、簡単なメモ化キャッシュを持つ。
const cmtMonthCache = new Map(); // "YYYYMM" -> Promise<rows>

function fetchCmtMonthList(yyyymm) {
  if (cmtMonthCache.has(yyyymm)) return cmtMonthCache.get(yyyymm);

  const promise = (async () => {
    const res = await fetch(`${CMT_LIST_BASE}cmt${yyyymm}.html`);
    if (!res.ok) throw new Error(`CMT一覧の取得に失敗しました(status ${res.status})`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const rows = [...doc.querySelectorAll("table tr")];

    const out = [];
    for (const tr of rows) {
      const cells = [...tr.querySelectorAll("td")].map(td => td.textContent.trim());
      // データ行は14列(発生時刻,緯度,経度,深さ,M,震央地域名,Mw,走向1,傾斜1,すべり角1,走向2,傾斜2,すべり角2,詳細)。
      // ヘッダー行(列数が違う・数値が入っていない)はここで自然に弾かれる。
      if (cells.length < 13) continue;
      const timeMs = cmtParseTimeToEpochMs(cells[0]);
      if (timeMs == null) continue;
      const lat = cmtParseDegMin(cells[1]);
      const lon = cmtParseDegMin(cells[2]);
      const depthMatch = cells[3].match(/\d+/);
      out.push({
        timeStr: cells[0],
        timeMs,
        lat, lon,
        depth: depthMatch ? parseInt(depthMatch[0], 10) : null,
        magnitude: parseFloat(cells[4]) || null,
        place: cells[5] || "",
        mw: parseFloat(cells[6]) || null,
        plane1: { strike: cells[7], dip: cells[8], rake: cells[9] },
        plane2: { strike: cells[10], dip: cells[11], rake: cells[12] },
        detailUrlStamp: cmtTimeToUrlStamp(cells[0]),
      });
    }
    return out;
  })();

  cmtMonthCache.set(yyyymm, promise);
  // 失敗した月はキャッシュに残さない(一時的なネットワーク障害等で、以後ずっと
  // 失敗扱いのままになるのを防ぐ)。
  promise.catch(() => cmtMonthCache.delete(yyyymm));
  return promise;
}

// 対象の地震(time・緯度経度)に最も近いCMT解の行を探す。
// 発生時刻が近い(±3分以内)ことを必須とし、その中で最も時刻が近いものを採用する
// (連続発生時に別の地震を誤って拾わないよう、念のため緯度経度も大きく離れて
//  いないか確認する)。
const CMT_MATCH_TOLERANCE_MS = 3 * 60 * 1000;
const CMT_MATCH_MAX_DEGREES = 2.0;

async function findCmtMatchForQuake(quake) {
  const quakeMs = quakeTimeToEpochMs(quake.time);
  if (quakeMs == null) return null;

  const d = new Date(quakeMs);
  // 発生時刻が月初め近くの場合、CMT解の一覧側は「発生時刻」(=同じ日本時間)なので
  // 基本的には地震自身と同じ月の一覧に載っているはずだが、念のため前月分も
  // 候補に含めておく(月境界をまたぐタイミングのずれ対策)。
  const yyyymmThis = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const prevMonthDate = new Date(quakeMs - 24 * 3600 * 1000);
  const yyyymmPrev = `${prevMonthDate.getUTCFullYear()}${String(prevMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
  const monthKeys = yyyymmThis === yyyymmPrev ? [yyyymmThis] : [yyyymmThis, yyyymmPrev];

  let candidates = [];
  for (const key of monthKeys) {
    try {
      const rows = await fetchCmtMonthList(key);
      candidates = candidates.concat(rows);
    } catch {
      // その月の一覧が取れなくても、もう片方の月で見つかる可能性があるので続行する。
    }
  }

  let best = null, bestDiff = Infinity;
  for (const row of candidates) {
    const diff = Math.abs(row.timeMs - quakeMs);
    if (diff > CMT_MATCH_TOLERANCE_MS) continue;
    if (quake.latitude != null && quake.longitude != null && row.lat != null && row.lon != null) {
      const dist = Math.abs(row.lat - quake.latitude) + Math.abs(row.lon - quake.longitude);
      if (dist > CMT_MATCH_MAX_DEGREES) continue;
    }
    if (diff < bestDiff) { bestDiff = diff; best = row; }
  }
  return best;
}

// 地震ごとの詳細ページ(cmtYYYYMMDDHHMMSS.html)を取得し、震源球画像や
// モーメントテンソル・発震機構解(P/T/N軸込み)・観測点数などを取り出す。
async function fetchCmtDetail(detailUrlStamp) {
  const url = `${CMT_FIG_BASE}cmt${detailUrlStamp}.html`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CMT詳細の取得に失敗しました(status ${res.status})`);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  // ページ内には複数の<table>があり、順番は固定(見出し文言で対応するテーブルを探す)。
  // h2見出しの直後の最初のtableを、その見出しのテーブルとみなす。
  function tableAfterHeading(keyword) {
    const heading = [...doc.querySelectorAll("h2")].find(h => h.textContent.includes(keyword));
    if (!heading) return null;
    let el = heading.nextElementSibling;
    while (el && el.tagName !== "TABLE") el = el.nextElementSibling;
    return el;
  }
  function rowCells(table, rowIndex) {
    if (!table) return [];
    const trs = table.querySelectorAll("tr");
    const tr = trs[rowIndex];
    if (!tr) return [];
    return [...tr.querySelectorAll("td,th")].map(c => c.textContent.trim());
  }

  const hypoTable = tableAfterHeading("地震発生時刻と震源位置");
  const hypo = rowCells(hypoTable, 1); // [発生時刻, 緯度, 経度, 深さ, M]

  const centroidTable = tableAfterHeading("セントロイド時刻");
  const centroid = rowCells(centroidTable, 1); // [セントロイド時刻, 緯度, 経度, 深さ, Mw]

  const mechTable = tableAfterHeading("発震機構解");
  const plane1Row = rowCells(mechTable, 1); // [断層面解1, 走向, 傾斜, すべり角, 方位, P軸方位, T軸方位, N軸方位]
  const plane2Row = rowCells(mechTable, 2); // [断層面解2, 走向, 傾斜, すべり角, 傾斜, P軸傾斜, T軸傾斜, N軸傾斜]

  const stationTable = tableAfterHeading("使用観測点数");
  const stationRow = rowCells(stationTable, 0);

  // 画像(震源球・周辺のCMT解)。<img>タグで直接読み込むだけなのでCORSの影響を受けない。
  // ページ内のsrc属性は相対パス("cmt....png"など)で書かれていることがあるため、
  // 文字列にパスが含まれているかで絞り込む前に、必ずURLを絶対パスへ解決してから
  // 判定する(でないと相対パスの画像を取りこぼす)。
  const images = [...doc.querySelectorAll("img")]
    .map(img => img.getAttribute("src"))
    .filter(Boolean)
    .map(src => new URL(src, url).href)
    .filter(src => !src.includes("jma.go.jp/jma/com/images/")); // 気象庁ロゴなど共通画像を除外
  const beachballImg = images.find(src => !/map/i.test(src)) || null;
  const surroundingMapImg = images.find(src => /map/i.test(src)) || null;

  return {
    sourceUrl: url,
    hypo: {
      time: hypo[0] || null, lat: hypo[1] || null, lon: hypo[2] || null,
      depth: hypo[3] || null, magnitude: hypo[4] || null,
    },
    centroid: {
      time: centroid[0] || null, lat: centroid[1] || null, lon: centroid[2] || null,
      depth: centroid[3] || null, mw: centroid[4] || null,
    },
    plane1: { strike: plane1Row[1] || null, dip: plane1Row[2] || null, rake: plane1Row[3] || null },
    plane2: { strike: plane2Row[1] || null, dip: plane2Row[2] || null, rake: plane2Row[3] || null },
    // P軸・T軸・N軸は「方位」の行(plane1Row)と「傾斜」の行(plane2Row)にそれぞれ
    // 3つずつ入っている(表が2行にまたがった構成のため)。
    axes: {
      p: { azimuth: plane1Row[5] || null, plunge: plane2Row[5] || null },
      t: { azimuth: plane1Row[6] || null, plunge: plane2Row[6] || null },
      n: { azimuth: plane1Row[7] || null, plunge: plane2Row[7] || null },
    },
    stationCount: stationRow[1] || null,
    varianceReduction: stationRow[3] || null,
    beachballImageUrl: beachballImg,
    surroundingMapImageUrl: surroundingMapImg,
  };
}


// 「地震カード」互換の軽量プレビュー形式に変換する(観測点別震度はまだ持たない)。
function eqdbListItemToPreview(eq) {
  const scale = eqdbIntensityStringToScale(eq.maxI || "");
  const depMatch = (eq.dep || "").match(/\d+/);
  const mag = parseFloat(eq.mag);
  return {
    id: eq.id,
    time: eqdbIdToTimeDisplay(eq.id) || (eq.ot || ""),
    place: eq.name || "震源地不明",
    maxIntensity: scale > 0 ? maxScaleToIntensityKey(scale) : "?",
    isForeign: false,
    magnitude: Number.isFinite(mag) && mag > 0 ? mag : null,
    depth: depMatch ? parseInt(depMatch[0], 10) : null,
    isEqdb: true, // 一覧表示で日時を「YYYY/MM/DD」形式にするための目印
  };
}

/* ─────────────────────────────────────────────────────
   AUTO FIT TEXT
   与えられたコンテナ幅に収まるよう、フォントサイズを自動的に縮小して1行で表示する。
   QuakeDetailCardの震源地名(短い地名〜長い地名まで幅が大きく変わる)向け。
   ResizeObserverでコンテナ幅の変化(画面回転・レイアウト変更)にも追従する。
   ───────────────────────────────────────────────────── */
function AutoFitText({ text, maxFontSize, minFontSize = 13, className, style }) {
  const containerRef = useRef(null);
  const textRef = useRef(null);
  const [fontSize, setFontSize] = useState(maxFontSize);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const textEl = textRef.current;
    if (!container || !textEl) return;

    function fit() {
      const containerWidth = container.clientWidth;
      if (containerWidth <= 0) return;

      // 最大サイズから1pxずつ縮めて、テキストの実測幅(scrollWidth)が
      // コンテナ幅に収まるところを探す。文字数が少なければ最大サイズのまま。
      let size = maxFontSize;
      textEl.style.fontSize = `${size}px`;
      while (size > minFontSize && textEl.scrollWidth > containerWidth) {
        size -= 1;
        textEl.style.fontSize = `${size}px`;
      }
      setFontSize(size);
    }

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(container);
    return () => ro.disconnect();
  }, [text, maxFontSize, minFontSize]);

  return (
    <div ref={containerRef} style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
      <span
        ref={textRef}
        className={className}
        style={{ ...style, fontSize, whiteSpace: "nowrap", display: "inline-block" }}
      >
        {text}
      </span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   PANEL DRAG HANDOFF CARD
   フローティングパネル最上部のカード(地震カード・津波カード)を掴んで縦方向に
   ドラッグした時、リスト内スクロールではなく、パネル本体の高さ調整
   (ハンドルのドラッグ)として扱うためのラッパー。QuakeListToolbarの
   onHandoffToPanelDrag(縦方向優位の動きをパネルドラッグへ引き渡す)と同じ考え方。
   カード内のボタン等のタップ操作はそのまま素通しするため、判定前は何もしない。
   ───────────────────────────────────────────────────── */
function PanelDragHandoffCard({ onHandoffToPanelDrag, children }) {
  const pointerId = useRef(null);
  const startX    = useRef(0);
  const startY    = useRef(0);
  const decided   = useRef(false);

  function handlePointerDown(e) {
    if (pointerId.current != null) return; // 複数指の同時操作は無視
    pointerId.current = e.pointerId;
    startX.current = e.clientX;
    startY.current = e.clientY;
    decided.current = false;
    // ここでsetPointerCaptureは呼ばない。指を置いた時点で無条件にキャプチャして
    // しまうと、動かさずに離しただけの単純なタップでも(ブラウザによっては)
    // 中のボタンへclickイベントが届かなくなることがある(PCのChromium系ブラウザで
    // 確認、iOS Safariでは問題なし)。縦ドラッグと判定できた時(下のhandlePointerMove)
    // だけ、その場でキャプチャしてすぐパネルドラッグへ引き渡す。
  }
  function handlePointerMove(e) {
    if (pointerId.current !== e.pointerId || decided.current) return;
    const dx = e.clientX - startX.current;
    const dy = e.clientY - startY.current;
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return; // まだ判定するには小さすぎる(タップの可能性)
    decided.current = true;
    if (Math.abs(dy) >= Math.abs(dx)) {
      // 縦方向優位の動き = パネルの高さ調整として引き渡す(ハンドルを掴んだ時と同じ)
      pointerId.current = null;
      onHandoffToPanelDrag?.(e);
    }
    // 横方向優位の動きは、このラッパーとしては何もしない(カード内の通常操作に任せる)
  }
  function handlePointerUp(e) {
    if (pointerId.current !== e.pointerId) return;
    pointerId.current = null;
  }

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{ touchAction: "none" }} // QuakeListToolbarと同じ(縦横ともブラウザ標準ジェスチャーを完全に無効化し、途中でpointercancelされるのを防ぐ)
    >
      {children}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   QUAKE DETAIL CARD
   地震リスト/地図で選択した地震の詳細を表示するカード。
   左に「最大震度」バッジ、右にM/深さ・震源地・発生時刻を積む構成。
   ───────────────────────────────────────────────────── */
function QuakeDetailCard({ quake }) {
  const { tokens } = useContext(ThemeContext);

  const style = useIntensityStyle(quake.maxIntensity || "1");
  const { num, suffix } = splitIntensityLabel(style.label);

  return (
    <div
      style={{
        margin: "2px 14px 4px",
        borderRadius: 16,
        padding: "7px 16px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        position: "relative",
        background: `linear-gradient(135deg, ${style.bg}2E, ${style.bg}14)`,
        boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.12)`,
        animation: "appear 0.35s cubic-bezier(.25,1,.5,1)",
      }}
    >
      {/* 最大震度バッジ — 遠地地震は震度が観測されないため「遠地」表示にする */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.6)`, whiteSpace: "nowrap", lineHeight: 1.1 }}>
          {quake.isForeign ? "遠地地震" : "最大震度"}
        </span>
        <div
          style={{
            width: 64, height: 64,
            borderRadius: 14,
            background: style.bg, color: style.fg,
            position: "relative",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          {/* テスト配信バッジ — 津波警報テスト配信(TsunamiDetailCard)と全く同じ見た目を
              そのまま流用する。最大震度アイコンの角に乗せることで、一目でテストデータだと
              分かるようにする。 */}
          {quake.isTest && (
            <span style={{
              position: "absolute", top: -8, left: -8,
              fontSize: 9.5, fontWeight: 800, color: "#fff",
              background: "#FF453A", borderRadius: 4, padding: "2px 6px",
              whiteSpace: "nowrap",
            }}>
              テスト配信
            </span>
          )}
          {quake.isForeign ? (
            <span style={{ fontSize: 14, fontWeight: 800, lineHeight: 1.2 }}>不明</span>
          ) : quake.maxIntensity === "?" ? (
            <span style={{ fontSize: 13, fontWeight: 800, lineHeight: 1.15, textAlign: "center" }}>調査中</span>
          ) : quake.maxIntensity === "5u" ? (
            // 震度5弱以上未入電 — 観測点の震度計は検知したが、確定した震度が
            // まだ入電されていない状態。「少なくとも5弱」を示す"5弱+"と、
            // その理由となる"未入電"を2段で表示する。
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", lineHeight: 1.1 }}>
              <span className="mono" style={{ fontSize: 22, fontWeight: 800 }}>5弱+</span>
              <span style={{ fontSize: 10, fontWeight: 700, marginTop: 2 }}>未入電</span>
            </div>
          ) : suffix ? (
            <>
              {/* 弱/強付き(5弱・5強・6弱・6強) — 数字と弱/強を近づけ、正方形の中央にまとめて配置 */}
              <span className="mono" style={{ fontSize: 32, fontWeight: 800, lineHeight: 1 }}>{num}</span>
              <span style={{
                fontSize: 15, fontWeight: 700, lineHeight: 1,
                marginLeft: 2, alignSelf: "flex-end", marginBottom: 14,
              }}>{suffix}</span>
            </>
          ) : (
            // 数字のみ(1〜4,7) — 弱/強が無い分、正方形の大きさを変えずに数字だけ少し大きく
            <span className="mono" style={{ fontSize: 32, fontWeight: 800, lineHeight: 1 }}>{num}</span>
          )}
        </div>
      </div>

      {/* 震源地 / M・深さ / 発生時刻 — 中央寄せで大きめに表示する */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0, lineHeight: 1.1 }}>
          {/* 発表段階バッジ。震度速報・震源に関する情報の間だけ「震源地」ラベルの
              代わりに表示し、確定報(DetailScale)が届いたら通常の「震源地」に戻る。
              ラベルの位置にそのまま差し替えるだけなので、他の行・列の並びは変わらない。 */}
          {QUAKE_STAGE_LABEL[quake.stage] ? (
            <span style={{
              flexShrink: 0, fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
              background: `rgba(${tokens.ink},0.14)`, color: `rgba(${tokens.ink},0.75)`,
              whiteSpace: "nowrap", lineHeight: 1.5,
            }}>
              {QUAKE_STAGE_LABEL[quake.stage]}
            </span>
          ) : (
            <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.55)`, flexShrink: 0, lineHeight: 1.1 }}>震源地</span>
          )}
          <AutoFitText
            text={quake.place}
            maxFontSize={30}
            minFontSize={13}
            style={{ fontWeight: 800, color: tokens.text, lineHeight: 1.1 }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 12, lineHeight: 1.1 }}>
          <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.1 }}>
            M<span className="mono" style={{ fontSize: 21, fontWeight: 800, color: tokens.text, marginLeft: 3, lineHeight: 1.1 }}>
              {quake.magnitude != null ? quake.magnitude.toFixed(1) : "-"}
            </span>
          </span>
          <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.1 }}>
            深さ<span className="mono" style={{ fontSize: 21, fontWeight: 800, color: tokens.text, marginLeft: 3, lineHeight: 1.1 }}>
              {quake.depth != null ? (quake.depth === 0 ? "ごく浅い" : quake.depth) : "-"}
            </span>
            {quake.depth != null && quake.depth !== 0 && (
              <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.6)`, marginLeft: 2, lineHeight: 1.1 }}>km</span>
            )}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 6, lineHeight: 1.1 }}>
          <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, flexShrink: 0, lineHeight: 1.1 }}>発生時刻</span>
          <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: `rgba(${tokens.ink},0.85)`, lineHeight: 1.1 }}>
            {formatQuakeTimeShort(quake.time)}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   QUAKE MESSAGE CARD — 電文(津波情報・付加文)
   選択中の地震について、津波の心配の有無や気象庁の付加コメントを表示する。
   ───────────────────────────────────────────────────── */
function QuakeMessageCard({ quake }) {
  const { tokens } = useContext(ThemeContext);

  const lines = buildQuakeMessage(quake);

  return (
    <div style={{ margin: "2px 14px 8px" }}>
      <div style={{
        borderRadius: 12,
        padding: "10px 12px",
        display: "flex", flexDirection: "column", gap: 8,
        background: `rgba(${tokens.ink},0.04)`,
        boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
      }}>
        {lines.map((line, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: line.color }}>
              【{line.label}】
            </span>
            <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.85)`, lineHeight: 1.5 }}>
              {line.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   STATION POINTS LIST — 各地の震度
   選択中の地震について、観測点ごとの震度を表示する。表示方法は設定で選べる:
     - "list"    : 震度が大きい順にフラットな一覧で表示(従来の見た目)。
                   件数が多い地震(数百観測点になることもある)を考慮し、
                   既定では上位のみ表示し「すべて表示」で展開できる。
     - "grouped" : 震度階級ごとの一覧(既定)。各行は「バッジ+震度ラベル+
                   都道府県名(まとめて表示)+ >」の要約行で、タップすると
                   その震度の地域一覧(都道府県ごとに開閉できる詳細画面)へ遷移する。
   観測点マスタに見つからず地図に表示されていない件数(unmappedCount)は、
   要約画面の最下部にまとめて表示する(詳細画面では表示しない)。
   ───────────────────────────────────────────────────── */
function StationPointsList({ points, displayMode = "list", openKey, onOpenKeyChange }) {
  const { tokens } = useContext(ThemeContext);

  const [expanded, setExpanded] = useState(false); // 一覧表示(list)用の「すべて表示」
  // 階層表示(grouped)用: 詳細画面を開いている震度キー。
  // フローティングの外にある丸い「戻る」ボタンでもこの詳細画面を閉じられるように、
  // 親(BottomDock)側にstateを持ち上げてpropsで受け取る形にしている
  // (✕ボタン自体はこれまで通りこのコンポーネント内に残す)。
  const [openPrefs, setOpenPrefs] = useState(() => new Set()); // 詳細画面内で開いている都道府県
  const [closePressed, setClosePressed] = useState(false); // 詳細画面の✕(ガラス)ボタンの押下状態
  const schemeId = useContext(QuakeColorSchemeContext);
  const scheme = QUAKE_COLOR_SCHEMES[schemeId] || QUAKE_COLOR_SCHEMES.fill;

  // scale(10刻みのJMAコード)が大きい順 = 震度が大きい順
  const sorted = useMemo(() => {
    return [...points].sort((a, b) => INTENSITY_ORDER.indexOf(b.intensityKey) - INTENSITY_ORDER.indexOf(a.intensityKey));
  }, [points]);

  // 震度キーごとにグループ化する(sortedは既に震度降順なので、Mapの挿入順=震度降順のまま保たれる)
  const groups = useMemo(() => {
    const map = new Map();
    for (const p of sorted) {
      if (!map.has(p.intensityKey)) map.set(p.intensityKey, []);
      map.get(p.intensityKey).push(p);
    }
    return [...map.entries()];
  }, [sorted]);

  // 選択中の地震が変わるたび(=points自体が変わるたび)、詳細画面は閉じておく
  useEffect(() => {
    onOpenKeyChange(null);
    setOpenPrefs(new Set());
  }, [points]);

  // 詳細画面を閉じた時・別の震度キーの詳細画面へ切り替わった時は、
  // 開いていた都道府県の展開状態をリセットする。
  // openPrefsは震度キーをまたいで共有しているstateなので、これをやらないと
  // 「震度5弱の詳細で北海道を開いたまま閉じて、震度3の詳細を開いたら
  //  北海道が開きっぱなしになっている」といった意図しない引き継ぎが起きる。
  useEffect(() => {
    setOpenPrefs(new Set());
  }, [openKey]);

  if (sorted.length === 0) return null;

  // 観測点マスタに見つからず、緯度経度が引けなかった(=地図上には表示されていない)観測点の数。
  // 地図上で「無いことに気づけない」状態を防ぐため、要約画面の最下部に件数を明示しておく。
  // 震度速報(isArea:true)の点は、そもそも個別の緯度経度を持たず区域塗り分けで
  // 表示される(観測点マスタに無いのとは違う)ため、この「地図に出せない件数」には含めない。
  const unmappedCount = sorted.filter(p => !p.isArea && (p.latitude == null || p.longitude == null)).length;

  const VISIBLE_COUNT = 10;
  const visible = expanded ? sorted : sorted.slice(0, VISIBLE_COUNT);
  const hasMore = sorted.length > VISIBLE_COUNT;

  function togglePref(pref) {
    setOpenPrefs(prev => {
      const next = new Set(prev);
      if (next.has(pref)) next.delete(pref); else next.add(pref);
      return next;
    });
  }

  // 階層表示(grouped)で、ある震度キーの地域詳細画面を開いている場合はそちらを表示する
  if (displayMode === "grouped" && openKey != null) {
    const groupPoints = groups.find(([k]) => k === openKey)?.[1] || [];
    const style = getIntensityStyleFromScheme(scheme, openKey);

    // 都道府県ごと→さらに市区町村ごとにまとめ直す(出現順を維持)。
    // 同じ市区町村の地点は1つの見出しの下にまとめ、見出しの繰り返しを避ける。
    const byPref = [];
    const prefIndexOf = new Map();
    for (const p of groupPoints) {
      if (!prefIndexOf.has(p.pref)) {
        prefIndexOf.set(p.pref, byPref.length);
        byPref.push({ pref: p.pref, cities: [], cityIndexOf: new Map() });
      }
      const prefEntry = byPref[prefIndexOf.get(p.pref)];
      const cityKey = p.city || `__nocity_${p.addr}`; // 市区町村が無い観測点は地点名単位でそのまま1件ずつ扱う
      if (!prefEntry.cityIndexOf.has(cityKey)) {
        prefEntry.cityIndexOf.set(cityKey, prefEntry.cities.length);
        prefEntry.cities.push({ city: p.city, addrs: [] });
      }
      prefEntry.cities[prefEntry.cityIndexOf.get(cityKey)].addrs.push(p.addr);
    }

    return (
      <div style={{ margin: "2px 14px 8px", textAlign: "left" }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center", padding: "6px 2px 10px" }}>
          <div style={{ flex: 1, textAlign: "left", fontSize: 14, fontWeight: 700, color: tokens.text, paddingRight: 36 }}>
            震度{style.label}の地域
          </div>
          <div style={{ position: "absolute", right: 0 }}>
            <Glass
              radius={999}
              style={{
                width: 28, height: 28,
                transform: closePressed ? "scale(1.16)" : "scale(1)",
                transformOrigin: "center",
                transition: "transform 0.18s cubic-bezier(.22,1,.36,1)",
              }}
            >
              <button
                onClick={() => onOpenKeyChange(null)}
                onPointerDown={() => setClosePressed(true)}
                onPointerUp={() => setClosePressed(false)}
                onPointerCancel={() => setClosePressed(false)}
                onPointerLeave={() => setClosePressed(false)}
                aria-label="閉じる"
                style={{
                  width: "100%", height: "100%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: "transparent", border: "none", cursor: "pointer",
                }}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
                     stroke={`rgba(${tokens.ink},0.75)`} strokeWidth="2.4" strokeLinecap="round">
                  <line x1="6" y1="6" x2="18" y2="18"/>
                  <line x1="18" y1="6" x2="6" y2="18"/>
                </svg>
              </button>
            </Glass>
          </div>
        </div>

        <div style={{
          borderRadius: 12,
          overflow: "hidden",
          background: `rgba(${tokens.ink},0.04)`,
          boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
        }}>
          {byPref.map((entry, pi) => {
            const isOpen = openPrefs.has(entry.pref);
            return (
              <div key={entry.pref}>
                {pi > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)` }}/>}
                <PressableButton
                  onClick={() => togglePref(entry.pref)}
                  style={{
                    width: "100%", display: "block", background: "transparent", border: "none",
                    cursor: "pointer", textAlign: "left", padding: 0,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px" }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: tokens.text, flex: 1 }}>
                      {entry.pref}
                    </span>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
                         stroke={`rgba(${tokens.ink},0.3)`} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
                         style={{ transform: isOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s ease", flexShrink: 0 }}>
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </div>
                  {isOpen && (
                    <div style={{ padding: "0 12px 10px", textAlign: "left" }}>
                      {entry.cities.map((c, ci) => (
                        <div key={ci} style={{ marginTop: ci > 0 ? 6 : 0, fontSize: 14, lineHeight: 1.7, textAlign: "left" }}>
                          {c.city && (
                            <span style={{ fontWeight: 700, color: tokens.text }}>{c.city} </span>
                          )}
                          <span style={{ color: `rgba(${tokens.ink},0.88)` }}>{c.addrs.join(" ")}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </PressableButton>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div style={{ margin: "2px 14px 8px" }}>
      <div style={{
        padding: "6px 2px",
        fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.5)`,
      }}>
        各地の震度
      </div>

      <div style={{
        borderRadius: 12,
        overflow: "hidden",
        background: `rgba(${tokens.ink},0.04)`,
        boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
      }}>
        {displayMode === "grouped" ? (
          groups.map(([key, groupPoints], gi) => {
            const style = getIntensityStyleFromScheme(scheme, key);
            const prefs = [...new Set(groupPoints.map(p => p.pref))];
            return (
              <div key={key}>
                {gi > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)` }}/>}
                <PressableButton
                  onClick={() => onOpenKeyChange(key)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 10,
                    padding: "9px 12px", background: "transparent", border: "none",
                    cursor: "pointer", textAlign: "left",
                  }}
                >
                  <span style={{
                    flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
                    background: style.bg, color: style.fg,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: key === "5u" ? 9 : 11, fontWeight: 800,
                  }}>
                    {key === "5u" ? "未入電" : style.label}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: tokens.text }}>
                      震度{style.label}
                    </div>
                    <div style={{ fontSize: 13, color: `rgba(${tokens.ink},0.65)`, marginTop: 3, lineHeight: 1.6 }}>
                      {prefs.map((pref, pi) => (
                        <span key={pref} style={{ whiteSpace: "nowrap" }}>
                          {pref}{pi < prefs.length - 1 ? "、" : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                       stroke={`rgba(${tokens.ink},0.3)`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                       style={{ flexShrink: 0 }}>
                    <polyline points="9 6 15 12 9 18"/>
                  </svg>
                </PressableButton>
              </div>
            );
          })
        ) : (
          visible.map((p, i) => {
            const style = getIntensityStyleFromScheme(scheme, p.intensityKey);
            return (
              <div key={`${p.pref}-${p.addr}-${i}`}>
                {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)`, marginLeft: 12 }}/>}
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px" }}>
                  <span style={{
                    flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
                    background: style.bg, color: style.fg,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: p.intensityKey === "5u" ? 9 : 11, fontWeight: 800,
                  }}>
                    {p.intensityKey === "5u" ? "未入電" : style.label}
                  </span>
                  <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.4)`, flexShrink: 0 }}>
                    {p.pref}
                  </span>
                  <span style={{
                    flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: tokens.text,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {p.addr}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {displayMode === "list" && hasMore && (
        <PressableButton
          onClick={() => setExpanded(v => !v)}
          style={{
            width: "100%", textAlign: "center", padding: "8px 0",
            fontSize: 12, fontWeight: 600, color: `rgba(${tokens.ink},0.55)`,
          }}
        >
          {expanded ? "閉じる" : `すべて表示 (${sorted.length}件)`}
        </PressableButton>
      )}

      {unmappedCount > 0 && (
        <div style={{ padding: "8px 2px 2px", fontSize: 11, fontWeight: 500, color: `rgba(${tokens.ink},0.35)` }}>
          うち{unmappedCount}件は観測点マスタに無く、地図には非表示です
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   QUAKE MECH DETAIL PANEL — 「この地震の詳細」画面
   
   気象庁の発震機構解(CMT解)を取得して表示する。M5.0以上でないとそもそも
   解析されないため、見つからない場合はその旨を案内する(エラーではない)。
   ───────────────────────────────────────────────────── */
function QuakeMechDetailPanel({ quake }) {
  const { tokens } = useContext(ThemeContext);
  // ホーム画面に追加したPWA(スタンドアロン表示)かどうか。
  // iOSのスタンドアロンPWAには「新しいタブ」という概念が無いため、
  // target="_blank"のリンクを踏むとOSがSafari側にまるごと処理を渡してしまい、
  // 「戻る」で復帰した時にPWA側のWebViewがメモリから破棄されていて
  // アプリ全体がリロードされてしまうことがある(=開いていた画面が消える不具合)。
  // スタンドアロン時だけtarget="_blank"を外し、同じWebView内で遷移させることで、
  // これを避ける。
  const isStandalonePwa = useIsStandalonePwa();
  // "loading" | "found" | "not_found" | "error"
  const [status, setStatus] = useState("loading");
  const [detail, setDetail] = useState(null);
  const [matchedRow, setMatchedRow] = useState(null);
  // 震源球画像のURLが取れても、実際には読み込みに失敗する(ページ構成の想定違いで
  // 誤ったURLを組み立ててしまった等)ことがあるため、<img>のonErrorで検知して
  // 壊れた画像アイコンの代わりに案内文を出す。
  const [imgLoadFailed, setImgLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setDetail(null);
    setMatchedRow(null);
    setImgLoadFailed(false);

    (async () => {
      try {
        const match = await findCmtMatchForQuake(quake);
        if (cancelled) return;
        if (!match) { setStatus("not_found"); return; }
        setMatchedRow(match);
        const d = await fetchCmtDetail(match.detailUrlStamp);
        if (cancelled) return;
        setDetail(d);
        setStatus("found");
      } catch (err) {
        console.error("発震機構解の取得に失敗:", err);
        if (!cancelled) setStatus("error");
      }
    })();

    return () => { cancelled = true; };
  }, [quake.id]);

  const rowLabelStyle = { fontSize: 11, color: tokens.textSecondary };
  const rowValueStyle = { fontSize: 13, fontWeight: 700, color: tokens.text };

  function DataRow({ label, value }) {
    if (value == null || value === "") return null;
    return (
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "6px 0" }}>
        <span style={rowLabelStyle}>{label}</span>
        <span style={rowValueStyle}>{value}</span>
      </div>
    );
  }

  // 深さ・M(またはMw)のように、単独の行だと空きスペースが目立つ2項目を
  // 1行に横並びで表示する(左右それぞれで見出し/値のペア)。
  // 片方だけ値が無い場合は、そちら側だけ非表示にする。
  function DataRowPair({ left, right }) {
    const leftHas = left.value != null && left.value !== "";
    const rightHas = right.value != null && right.value !== "";
    if (!leftHas && !rightHas) return null;
    return (
      <div style={{ display: "flex", gap: 10, padding: "6px 0" }}>
        {leftHas && (
          <div style={{ flex: 1, display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ ...rowLabelStyle, flexShrink: 0 }}>{left.label}</span>
            <span style={{ ...rowValueStyle, flex: 1, textAlign: "center" }}>{left.value}</span>
          </div>
        )}
        {rightHas && (
          <div style={{ flex: 1, display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ ...rowLabelStyle, flexShrink: 0 }}>{right.label}</span>
            <span style={{ ...rowValueStyle, flex: 1, textAlign: "center" }}>{right.value}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <QuakeDetailCard quake={quake}/>
      <div style={{ padding: "2px 14px 16px" }}>
      {status === "loading" && (
        <Glass radius={14} style={{ padding: "24px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 12, color: tokens.textSecondary }}>気象庁のデータを確認しています…</div>
        </Glass>
      )}

      {status === "not_found" && (
        <Glass radius={14} style={{ padding: "24px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 12, color: tokens.textSecondary, lineHeight: 1.6 }}>
            この地震の発震機構解は見つかりませんでした。<br/>
            まだ解析中か、解析対象外の可能性があります。
          </div>
        </Glass>
      )}

      {status === "error" && (
        <Glass radius={14} style={{ padding: "24px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 12, color: "rgba(255,140,140,0.9)", lineHeight: 1.6 }}>
            気象庁のデータ取得に失敗しました。時間をおいて再度お試しください。
          </div>
        </Glass>
      )}

      {status === "found" && detail && (
        <>
          {/* 使用観測点数・精度(左)と震源球の図(右)を横並びにする。
              左側は中身の幅だけ確保し(space-betweenで間延びさせない)、
              余った分は震源球の画像を大きく見せる方に回す。
              「震源球(下半球等積投影)」のキャプションは画像の下ではなく、
              左側の解の精度の下に矢印つきで置くことで、画像により幅を割ける。 */}
          <Glass radius={14} style={{ padding: 16, marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, minWidth: 0 }}>
              <div style={{ flexShrink: 1, minWidth: 0 }}>
                <DataRow label="使用観測点数" value={detail.stationCount} />
                <DataRow label="解の精度(V.R.)" value={detail.varianceReduction} />
                {detail.beachballImageUrl && !imgLoadFailed && (
                  <div style={{ fontSize: 10, color: tokens.textSecondary, marginTop: 6 }}>
                    震源球(下半球等積投影)→
                  </div>
                )}
              </div>
              {detail.beachballImageUrl && (
                <div style={{ flex: "0 1 150px", minWidth: 0, maxWidth: 150, textAlign: "center" }}>
                  {!imgLoadFailed ? (
                    <img
                      src={detail.beachballImageUrl}
                      alt="震源球(発震機構解)"
                      style={{ display: "block", width: "100%", maxWidth: "100%", height: "auto", borderRadius: 8, background: "#fff" }}
                      onError={() => setImgLoadFailed(true)}
                    />
                  ) : (
                    <div style={{ fontSize: 10, color: tokens.textSecondary, lineHeight: 1.5 }}>
                      画像を読み込めませんでした
                    </div>
                  )}
                </div>
              )}
            </div>
          </Glass>

          <Glass radius={14} style={{ padding: "6px 16px", marginBottom: 10 }}>
            <DataRow label="発生時刻" value={detail.hypo.time} />
            <DataRow label="震源位置" value={detail.hypo.lat && detail.hypo.lon ? `${detail.hypo.lat} ${detail.hypo.lon}` : null} />
            <DataRowPair
              left={{ label: "深さ", value: detail.hypo.depth }}
              right={{ label: "M", value: detail.hypo.magnitude }}
            />
          </Glass>

          <Glass radius={14} style={{ padding: "6px 16px", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text, padding: "8px 0 2px" }}>
              セントロイド・モーメントマグニチュード
            </div>
            <DataRow label="セントロイド時刻" value={detail.centroid.time} />
            <DataRow label="位置" value={detail.centroid.lat && detail.centroid.lon ? `${detail.centroid.lat} ${detail.centroid.lon}` : null} />
            <DataRowPair
              left={{ label: "深さ", value: detail.centroid.depth }}
              right={{ label: "Mw", value: detail.centroid.mw }}
            />
          </Glass>

          {/* 断層面解1・2は片方ずつだと余白が目立つため、真ん中に区切り線を入れて
              横に2つ並べる。 */}
          <Glass radius={14} style={{ padding: "6px 16px", marginBottom: 10 }}>
            <div style={{ display: "flex", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text, padding: "8px 0 2px" }}>
                  断層面解1
                </div>
                <DataRow label="走向" value={detail.plane1.strike} />
                <DataRow label="傾斜" value={detail.plane1.dip} />
                <DataRow label="すべり角" value={detail.plane1.rake} />
              </div>
              <div style={{ width: 1, alignSelf: "stretch", background: tokens.divider, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text, padding: "8px 0 2px" }}>
                  断層面解2
                </div>
                <DataRow label="走向" value={detail.plane2.strike} />
                <DataRow label="傾斜" value={detail.plane2.dip} />
                <DataRow label="すべり角" value={detail.plane2.rake} />
              </div>
            </div>
          </Glass>

          <Glass radius={14} style={{ padding: "6px 16px", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text, padding: "8px 0 2px" }}>
              P軸・T軸・N軸(方位 / 傾斜)
            </div>
            <DataRow label="P軸" value={detail.axes.p.azimuth && detail.axes.p.plunge ? `${detail.axes.p.azimuth}° / ${detail.axes.p.plunge}°` : null} />
            <DataRow label="T軸" value={detail.axes.t.azimuth && detail.axes.t.plunge ? `${detail.axes.t.azimuth}° / ${detail.axes.t.plunge}°` : null} />
            <DataRow label="N軸" value={detail.axes.n.azimuth && detail.axes.n.plunge ? `${detail.axes.n.azimuth}° / ${detail.axes.n.plunge}°` : null} />
          </Glass>

          <a
            href={detail.sourceUrl}
            {...(isStandalonePwa ? {} : { target: "_blank", rel: "noopener noreferrer" })}
            style={{
              display: "block", textAlign: "center", padding: "10px 0",
              fontSize: 12, fontWeight: 600, color: tokens.accentText || "#0A84FF",
              textDecoration: "none",
            }}
          >
            気象庁の該当ページを開く ↗
          </a>
        </>
      )}

      {/* CMT解についての注意書きは最下部に置く */}
      <Glass radius={14} style={{ padding: "14px 16px", marginTop: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: tokens.text, marginBottom: 2 }}>
          発震機構解(CMT解)
        </div>
        <div style={{ fontSize: 11, color: tokens.textSecondary, lineHeight: 1.5 }}>
          気象庁の解析結果です。マグニチュード5.0程度以上の地震のみ解析されるため、
          対象の地震でも掲載されていない場合があります。
        </div>
      </Glass>
      </div>
    </>
  );
}


/* ─────────────────────────────────────────────────────
   TOGGLE (iOS-style)
   ───────────────────────────────────────────────────── */
function Toggle({ on, onChange, disabled = false }) {
  const { tokens } = useContext(ThemeContext);

  return (
    <div
      onClick={disabled ? undefined : onChange}
      role="switch" aria-checked={on} aria-disabled={disabled || undefined}
      style={{
        width: 44, height: 26, borderRadius: 13, flexShrink: 0,
        background: on ? "#32D74B" : `rgba(${tokens.ink},0.2)`,
        position: "relative", cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 0.22s",
        boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.2)",
      }}
    >
      <div style={{
        position: "absolute", top: 3,
        left: on ? 21 : 3, width: 20, height: 20,
        borderRadius: "50%", background: "#fff",
        boxShadow: "0 1px 4px rgba(0,0,0,0.35)",
        transition: "left 0.22s cubic-bezier(.25,1,.5,1)",
      }}/>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   NAV ICONS
   ───────────────────────────────────────────────────── */
const NAV_ICONS = {
  quake: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <polyline points="2,12 4,12 5,7 6,17 8,4 9,20 11,10 12,12 14,12"/>
      <polyline points="14,12 15,9 16,15 18,12 22,12"/>
    </svg>
  ),
  tsunami: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none"
         stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2,10.5C5,10.5 5,2.5 10.3,2.5 14.1,2.5 16,5.1 16,7.4
               c0,1.8 -1.2,3.1 -2.7,3.1 -1.3,0 -2.3,-0.9 -2.3,-2.1
               0,-0.9 0.7,-1.6 1.5,-1.6 0.6,0 1.1,0.5 1.1,1"/>
      <path d="M2,13h20"/>
      <path d="M2,19c1.5,0 1.5,-2.2 3,-2.2s1.5,2.2 3,2.2 1.5,-2.2 3,-2.2 1.5,2.2 3,2.2
               1.5,-2.2 3,-2.2 1.5,2.2 3,2.2 1.5,-2.2 3,-2.2 1.5,2.2 3,2.2"/>
    </svg>
  ),
  weather: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M20,17.58A5,5 0 0 0 18,8h-1.26A8,8 0 1 0 4,16.25"/>
      <line x1="8" y1="19" x2="8" y2="21"/><line x1="12" y1="19" x2="12" y2="21"/>
      <line x1="16" y1="19" x2="16" y2="21"/>
    </svg>
  ),
  alert: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2 1 21h22z"/>
      <line x1="12" y1="9" x2="12" y2="14"/>
      <line x1="12" y1="17.5" x2="12" y2="17.5"/>
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  ),
};

/* ─────────────────────────────────────────────────────
   SIDE NAV RAIL
   広い画面(isWide)用の、縦タブバーの中身(アイコン列+スライドする
   ハイライト)。ドラッグ操作は無く、単純なクリックだけでタブを切り替える
   (PC・タブレットでは横スワイプよりクリック/タップの方が自然なため)。
   このコンポーネント自身はGlassや位置決めを持たない。フローティング
   パネルと1枚の連続したガラスに見せるため、App側で用意した共有の
   Glassの中に、コンテンツ(BottomDock)と並べて描画される。
   ───────────────────────────────────────────────────── */
const WIDE_RAIL_WIDTH = 44;      // 横幅[px]
const WIDE_RAIL_TOP = 16;        // 画面上端からの余白[px]。フローティングパネルと揃える
const WIDE_RAIL_RADIUS = 28;     // 角丸[px](共有Glass全体に適用する)

function SideNavRail({ active, onNav, uiScale = 1 }) {
  const { tokens, mode } = useContext(ThemeContext);
  const { opaque: glassOpaque } = useContext(GlassOpaqueContext);

  const RAIL_PAD_Y = 14; // 内側コンテンツ(ボタン列)の上下パディング[px]。JSXと一致させる
  const N = NAV.length;
  const tabH = 100 / N;  // 1タブぶんの高さ[%](内側領域基準)
  const activeIndex = Math.max(0, NAV.findIndex(n => n.id === active));

  // 縦画面のナビ行(%ベースで指に連続追従するハイライト)と全く同じ考え方を、
  // 横→縦の軸を入れ替えて再現する。バーの全長自体がclamp(vh)で画面サイズに
  // 応じて伸縮するため、pxではなく%で管理する(そうしないと画面サイズが
  // 変わった時にハイライトの位置・サイズがずれてしまう)。
  const contentRef    = useRef(null);
  const pointerIdRef  = useRef(null);
  const movedRef      = useRef(false);
  const startYRef     = useRef(0);
  const [highlightTop, setHighlightTop] = useState(activeIndex * tabH); // %
  const [dragging,     setDragging]     = useState(false);
  const [pressed,      setPressed]      = useState(false); // 指が触れている間ずっとtrue
  const [previewIdx,   setPreviewIdx]   = useState(null);

  // active が外部から変わった時(タップ以外の切替)にハイライトを追従させる
  useEffect(() => {
    if (!dragging) setHighlightTop(activeIndex * tabH);
  }, [activeIndex, dragging, tabH]);

  // clientY → 内側領域(上下RAIL_PAD_Y除外)を基準にした正規化top [%]
  function clientYToTop(clientY) {
    const el = contentRef.current;
    if (!el) return activeIndex * tabH;
    const { top, height } = el.getBoundingClientRect();
    const innerTop    = top + RAIL_PAD_Y;
    const innerHeight = height - RAIL_PAD_Y * 2;
    const ratio = Math.max(0, Math.min(1, (clientY - innerTop) / innerHeight));
    return Math.max(0, Math.min(100 - tabH, ratio * 100 - tabH / 2));
  }

  // clientY に最も近いタブのindexを返す
  function clientYToIndex(clientY) {
    const el = contentRef.current;
    if (!el) return activeIndex;
    const { top, height } = el.getBoundingClientRect();
    const innerTop    = top + RAIL_PAD_Y;
    const innerHeight = height - RAIL_PAD_Y * 2;
    const ratio = Math.max(0, Math.min(1, (clientY - innerTop) / innerHeight));
    return Math.max(0, Math.min(N - 1, Math.round(ratio * 100 / tabH - 0.5)));
  }

  function handlePointerDown(e) {
    pointerIdRef.current = e.pointerId;
    movedRef.current = false;
    startYRef.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    const idx = clientYToIndex(e.clientY);
    setPreviewIdx(idx);
    setPressed(true);
    // タップの可能性がある間はtransitionを効かせたまま、目的のタブへ
    // スライドするアニメーションを見せる(縦画面版と同じ考え方)。
    setHighlightTop(idx * tabH);
  }

  function handlePointerMove(e) {
    if (pointerIdRef.current !== e.pointerId) return;
    if (Math.abs(e.clientY - startYRef.current) > 3 && !movedRef.current) {
      movedRef.current = true;
      setDragging(true);
    }
    const idx = clientYToIndex(e.clientY);
    setPreviewIdx(idx);
    if (movedRef.current) {
      setHighlightTop(clientYToTop(e.clientY)); // 指の連続位置に追従
    } else {
      setHighlightTop(idx * tabH);
    }
  }

  function handlePointerUp(e) {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    const idx = clientYToIndex(e.clientY);
    setDragging(false);
    setPressed(false);
    setPreviewIdx(null);
    setHighlightTop(idx * tabH);
    onNav(NAV[idx].id);
  }

  function handleClick(id) {
    if (movedRef.current) return; // ドラッグ完了後の二重発火を防ぐ
    const idx = NAV.findIndex(n => n.id === id);
    setHighlightTop(idx * tabH);
    onNav(id);
  }

  const displayIdx = dragging && previewIdx != null ? previewIdx : activeIndex;

  return (
      <div style={{
        width: `${100 / uiScale}%`,
        height: `${100 / uiScale}%`,
        transform: `scale(${uiScale})`,
        transformOrigin: "top left",
      }}>
        <div
          ref={contentRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          style={{
            position: "relative",
              height: "100%",
              display: "flex", flexDirection: "column",
              alignItems: "stretch",
              padding: `${RAIL_PAD_Y}px 5px`,
              touchAction: "none",
              userSelect: "none",
              WebkitUserSelect: "none",
              WebkitTouchCallout: "none",
            }}
          >
            {/* ガラスのハイライトピル — 縦画面のナビ行と全く同じ見た目・挙動
                (完全な丸ピル、指に連続追従、押し込むと少し膨らむ)。
                バーの全長がclamp(vh)で伸縮するため、位置・高さとも%で
                管理し、画面サイズが変わっても常に正しい位置に来るようにする。 */}
            <div
              aria-hidden
              style={{
                position: "absolute",
                left: 3, right: 3,
                top: `calc(${RAIL_PAD_Y}px + (100% - ${RAIL_PAD_Y * 2}px) * ${highlightTop / 100})`,
                height: `calc((100% - ${RAIL_PAD_Y * 2}px) * ${tabH / 100})`,
                borderRadius: 999,
                background: (pressed || dragging) && !glassOpaque ? tokens.glassTint : tokens.navPillBg,
                boxShadow: (pressed || dragging) && !glassOpaque
                  ? `inset 0 0 0 0.5px ${tokens.rimLight}, inset 0 1px 0 ${tokens.rimHighlight}`
                  : tokens.navPillShadow,
                // タッチ/ドラッグ中だけ本物のガラス(backdrop-filter blur)にする。
                // 通常時は軽量なフラットピルのままにして、常時ブラーによる
                // 描画負荷を避ける。
                backdropFilter: (pressed || dragging) && !glassOpaque ? touchGlassBackdropFilter(mode) : "none",
                WebkitBackdropFilter: (pressed || dragging) && !glassOpaque ? touchGlassBackdropFilter(mode) : "none",
                transform: pressed ? "scale(1.08)" : "scale(1)",
                transformOrigin: "center",
                transition: dragging
                  ? "transform 0.18s cubic-bezier(.22,1,.36,1)"
                  : "top 0.38s cubic-bezier(.22,1,.36,1), transform 0.18s cubic-bezier(.22,1,.36,1)",
                pointerEvents: "none",
                zIndex: 0,
              }}
            />

            {NAV.map(({ id, label }, idx) => {
              const isActive = idx === displayIdx;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => handleClick(id)}
                  style={{
                    position: "relative", zIndex: 1,
                    flex: 1, minHeight: 0, width: "100%",
                    display: "flex", flexDirection: "column",
                    alignItems: "center", justifyContent: "center",
                    gap: 1,
                    borderRadius: 999, border: "none", cursor: "pointer",
                    background: "transparent",
                    color: isActive ? tokens.text : `rgba(${tokens.ink},0.6)`,
                    transition: "color 0.15s",
                    touchAction: "none",
                    userSelect: "none",
                    WebkitUserSelect: "none",
                    WebkitTouchCallout: "none",
                  }}
                >
                  <span style={{ transform: "scale(0.7)" }}>{NAV_ICONS[id]}</span>
                  <span style={{ fontSize: 9, fontWeight: isActive ? 700 : 500, letterSpacing: -0.1 }}>
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
  );
}

/* ─────────────────────────────────────────────────────
   useSnapDrag
   ハンドルをドラッグして、高さを複数のスナップ位置のどれかに
   固定できるようにする汎用フック。UIロジックを切り離してあるので、
   heights配列を変えるだけで他のフローティングパネルにも流用できる。

   引数:
     heights: 昇順のスナップ高さ配列(px)。例: [0, 中, 高, 全画面]
     index:   現在のスナップ位置のindex(外部stateで管理)
     onSnap:  ドラッグが終わり、最も近いスナップ位置が決まった時に呼ばれる
   戻り値:
     { height, isDragging, handlePointerDown }
   ───────────────────────────────────────────────────── */
function useSnapDrag({ heights, index, onSnap }) {
  const [dragHeight, setDragHeight] = useState(null);
  const dragStartY      = useRef(0);
  const dragStartHeight = useRef(0);
  const liveHeight       = useRef(0);
  // フリック速度検出用: 直近の(時刻, 高さ)を記録しておき、
  // 指を離す直前の「速度」を算出する。
  const velocityTrack = useRef([]); // [{ t, h }, ...]

  const isDragging  = dragHeight !== null;
  const restHeight  = heights[index] ?? 0;
  const height      = isDragging ? dragHeight : restHeight;
  const maxHeight   = heights[heights.length - 1];

  function handlePointerMove(e) {
    const dy = dragStartY.current - e.clientY; // 上に引くほど高さが増える
    const h = Math.max(0, Math.min(maxHeight, dragStartHeight.current + dy));
    liveHeight.current = h;
    setDragHeight(h);

    // 直近120ms分だけ (時刻, 高さ) を保持し、速度計算に使う
    const now = performance.now();
    const track = velocityTrack.current;
    track.push({ t: now, h });
    while (track.length > 2 && now - track[0].t > 120) track.shift();
  }
  function endDrag() {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
    const finalH = liveHeight.current;

    // フリック速度(px/ms)を算出。track の最初と最後の差分から求める。
    // 正 = 上向き(高さが増える方向)、負 = 下向き(高さが減る方向)。
    const track = velocityTrack.current;
    let velocity = 0;
    if (track.length >= 2) {
      const first = track[0], last = track[track.length - 1];
      const dt = last.t - first.t;
      if (dt > 0) velocity = (last.h - first.h) / dt;
    }
    velocityTrack.current = [];

    // 現在のスナップ位置に一番近いindexを求めておく(通常時のフォールバック用)
    let nearest = 0, nearestDist = Infinity;
    heights.forEach((h, i) => {
      const d = Math.abs(h - finalH);
      if (d < nearestDist) { nearestDist = d; nearest = i; }
    });

    // 明確な勢い(フリック)がある場合は、最近傍ではなく
    // 「現在地から見て指の動いた方向にある次のスナップ」を優先する。
    // これにより、上→下へサッとスワイプした時に中間で止まらず、
    // 意図通り1段階(またはそれ以上)下まで閉じやすくなる。
    //
    // ただし、指を離した位置がすでに特定のスナップのすぐ近くにある場合は、
    // そこで止めようとした意図とみなし、フリック判定より最近傍を優先する。
    // 許容範囲は「最も近いスナップと、その両隣との間隔」から決める
    // (全スナップ中の最小間隔を使うと、無関係な離れた場所の間隔が極端に
    //  狭い場合に引きずられて許容範囲が潰れてしまうため)。
    const lowerNeighbor = heights[nearest - 1];
    const upperNeighbor = heights[nearest + 1];
    const distToLower = lowerNeighbor !== undefined ? heights[nearest] - lowerNeighbor : Infinity;
    const distToUpper = upperNeighbor !== undefined ? upperNeighbor - heights[nearest] : Infinity;
    const localGap = Math.min(distToLower, distToUpper);
    const SNAP_STICK_PX = Math.max(8, Math.min(30, localGap / 2));

    const FLICK_THRESHOLD = 0.45; // px/ms。これを超えたら明確なフリックとみなす
    let target = nearest;
    if (Math.abs(velocity) > FLICK_THRESHOLD && nearestDist > SNAP_STICK_PX) {
      // 現在の指位置(finalH)がどのスナップ帯にいるかを求め、
      // フリック方向にある隣接スナップへ進める。
      let below = 0;
      for (let i = 0; i < heights.length; i++) {
        if (heights[i] <= finalH) below = i; else break;
      }
      target = velocity < 0
        ? below                                   // 下向きフリック → 現在地点以下の直近スナップ
        : Math.min(below + 1, heights.length - 1); // 上向きフリック → 直近の上のスナップ
    }

    setDragHeight(null);
    onSnap(target);
  }
  function handlePointerDown(e) {
    e.preventDefault();
    dragStartY.current = e.clientY;
    dragStartHeight.current = restHeight;
    liveHeight.current = restHeight;
    velocityTrack.current = [{ t: performance.now(), h: restHeight }];
    setDragHeight(restHeight);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
  }

  return { height, isDragging, handlePointerDown };
}

/* ─────────────────────────────────────────────────────
   BOTTOM DOCK
   ナビバーと地図レイヤーパネルを「ひとつの液体ガラス」として統合する。
   分割した2枚のGlassを並べるのではなく、単一のGlass表面の
   高さ・角丸だけを変化させることで、ナビバーのガラス素材そのものが
   下から上へ伸びて、内側からパネルが生まれてくるように見せる。

   - 高さ: useSnapDrag により、低(閉)・中・中高・中中高・高(従来の全開)・全画面の
     4段階のスナップ位置のどれかに固定される。先頭の白いハンドルを
     ドラッグすると、指の動きにリアルタイムで追従し、離した位置に
     最も近いスナップへ収まる。画面上部近くまで引き上げ続けると、
     そのまま画面いっぱいに広がる「全画面」状態まで連続的に伸びる。
   - 角丸: 高さの開き具合に応じて連続的に補間する。閉時は四隅とも
     ナビバー本来のピル(33px)、開くにつれて上だけ26pxへ柔らかく変化。
     999pxのような巨大な値は使わない(箱のサイズを超えてクランプされ、
     歪な円形になるのを防ぐため)。
   ───────────────────────────────────────────────────── */
function BottomDock({
  active, onNav, navCollapseSignal, navDoubleTapSignal, layerOpen, layers, onToggleLayer, onLayerOpenChange,
  quakes, quakeStatus, selectedQuakeId, onSelectQuake, stationPoints = [],
  tsunamis = [], tsunamiStatus = "loading", selectedTsunamiId, onSelectTsunami,
  isViewingPastTsunami = false,
  tsunamiHistory, onLoadMoreTsunamiHistory, onCausingQuakeChange,
  onTsunamiViewModeChange,
  tideStations = EMPTY_EQDB_LIST, tideStationsStatus = "idle",
  selectedTideStationCode, onSelectTideStation, tideObsByStation = {}, onLoadTideObs,
  tideStationSelectSignal, tsunamiHeightByStation = {}, tsunamiHeightTimeByStation = {},
  stationMarkersVisible = true, onToggleStationMarkersVisible,
  tideStationMarkersVisible = true, onToggleTideStationMarkersVisible,
  onChangeQuakeColorScheme,
  onChangeNowcastColorScheme,
  estIntensityEnabled, onChangeEstIntensityEnabled,
  areaFillEnabled, onChangeAreaFillEnabled,
  faultsEnabled, onChangeFaultsEnabled,
  plateBoundariesEnabled, onChangePlateBoundariesEnabled,
  epicenterCirclesEnabled, onChangeEpicenterCirclesEnabled,
  boundaryLineColorId, onChangeBoundaryLineColorId,
  quakeFetchLimit, onChangeQuakeFetchLimit,
  stationListDisplayMode, onChangeStationListDisplayMode,
  experimentalFeaturesEnabled, onChangeExperimentalFeaturesEnabled,
  testTsunami, onBroadcastTestTsunami, onCancelTestTsunami, onClearTestTsunami,
  testEews = EMPTY_EQDB_LIST, onTestEewAction,
  eewTestForm, eewEpicenterPickActive,
  testQuake, onTestQuakeAction, quakeTestForm, quakeEpicenterPickActive, quakeTestAutoPlaying,
  eews = EMPTY_EQDB_LIST, eewDetailOpen, eewOpenSignal, onOpenEewDetail, onCloseEewDetail,
  tsunamiAreaPickActive, onStartTsunamiAreaPick, pickedTsunamiAreas,
  onRemoveTsunamiAreaPick, onCycleTsunamiAreaGrade,
  pickedTsunamiHeights, onChangeTsunamiHeightPick, onRemoveTsunamiHeightPick,
  candidateHeightStations, onAddTsunamiHeightPick,
  stations, searchQuake, onFoundSearchQuake,
  onEpicenterPointsChange,
  onEpicenterLoadingChange,
  mapSelectSignal,
  uiScale = 1,
  onCurrentLocationChange, // 気象タブ「地点」モードでGPS取得できた現在地をApp側(地図の青丸表示用)に伝える
  onNowcastChange, // 雨雲レーダーがON中の現在の時刻コマをApp側(地図の雨雲レイヤー表示用)に伝える
  onPrecipChange, // 1/3/24時間降水量がON中の現在のモード・時刻コマをApp側(地図の降水量レイヤー表示用)に伝える
  onWdistChange, // 天気分布予報がON中の現在の時刻コマをApp側(地図の天気分布レイヤー表示用)に伝える
  onTyphoonChange, // 台風情報がON中の現在のgeojsonをApp側(地図の台風レイヤー表示用)に伝える
  onSelectTyphoon, // 台風一覧の項目をタップした時に呼ぶ(App側で地図をflyTo)
  selectedTyphoonInfo, // 時刻チップ/台風一覧の項目をタップして選択中の台風詳細情報。App側で保持
  onClearSelectedTyphoon, // 台風詳細の選択解除(戻るボタン・フローティングを閉じた時)に呼ぶ
  onSelectTyphoonDetail, // 詳細カード内の予報タイムラインで別の時刻をタップした時に呼ぶ
  warningLevelMap = {}, // 警報タブ: regioncode → {level, kinds} のマップ
  warningAreaByRegioncode = {}, // 警報タブ: regioncode → {name, lat, lon} の名称マスタ
  selectedWarningArea, // 警報タブ: タップ/一覧選択中のregioncode | null
  onSelectWarningAreaFromList, // 警報タブ: 一覧の項目をタップした時に呼ぶ(選択+flyTo)
  onBackFromWarningArea, // 警報タブ: 詳細カードの「戻る」ボタンを押した時に呼ぶ
  onAlertLayerChange, // 警報タブ: くの字メニューでキキクル(土砂/浸水)を切り替えた時にApp側(地図のキキクルレイヤー表示用)に伝える。"doshaKikkuru" | "inundKikkuru" | null
  onAlertModeChange, // 警報タブ: 「今どの項目が選ばれているか」を常に伝える("doshaKikkuru" | "inundKikkuru" | "riverLevel" | null)。キキクルの時刻コマ通知(onAlertLayerChange)とは独立していて、river水位選択中にnullで巻き戻されたりしない。
  onRiverLayerChange, // 警報タブ: くの字メニューで「河川水位」を選択した時にApp側(地図の河川水位レイヤー表示用)に伝える。GeoJSON FeatureCollection | null
  selectedRiverStation = null, // 警報タブ: タップ中の河川水位観測所のproperties | null
  onSelectRiverStation, // 警報タブ: 河川水位観測所のピンをタップ/選択解除した時に呼ぶ(App側のstateを更新)
}) {
  const { tokens, mode } = useContext(ThemeContext);
  const { opaque: glassOpaque } = useContext(GlassOpaqueContext);

  const HANDLE_HEIGHT = 18; // ハンドル行の固定高さ(スクロールに巻き込まれず常に上部に固定)。
                            // 地震タブでは直下のQuakeListToolbarが縦ドラッグをこのハンドルへ
                            // 引き渡す(onHandoffToPanelDrag)ため、ハンドル自体を広げる必要はない。
  const isWide = useIsWideLayout(); // 横画面スマホ・タブレット・PCなどの広い画面かどうか
  const scrollRef = useRef(null);

  // 一覧⇄検索の切り替えや地震の選択/選択解除など、表示中身が切り替わって
  // scrollRef自体がkeyごと作り直される直前に呼ぶ。「勢いよくスクロールした
  // 直後に切り替える」と、iOSの慣性スクロール(フリック後の減速アニメーション)が
  // 古い要素に対してまだ動いている場合があり、key変更によるDOM要素の作り直しが
  // 1フレーム遅れるだけでも新しい要素側に慣性が乗り移って見えることがあるため、
  // 切り替えの直前にoverflowをhiddenにして慣性スクロールを即座に断ち切っておく
  // (新しい要素はstyle指定で改めてoverflow: autoになるので支障はない)。
  function killScrollMomentum() {
    // overflowをhidden→autoと切り替えて慣性スクロールを断ち切る方式は、
    // iOS Safariでボタン要素(地震一覧の各行など)がスクロールをまったく
    // 受け付けなくなる不具合の原因になっていたため廃止した。
    // スクロール位置の復元はuseLayoutEffect側でscrollTopを直接設定するだけで
    // 十分実用上問題なく、慣性も自然に収まる。
  }

  const colorSchemeId = useContext(QuakeColorSchemeContext);
  const colorScheme = QUAKE_COLOR_SCHEMES[colorSchemeId] || QUAKE_COLOR_SCHEMES.fill;
  const nowcastColorSchemeId = useContext(NowcastColorSchemeContext);

  // 設定タブ内の階層メニューの現在地。[] = トップメニュー、["quake"] = 地震カテゴリの
  // メニュー、["quake","colorScheme"] = 震度配色の中身、のようにパスで表現する。
  // 設定タブ以外に移動したら、次に開いた時は必ずトップメニューから始まるようにリセットする。
  const [settingsPath, setSettingsPath] = useState([]);
  useEffect(() => {
    if (active !== "settings") setSettingsPath([]);
  }, [active]);

  // 設定内の画面を切り替えるたびに、スクロール位置(共有の1本のscrollRef)を
  // 先頭へ戻す。そうしないと、例えば「利用規約」を下までスクロールした状態で
  // 「注意事項」に切り替えた時、同じスクロール位置が引き継がれてしまう。
  function handleSettingsNavigate(nextPath) {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setSettingsPath(nextPath);
  }

  // 横画面(isWide)では、戻るボタンをガラスの外に浮かせて表示するため、
  // パネル本体(GlassOrPlainの中身)の画面上の位置を測っておく。
  const wideContentRef = useRef(null);
  const [wideAnchorRect, setWideAnchorRect] = useState(null);
  useLayoutEffect(() => {
    if (!isWide) { setWideAnchorRect(null); return; }
    const update = () => {
      if (wideContentRef.current) setWideAnchorRect(wideContentRef.current.getBoundingClientRect());
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [isWide, active, selectedQuakeId, settingsPath]);

  // 地震タブの表示モード。"recent" = 直近の地震一覧(P2P地震情報フィード)、
  // "search" = 気象庁 震度データベースを検索するUI。
  // タブを離れたら次に開いた時は必ず「一覧」から始まるようにリセットする。
  // ただし、検索結果から地震を選択して詳細カードを表示している間に他のタブへ
  // 移動した場合はリセットしない。ここでリセットしてしまうと、タブを行き来して
  // 地震タブに戻ってきた時点では detail カードがそのまま表示され続けるため
  // 気づきにくいが、その後「戻る」を押した瞬間にquakeViewModeが既に"recent"に
  // 書き換わっており、本来戻るべき検索結果ではなく直近一覧に戻ってしまう
  // (=検索経由で選択→他タブ→戻る→「戻る」ボタンでリストタブになる不具合)。
  const [quakeViewMode, setQuakeViewMode] = useState("recent"); // "recent" | "search"
  useEffect(() => {
    if (active !== "quake" && selectedQuakeId == null) setQuakeViewMode("recent");
  }, [active, selectedQuakeId]);

  // 気象タブの表示内容は常に「地点」の中身(WeatherLocationPanel)のみ。
  // 以前あった「地点」⇄「一覧」の上部切り替えバーは廃止した(雨雲レーダーは
  // 下のweatherMenuOpenのフローティングボタンから、気象タブにいる間いつでも
  // 開けるようにしたため、モードを分ける必要が無くなった)。

  // 雨雲レーダー等のメニュー(右下に浮かぶ、展開式のフローティングボタン)の
  // 開閉状態。気象タブにいる間はいつでも出しておき、タブを離れたら閉じておく。
  const [weatherMenuOpen, setWeatherMenuOpen] = useState(true);
  useEffect(() => {
    // 気象タブに入るたびに開いた状態にする(離れたら閉じる)。マウント時点の
    // activeが最初から"weather"とは限らない(既定タブは別にある)ため、
    // 初期値をtrueにしただけでは、このeffectが最初に走った時点で
    // すぐfalseに上書きされてしまっていた。
    setWeatherMenuOpen(active === "weather");
  }, [active]);

  /* ─────────────────────────────────────────────────────
     雨雲レーダー(高解像度降水ナウキャスト)。ONにするたびに実況+予測の時刻
     一覧を取り直し、デフォルトは最新の実況コマを表示する。JMAのナウキャストは
     5分おきに更新されるため、表示中も5分おきに一覧を取り直して追従させる
     (これが無いと、開きっぱなしで放置した時にスライダーの時刻表示が実際の
     時刻からどんどんずれていってしまう)。ONの間だけApp側(地図の雨雲レイヤー
     表示用)に現在のコマを伝える。
     ───────────────────────────────────────────────────── */
  const [nowcastEnabled, setNowcastEnabled] = useState(false);
  const [nowcastFrames, setNowcastFrames] = useState(null); // null=未読込
  const [nowcastFrameIndex, setNowcastFrameIndex] = useState(null);
  const [nowcastLoadError, setNowcastLoadError] = useState(false);
  // 一覧の再取得時、直前に選んでいたコマを引き継ぐために使う(effectの
  // 依存配列にnowcastFrames/nowcastFrameIndexを入れると再取得タイマーが
  // 毎回リセットされてしまうため、refで最新値を追いかける)。
  const nowcastFramesRef = useRef(null);
  const nowcastFrameIndexRef = useRef(null);
  useEffect(() => { nowcastFramesRef.current = nowcastFrames; }, [nowcastFrames]);
  useEffect(() => { nowcastFrameIndexRef.current = nowcastFrameIndex; }, [nowcastFrameIndex]);

  useEffect(() => {
    if (!nowcastEnabled) {
      // OFFにした一覧を使い回さない。次にONにした時に必ず最新を取り直す。
      setNowcastFrames(null);
      setNowcastFrameIndex(null);
      setNowcastLoadError(false);
      return;
    }
    let cancelled = false;
    const fetchAndApply = () => {
      loadNowcastFrames()
        .then((frames) => {
          if (cancelled) return;
          setNowcastLoadError(false);
          let latestObsIndex = -1;
          frames.forEach((f, i) => { if (f.kind === "obs") latestObsIndex = i; });
          let nextIndex = latestObsIndex >= 0 ? latestObsIndex : 0;

          const prevFrames = nowcastFramesRef.current;
          const prevIndex = nowcastFrameIndexRef.current;
          if (prevFrames && prevIndex != null) {
            let prevLatestObsIndex = -1;
            prevFrames.forEach((f, i) => { if (f.kind === "obs") prevLatestObsIndex = i; });
            const wasFollowingLatest = prevIndex === prevLatestObsIndex;
            // 過去のコマを手動で選んで見ていた場合(=最新追従中でなかった場合)は、
            // 更新後の一覧に同じvalidtimeのコマがあればそこへ選択を維持する。
            // 無くなっていれば(実況の一覧から溢れて消えた等)最新の実況へ戻す。
            if (!wasFollowingLatest) {
              const prevFrame = prevFrames[prevIndex];
              const sameIdx = prevFrame
                ? frames.findIndex(f => f.kind === prevFrame.kind && f.validtime === prevFrame.validtime)
                : -1;
              if (sameIdx >= 0) nextIndex = sameIdx;
            }
          }

          setNowcastFrames(frames);
          setNowcastFrameIndex(nextIndex);
        })
        .catch((err) => {
          console.error("雨雲レーダーの時刻一覧の取得に失敗:", err);
          if (!cancelled) setNowcastLoadError(true);
        });
    };
    fetchAndApply();
    const intervalId = setInterval(fetchAndApply, 5 * 60 * 1000); // 5分おきに追従
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [nowcastEnabled]);

  const currentNowcastFrame =
    nowcastFrames && nowcastFrameIndex != null ? nowcastFrames[nowcastFrameIndex] : null;

  // 先読みを一旦廃止し、今見ているコマだけを読み込むようにする。
  // (元の「前後NOWCAST_PRELOAD_RADIUSコマぶん先読み」ロジックはコメントアウトで
  // 残してあるので、戻す時はここを差し替えるだけでよい。)
  const nowcastPreloadFrames = useMemo(() => [], []);
  // const nowcastPreloadFrames = useMemo(() => {
  //   if (!nowcastFrames || nowcastFrameIndex == null) return [];
  //   const start = Math.max(0, nowcastFrameIndex - NOWCAST_PRELOAD_RADIUS);
  //   const end = Math.min(nowcastFrames.length - 1, nowcastFrameIndex + NOWCAST_PRELOAD_RADIUS);
  //   const result = [];
  //   for (let i = start; i <= end; i++) if (i !== nowcastFrameIndex) result.push(nowcastFrames[i]);
  //   return result;
  // }, [nowcastFrames, nowcastFrameIndex]);
  const nowcastPreloadKey = nowcastPreloadFrames.map(f => f.validtime).join(",");

  useEffect(() => {
    onNowcastChange?.(
      nowcastEnabled && currentNowcastFrame
        ? {
            frame: currentNowcastFrame,
            preloadFrames: nowcastPreloadFrames,
            // 実況+予測の全validtime。予測コマは5分おきの一覧更新のたびに
            // (「今から60分先まで」で毎回ほぼ丸ごと)入れ替わるため、地図側の
            // キャッシュにこの一覧を渡して、もう存在しない予測コマのレイヤーを
            // 掃除できるようにする(でないと予測コマのキャッシュが更新のたびに
            // 溜まり続けてしまう)。
            knownValidtimes: nowcastFrames.map(f => f.validtime),
          }
        : null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowcastEnabled, currentNowcastFrame?.basetime, currentNowcastFrame?.validtime, nowcastPreloadKey, nowcastFrames, onNowcastChange]);

  /* ─────────────────────────────────────────────────────
     1時間・3時間・24時間降水量(今後の雨・降水短時間予報)。
     precipMode("precip1h"|"precip3h"|"precip24h"|null)はラジオボタン的な
     排他選択(3つ同時にはONにならない)。雨雲レーダーとも排他で、どちらかを
     ONにするともう片方は自動でOFFになる(exclusivityはhandleToggleWeatherMenuItem
     側で処理)。ON中は雨雲レーダーと同じく5分おきに一覧を再取得して追従させる。
     ───────────────────────────────────────────────────── */
  const [precipMode, setPrecipMode] = useState(null);
  const [precipFrames, setPrecipFrames] = useState(null); // null=未読込
  const [precipFrameIndex, setPrecipFrameIndex] = useState(null);
  const [precipLoadError, setPrecipLoadError] = useState(false);
  const precipFramesRef = useRef(null);
  const precipFrameIndexRef = useRef(null);
  useEffect(() => { precipFramesRef.current = precipFrames; }, [precipFrames]);
  useEffect(() => { precipFrameIndexRef.current = precipFrameIndex; }, [precipFrameIndex]);

  useEffect(() => {
    if (!precipMode) {
      setPrecipFrames(null);
      setPrecipFrameIndex(null);
      setPrecipLoadError(false);
      return;
    }
    let cancelled = false;
    const fetchAndApply = () => {
      loadPrecipFrames(precipMode)
        .then((frames) => {
          if (cancelled) return;
          setPrecipLoadError(false);
          // 「現在」に相当するコマが分からない(kindの区別が無い)データなので、
          // 現在時刻に一番近いコマを暫定的な基準にする。
          let nextIndex = nowcastNearestIndexToNow(frames);

          const prevFrames = precipFramesRef.current;
          const prevIndex = precipFrameIndexRef.current;
          if (prevFrames && prevIndex != null && frames.length > 0) {
            const prevNearestIndex = nowcastNearestIndexToNow(prevFrames);
            const wasFollowingLatest = prevIndex === prevNearestIndex;
            // 過去のコマを手動で選んで見ていた場合は、更新後の一覧に同じ
            // validtimeのコマがあればそこへ選択を維持する。無くなっていれば
            // 現在時刻に一番近いコマへ戻す。
            if (!wasFollowingLatest) {
              const prevFrame = prevFrames[prevIndex];
              const sameIdx = prevFrame ? frames.findIndex(f => f.validtime === prevFrame.validtime) : -1;
              if (sameIdx >= 0) nextIndex = sameIdx;
            }
          }

          setPrecipFrames(frames);
          setPrecipFrameIndex(nextIndex);
        })
        .catch((err) => {
          console.error(`降水量[${precipMode}]の時刻一覧の取得に失敗:`, err);
          if (!cancelled) setPrecipLoadError(true);
        });
    };
    fetchAndApply();
    const intervalId = setInterval(fetchAndApply, 5 * 60 * 1000); // 5分おきに追従
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [precipMode]);

  const currentPrecipFrame =
    precipFrames && precipFrameIndex != null ? precipFrames[precipFrameIndex] : null;

  useEffect(() => {
    onPrecipChange?.(
      precipMode && currentPrecipFrame
        ? { mode: precipMode, frame: currentPrecipFrame, knownValidtimes: precipFrames.map(f => f.validtime) }
        : null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [precipMode, currentPrecipFrame?.basetime, currentPrecipFrame?.validtime, precipFrames, onPrecipChange]);

  /* ─────────────────────────────────────────────────────
     天気分布予報(天気分布・気温分布)。wdistMode("weather"|"temperature"|null)は
     ラジオボタン的な排他選択で、雨雲レーダー・1/3/24時間降水量とも全て排他
     (exclusivityはhandleToggleWeatherMenuItem側で処理)。データの更新自体は
     1日3回(5時・11時・17時)だが、一覧の取得ロジックは降水量と揃えて
     5分おきの再確認にしている(新しい発表を取りこぼさないようにするための
     ポーリングであり、実際に中身が変わるのは1日3回だけ)。
     ───────────────────────────────────────────────────── */
  const [wdistMode, setWdistMode] = useState(null);
  const [wdistFrames, setWdistFrames] = useState(null);
  const [wdistFrameIndex, setWdistFrameIndex] = useState(null);
  const [wdistLoadError, setWdistLoadError] = useState(false);
  const wdistFramesRef = useRef(null);
  const wdistFrameIndexRef = useRef(null);
  useEffect(() => { wdistFramesRef.current = wdistFrames; }, [wdistFrames]);
  useEffect(() => { wdistFrameIndexRef.current = wdistFrameIndex; }, [wdistFrameIndex]);

  useEffect(() => {
    if (!wdistMode) {
      setWdistFrames(null);
      setWdistFrameIndex(null);
      setWdistLoadError(false);
      return;
    }
    let cancelled = false;
    const fetchAndApply = () => {
      loadWdistFrames(wdistMode)
        .then((frames) => {
          if (cancelled) return;
          setWdistLoadError(false);
          let nextIndex = nowcastNearestIndexToNow(frames);

          const prevFrames = wdistFramesRef.current;
          const prevIndex = wdistFrameIndexRef.current;
          if (prevFrames && prevIndex != null && frames.length > 0) {
            const prevNearestIndex = nowcastNearestIndexToNow(prevFrames);
            const wasFollowingLatest = prevIndex === prevNearestIndex;
            if (!wasFollowingLatest) {
              const prevFrame = prevFrames[prevIndex];
              const sameIdx = prevFrame ? frames.findIndex(f => f.validtime === prevFrame.validtime) : -1;
              if (sameIdx >= 0) nextIndex = sameIdx;
            }
          }

          setWdistFrames(frames);
          setWdistFrameIndex(nextIndex);
        })
        .catch((err) => {
          console.error(`天気分布予報[${wdistMode}]の時刻一覧の取得に失敗:`, err);
          if (!cancelled) setWdistLoadError(true);
        });
    };
    fetchAndApply();
    const intervalId = setInterval(fetchAndApply, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [wdistMode]);

  const currentWdistFrame =
    wdistFrames && wdistFrameIndex != null ? wdistFrames[wdistFrameIndex] : null;

  useEffect(() => {
    onWdistChange?.(
      wdistMode && currentWdistFrame
        ? { mode: wdistMode, frame: currentWdistFrame, knownValidtimes: wdistFrames.map(f => f.validtime) }
        : null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wdistMode, currentWdistFrame?.basetime, currentWdistFrame?.validtime, wdistFrames, onWdistChange]);

  /* ─────────────────────────────────────────────────────
     台風情報。ONにするたびに気象庁 台風情報API(bosai/typhoon)を取得し直し、
     ON中は毎時0分10秒(気象庁の発表タイミングに合わせた台風スケジューラーと
     同じ考え方)に自動更新して追従させる。ONの間だけApp側(地図の台風レイヤー
     表示用)に現在のgeojsonを伝える。一覧パネル用のサマリー配列(typhoonList)
     も同時に保持する。
     ───────────────────────────────────────────────────── */
  const [typhoonEnabled, setTyphoonEnabled] = useState(false);
  const [typhoonGeojson, setTyphoonGeojson] = useState(null);
  const [typhoonList, setTyphoonList] = useState([]);
  const [typhoonLoadError, setTyphoonLoadError] = useState(false);
  // 予報円の表示間隔(時間)。設定タブ(気象カテゴリ)から変更でき、localStorageに保存する。
  const [typhoonForecastIntervalHours, setTyphoonForecastIntervalHoursState] = useState(loadStoredTyphoonForecastInterval);
  function handleChangeTyphoonForecastIntervalHours(hours) {
    setTyphoonForecastIntervalHoursState(hours);
    saveTyphoonForecastInterval(hours);
  }

  useEffect(() => {
    if (!typhoonEnabled) {
      setTyphoonGeojson(null);
      setTyphoonList([]);
      setTyphoonLoadError(false);
      return;
    }
    let cancelled = false;
    let timeoutId = null;

    const fetchAndApply = () => {
      fetchTyphoonData(typhoonForecastIntervalHours)
        .then(({ geojson, list }) => {
          if (cancelled) return;
          setTyphoonLoadError(false);
          setTyphoonGeojson(geojson);
          setTyphoonList(list);
        })
        .catch((err) => {
          console.error("台風情報の取得に失敗:", err);
          if (!cancelled) setTyphoonLoadError(true);
        });
    };
    // 毎時0分10秒に次回実行を予約する(気象庁の台風情報の発表タイミングに合わせた遅延)
    const scheduleNext = () => {
      const now = Date.now();
      const HOUR_MS = 60 * 60 * 1000;
      const nextTick = Math.ceil(now / HOUR_MS) * HOUR_MS + 10_000;
      const wait = Math.max(1000, nextTick - now);
      timeoutId = setTimeout(() => {
        fetchAndApply();
        scheduleNext();
      }, wait);
    };
    fetchAndApply();
    scheduleNext();
    return () => { cancelled = true; if (timeoutId) clearTimeout(timeoutId); };
  }, [typhoonEnabled, typhoonForecastIntervalHours]);


  useEffect(() => {
    onTyphoonChange?.(typhoonEnabled && typhoonGeojson ? typhoonGeojson : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typhoonEnabled, typhoonGeojson, onTyphoonChange]);

  // 「台風情報」ボタン自体を、台風が1つも発生していない間は表示しないためのフラグ。
  // typhoonEnabled(トグルON)とは独立に、まずtargetTc.jsonだけの軽い問い合わせで
  // 「そもそも対象の台風があるか」を確認する(ボタンを出すかどうかの判定自体に、
  // トグルをONにしないと分からないのでは意味が無いため)。
  const [hasActiveTyphoons, setHasActiveTyphoons] = useState(null); // null=未確認
  useEffect(() => {
    let cancelled = false;
    let timeoutId = null;
    const check = () => {
      fetchActiveTyphoonExists()
        .then((exists) => { if (!cancelled) setHasActiveTyphoons(exists); })
        .catch(() => { if (!cancelled) setHasActiveTyphoons(false); });
    };
    // 台風データ本体と同じく、毎時0分10秒に次回実行を予約する。
    const scheduleNext = () => {
      const now = Date.now();
      const HOUR_MS = 60 * 60 * 1000;
      const nextTick = Math.ceil(now / HOUR_MS) * HOUR_MS + 10_000;
      const wait = Math.max(1000, nextTick - now);
      timeoutId = setTimeout(() => { check(); scheduleNext(); }, wait);
    };
    check();
    scheduleNext();
    return () => { cancelled = true; if (timeoutId) clearTimeout(timeoutId); };
  }, []);
  // 台風が1つも無くなった時、ONのままだったトグルは自動でOFFに戻す。
  // (ボタンごとメニューから消えるので、そのままだと操作で戻せなくなるため。)
  useEffect(() => {
    if (hasActiveTyphoons === false && typhoonEnabled) setTyphoonEnabled(false);
  }, [hasActiveTyphoons, typhoonEnabled]);

  /* ─────────────────────────────────────────────────────
     気象タブ「地点」モード — 現在地(GPS)または登録地点(1件のみ)の天気予報。
     GPSは「地点」モードを実際に見ている間だけwatchPositionで追跡し、それ以外
     (タブを離れた・一覧モードに切り替えた)は追跡を止めてバッテリー消費を避ける。
     どちらの予報を表示するかは自動フォールバックではなく、パネル上部の
     「現在地/登録地点」ボタン(weatherSourceMode)で利用者が明示的に選ぶ。

     位置情報の利用目的が伝わらないままいきなりブラウザの許可ダイアログが出ると、
     何のために・どう使われるのかが利用者に伝わらず誤解を招きかねない。そのため、
     初めて「地点」モードを開いた時はブラウザに許可を求める前にアプリ内で目的を
     説明する画面(WeatherLocationPanel側の「awaiting-consent」表示)を挟み、
     利用者が明示的に「現在地を使う」を選んでから初めてgeolocationを呼び出す。
     一度許可した後は、次回以降この説明を省略する(localStorageに記憶)。
     ───────────────────────────────────────────────────── */
  const weatherLocationActive = active === "weather";

  const WEATHER_LOCATION_CONSENT_KEY = "meteoquake_weather_location_consented_v1";
  const [weatherLocationConsented, setWeatherLocationConsentedState] = useState(() => {
    try { return localStorage.getItem(WEATHER_LOCATION_CONSENT_KEY) === "1"; } catch { return false; }
  });
  const markWeatherLocationConsented = useCallback(() => {
    setWeatherLocationConsentedState(true);
    try { localStorage.setItem(WEATHER_LOCATION_CONSENT_KEY, "1"); } catch {}
  }, []);
  // 一度ブラウザ側の許可を拒否/無視した後でも、後からもう一度説明画面に
  // 戻れるようにするための取り消し。ブラウザの許可設定自体はここでは変えられない
  // (それは各ブラウザのサイト設定からしか変更できない)が、少なくともアプリ側で
  // 「詰んで二度と設定できない」状態にはしない。
  const resetWeatherLocationConsent = useCallback(() => {
    setWeatherLocationConsentedState(false);
    try { localStorage.removeItem(WEATHER_LOCATION_CONSENT_KEY); } catch {}
  }, []);

  // status: "idle"(見ていない) | "awaiting-consent"(説明を表示中、まだブラウザには
  // 要求していない) | "loading" | "ready" | "error" | "unsupported"
  const [geoState, setGeoState] = useState({ status: "idle", coords: null, error: null });

  // iOS Safari等のブラウザでは、位置情報のブラウザ許可ダイアログは「利用者の
  // クリック操作の中で直接geolocationを呼び出した場合」しか出ない。useEffect側
  // (クリックとは別の非同期タイミング)から初回のリクエストを投げると、許可待ちの
  // "ユーザー操作あり"扱いにならず、ダイアログが出ないまま静かに失敗することがある。
  // そのため、初回の許可要求(=ボタンのonClickから直接呼ぶ)はgetCurrentPositionで
  // 同期的に行い、既に許可済み(weatherLocationConsented)の場合の継続的な追跡だけを
  // 下のuseEffectのwatchPositionに任せる。
  const requestWeatherLocationPermission = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setGeoState({ status: "unsupported", coords: null, error: null });
      return;
    }
    setGeoState(s => ({ status: "loading", coords: s.coords, error: null }));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        markWeatherLocationConsented();
        setGeoState({
          status: "ready",
          coords: { lat: pos.coords.latitude, lon: pos.coords.longitude },
          error: null,
        });
      },
      (err) => {
        setGeoState(s => ({ status: "error", coords: s.coords, error: err }));
      },
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 15000 }
    );
  }, [markWeatherLocationConsented]);

  useEffect(() => {
    if (!weatherLocationActive) {
      setGeoState(s => (s.status === "idle" ? s : { status: "idle", coords: null, error: null }));
      return;
    }
    if (!("geolocation" in navigator)) {
      setGeoState({ status: "unsupported", coords: null, error: null });
      return;
    }
    if (!weatherLocationConsented) {
      // まだ一度も許可されていない場合は、ここでは何もしない(呼び出すと許可
      // ダイアログが出ないブラウザがあるため)。ボタンのonClickから直接
      // requestWeatherLocationPermissionを呼んでもらうまで説明画面のまま待つ。
      setGeoState(s => (s.status === "awaiting-consent" ? s : { status: "awaiting-consent", coords: null, error: null }));
      return;
    }
    // 既に許可済みなら、ここから継続的な追跡(watchPosition)を始めてよい。
    // 許可済みの状態でのgeolocation呼び出しはユーザー操作なしでも動く。
    setGeoState(s => ({ status: "loading", coords: s.coords, error: null }));
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setGeoState(s => {
          const next = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          if (s.status === "ready" && s.coords) {
            // GPSは数メートル単位で常に細かく揺らぐため、座標オブジェクトを毎回
            // 作り直すと(下流のactiveWeatherPoint→天気予報の再取得の
            // useEffectが依存しているlat/lonが毎回変わったと誤認識し)数秒おきに
            // 天気予報を取り直してフローティングがちらつく/読み込み直したように
            // 見えてしまう。実質的に同じ場所とみなせる範囲(約300m未満の移動)
            // なら、座標はあえて更新しない。
            const movedKm2 = fastDist2(s.coords.lat, s.coords.lon, next.lat, next.lon);
            if (movedKm2 < 0.3 * 0.3) return s;
          }
          return { status: "ready", coords: next, error: null };
        });
      },
      (err) => {
        setGeoState(s => ({ status: "error", coords: s.coords, error: err }));
      },
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 15000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [weatherLocationActive, weatherLocationConsented]);

  // App側(地図の現在地マーカー=青丸の表示用)に、GPSで取れている間だけ座標を伝える。
  // このタブ・このモードを見ていない間や、GPSが使えない間はnullを伝えて地図から消す。
  useEffect(() => {
    onCurrentLocationChange?.(
      weatherLocationActive && geoState.status === "ready" ? geoState.coords : null
    );
  }, [weatherLocationActive, geoState.status, geoState.coords, onCurrentLocationChange]);

  // GPS座標から、市区町村境界データ(warning_areas.json)を使って現在地の
  // 市区町村名を逆引きする。あくまで表示用(「現在地」の代わりに「港区」のように
  // 出すため)で、天気予報の取得自体は従来通り最寄りアメダス地点ベースで行う。
  const [currentMunicipalityName, setCurrentMunicipalityName] = useState(null);
  useEffect(() => {
    if (!(weatherLocationActive && geoState.status === "ready" && geoState.coords)) {
      setCurrentMunicipalityName(null);
      return;
    }
    let cancelled = false;
    findMunicipalityAtPoint(geoState.coords.lat, geoState.coords.lon)
      .then((props) => { if (!cancelled) setCurrentMunicipalityName(props ? props.regionname : null); })
      .catch((err) => { console.error("現在地の市区町村名の逆引きに失敗:", err); if (!cancelled) setCurrentMunicipalityName(null); });
    return () => { cancelled = true; };
  }, [weatherLocationActive, geoState.status, geoState.coords]);

  // 登録地点(1件のみ)。{ name(=都道府県+市区町村), lat, lon, regioncode } | null。
  // 他の設定と同様localStorageに保存し、次回起動時も覚えておく。
  const REGISTERED_WEATHER_POINT_KEY = "meteoquake_registered_weather_point_v1";
  const [registeredWeatherPoint, setRegisteredWeatherPointState] = useState(() => {
    try {
      const saved = localStorage.getItem(REGISTERED_WEATHER_POINT_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });
  const setRegisteredWeatherPoint = useCallback((next) => {
    setRegisteredWeatherPointState(next);
    try {
      if (next) localStorage.setItem(REGISTERED_WEATHER_POINT_KEY, JSON.stringify(next));
      else localStorage.removeItem(REGISTERED_WEATHER_POINT_KEY);
    } catch {}
  }, []);

  // 「現在地」と「登録地点」のどちらの予報を表示するか。パネル上部のボタンで
  // 明示的に切り替える(以前のような「GPSが使えなければ自動で登録地点に
  // フォールバック」はせず、利用者が選んだ方をそのまま表示する)。
  const [weatherSourceMode, setWeatherSourceMode] = useState("gps"); // "gps" | "registered"

  // 実際に予報を取りに行く対象地点。選択中のモードに対応する地点が無ければnull
  // (=予報を取りに行かない、パネル側で案内を出す)。
  const activeWeatherPoint = useMemo(() => {
    if (weatherSourceMode === "registered") {
      if (!registeredWeatherPoint) return null;
      return { source: "registered", lat: registeredWeatherPoint.lat, lon: registeredWeatherPoint.lon, name: registeredWeatherPoint.name };
    }
    if (geoState.status === "ready" && geoState.coords) {
      return { source: "gps", lat: geoState.coords.lat, lon: geoState.coords.lon };
    }
    return null;
  }, [weatherSourceMode, geoState.status, geoState.coords, registeredWeatherPoint]);

  // { status: "idle"|"loading"|"ready"|"error", data, error } — activeWeatherPointが
  // 変わるたび(GPSで動いた・登録地点を変えた・モードを切り替えた等)取り直す。
  const [weatherForecastState, setWeatherForecastState] = useState({ status: "idle", data: null });
  useEffect(() => {
    if (!weatherLocationActive || !activeWeatherPoint) {
      setWeatherForecastState({ status: "idle", data: null });
      return;
    }
    let cancelled = false;
    setWeatherForecastState(s => ({ status: "loading", data: s.data }));
    fetchCurrentLocationForecast(activeWeatherPoint.lat, activeWeatherPoint.lon)
      .then((data) => { if (!cancelled) setWeatherForecastState({ status: "ready", data }); })
      .catch((err) => {
        console.error("現在地の天気予報の取得に失敗:", err);
        if (!cancelled) setWeatherForecastState({ status: "error", data: null });
      });
    return () => { cancelled = true; };
  }, [weatherLocationActive, activeWeatherPoint?.source, activeWeatherPoint?.lat, activeWeatherPoint?.lon]);

  // 地域時系列予報(3時間ごとの天気・風・気温)。通常の天気予報の取得が終わって
  // class10Codeが分かってから、追加でもう1件取りに行く。
  const [timeSeriesState, setTimeSeriesState] = useState({ status: "idle", data: null });
  useEffect(() => {
    const class10Code = weatherForecastState.status === "ready" ? weatherForecastState.data?.class10Code : null;
    if (!weatherLocationActive || !class10Code) {
      setTimeSeriesState({ status: "idle", data: null });
      return;
    }
    let cancelled = false;
    setTimeSeriesState(s => ({ status: "loading", data: s.data }));
    fetchAreaTimeSeries(class10Code)
      .then((data) => { if (!cancelled) setTimeSeriesState({ status: "ready", data }); })
      .catch((err) => {
        console.error("地域時系列予報の取得に失敗:", err);
        if (!cancelled) setTimeSeriesState({ status: "error", data: null });
      });
    return () => { cancelled = true; };
  }, [weatherLocationActive, weatherForecastState.status, weatherForecastState.data?.class10Code]);

  /* ─────────────────────────────────────────────────────
     地点登録 — まず都道府県を選び、その都道府県内で五十音順の絞り込み選択
     (あかさたなはまやらわ→あいうえお→一覧)を行う。市区町村の一覧・境界は
     warning_areas.json(1,821市区町村)から読み込み、選んだ市区町村の代表点
     (ポリゴン頂点の単純平均)を登録地点の緯度経度として使う。
     ───────────────────────────────────────────────────── */
  const [kanaPickerOpen, setKanaPickerOpen] = useState(false);
  const [kanaPickerStep, setKanaPickerStep] = useState("prefectures"); // "prefectures" | "rows" | "columns" | "list"
  const [kanaPickerPref, setKanaPickerPref] = useState(null);
  const [kanaPickerRow, setKanaPickerRow] = useState(null);
  const [kanaPickerCol, setKanaPickerCol] = useState(null);
  const [municipalityList, setMunicipalityList] = useState(null); // null=未読込
  const [municipalityListError, setMunicipalityListError] = useState(false);
  useEffect(() => {
    if (!kanaPickerOpen || municipalityList || municipalityListError) return;
    let cancelled = false;
    loadWarningAreaMunicipalities()
      .then((list) => { if (!cancelled) setMunicipalityList(list); })
      .catch((err) => {
        console.error("市区町村一覧の取得に失敗:", err);
        if (!cancelled) setMunicipalityListError(true);
      });
    return () => { cancelled = true; };
  }, [kanaPickerOpen, municipalityList, municipalityListError]);

  // 選んだ都道府県の中だけで五十音グルーピングする。都道府県未選択(prefecturesの
  // 段階)の間はnullのままでよい(その段階ではgroupedを使わないため)。
  const kanaGroupedMunicipalities = useMemo(() => {
    if (!municipalityList || !kanaPickerPref) return null;
    const inPref = municipalityList.filter(m => derivePrefFromEewAreaName(m.regionname) === kanaPickerPref);
    return groupMunicipalitiesByKana(inPref);
  }, [municipalityList, kanaPickerPref]);

  const openKanaPicker = useCallback(() => {
    setKanaPickerStep("prefectures");
    setKanaPickerPref(null);
    setKanaPickerRow(null);
    setKanaPickerCol(null);
    setKanaPickerOpen(true);
  }, []);
  const closeKanaPicker = useCallback(() => setKanaPickerOpen(false), []);

  // 津波タブ版の表示モード。"recent" = 直近の津波情報一覧、
  // "history" = 過去に発表された津波情報一覧(/history APIをoffsetで遡って取得)。
  // 考え方はquakeViewModeと全く同じ(タブを離れたら「一覧」に戻す/選択中は維持)。
  const [tsunamiViewMode, setTsunamiViewMode] = useState("recent"); // "recent" | "history" | "tidegauge"
  useEffect(() => {
    if (active !== "tsunami" && selectedTsunamiId == null) setTsunamiViewMode("recent");
  }, [active, selectedTsunamiId]);

  // App側(地図の潮位計ピン表示用)に、現在のtsunamiViewModeを都度伝える。
  useEffect(() => {
    onTsunamiViewModeChange?.(tsunamiViewMode);
  }, [tsunamiViewMode, onTsunamiViewModeChange]);

  // 「過去」モードを初めて開いた時、まだ何も取得していなければ最初の1ページを取得する。
  useEffect(() => {
    if (
      active === "tsunami" && tsunamiViewMode === "history" &&
      tsunamiHistory && tsunamiHistory.items.length === 0 && tsunamiHistory.status === "idle"
    ) {
      onLoadMoreTsunamiHistory?.();
    }
  }, [active, tsunamiViewMode, tsunamiHistory, onLoadMoreTsunamiHistory]);

  /* ─────────────────────────────────────────────────────
     「↪︎ 津波を引き起こした地震」— 津波カードの右下ボタン。

     判定方法(ユーザー指定の方式):
     1. 選択中の津波情報が属する「一連の津波現象」(最初の警報・注意報・予報〜
        解除まで)を特定する。厳密な系列IDは無いので、直近一覧+過去一覧を
        時刻順に並べ、選択中の情報から過去へ辿って、隣り合う発表の間隔が
        24時間以内で続く限りひとつながりの現象とみなす(24時間以上の空きが
        あればそこで別の現象として区切る)、という簡易ヒューリスティックを使う。
     2. その現象の「最初の発表時刻」の30分前〜その時刻までを検索窓とし、
        気象庁 震度データベース(eqdb)でこの窓に発生した地震を検索する。
     3. 該当した地震のうち、規模(M)が最大のものを「津波を引き起こした地震」
        と特定する。
     4. eqdbで見つからず、かつ第1報の発表から3日以内の現象であれば、eqdbへの
        反映が間に合っていないだけの可能性があるため、代わりにP2P地震情報
        (直近の地震情報フィード)側から同じ時間窓で探し直す
        (findCausingQuakeFromP2p参照)。
     ───────────────────────────────────────────────────── */
  // 形: { [tsunamiId]: { status: "loading"|"done"|"notfound"|"error", quake: card|null } }
  const [causingQuakeState, setCausingQuakeState] = useState({});
  // 現在「引き起こした地震」のカードを表示中の津波ID(nullなら通常の津波カード表示)
  const [showingCausingQuakeFor, setShowingCausingQuakeFor] = useState(null);
  // 引き起こした地震の観測点一覧が「階層表示」設定の時に使う、開いている震度キー
  // (StationPointsListの通常の観測点一覧(stationDetailOpenKey)とは別に持つ)。
  const [causingQuakeStationOpenKey, setCausingQuakeStationOpenKey] = useState(null);
  // 選択中の津波情報が変わったら(別の情報を選び直した/選択解除した)、
  // 「引き起こした地震」の表示は必ず一旦引っ込める(別の津波情報のまま古い結果が
  // 表示され続けるのを防ぐ)。
  useEffect(() => {
    setShowingCausingQuakeFor(null);
    setCausingQuakeStationOpenKey(null);
  }, [selectedTsunamiId]);

  // 表示中の「引き起こした地震」が変わるたび、App側(地図表示用)に通知する。
  // 見つかっていない・読み込み中・選択解除されている間はnullを通知して地図から消す。
  useEffect(() => {
    if (showingCausingQuakeFor == null) {
      onCausingQuakeChange?.(null);
      return;
    }
    const st = causingQuakeState[showingCausingQuakeFor];
    onCausingQuakeChange?.(st && st.status === "done" ? st.quake : null);
  }, [showingCausingQuakeFor, causingQuakeState, onCausingQuakeChange, active]);

  // 「戻る」を押した時に呼ぶ。表示を引っ込めるだけでなく、キャッシュ済みの
  // 結果も消して表示をクリアする(再度ボタンを押すとまた最初から検索し直す)。
  function handleBackFromCausingQuake() {
    setShowingCausingQuakeFor(null);
    setCausingQuakeStationOpenKey(null);
    if (selectedTsunamiId != null) {
      setCausingQuakeState(prev => {
        const next = { ...prev };
        delete next[selectedTsunamiId];
        return next;
      });
    }
  }

  // 津波タブ版の「戻る」ボタン。地震タブのhandleBackFromQuakeと同じ考え方で、
  // 「引き起こした地震」を表示中ならまずそれを閉じて予報区一覧に戻し、
  // 何も開いていなければ津波情報の選択自体を解除して一覧に戻る。
  function handleBackFromTsunami() {
    if (showingCausingQuakeFor != null) {
      handleBackFromCausingQuake();
      return;
    }
    if (selectedTideStationCode != null) {
      onSelectTideStation?.(null);
      return;
    }
    onSelectTsunami(null);
  }
  // 気象メニューの項目トグル共通ハンドラ。項目が増えるたびに個別のprops/分岐を
  // 増やさなくて済むよう、idで振り分ける形にしている。
  // 雨雲レーダー・1/3/24時間降水量・天気分布予報(天気分布/気温分布)は
  // 「地図に重ねる面情報」という意味で互いに全て排他にする(常にこのグループの
  // 中でどれか1つだけが表示される)。天気分布/気温分布同士もラジオボタン的な
  // 排他選択(1/3/24時間降水量と同じ考え方)。台風情報だけはこのグループに
  // 含めず独立(重ねて表示できる)。
  function handleToggleWeatherMenuItem(id) {
    if (id === "precip1h" || id === "precip3h" || id === "precip24h") {
      setPrecipMode(prev => {
        const next = prev === id ? null : id;
        if (next) { setNowcastEnabled(false); setWdistMode(null); }
        return next;
      });
    } else if (id === "typhoonInfo") {
      setTyphoonEnabled(v => !v);
    } else if (id === "rainRadar") {
      setNowcastEnabled(prev => {
        const next = !prev;
        if (next) { setPrecipMode(null); setWdistMode(null); }
        return next;
      });
    } else if (id === "weatherDistribution" || id === "temperatureDistribution") {
      const mode = id === "weatherDistribution" ? "weather" : "temperature";
      setWdistMode(prev => {
        const next = prev === mode ? null : mode;
        if (next) { setPrecipMode(null); setNowcastEnabled(false); }
        return next;
      });
    }
  }
  const weatherMenuItemStates = {
    precip1h: precipMode === "precip1h",
    precip3h: precipMode === "precip3h",
    precip24h: precipMode === "precip24h",
    typhoonInfo: typhoonEnabled,
    rainRadar: nowcastEnabled,
    weatherDistribution: wdistMode === "weather",
    temperatureDistribution: wdistMode === "temperature",
  };
  // 警報タブの「くの字」メニュー(キキクル)版。開閉・選択状態(ラジオボタン的に
  // 1つだけON)に加えて、選択中モードの時刻一覧(riskFrames)・現在のコマ
  // (riskFrameIndex)も持つ。考え方は1/3/24時間降水量(precipMode)と全く同じで、
  // 10分おきに一覧を再取得して追従させる(JMAのキキクルは10分更新)。
  const [alertMenuOpen, setAlertMenuOpen] = useState(false);
  useEffect(() => {
    // 気象タブのweatherMenuOpenと全く同じ考え方。警報タブに入るたびに開いた
    // 状態にする(離れたら閉じる)。
    setAlertMenuOpen(active === "alert");
  }, [active]);
  const [alertLayerMode, setAlertLayerMode] = useState(null); // "doshaKikkuru" | "inundKikkuru" | null
  const [riskFrames, setRiskFrames] = useState(null); // null=未読込
  const [riskFrameIndex, setRiskFrameIndex] = useState(null);
  const [riskLoadError, setRiskLoadError] = useState(false);
  const riskFramesRef = useRef(null);
  const riskFrameIndexRef = useRef(null);
  useEffect(() => { riskFramesRef.current = riskFrames; }, [riskFrames]);
  useEffect(() => { riskFrameIndexRef.current = riskFrameIndex; }, [riskFrameIndex]);

  function handleToggleAlertMenuItem(id) {
    setAlertLayerMode(prev => (prev === id ? null : id));
  }
  const alertMenuItemStates = {
    doshaKikkuru: alertLayerMode === "doshaKikkuru",
    inundKikkuru: alertLayerMode === "inundKikkuru",
    riverLevel: alertLayerMode === "riverLevel",
  };

  // 「今どの項目が選ばれているか」をApp側に常に伝える。alertLayerMode(この
  // BottomDock内のstate)が変わったら即座に、他のeffectの都合(時刻コマの
  // 有無など)に関係なく通知する。
  useEffect(() => {
    onAlertModeChange?.(alertLayerMode);
  }, [alertLayerMode, onAlertModeChange]);

  useEffect(() => {
    // 河川水位はラスタータイル(キキクル)と仕組みが全く違う(GeoJSON点+別effectで
    // 扱う)ので、このeffectでは何もしない(既存のriskFramesはクリアしておく)。
    if (!alertLayerMode || alertLayerMode === "riverLevel") {
      setRiskFrames(null);
      setRiskFrameIndex(null);
      setRiskLoadError(false);
      return;
    }
    let cancelled = false;
    const fetchAndApply = () => {
      loadRiskFrames(alertLayerMode)
        .then((frames) => {
          if (cancelled) return;
          setRiskLoadError(false);
          if (frames.length === 0) { setRiskFrames(frames); setRiskFrameIndex(null); return; }
          // 初期選択・「追従」の基準は常に最新フレーム(旧ツールと同じ)。
          let nextIndex = frames.length - 1;

          const prevFrames = riskFramesRef.current;
          const prevIndex = riskFrameIndexRef.current;
          if (prevFrames && prevIndex != null) {
            const wasFollowingLatest = prevIndex === prevFrames.length - 1;
            // 過去のコマを手動で選んで見ていた場合は、更新後の一覧に同じ
            // validtimeのコマがあればそこへ選択を維持する。無くなっていれば
            // 最新へ戻す。
            if (!wasFollowingLatest) {
              const prevFrame = prevFrames[prevIndex];
              const sameIdx = prevFrame ? frames.findIndex(f => f.validtime === prevFrame.validtime) : -1;
              if (sameIdx >= 0) nextIndex = sameIdx;
            }
          }

          setRiskFrames(frames);
          setRiskFrameIndex(nextIndex);
        })
        .catch((err) => {
          console.error(`キキクル[${alertLayerMode}]の時刻一覧の取得に失敗:`, err);
          if (!cancelled) setRiskLoadError(true);
        });
    };
    fetchAndApply();
    const intervalId = setInterval(fetchAndApply, 10 * 60 * 1000); // 10分おきに追従(JMAの更新周期と同じ)
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [alertLayerMode]);

  const currentRiskFrame =
    riskFrames && riskFrameIndex != null ? riskFrames[riskFrameIndex] : null;

  useEffect(() => {
    onAlertLayerChange?.(
      alertLayerMode && currentRiskFrame
        ? { mode: alertLayerMode, frame: currentRiskFrame, knownValidtimes: riskFrames.map(f => f.validtime) }
        : null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertLayerMode, currentRiskFrame?.basetime, currentRiskFrame?.validtime, riskFrames, onAlertLayerChange]);

  // 河川水位(国管理・主要河川)。キキクルと違いラスタータイルではなく
  // GeoJSONの点データなので、専用のstate・専用のコールバック(onRiverLayerChange)
  // で親(App)に伝える。まずは全国・基準超過(水防団待機水位以上)のみの概観を
  // 10分おきに取得する(市区町村単位の全件表示・観測所詳細は今後の拡張)。
  const [riverStations, setRiverStations] = useState(null); // null=未読込
  const [riverLoadError, setRiverLoadError] = useState(false);
  useEffect(() => {
    if (alertLayerMode !== "riverLevel") {
      setRiverStations(null);
      setRiverLoadError(false);
      return;
    }
    let cancelled = false;
    const fetchAndApply = () => {
      loadRiverOverview()
        .then((geojson) => {
          if (cancelled) return;
          setRiverLoadError(false);
          console.log(`[河川水位] ${geojson?.features?.length ?? 0}件取得`, geojson?.features?.[0]?.properties);
          setRiverStations(geojson);
        })
        .catch((err) => {
          console.error("河川水位(概観)の取得に失敗:", err);
          if (!cancelled) setRiverLoadError(true);
        });
    };
    fetchAndApply();
    const intervalId = setInterval(fetchAndApply, 10 * 60 * 1000); // 10分おきに追従
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [alertLayerMode]);

  useEffect(() => {
    onRiverLayerChange?.(alertLayerMode === "riverLevel" ? riverStations : null);
  }, [alertLayerMode, riverStations, onRiverLayerChange]);

  // 台風タブ版の「戻る」— 詳細カードから一覧表示に戻す。フローティング自体は
  // 閉じない(閉じた時の選択解除は別のuseEffectで扱う)。
  function handleBackFromTyphoon() {
    onClearSelectedTyphoon?.();
  }
  // 詳細カード内の予報タイムラインをタップした時。縦画面では、タイムライン自体が
  // カードの下(スクロールした先)にあることが多いため、選択を切り替えると同時に
  // パネルを一番上までスクロールし、更新された詳細カードがすぐ見えるようにする。
  // 横画面(isWide)はレイアウトが異なり、この配慮は不要なので対象外にする。
  function handleSelectTyphoonDetail(itemInfo) {
    if (!isWide && scrollRef.current) scrollRef.current.scrollTop = 0;
    onSelectTyphoonDetail?.(itemInfo);
  }
  const backFromTsunamiLabel = showingCausingQuakeFor != null
    ? "予報区一覧に戻る"
    : (tsunamiViewMode === "tidegauge" && selectedTideStationCode != null)
    ? "観測点一覧に戻る"
    : "津波情報一覧に戻る";
  // 観測点表示切替ボタンは、「引き起こした地震」が実際に見つかった時だけ出す
  // (読み込み中・見つからなかった時・エラー時は観測点自体が無いので出さない)。
  const causingQuakeFound = showingCausingQuakeFor != null && causingQuakeState[showingCausingQuakeFor]?.status === "done";

  // 現在進行形で有効な(解除されていない)津波情報。App側の同名の計算(地図の
  // 予報区塗り分け用)と同じ考え方で、ここでは「潮位観測点オンオフボタン」を
  // 出すかどうかの判定にだけ使う。
  // tsunamisは新しい順にソート済みなので、一番新しい1件だけを見る。以前は
  // find(t => !t.cancelled)としており、一番新しい報が「解除」だった場合に
  // それを読み飛ばして1つ前の(すでに解除済みの)警報を「現在進行形」として
  // 扱ってしまっていた(解除後も古い警報の表示が残り続けるバグ)。
  const newestTsunami = tsunamis[0] || null;
  const activeTsunami = newestTsunami && !newestTsunami.cancelled ? newestTsunami : null;
  // 潮位観測点の自動表示は、有効な津波情報がある間・かつ「引き起こした地震」を
  // 見ていない間だけ提供する(引き起こした地震を見ている間は、その地震の震度観測点
  // 用に同じボタン枠を使っているため)。

  async function handleFindCausingQuake(tsunamiCard) {
    const id = tsunamiCard.id;
    setShowingCausingQuakeFor(id);
    if (causingQuakeState[id]?.status === "loading" || causingQuakeState[id]?.status === "done") return;
    setCausingQuakeState(prev => ({ ...prev, [id]: { status: "loading", quake: null } }));
    try {
      const allCards = dedupeTsunamiList([...(tsunamis || []), ...(tsunamiHistory?.items || [])]);
      const sorted = [...allCards].sort((a, b) => new Date(a.time) - new Date(b.time));
      const idx = sorted.findIndex(c => c.id === id);
      let episodeStart = idx >= 0 ? new Date(sorted[idx].time) : new Date(tsunamiCard.time);
      const GAP_LIMIT_MS = 24 * 60 * 60 * 1000; // 24時間以上の空きで別の現象とみなす
      for (let i = idx; i > 0; i--) {
        const cur = new Date(sorted[i].time);
        const prevTime = new Date(sorted[i - 1].time);
        if (cur.getTime() - prevTime.getTime() > GAP_LIMIT_MS) break;
        episodeStart = prevTime;
      }

      const winEnd = episodeStart;
      const winStart = new Date(episodeStart.getTime() - 30 * 60 * 1000);
      const pad2 = n => String(n).padStart(2, "0");
      const dateStr = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      const timeStr = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

      const { list, errMsg } = await fetchEqdbSearch({
        startDate: dateStr(winStart), startTime: timeStr(winStart),
        endDate: dateStr(winEnd), endTime: timeStr(winEnd),
        minMag: 0, maxInt: "1", sort: "S3", epi: "99", // S3: 地震の規模(M)の大きい順
      });
      if (!errMsg && list && list.length > 0) {
        const top = list[0]; // 規模が最大の1件
        const [detail, geo] = await Promise.all([fetchEqdbEventCached(top.id), loadGeoData()]);
        if (detail) {
          const card = buildEqdbQuakeCard(detail, top, stations, geo?.areas);
          setCausingQuakeState(prev => ({ ...prev, [id]: { status: "done", quake: card } }));
          return;
        }
      }

      // 気象庁 震度データベース(eqdb)で見つからなかった場合、この現象の発表(第1報)
      // から3日以内であれば、まだデータベースに反映されていないだけの可能性がある。
      // その場合は代わりにP2P地震情報(直近の地震情報フィード)側から同じ時間窓で
      // 探し、見つかればそちらを採用する。
      const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
      const isRecentEpisode = (Date.now() - winEnd.getTime()) <= THREE_DAYS_MS;
      if (isRecentEpisode) {
        const p2pMatch = await findCausingQuakeFromP2p(winStart, winEnd);
        if (p2pMatch) {
          const geo2 = await loadGeoData(); // キャッシュ済みのため実質即座に解決する
          const resolvedPoints = resolveStationPoints(p2pMatch.points, stations, geo2?.areas);
          setCausingQuakeState(prev => ({ ...prev, [id]: { status: "done", quake: { ...p2pMatch, resolvedPoints } } }));
          return;
        }
      }

      setCausingQuakeState(prev => ({ ...prev, [id]: { status: "notfound", quake: null } }));
    } catch (err) {
      console.error("津波を引き起こした地震の検索に失敗:", err);
      setCausingQuakeState(prev => ({ ...prev, [id]: { status: "error", quake: null } }));
    }
  }

  // 「この震源の近傍で発生した地震」パネルを開いている場合の、震源地名。
  // nullなら通常の地震詳細カードを表示し、震源地名(文字列)が入っている間は
  // 代わりにNearbyQuakesPanelを表示する。選択解除(戻るボタンで一覧に戻る等)
  // されたら一緒に閉じる。
  const [nearbyQuakeFor, setNearbyQuakeFor] = useState(null);
  // 「近傍で発生した地震」ボタンを押した、元の地震のID。
  // 近傍一覧から別の地震を選んで詳細を見た後、一覧に「戻る」時にはこのIDの地震を
  // 選択し直す(=一覧を開いていた時点の地震に選択・観測点・凡例を揃える)ために使う。
  // 一覧自体から「戻る」を押して元の地震の詳細に戻ったらクリアする。
  const [nearbyOriginId, setNearbyOriginId] = useState(null);
  // 「各地の震度」の詳細画面(震度キーごとの地域一覧)を開いている場合の、その震度キー。
  // StationPointsList内の✕ボタンだけでなく、フローティングの外にある丸い
  // 「戻る」ボタンでも閉じられるようにするため、stateをここ(親)に持ち上げている。
  const [stationDetailOpenKey, setStationDetailOpenKey] = useState(null);
  // 「この地震の詳細」(発震機構解)画面を開いているかどうか。
  // stationDetailOpenKeyと同様、外の「戻る」ボタンで閉じられるよう親に持ち上げている。
  const [mechDetailOpen, setMechDetailOpen] = useState(false);
  useEffect(() => {
    if (selectedQuakeId == null) {
      setNearbyQuakeFor(null);
      setNearbyOriginId(null);
      setStationDetailOpenKey(null);
      setMechDetailOpen(false);
    }
  }, [selectedQuakeId]);

  /* ─────────────────────────────────────────────────────
     震央分布(地図上に丸で重ねて表示し、タップで選択できるようにする機能)。
     P2P地震一覧(quakes)・近傍地震検索(NearbyQuakesPanel)・データベース検索
     (QuakeSearchPanel)のうち、「今どれを表示中か」に応じて1つだけをMapCanvasに
     渡す。個別の地震を選択して詳細を見ている間は、震源のバツ印だけで十分なため
     分布は消す。
     近傍・検索の2つは、生の一覧に座標が無く、子コンポーネント側で
     バックグラウンド解決した点をonPointsChangeで受け取って保持している。
     ───────────────────────────────────────────────────── */
  const [nearbyEpicenterPoints, setNearbyEpicenterPoints] = useState([]);
  const [searchEpicenterPoints, setSearchEpicenterPoints] = useState([]);
  // 震央分布の丸を、まだ全件分バックグラウンド解決しきっていない間のフラグ。
  // 地図側でローディング表示を出すために使う。
  const [nearbyEpicenterLoading, setNearbyEpicenterLoading] = useState(false);
  const [searchEpicenterLoading, setSearchEpicenterLoading] = useState(false);

  const selectedForMap = quakes.find(q => q.id === selectedQuakeId)
    || (searchQuake && searchQuake.id === selectedQuakeId ? searchQuake : null);

  const activeEpicenterPoints = useMemo(() => {
    if (!epicenterCirclesEnabled) return []; // 設定でOFFなら常に非表示
    if (active !== "quake") return [];
    if (nearbyQuakeFor) return nearbyEpicenterPoints;
    if (selectedForMap) return []; // 個別の地震の詳細表示中は分布を出さない
    if (quakeViewMode === "search") return searchEpicenterPoints;
    return quakes
      .filter(q => Number.isFinite(q.latitude) && Number.isFinite(q.longitude))
      .map(q => ({
        id: q.id,
        latitude: q.latitude,
        longitude: q.longitude,
        magnitude: q.magnitude,
        maxIntensityKey: q.maxIntensity,
        time: q.time,
        depth: q.depth,
        place: q.place,
      }));
  }, [epicenterCirclesEnabled, active, nearbyQuakeFor, nearbyEpicenterPoints, selectedForMap, quakeViewMode, searchEpicenterPoints, quakes]);

  useEffect(() => {
    onEpicenterPointsChange?.(activeEpicenterPoints);
  }, [activeEpicenterPoints]);

  // 震央分布の丸がまだ読み込み中かどうかも、表示中の分布(近傍/検索)に応じて同様に選ぶ。
  const activeEpicenterLoading = useMemo(() => {
    if (!epicenterCirclesEnabled) return false;
    if (active !== "quake") return false;
    if (nearbyQuakeFor) return nearbyEpicenterLoading;
    if (selectedForMap) return false;
    if (quakeViewMode === "search") return searchEpicenterLoading;
    return false;
  }, [epicenterCirclesEnabled, active, nearbyQuakeFor, nearbyEpicenterLoading, selectedForMap, quakeViewMode, searchEpicenterLoading]);

  useEffect(() => {
    onEpicenterLoadingChange?.(activeEpicenterLoading);
  }, [activeEpicenterLoading]);

  // 地震タブの「戻る」ボタン(フローティングの外にある丸ボタン)の挙動。
  // 手前で開いている画面から順に閉じていくスタック式:
  //   1. 「この地震の詳細」(発震機構解)画面を開いていれば、まずそれを閉じる
  //   2. 「各地の震度」の詳細画面(震度キーごとの地域一覧)を開いていれば、それを閉じる
  //   3. 「近傍の地震」一覧を開いていれば、それを閉じる
  //   4. 近傍一覧から選んだ地震の詳細を見ていれば、元の地震の近傍一覧に戻す
  //   5. どれでもなければ、選択解除して一覧に戻る
  // ✕ボタン(StationPointsList内)はこれとは別に残したままにしている。
  function handleBackFromQuake() {
    killScrollMomentum();
    if (mechDetailOpen) {
      setMechDetailOpen(false);
      return;
    }
    if (stationDetailOpenKey != null) {
      setStationDetailOpenKey(null);
      return;
    }
    if (nearbyQuakeFor) {
      setNearbyQuakeFor(null);
      setNearbyOriginId(null);
      setSnapIndex(1);
      return;
    }
    if (nearbyOriginId) {
      // 近傍一覧から選んだ地震の詳細から、一覧に戻る。
      // 選択自体も元の地震に戻すことで、観測点・凡例・地図上のバツ印を
      // 一覧を開いていた時点の地震に揃える(戻さないと、一覧の裏で
      // 選んだ地震のデータがそのまま残ってしまう)。
      const originQuake = quakes.find(q => q.id === nearbyOriginId)
        || (searchQuake && searchQuake.id === nearbyOriginId ? searchQuake : null);
      if (originQuake) {
        pendingNearbyScrollRestoreRef.current = true;
        onSelectQuake(nearbyOriginId);
        setNearbyQuakeFor(originQuake.place);
      } else {
        setNearbyOriginId(null);
      }
      setSnapIndex(3);
      return;
    }
    onSelectQuake(null);
  }
  const backFromQuakeLabel =
    mechDetailOpen ? "地震の詳細に戻る" :
    stationDetailOpenKey != null ? "地震の詳細に戻る" :
    nearbyQuakeFor ? "地震の詳細に戻る" :
    nearbyOriginId ? "近傍地震一覧に戻る" :
    "地震一覧に戻る";

  // 気象庁 震度データベース検索フォーム・結果一覧の状態。
  // QuakeSearchPanel自身の内部state(useState)ではなくここに持たせているのは、
  // 地震を選択すると一覧側(QuakeSearchPanel)がいったんアンマウントされるため
  // (選択中は代わりにQuakeDetailCard等を表示する排他表示になっている)。
  // 「戻る」ボタンで選択解除して一覧に戻った時に、検索結果や入力条件が
  // 消えてしまわないよう、アンマウントされないBottomDock側で保持する。
  const [eqdbSearch, setEqdbSearch] = useState(() => {
    const { start, end } = defaultEqdbDateRange();
    return {
      startDate: start, endDate: end,
      minMag: "0.0", maxInt: "1", sort: "S0", epicenterName: "",
      status: "", isSearching: false, hasSearched: false,
      results: [], loadingId: null,
    };
  });

  // 一覧(未選択状態)のスクロール位置を覚えておくためのref。
  // 地震を選択するとカード表示に排他的に切り替わり(keyが変わり)一覧側のDOM要素
  // ごと作り直されるため、選択した瞬間のスクロール位置を保存しておかないと、
  // 「戻る」で一覧に戻った時に必ず先頭に戻ってしまう。選択操作の直前
  // (handleSelectQuakeForScroll)で保存し、選択解除(戻る)で復元する。
  const listScrollTopRef = useRef(0);
  function handleSelectQuakeForScroll(id) {
    if (scrollRef.current) listScrollTopRef.current = scrollRef.current.scrollTop;
    killScrollMomentum();
    onSelectQuake(id);
    setSnapIndex(1);
  }

  // 津波タブ版のhandleSelectQuakeForScroll。地震タブと同じく、選択した瞬間に
  // パネルの高さを「中」に揃える。
  function handleSelectTsunamiForScroll(id) {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    killScrollMomentum();
    onSelectTsunami(id);
    setSnapIndex(1);
  }

  // 近傍地震一覧のスクロール位置。一覧→他の地震の詳細→一覧、と行き来する際、
  // NearbyQuakesPanel自体はDOMごと作り直される(=スクロール位置は自然には
  // 残らない)ため、一覧から離れる直前に保存しておき、一覧に戻ってきた時だけ
  // 復元する。pendingNearbyScrollRestoreRefは「次にスクロール位置を調整する
  // タイミングでは、0にリセットするのではなくこちらを復元してほしい」という
  // 1回限りの合図。
  const nearbyListScrollTopRef = useRef(0);
  const pendingNearbyScrollRestoreRef = useRef(false);

  // タブ切り替え、一覧⇄検索モードの切り替え、地震の選択/選択解除で表示中身が
  // 変わるたびに、ブラウザのスクロールアンカリングによりscrollTopが勝手に動き、
  // カードやヘッダーが隠れて見えることがあるため、そのたびに明示的にスクロール
  // 位置を調整する。
  // ただし「戻る」ボタンで選択解除して一覧に戻っただけ(タブ・モードは変わって
  // いない)場合は、先頭に戻すのではなく選択前のスクロール位置を復元する
  // (=一覧を下の方までスクロールして地震を選んだ後、戻ったら同じ場所に
  //  留まってほしい、という自然な挙動にするため)。
  const prevScrollDepsRef = useRef({ active, quakeViewMode, tsunamiViewMode, selectedQuakeId });
  useLayoutEffect(() => {
    if (!scrollRef.current) return;
    const prev = prevScrollDepsRef.current;
    const onlyDeselected =
      prev.active === active && prev.quakeViewMode === quakeViewMode && prev.tsunamiViewMode === tsunamiViewMode &&
      prev.selectedQuakeId != null && selectedQuakeId == null;

    // scrollTopを直接設定するだけで、一覧⇄詳細切り替え時の位置調整は十分。
    // 以前はここでoverflowをhidden→autoと切り替えていたが、iOS Safariで
    // ボタン要素(地震一覧の各行)がスクロールを受け付けなくなる不具合の
    // 原因になっていたため廃止した(killScrollMomentum側も参照)。
    const el = scrollRef.current;
    if (pendingNearbyScrollRestoreRef.current) {
      el.scrollTop = nearbyListScrollTopRef.current;
      pendingNearbyScrollRestoreRef.current = false;
    } else {
      el.scrollTop = onlyDeselected ? listScrollTopRef.current : 0;
    }
    prevScrollDepsRef.current = { active, quakeViewMode, tsunamiViewMode, selectedQuakeId };
    // settingsPath(設定の階層メニュー内の画面遷移。例: ライセンス一覧→個別ライセンス詳細)や
    // stationDetailOpenKey(「各地の震度」の詳細画面)は、同じscrollRefを共有したまま
    // 中身の高さだけ変わる。これらの変化時にscrollTopをリセットしないと、深くスクロール
    // した状態で戻った時、新しい(短い)中身に対して古い(大きい)scrollTopが残ったままになり、
    // 中身が全部スクロールアウトして「フローティング内が何も表示されない」ように見える不具合が起きる。
  }, [active, selectedQuakeId, quakeViewMode, tsunamiViewMode, nearbyQuakeFor, settingsPath, stationDetailOpenKey, mechDetailOpen]);


  // 画面の高さ — 「全画面」スナップの基準になる
  const [viewportH, setViewportH] = useState(() =>
    typeof window !== "undefined" ? window.innerHeight : 800
  );
  useEffect(() => {
    function onResize() { setViewportH(window.innerHeight); }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const NAV_ROW_HEIGHT  = 66; // ナビ行の固定高さ(58pxボタン + 上下4pxパディング)
  const BOTTOM_OFFSET   = 32; // 親側の bottom:16px+safeArea の概算
  const TOP_GAP         = 56; // 全画面時に画面最上部へ残す余白

  // ハンドル行の高さ(HANDLE_HEIGHT)を変更した場合の差分。
  // 各スナップの固定高さは元々HANDLE_HEIGHT=18px前提で調整済みなので、
  // ここで差分を加算しておくことで、将来ハンドルの高さを変えても
  // 中身の表示領域(ここが本質)は変えずに済むようにしている。
  // 現在はHANDLE_HEIGHT=18のためこの差分は0。
  const HANDLE_HEIGHT_DELTA = HANDLE_HEIGHT - 18;

  // 0:低(閉) 1:中 2:中中 3:中高 4:高 5:全画面
  // 「高」「全画面」は、以前は表示中のタブの中身の実測高さ(naturalHeight)を
  // 元に計算していたが、これだと地震タブ(地震の件数や「各地の震度」展開で
  // 中身の長さが大きく変動する)だけ、気象/津波/警報/設定タブ(常に同じ
  // 「地図レイヤー」一覧を表示)と「高」「全画面」の高さがズレてしまっていた。
  // → タブごとの中身の長さには一切依存させず、常に同じ固定値/画面基準の
  //    値にすることで、どのタブでも「高」「全画面」が同じ高さになるようにする。
  //    中身がその高さより長い場合は、パネル内部のスクロール(scrollRef)に任せる。
  const highHeight = 390 + HANDLE_HEIGHT_DELTA; // 「高」の固定高さ(px)。地図レイヤー一覧(6項目)相当の目安(旧: 350)
  const fullscreenContentHeight = viewportH - TOP_GAP - BOTTOM_OFFSET - NAV_ROW_HEIGHT;

  // 「中」「中高」はタブによらず常に同じ高さになるよう固定pxで持つ
  // (地図レイヤー一覧で調整済みだった見た目の高さをそのまま定数化している)。
  const MID_FIXED     = 115 + HANDLE_HEIGHT_DELTA; // 「中」の固定高さ(px)
  // 「中中」の固定高さ(px)。「中」と「中高」の間に設ける中間スナップ。
  const MIDMID_FIXED = 200 + HANDLE_HEIGHT_DELTA;
  // 「中高」の固定高さ(px)。設定タブのトップメニュー(ヘッダー+5項目のカード)や、
  // 地震タブの検索フォーム(検索ボタンまで)がスクロールなしで丸ごと収まる高さを
  // 基準に調整している(旧: 222px)。検索フォーム側を見た目のバランスを保ちつつ
  // コンパクトに詰めることで、この高さのまま検索ボタンまで収まるようにしている。
  const MIDHIGH_FIXED = 290 + HANDLE_HEIGHT_DELTA;
  const GAP           = 20;  // 各スナップ間に必ず確保する最低差(px)
  const midHeight     = Math.min(MID_FIXED, highHeight - GAP * 2);
  const midHighHeight = Math.max(
    Math.min(MIDHIGH_FIXED, highHeight - GAP),
    midHeight + GAP
  );
  const midMidHeight = Math.max(
    Math.min(MIDMID_FIXED, midHighHeight - GAP),
    midHeight + GAP
  );

  // 地震を選択した直後にスナップする「低(カードのみ)」の高さ。
  // 完全に閉じる(0)ではなく、QuakeDetailCard 1枚(+ハンドル)がちょうど収まる
  // 高さにして、地図の震源付近が広く見えつつカードも確認できるようにする。
  const CARD_ONLY_HEIGHT = 96 + HANDLE_HEIGHT_DELTA; // QuakeDetailCard 1枚の実測目安(margin込み)
  const quakeLowHeight = Math.min(CARD_ONLY_HEIGHT, midHeight - GAP);

  const SNAP_HEIGHTS = [
    0,
    midHeight,
    midMidHeight,
    midHighHeight,
    highHeight,
    Math.max(fullscreenContentHeight, highHeight),
  ];
  const [snapIndex, setSnapIndex] = useState(0);

  // 「今、自分(タブタップの開閉トグル)が開いた状態にしているか」を表すref。
  // タブ切り替えで開いた場合もここを立てておくことで、直後の同じタブの再タップで
  // 正しく閉じられるようにする(現在のsnapIndexの読み取りには依存しない)。
  const openedByTapRef = useRef(false);

  // 別のタブに切り替えた時は、フローティングを「中高」まで開く。
  // (同じタブを再タップした時の開閉トグルとは別物なので、prevActiveRefで
  // 「本当にタブが変わった時だけ」を判定している)
  // ただし、緊急地震速報の詳細を表示していて(eewDetailOpen)、かつフローティングが
  // 既に開いている(snapIndex !== 0)間は、タブを切り替えてもこの自動オープンを
  // 起こさない。EEW表示中に他のタブのボタンを押しても、開いているパネルの高さが
  // 勝手に変わらないようにするため。フローティングが閉じている時は、EEW表示中でも
  // このガードの対象外とする(閉じた状態を維持するだけなので、タブ切り替えの
  // 邪魔にはならない)。
  const prevActiveRef = useRef(active);
  useEffect(() => {
    if (prevActiveRef.current !== active) {
      if (!(eewDetailOpen && snapIndex !== 0)) {
        killScrollMomentum();
        setSnapIndex(3);
        openedByTapRef.current = true;
      }
    }
    prevActiveRef.current = active;
  }, [active, eewDetailOpen, snapIndex]);

  // 緊急地震速報の詳細が開かれた瞬間、フローティングの高さを自動で「中中」にする。
  // EEWの内容(震源・予測震度など)が見える程度に開きつつ、地図もある程度隠れずに
  // 見える高さとしてちょうどいいため。閉じた時の高さの復元は行わない
  // (EEWは緊急性が高く、閉じた後にどの高さへ戻すべきかが自明ではないため)。
  const prevEewDetailOpenRef = useRef(eewDetailOpen);
  useEffect(() => {
    if (!prevEewDetailOpenRef.current && eewDetailOpen) {
      killScrollMomentum();
      setSnapIndex(2);
      openedByTapRef.current = true;
    }
    prevEewDetailOpenRef.current = eewDetailOpen;
  }, [eewDetailOpen]);

  // 台風の時刻チップ(地図上)/台風一覧の項目をタップして詳細を選択した瞬間、
  // フローティングの高さを自動で「中中」にする(EEWの詳細を開いた時と同じ考え方)。
  // ただし、詳細カード内の予報タイムラインで時刻を切り替える操作(後述)は
  // 「選択が変わる」という点では同じだが、その都度パネルの高さを戻されると
  // 閲覧の邪魔になるため、「未選択→選択」に変わった瞬間だけを対象にする。
  const typhoonDetailKey = selectedTyphoonInfo
    ? `${selectedTyphoonInfo.id || ""}|${selectedTyphoonInfo.forecastTime || ""}`
    : null;
  const prevTyphoonDetailKeyRef = useRef(typhoonDetailKey);
  useEffect(() => {
    if (typhoonDetailKey && !prevTyphoonDetailKeyRef.current) {
      killScrollMomentum();
      setSnapIndex(2);
      openedByTapRef.current = true;
    }
    prevTyphoonDetailKeyRef.current = typhoonDetailKey;
  }, [typhoonDetailKey]);

  // フローティングが完全に閉じられたら(snapIndex===0)、台風の詳細選択も解除する。
  useEffect(() => {
    if (snapIndex === 0 && selectedTyphoonInfo != null) {
      onClearSelectedTyphoon?.();
    }
  }, [snapIndex, selectedTyphoonInfo, onClearSelectedTyphoon]);

  // FAB(!ボタン)を押すたびに増える信号。eewDetailOpenが既にtrueのまま(例: 手元で
  // フローティングだけ閉じていた状態で、もう一度!ボタンを押して確認し直したい時)
  // だと上のuseEffectの「falseからtrueへの変化」という条件に引っかからず、
  // パネルが開き直されない(上部が見切れたまま/閉じたままになる)ことがあったため、
  // 値が変わるたびに必ず開き直す専用の信号として分けている。
  const isFirstEewOpenSignalRender = useRef(true);
  useEffect(() => {
    if (isFirstEewOpenSignalRender.current) {
      isFirstEewOpenSignalRender.current = false;
      return;
    }
    killScrollMomentum();
    setSnapIndex(2);
    openedByTapRef.current = true;
  }, [eewOpenSignal]);

  // タブバーで、既にアクティブなタブがもう一度タップされた時(navCollapseSignalの変化で検知)、
  // フローティングを開閉トグルする。前回タップ(またはタブ切り替え)で自分が開いたかどうかを
  // refで直接管理し、現在のsnapIndexの読み取り(ドラッグ操作等の影響を受けうる)には依存しないようにする。
  const isFirstNavCollapseRender = useRef(true);
  useEffect(() => {
    if (isFirstNavCollapseRender.current) {
      isFirstNavCollapseRender.current = false;
      return;
    }
    killScrollMomentum();
    // 緊急地震速報の詳細を表示中は、同じタブの再タップによる開閉トグルで
    // フローティングを閉じてしまわないようにする(EEWの内容を見せ続けるため)。
    // 閉じている(snapIndex===0)状態からの場合だけ、詳細が見える高さまで開く。
    if (eewDetailOpen) {
      openedByTapRef.current = true;
      if (snapIndex === 0) setSnapIndex(2);
      return;
    }
    if (openedByTapRef.current) {
      openedByTapRef.current = false;
      setSnapIndex(0);
    } else {
      openedByTapRef.current = true;
      setSnapIndex(3);
    }
  }, [navCollapseSignal]);

  // タブバーで、既にアクティブなタブをダブルタップした時、フローティングを一気に
  // 「高」(中高のひとつ上)まで開く。
  const isFirstNavDoubleTapRender = useRef(true);
  useEffect(() => {
    if (isFirstNavDoubleTapRender.current) {
      isFirstNavDoubleTapRender.current = false;
      return;
    }
    killScrollMomentum();
    openedByTapRef.current = true;
    setSnapIndex(4);
  }, [navDoubleTapSignal]);

  // 親から渡される layerOpen(真偽値)を 低(0)⇄高(4) として反映する。
  // ドラッグで内部的に決めたスナップを、ここで二重に上書きしないようrefで判定する。
  // ただし、緊急地震速報の詳細を表示中(eewDetailOpen)は、他の自動高さ調整
  // (タブ切り替え・設定タブ)と同じくこの反映を行わない。EEWは表示中に他の
  // タブへ切り替えることもあるが、layerOpenは実際にはハンドルのドラッグでしか
  // 更新されないため、EEW表示中の高さ変更(直接setSnapIndexしているだけで
  // layerOpenは連動して更新されない)との間でズレが生じることがあり、その
  // ズレがEEWを閉じるより前に別タブへの切り替えで表面化すると、そのタブが
  // 意図せず「高」まで開いてしまう。eewDetailOpen中はrefだけ最新に保って
  // このズレを解消しておき、実際の高さ変更は行わない。
  const lastLayerOpen = useRef(layerOpen);
  useEffect(() => {
    if (eewDetailOpen) {
      lastLayerOpen.current = layerOpen;
      return;
    }
    if (layerOpen !== lastLayerOpen.current) {
      lastLayerOpen.current = layerOpen;
      setSnapIndex(layerOpen ? (active === "quake" ? 3 : 4) : 0);
    }
  }, [layerOpen, active, eewDetailOpen]);

  // 震央分布(地図上の丸)をタップして地震を選択した時も、一覧内から選んだ時
  // (handleSelectQuakeForScroll)と同じく、フローティングの高さを「中」に揃える。
  // mapSelectSignalは「丸がタップされるたびに1増える」だけの値なので、
  // 初回マウント時(値が変わっていない)には反応しないようにしておく。
  const lastMapSelectSignal = useRef(mapSelectSignal);
  useEffect(() => {
    if (mapSelectSignal !== lastMapSelectSignal.current) {
      lastMapSelectSignal.current = mapSelectSignal;
      setSnapIndex(1);
      // 近傍の地震一覧を開いたまま丸をタップした場合、一覧側の表示を優先してしまい
      // (a)フローティングに選んだ地震の詳細が出ない (b)他の丸が消えない、という
      // 2つの不具合につながるため、丸タップでの選択は一覧表示(nearbyQuakeFor)を
      // 閉じる。ただしnearbyOriginIdは残す — これは一覧内の行をタップして選んだ時
      // (NearbyQuakesPanelのonSelectQuake)と同じ挙動で、これを消してしまうと
      // 「戻る」を押した時に近傍一覧へ戻れず、最初の画面まで戻ってしまう。
      setNearbyQuakeFor(null);
    }
  }, [mapSelectSignal]);

  // 潮位観測点ピン(発令中の予報区分。潮位計モードでない間に自動表示しているもの)を
  // 地図上でタップした時、わざわざ「潮位計」モードへ切り替えてしまうと、見終わった後
  // また元のモード(直近の津波情報一覧など)へ手動で戻す一手間が発生してしまう。
  // そのため、tsunamiViewModeは変えずに(=見ていたモードのまま)、その場で観測点の
  // 詳細を表示する(TsunamiSection側でselectedTideStationCodeの有無を
  // viewModeより優先して判定するように変更している)。震央分布の丸タップ
  // (mapSelectSignal)と同じく「タップのたびに1増えるだけの値」パターンで、
  // 初回マウント時には反応しない。ここではフローティングの高さの調整だけ行う。
  const lastTideStationSelectSignal = useRef(tideStationSelectSignal);
  useEffect(() => {
    if (tideStationSelectSignal !== lastTideStationSelectSignal.current) {
      lastTideStationSelectSignal.current = tideStationSelectSignal;
      setSnapIndex(4); // 潮位の詳細がしっかり見えるよう「高」の高さに揃える
    }
  }, [tideStationSelectSignal]);

  // 地震の選択が「あり→なし」に変わった(=戻るボタンで選択解除された)ら、
  // 詳細カード表示の「中」から一覧表示の「中高」へ戻す。
  const lastSelectedQuakeId = useRef(selectedQuakeId);
  useEffect(() => {
    if (lastSelectedQuakeId.current != null && selectedQuakeId == null) {
      setSnapIndex(3);
    }
    lastSelectedQuakeId.current = selectedQuakeId;
  }, [selectedQuakeId]);

  // 津波タブ版。考え方は地震タブとまったく同じ。
  const lastSelectedTsunamiId = useRef(selectedTsunamiId);
  useEffect(() => {
    if (lastSelectedTsunamiId.current != null && selectedTsunamiId == null) {
      setSnapIndex(3);
    }
    lastSelectedTsunamiId.current = selectedTsunamiId;
  }, [selectedTsunamiId]);

  // 警報タブ版。地図タップ/一覧タップのどちらでエリアを選んでも(=なし→ありに
  // 変わったら)、詳細カードがしっかり見えるよう「中高」に揃える。地震・津波と
  // 違って「戻る」で選択解除した時に別の高さへ戻す処理は無く、一覧表示も
  // 同じ「中高」を使っているため、選択解除時は現在の高さのままでよい。
  const lastSelectedWarningArea = useRef(selectedWarningArea);
  useEffect(() => {
    if (lastSelectedWarningArea.current == null && selectedWarningArea != null) {
      setSnapIndex(3);
    }
    lastSelectedWarningArea.current = selectedWarningArea;
  }, [selectedWarningArea]);

  // 河川水位観測所のピンをタップした時も同様に「中高」に揃える。
  const lastSelectedRiverStation = useRef(selectedRiverStation);
  useEffect(() => {
    if (lastSelectedRiverStation.current == null && selectedRiverStation != null) {
      setSnapIndex(3);
    }
    lastSelectedRiverStation.current = selectedRiverStation;
  }, [selectedRiverStation]);

  // 設定タブを開いた瞬間は、常にパネルの高さを「中高」にする
  // (トップメニューがスクロールなしで丸ごと見える高さのため)。
  // 設定タブから抜ける時も、行き先のタブに関わらず同じく「中高」にする
  // (他のタブ切り替え全般と同じ、通常の開閉挙動に揃えている)。
  // ただし、緊急地震速報の詳細を表示中(eewDetailOpen)は、この高さ強制を
  // 行わない。EEW表示中に設定タブへ切り替えても、フローティングの高さが
  // 勝手に変わらないようにするため(タブ切り替え全般でのeewDetailOpen中の
  // 挙動を、他のタブ切り替えガードと揃えている)。
  const lastActiveForSettings = useRef(active);
  useEffect(() => {
    if (eewDetailOpen) {
      lastActiveForSettings.current = active;
      return;
    }
    if (
      (lastActiveForSettings.current !== "settings" && active === "settings") ||
      (lastActiveForSettings.current === "settings" && active !== "settings")
    ) {
      setSnapIndex(3);
    }
    lastActiveForSettings.current = active;
  }, [active, eewDetailOpen]);

  // 気象タブは、タブをタッチして開いた瞬間に必ず「中高」のひとつ下の「中中」にする。
  // (他のタブ全般に対する上のタブ切り替え効果は「中高」だが、気象タブだけは
  // 専用処理としてひとつ下の高さにしている)。ダブルタップで「高」まで開く挙動は
  // navDoubleTapSignal側の共通処理のままで、他タブと変わらない。
  // 緊急地震速報の詳細を表示中(eewDetailOpen)は、他のタブ切り替えガードと
  // 同じくこの高さ強制を行わない。
  const lastActiveForWeather = useRef(active);
  useEffect(() => {
    if (eewDetailOpen) {
      lastActiveForWeather.current = active;
      return;
    }
    if (lastActiveForWeather.current !== "weather" && active === "weather") {
      setSnapIndex(2);
    }
    lastActiveForWeather.current = active;
  }, [active, eewDetailOpen]);

  // 津波警報テスト配信の「地図タップで選択」モード。ONになった瞬間、その時点の
  // 高さを覚えたうえでフローティングを完全にたたみ(低=0)、地図全体をタップできる
  // ようにする。OFFに戻った瞬間(予報区を選び終えた時・キャンセルした時のどちらも
  // App側ではtsunamiAreaPickActive=falseにするだけなので、ここでは真偽値の変化だけを
  // 見て判定する)、覚えておいた高さへ自動的に戻す。
  const preTsunamiPickSnapIndexRef = useRef(snapIndex);
  const lastTsunamiAreaPickActive = useRef(tsunamiAreaPickActive);
  useEffect(() => {
    if (!lastTsunamiAreaPickActive.current && tsunamiAreaPickActive) {
      preTsunamiPickSnapIndexRef.current = snapIndex; // ピック開始直前の高さを覚えておく
      setSnapIndex(0);
    } else if (lastTsunamiAreaPickActive.current && !tsunamiAreaPickActive) {
      setSnapIndex(preTsunamiPickSnapIndexRef.current); // 覚えておいた高さに戻す
    }
    lastTsunamiAreaPickActive.current = tsunamiAreaPickActive;
  }, [tsunamiAreaPickActive]);

  function handleSnap(newIndex) {
    setSnapIndex(newIndex);
    const shouldOpen = newIndex > 0;
    if (shouldOpen !== layerOpen) {
      lastLayerOpen.current = shouldOpen;
      onLayerOpenChange(shouldOpen);
    }
  }

  const { height: currentHeight, isDragging, handlePointerDown } =
    useSnapDrag({ heights: SNAP_HEIGHTS, index: snapIndex, onSnap: handleSnap });

  // 開閉トランジション・ドラッグ中だけ軽量モードにする:
  // border-radius / height のような「レイアウトに影響するプロパティ」を
  // 大きく・複雑な屈折フィルタ付きの要素でアニメーションさせると、
  // ブラウザがフレームごとにbackdrop-filter+SVGフィルタを再計算するため重くなる。
  // 動いている間だけ屈折SVGフィルタを外し、blurも軽くして、
  // 静止したら元のリッチな質感に戻す。
  const [settled, setSettled] = useState(true);
  const settleTimer = useRef(null);
  function scheduleSettle(delay = 460) {
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => setSettled(true), delay);
  }
  useEffect(() => {
    setSettled(false);
    scheduleSettle(460);
    return () => clearTimeout(settleTimer.current);
  }, [snapIndex]);
  useEffect(() => {
    if (isDragging) { setSettled(false); clearTimeout(settleTimer.current); }
  }, [isDragging]);

  // タブ切り替え(active変化)でも中身の自然な高さが変わり、パネルの高さが
  // アニメーションで追従する。この高さ変化中も、スナップ切り替え時と同様に
  // 重い屈折フィルタを一時的に外して軽量モードにする。
  useEffect(() => {
    setSettled(false);
    scheduleSettle(460);
  }, [active]);

  // 角丸は「現在のガラス全体の実際の高さ」と「開き具合」から直接算出する。
  // 999pxのような巨大な値をそのままトランジションさせると、中間状態で
  // border-radiusが箱の寸法を超えてクランプされ、丸が膨らんで歪な円形に
  // なってしまうため、999は一切使わない。
  // 下の角丸はナビ行(高さ66固定)に合わせて常に33pxで一定。
  // 上の角丸は、閉じている時は下と揃えて完全な丸ピルにし(33px)、
  // 開くにつれて少しだけ締まった26pxへ滑らかに変化させる
  // — 26〜33はどちらも箱の最小高さ(66, 半分33)を超えない安全な値なので、
  // 補間の途中でも歪みは発生しない(「高」を超えて全画面へ伸びる間もtopRadiusは26で頭打ち)。
  const BOTTOM_RADIUS = NAV_ROW_HEIGHT / 2; // 33px
  // openProgressは「高」の固定高さ(highHeight)を基準にする。
  // 以前はnaturalHeight(タブごとに変わる中身の実測高さ)を分母にしていたため、
  // 同じスナップ高さでもタブによってopenProgressが変わり、地震タブだけ
  // 上の角丸が他タブと微妙に異なって見える原因になっていた。
  const openProgress = Math.min(1, Math.max(0, currentHeight / highHeight));
  const topRadius    = BOTTOM_RADIUS + (26 - BOTTOM_RADIUS) * openProgress;
  const bottomRadius = BOTTOM_RADIUS;

  /* ── ナビ行スワイプ選択（%ベース連続追従方式）────────────────
     タブは flex:1 で等幅。ハイライトの left/width は、ナビ行の
     「左右パディングを除いた内側領域」を基準にした % で一貫管理する。
     NAV_PAD_X は JSX 側の padding と必ず一致させること(ズレ防止)。
     端のタブでハイライトが外枠ぎりぎりに接しないよう、左右に
     十分な余白(NAV_PAD_X)を確保している。 */
  const NAV_PAD_X = 8; // ナビ行の左右パディング[px]。JSXのpaddingと一致させる
  const navRowRef    = useRef(null);
  const navPointerId = useRef(null);
  const navMoved     = useRef(false);
  const navStartX    = useRef(0);
  const N = NAV.length;                       // タブ数
  const tabW = 100 / N;                       // 1タブの幅 [%]（内側領域基準）

  const activeIndex = NAV.findIndex(n => n.id === active);
  const [highlightLeft, setHighlightLeft] = useState(activeIndex * tabW);
  const [navDragging,   setNavDragging]   = useState(false);
  const [navPressed,    setNavPressed]    = useState(false);  // 指が触れている間ずっとtrue(タップ/ドラッグ問わず)
  const [previewIdx,    setPreviewIdx]    = useState(null);  // ドラッグ中の最近傍index

  // active が外部から変わった時（タップ以外の切替）にハイライトを追従させる
  useEffect(() => {
    if (!navDragging) {
      setHighlightLeft(activeIndex * tabW);
    }
  }, [activeIndex, navDragging, tabW]);

  // clientX → 内側領域(左右NAV_PAD_X除外)を基準にした正規化 left [%]
  function clientXToLeft(clientX) {
    const row = navRowRef.current;
    if (!row) return activeIndex * tabW;
    const { left, width } = row.getBoundingClientRect();
    const innerLeft  = left + NAV_PAD_X;
    const innerWidth = width - NAV_PAD_X * 2;
    const ratio = Math.max(0, Math.min(1, (clientX - innerLeft) / innerWidth));
    return ratio * 100;              // % 値（内側領域基準）
  }

  // clientX に最も近いタブの index を返す
  function clientXToIndex(clientX) {
    const pct = clientXToLeft(clientX);          // 0–100（内側領域基準）
    return Math.max(0, Math.min(N - 1, Math.round(pct / tabW - 0.5)));
  }

  function handleNavPointerDown(e) {
    navPointerId.current = e.pointerId;
    navMoved.current     = false;
    navStartX.current    = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
    const idx = clientXToIndex(e.clientX);
    setPreviewIdx(idx);
    setNavPressed(true);
    // ここでは navDragging を立てない。
    // navDragging=true は transition を切るためのフラグなので、
    // まだ指が動いていない(タップの可能性がある)段階では
    // transition を有効なままにしておき、目的のタブへ
    // スライドして移動するアニメーションを見せる。
    setHighlightLeft(idx * tabW);
  }

  function handleNavPointerMove(e) {
    if (navPointerId.current !== e.pointerId) return;
    if (Math.abs(e.clientX - navStartX.current) > 3 && !navMoved.current) {
      // ここで初めて「実際のドラッグ」と確定する。
      // この瞬間から transition を切って指に即座追従させる。
      navMoved.current = true;
      setNavDragging(true);
    }
    const idx = clientXToIndex(e.clientX);
    setPreviewIdx(idx);
    if (navMoved.current) {
      // ドラッグ確定後は、指の連続位置にハイライトを追従させる
      const raw = clientXToLeft(e.clientX) - tabW / 2;
      setHighlightLeft(Math.max(0, Math.min(100 - tabW, raw)));
    } else {
      // まだタップ相当の間はタブ中心に置いたまま(スライドで追いつく)
      setHighlightLeft(idx * tabW);
    }
  }

  function handleNavPointerUp(e) {
    if (navPointerId.current !== e.pointerId) return;
    navPointerId.current = null;
    const idx = clientXToIndex(e.clientX);
    setNavDragging(false);
    setNavPressed(false);
    setPreviewIdx(null);
    setHighlightLeft(idx * tabW);
    onNav(NAV[idx].id);
  }

  // タップ(pointermove なし)は click でも拾えるようフォールバック。
  // タップ回数(シングル/ダブル)の判定は、ここでは一切行わない。
  // 1回の物理タップに対して pointerup(handleNavPointerUp)とclick(この関数)の
  // 両方から onNav が呼ばれる点も含め、判定はすべてApp側のhandleNavTapに一本化する
  // (SideNavRailのhandleClickと同じ考え方)。以前はここにも独自のダブルタップ判定
  // (lastTapTime/DOUBLE_TAP_MS)を持っていたが、App側の判定(navCollapseSignal/
  // navDoubleTapSignal、80ms/400msの窓)と別々のタイマーが同時に動くことになり、
  // 判定窓のズレ(320ms vs 400ms)や layerOpen と snapIndex の不整合により
  // ダブルタップが効かない・動作が不安定になる原因になっていたため撤去した。
  function handleNavClick(id) {
    if (navMoved.current) return;   // ドラッグ完了後の二重発火を防ぐ

    const idx = NAV.findIndex(n => n.id === id);
    setHighlightLeft(idx * tabW);
    onNav(id);
  }

  // ドラッグ中はプレビューindex、そうでなければactiveをハイライト表示に使う
  const displayIdx = navDragging && previewIdx != null ? previewIdx : activeIndex;

  // 戻るボタンの下端オフセット。パネル本体(currentHeight)+ナビ行(NAV_ROW_HEIGHT)+
  // 少し余白、を常に足し上げているため、ドラッグ中も含めてパネルの高さに追従する。
  const backButtonBottom = currentHeight + NAV_ROW_HEIGHT + 12;

  // 緊急地震速報のFAB/戻るボタンを出すかどうか(取消済みでないEEWが1件でもあるか)。
  const hasActiveEew = eews.some(e => !e.cancelled);

  // 「戻るボタンの位置」(right:16, bottom:backButtonBottom)を、他のタブ固有の
  // 戻るボタン/切替ボタン群がすでに使っているかどうか。使っている場合だけ、
  // びっくりボタンをその左側にずらす(同時に2つ出ても重ならないようにする)。
  // eewDetailOpen中は他タブの戻るボタン自体を出さない(下の各ブロックで
  // !eewDetailOpen && を付けている)ため、ここでは判定用に元の条件だけを見る。
  const otherBackSlotOccupied =
    (active === "quake" && selectedQuakeId != null) ||
    (active === "tsunami" && (
      selectedTsunamiId != null ||
      selectedTideStationCode != null ||
      (activeTsunami != null && !causingQuakeFound)
    )) ||
    (active === "weather") ||
    (active === "alert" && selectedWarningArea != null) ||
    (active === "settings" && settingsPath.length > 0);

  return (
    <>
      {/* 広い画面では、SideNavRail(タブ部分)はApp側で共有のGlassの中に
          BottomDockと並べて描画するため、ここでは出さない。 */}

      {/* 緊急地震速報のFAB／戻るボタン — 通常は地震タブの戻るボタンと全く同じ位置
          (right:16, backButtonBottom)に出す。詳細表示中(eewDetailOpen)は他タブの
          戻るボタンを隠すため、この位置を独占できる。詳細表示前(FABの状態)に
          他タブの戻るボタン等がすでにその位置を使っている場合だけ、びっくりボタンを
          左にずらして重ならないようにする。 */}
      {hasActiveEew && (
        isWide && wideAnchorRect ? createPortal(
          <div style={{
            position: "fixed",
            left: (!eewDetailOpen && otherBackSlotOccupied) ? wideAnchorRect.right + 12 + 56 : wideAnchorRect.right + 12,
            top: wideAnchorRect.top + 16,
            zIndex: 50,
          }}>
            {eewDetailOpen ? (
              <BackToListButton onClick={onCloseEewDetail} label="閉じる"/>
            ) : (
              <EewFabButton onClick={onOpenEewDetail}/>
            )}
          </div>,
          document.body
        ) : (
        <div style={{
          position: "absolute",
          right: (!eewDetailOpen && otherBackSlotOccupied) ? 16 + 56 : 16,
          bottom: backButtonBottom,
          transition: isDragging ? "none" : "bottom 0.4s cubic-bezier(.22,1,.36,1), right 0.25s cubic-bezier(.22,1,.36,1)",
          zIndex: 10,
        }}>
          {eewDetailOpen ? (
            <BackToListButton onClick={onCloseEewDetail} label="閉じる"/>
          ) : (
            <EewFabButton onClick={onOpenEewDetail}/>
          )}
        </div>
        )
      )}

      {/* 戻るボタン — 地震を選択している間だけ、パネルのすぐ上に浮かぶ。
          Glass(パネル本体)の兄弟として置くことで、currentHeightの変化
          (ドラッグ含む)にそのまま追従できるようにしている。
          緊急地震速報の詳細を表示している間は、その位置をびっくりボタン側の
          「戻る」ボタンが使うため、ここでは出さない。 */}
      {!eewDetailOpen && active === "quake" && selectedQuakeId != null && (
        isWide && wideAnchorRect ? createPortal(
          <div style={{
            position: "fixed",
            left: wideAnchorRect.right + 12,
            top: wideAnchorRect.top + 16,
            zIndex: 50,
          }}>
            <BackToListButton
              onClick={handleBackFromQuake}
              label={backFromQuakeLabel}
            />
            <div style={{ marginTop: 12 }}>
              {areaFillEnabled && (
                <StationMarkerToggleButton visible={stationMarkersVisible} onClick={onToggleStationMarkersVisible}/>
              )}
            </div>
          </div>,
          document.body
        ) : (
        <div style={{
          position: "absolute",
          right: 16,
          bottom: backButtonBottom,
          transition: isDragging ? "none" : "bottom 0.4s cubic-bezier(.22,1,.36,1)",
          zIndex: 10,
        }}>
          <div style={{ marginBottom: 12 }}>
            {areaFillEnabled && (
              <StationMarkerToggleButton visible={stationMarkersVisible} onClick={onToggleStationMarkersVisible}/>
            )}
          </div>
          <BackToListButton
            onClick={handleBackFromQuake}
            label={backFromQuakeLabel}
          />
        </div>
        )
      )}

      {/* 津波タブ版。地震タブの戻るボタンと全く同じ考え方。
          ボタン群を出す条件は3通りある(いずれか1つで表示):
            1. 個別の津波情報を選択中(戻るボタン)
            2. 潮位観測点を選択中(戻るボタン。潮位計モードに限らない — 直近一覧などを
               見ながら地図の観測点ピンをタップした場合も、モードは切り替えずその場で
               詳細を出すため)
            3. 現在進行形の津波情報がある(一覧に戻るものが無くても、潮位観測点
               オンオフボタンだけは出す。「引き起こした地震」を見ている間は
               その地震の震度観測点用に同じ枠を使うため出さない)
          観測点表示切替ボタンは、「引き起こした地震」を表示している間は震度観測点用
          (stationMarkersVisible)、それ以外で有効な津波情報がある間は潮位観測点用
          (tideStationMarkersVisible)を出す。両方同時に出ることはない。 */}
      {!eewDetailOpen && active === "tsunami" && (
        selectedTsunamiId != null ||
        selectedTideStationCode != null ||
        (activeTsunami != null && !causingQuakeFound)
      ) && (
        isWide && wideAnchorRect ? createPortal(
          <div style={{
            position: "fixed",
            left: wideAnchorRect.right + 12,
            top: wideAnchorRect.top + 16,
            zIndex: 50,
          }}>
            {(selectedTsunamiId != null || selectedTideStationCode != null) && (
              <BackToListButton
                onClick={handleBackFromTsunami}
                label={backFromTsunamiLabel}
              />
            )}
            {causingQuakeFound ? (
              <div style={{ marginTop: 12 }}>
                <StationMarkerToggleButton visible={stationMarkersVisible} onClick={onToggleStationMarkersVisible}/>
              </div>
            ) : activeTsunami != null && !isViewingPastTsunami && tsunamiViewMode !== "tidegauge" && (
              <div style={{ marginTop: 12 }}>
                <StationMarkerToggleButton visible={tideStationMarkersVisible} onClick={onToggleTideStationMarkersVisible}/>
              </div>
            )}
          </div>,
          document.body
        ) : (
        <div style={{
          position: "absolute",
          right: 16,
          bottom: backButtonBottom,
          transition: isDragging ? "none" : "bottom 0.4s cubic-bezier(.22,1,.36,1)",
          zIndex: 10,
        }}>
          {causingQuakeFound ? (
            <div style={{ marginBottom: 12 }}>
              <StationMarkerToggleButton visible={stationMarkersVisible} onClick={onToggleStationMarkersVisible}/>
            </div>
          ) : activeTsunami != null && !isViewingPastTsunami && tsunamiViewMode !== "tidegauge" && (
            <div style={{ marginBottom: 12 }}>
              <StationMarkerToggleButton visible={tideStationMarkersVisible} onClick={onToggleTideStationMarkersVisible}/>
            </div>
          )}
          {(selectedTsunamiId != null || selectedTideStationCode != null) && (
            <BackToListButton
              onClick={handleBackFromTsunami}
              label={backFromTsunamiLabel}
            />
          )}
        </div>
        )
      )}

      {/* 設定タブのサブ画面(カテゴリ/項目の中身)を見ている間だけ、同じ戻るボタンを浮かべる。 */}
      {!eewDetailOpen && active === "settings" && settingsPath.length > 0 && (
        isWide && wideAnchorRect ? createPortal(
          <div style={{
            position: "fixed",
            left: wideAnchorRect.right + 12,
            top: wideAnchorRect.top + 16,
            zIndex: 50,
          }}>
            <BackToListButton
              onClick={() => setSettingsPath(p => p.slice(0, -1))}
              label="前の画面に戻る"
            />
          </div>,
          document.body
        ) : (
        <div style={{
          position: "absolute",
          right: 16,
          bottom: backButtonBottom,
          transition: isDragging ? "none" : "bottom 0.4s cubic-bezier(.22,1,.36,1)",
          zIndex: 10,
        }}>
          <BackToListButton
            onClick={() => setSettingsPath(p => p.slice(0, -1))}
            label="前の画面に戻る"
          />
        </div>
        )
      )}

      {/* 警報タブ用 — エリアを選択(タップ/一覧選択)している間は、地震・津波・
          設定タブと全く同じ「戻るボタンの枠」(フローティング外部、right:16・
          bottom:backButtonBottom。横画面ではパネル右上の外側)に戻るボタンを浮かべる。
          選択していない(一覧表示中の)間は、気象タブと全く同じ考え方で、
          同じ枠にキキクル(土砂/浸水)を切り替えるくの字メニューを浮かべる。 */}
      {!eewDetailOpen && active === "alert" && (
        isWide && wideAnchorRect ? createPortal(
          <>
          <div style={{
            position: "fixed",
            left: wideAnchorRect.right + 12,
            top: wideAnchorRect.top + 16,
            zIndex: 50,
          }}>
            {selectedWarningArea != null || selectedRiverStation != null ? (
              <BackToListButton
                onClick={selectedRiverStation != null ? () => onSelectRiverStation?.(null) : onBackFromWarningArea}
                label={selectedRiverStation != null ? "一覧に戻る" : "警報一覧に戻る"}
              />
            ) : (
              <AlertMenuFloating
                open={alertMenuOpen}
                onToggle={() => setAlertMenuOpen(v => !v)}
                growUp={false}
                itemStates={alertMenuItemStates}
                onToggleItem={handleToggleAlertMenuItem}
              />
            )}
          </div>
          {/* キキクルの時刻スライダー(横画面) — 気象タブの各時刻スライダーと同じく、
              展開メニューが閉じている間だけ、パネルの右側・画面下端に沿って
              横いっぱいに浮かべる。1/3/24時間降水量と全く同じPrecipTimeSliderを
              流用し、ラベルの出し方(formatLabel)だけキキクル用に差し替える。 */}
          {alertLayerMode && riskFrames && riskFrameIndex != null && !alertMenuOpen && (
            <div style={{
              position: "fixed",
              left: wideAnchorRect.right + 12,
              right: 16,
              bottom: 16,
              zIndex: 50,
            }}>
              <PrecipTimeSlider
                frames={riskFrames}
                frameIndex={riskFrameIndex}
                onChangeFrameIndex={setRiskFrameIndex}
                formatLabel={formatRiskFrameLabel}
              />
            </div>
          )}
          </>,
          document.body
        ) : (
        <div style={{
          position: "absolute",
          left: 16,
          right: 16,
          bottom: backButtonBottom,
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "flex-end",
          gap: 8,
          transition: isDragging ? "none" : "bottom 0.4s cubic-bezier(.22,1,.36,1)",
          zIndex: 10,
        }}>
          {/* キキクルの時刻スライダー — 展開メニューが閉じている間だけ、
              ボタンの左側いっぱいに表示する(気象タブの各時刻スライダーと同じ考え方)。 */}
          {alertLayerMode && riskFrames && riskFrameIndex != null && !alertMenuOpen && (
            <PrecipTimeSlider
              frames={riskFrames}
              frameIndex={riskFrameIndex}
              onChangeFrameIndex={setRiskFrameIndex}
              formatLabel={formatRiskFrameLabel}
            />
          )}
          {selectedWarningArea != null || selectedRiverStation != null ? (
            <BackToListButton
              onClick={selectedRiverStation != null ? () => onSelectRiverStation?.(null) : onBackFromWarningArea}
              label={selectedRiverStation != null ? "一覧に戻る" : "警報一覧に戻る"}
            />
          ) : (
            <AlertMenuFloating
              open={alertMenuOpen}
              onToggle={() => setAlertMenuOpen(v => !v)}
              growUp={true}
              itemStates={alertMenuItemStates}
              onToggleItem={handleToggleAlertMenuItem}
            />
          )}
        </div>
        )
      )}

      {/* 気象タブ用 — 地震・津波・設定タブと全く同じ「戻るボタンの枠」
          (right:16, bottom:backButtonBottom)を使って、雨雲レーダー等のメニューを
          開閉するボタンを浮かべる。気象タブにいる間はいつでも出す。開くとボタンの
          すぐ上に簡易メニューが現れ、くの字アイコンが下向きに反転する。もう一度
          押すと閉じて元の上向きに戻る。 */}
      {!eewDetailOpen && active === "weather" && (
        isWide && wideAnchorRect ? createPortal(
          <>
          <div style={{
            position: "fixed",
            left: wideAnchorRect.right + 12,
            top: wideAnchorRect.top + 16,
            zIndex: 50,
          }}>
            {selectedTyphoonInfo ? (
              <BackToListButton onClick={handleBackFromTyphoon} label="台風一覧に戻る"/>
            ) : (
              <WeatherMenuFloating open={weatherMenuOpen} onToggle={() => setWeatherMenuOpen(v => !v)} growUp={false} itemStates={weatherMenuItemStates} onToggleItem={handleToggleWeatherMenuItem} hasActiveTyphoons={hasActiveTyphoons}/>
            )}
          </div>
          {/* 雨雲レーダーの時刻スライダー(横画面) — 縦画面の時と同じく、展開メニューが
              閉じている間だけ表示する。縦画面ではボタンのすぐ上に置いているが、
              横画面ではパネルの右側・画面下端に沿って横いっぱいに浮かべる。 */}
          {nowcastEnabled && !weatherMenuOpen && (
            <div style={{
              position: "fixed",
              left: wideAnchorRect.right + 12,
              right: 16,
              bottom: 16, // サイドバー(SideNavRail)側のフローティングと同じ bottom:16 に揃える
              zIndex: 50,
            }}>
              <NowcastTimeSlider
                frames={nowcastFrames}
                frameIndex={nowcastFrameIndex ?? 0}
                onChangeFrameIndex={setNowcastFrameIndex}
              />
            </div>
          )}
          {/* 1/3/24時間降水量の時刻スライダー(横画面)。雨雲レーダーとは排他なので
              同時に両方出ることは無いが、念のため同じ条件(展開メニューが閉じている
              間だけ)で出す。 */}
          {precipMode && !weatherMenuOpen && (
            <div style={{
              position: "fixed",
              left: wideAnchorRect.right + 12,
              right: 16,
              bottom: 16,
              zIndex: 50,
            }}>
              <PrecipTimeSlider
                frames={precipFrames}
                frameIndex={precipFrameIndex ?? 0}
                onChangeFrameIndex={setPrecipFrameIndex}
              />
            </div>
          )}
          {/* 天気分布予報の時刻スライダー(横画面)。他とは全て排他。 */}
          {wdistMode && !weatherMenuOpen && (
            <div style={{
              position: "fixed",
              left: wideAnchorRect.right + 12,
              right: 16,
              bottom: 16,
              zIndex: 50,
            }}>
              <PrecipTimeSlider
                frames={wdistFrames}
                frameIndex={wdistFrameIndex ?? 0}
                onChangeFrameIndex={setWdistFrameIndex}
                formatLabel={formatWdistFrameLabel}
              />
            </div>
          )}
          </>,
          document.body
        ) : (
        <div style={{
          position: "absolute",
          left: 16,
          right: 16,
          bottom: backButtonBottom,
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "flex-end",
          gap: 8,
          transition: isDragging ? "none" : "bottom 0.4s cubic-bezier(.22,1,.36,1)",
          zIndex: 10,
        }}>
          {/* 雨雲レーダーの時刻スライダー — 展開メニューが閉じている間だけ、
              ボタンの左側いっぱいに表示する。開いている間は簡易メニューと
              重なってしまうため隠す。 */}
          {nowcastEnabled && !weatherMenuOpen && (
            <NowcastTimeSlider
              frames={nowcastFrames}
              frameIndex={nowcastFrameIndex ?? 0}
              onChangeFrameIndex={setNowcastFrameIndex}
            />
          )}
          {/* 1/3/24時間降水量の時刻スライダー。雨雲レーダーとは排他。 */}
          {precipMode && !weatherMenuOpen && (
            <PrecipTimeSlider
              frames={precipFrames}
              frameIndex={precipFrameIndex ?? 0}
              onChangeFrameIndex={setPrecipFrameIndex}
            />
          )}
          {/* 天気分布予報の時刻スライダー。他とは全て排他。 */}
          {wdistMode && !weatherMenuOpen && (
            <PrecipTimeSlider
              frames={wdistFrames}
              frameIndex={wdistFrameIndex ?? 0}
              onChangeFrameIndex={setWdistFrameIndex}
              formatLabel={formatWdistFrameLabel}
            />
          )}
          {selectedTyphoonInfo ? (
            <BackToListButton onClick={handleBackFromTyphoon} label="台風一覧に戻る"/>
          ) : (
            <WeatherMenuFloating open={weatherMenuOpen} onToggle={() => setWeatherMenuOpen(v => !v)} growUp={true} itemStates={weatherMenuItemStates} onToggleItem={handleToggleWeatherMenuItem} hasActiveTyphoons={hasActiveTyphoons}/>
          )}
        </div>
        )
      )}

      {(() => {
        const GlassOrPlain = isWide ? "div" : Glass;
        const glassProps = isWide
          ? { ref: wideContentRef, style: { width: "clamp(240px, 30vw, 380px)", height: "100%", overflow: "hidden", position: "relative" } }
          : {
              filterSize: settled ? "normal" : "none",
              blur: settled ? 14 : 8,
              style: {
                width: "100%",
                maxWidth: 480,
                minWidth: 240,
                borderRadius: `${topRadius}px ${topRadius}px ${bottomRadius}px ${bottomRadius}px`,
                transition: isDragging ? "none" : "border-radius 0.4s cubic-bezier(.22,1,.36,1)",
                overflow: "hidden",
                animation: "appear 0.4s cubic-bezier(.25,1,.5,1) 0.1s both",
              },
            };
        return (
      <GlassOrPlain {...glassProps}>
      {/* uiScaleが1未満の時(横画面で画面が低い場合)、中身を実際より広い
          仮想サイズでレイアウトさせてから縮小することで、外枠(Glassの箱)の
          サイズは変えずに文字・要素だけを縮めて収める。
          uiScale===1(縦画面、または横画面でも画面が十分高い場合)では、
          たとえscale(1)であってもtransformを祖先要素に付けると、
          スクロール関連の挙動(iOS Safariでのタッチスクロール、
          scrollIntoViewによる自動スクロール位置など)がおかしくなる
          ことがあるため、実際に縮小が必要な時だけこのラッパーを使う
          (それ以外はFragmentで素通しする)。 */}
      {(() => {
        const needsScale = uiScale < 1;
        const ScaleWrap = needsScale ? "div" : Fragment;
        const scaleWrapProps = needsScale ? {
          style: {
            width: `${100 / uiScale}%`,
            height: `${100 / uiScale}%`,
            transform: `scale(${uiScale})`,
            transformOrigin: "top left",
          },
        } : {};
        return (
      <ScaleWrap {...scaleWrapProps}>
      {/* レイヤーパネル部分 — 高さを直接アニメーションし、
          ナビバーのガラスの中から「せり出してくる」ように展開する。
          広い画面(isWide)では、ドラッグで高さを変える仕組み自体を使わず、
          常に親いっぱいの固定高さで表示する。 */}
      <div
        aria-hidden={!isWide && snapIndex === 0 && !isDragging}
        style={{
          height: isWide ? "100%" : currentHeight,
          paddingTop: isWide ? 14 : 0, // ハンドルが無い分、上に少し余白を持たせる
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          transition: isWide || isDragging ? "none" : "height 0.4s cubic-bezier(.22,1,.36,1)",
          pointerEvents: isWide || snapIndex > 0 || isDragging ? "auto" : "none",
        }}
      >
        {/* ドラッグハンドル — 広い画面(isWide)では高さを変える操作自体が無いため
            表示しない。狭い画面(縦持ち)でのみ、常に上部に固定表示する。
            以前は当たり判定を absolute で上下に張り出す構成にしていたが、
            重ね合わせが原因と思われる表示崩れが発生したため、
            ハンドル行自体の高さを広げてタップ範囲とするシンプルな
            構成に戻した(見た目のバー位置は中央のまま変わらない)。 */}
        {!isWide && (
        <div
          onPointerDown={handlePointerDown}
          style={{
            flexShrink: 0,
            display: "flex", justifyContent: "center", alignItems: "center",
            width: "100%", height: HANDLE_HEIGHT,
            background: "transparent",
            cursor: "grab",
            touchAction: "none", userSelect: "none",
          }}
        >
          <div style={{
            width: 36, height: 4, borderRadius: 999,
            background: `rgba(${tokens.ink},0.45)`,
          }}/>
        </div>
        )}

        {/* 地震タブの「一覧⇄検索」切り替えバー — ハンドル直下に固定表示し、
            スクロールしても本体と一緒には動かない(検索/一覧の入口を常に見せておく)。
            地震を選択してカード表示になっている間、および緊急地震速報の詳細を
            表示している間は不要なので隠す。 */}
        {!eewDetailOpen && active === "quake" && selectedQuakeId == null && (
          <QuakeListToolbar
            mode={quakeViewMode}
            onModeChange={(mode) => { killScrollMomentum(); setQuakeViewMode(mode); }}
            onHandoffToPanelDrag={handlePointerDown}
          />
        )}

        {/* 津波タブの「一覧⇄過去」切り替えバー — 地震タブと全く同じ考え方。
            津波情報を選択してカード表示になっている間、または(モードを切り替えずに
            その場で表示している)潮位観測点の詳細を表示している間、および緊急地震速報の
            詳細を表示している間は不要なので隠す。 */}
        {!eewDetailOpen && active === "tsunami" && selectedTsunamiId == null && selectedTideStationCode == null && (
          <QuakeListToolbar
            items={TSUNAMI_TOOLBAR_ITEMS}
            mode={tsunamiViewMode}
            onModeChange={(mode) => { killScrollMomentum(); setTsunamiViewMode(mode); }}
            onHandoffToPanelDrag={handlePointerDown}
          />
        )}

        {/* スクロール可能な本体 — ヘッダー・レイヤー一覧だけがここでスクロールする。
            overflowAnchor: "none" は、タブ切り替えで中身の高さが変わった際に
            ブラウザのスクロールアンカリングがスクロール位置を勝手にずらし、
            ヘッダーや先頭行が隠れて見える不具合を防ぐため。
            key で active/quakeViewMode ごとに別のDOM要素にしているのは、
            scrollTop=0を後から代入するだけだと、iOSの慣性スクロール(勢いよく
            フリックした後の減速アニメーション)が同じ要素に対して裏側で動き続け、
            切り替え直後にリセットしてもすぐ上書きされて別タブ側まで動いてしまう
            ため。要素ごと作り直すことで、古い要素に紐づく慣性スクロールを
            物理的に断ち切る。
            eewDetailOpenもkeyに含めているのは、これが無いと「今見ているタブ」の
            スクロールコンテナをそのまま緊急地震速報の表示にも使い回してしまい、
            EEWを開く前/後でスクロール位置が引き継がれてしまう(EEWを見ている間に
            スクロールすると、閉じた時にタブ本来の内容側もそのスクロール位置に
            なってしまう)ため。 */}
        <div
          key={`${eewDetailOpen}:${active}:${quakeViewMode}:${tsunamiViewMode}:${selectedQuakeId != null}:${selectedTsunamiId != null}:${selectedTideStationCode != null}`}
          ref={scrollRef}
          style={{
            flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", overflowAnchor: "none",
            // 文字(数字含む)の上を指でなぞった時、iOS Safariは既定だと
            // テキスト選択ジェスチャーとして扱ってしまい、スクロールが
            // 効かなくなることがある。中身のテキストを選択不可にして、
            // どこを触ってもスクロールとして扱われるようにする。
            userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none",
          }}
        >
          <div>
            {eewDetailOpen ? (
              <>
                {/* 緊急地震速報の詳細 — 地震タブでQuakeDetailCard/QuakeMessageCardが
                    並ぶのと全く同じように、囲みなしでカードを直接並べる。タブの中身を
                    一時的に置き換えるだけで、閉じれば元のタブ表示にそのまま戻る。
                    地震カード・津波カードと違い、カード全体ではなく「緊急地震速報
                    (警報/予報)」ブロックと「第◯報」ブロック(見出し部分)だけを
                    PanelDragHandoffCardで包む(EewDetailFloatingCard内部で対応)。
                    最大予測震度カードなど、それ以外の部分をドラッグしてもパネルの
                    高さは変わらないようにするため。 */}
                {eews.map(eew => (
                  <EewDetailFloatingCard key={eew.eventId} eew={eew} onHandoffToPanelDrag={handlePointerDown}/>
                ))}
              </>
            ) : active === "quake" ? (
              <>
                {quakeViewMode !== "search" && quakeStatus === "loading" && quakes.length === 0 && (
                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    gap: 8, padding: "18px 0", color: `rgba(${tokens.ink},0.45)`,
                  }}>
                    <div style={{
                      width: 16, height: 16, borderRadius: "50%",
                      border: `2px solid rgba(${tokens.ink},0.15)`,
                      borderTopColor: `rgba(${tokens.ink},0.6)`,
                      animation: "spin 0.8s linear infinite",
                    }}/>
                    <span style={{ fontSize: 12 }}>地震情報を取得中…</span>
                  </div>
                )}

                {quakeViewMode !== "search" && quakeStatus === "error" && quakes.length === 0 && (
                  <div style={{ padding: "18px 16px", textAlign: "center" }}>
                    <span style={{ fontSize: 12, color: "rgba(255,140,140,0.9)" }}>
                      地震情報の取得に失敗しました
                    </span>
                  </div>
                )}

                {(() => {
                  // 選択中の地震は、直近一覧(quakes)だけでなく、気象庁 震度データベース検索
                  // から開いた地震(searchQuake)も対象に探す(検索結果はquakesには入れていないため)。
                  const selected = quakes.find(q => q.id === selectedQuakeId)
                    || (searchQuake && searchQuake.id === selectedQuakeId ? searchQuake : null);

                  // 選択中は「カード(+各地の震度)のみ」、未選択は「一覧のみ」の排他表示。
                  if (selected) {
                    if (nearbyQuakeFor) {
                      return (
                        <div key={`${selected.id}:nearby`}>
                          <NearbyQuakesPanel
                            place={nearbyQuakeFor}
                            stations={stations}
                            colorScheme={colorScheme}
                            onFoundQuake={onFoundSearchQuake}
                            onPointsChange={setNearbyEpicenterPoints}
                            onLoadingChange={setNearbyEpicenterLoading}
                            epicenterCirclesEnabled={epicenterCirclesEnabled}
                            onSelectQuake={(id) => {
                              if (scrollRef.current) nearbyListScrollTopRef.current = scrollRef.current.scrollTop;
                              setNearbyQuakeFor(null);
                              handleSelectQuakeForScroll(id);
                            }}
                          />
                        </div>
                      );
                    }
                    if (mechDetailOpen) {
                      return (
                        <div key={`${selected.id}:mech`}>
                          <QuakeMechDetailPanel quake={selected}/>
                        </div>
                      );
                    }
                    return (
                      <div key={selected.id}>
                        <PanelDragHandoffCard onHandoffToPanelDrag={handlePointerDown}>
                          <QuakeDetailCard quake={selected}/>
                        </PanelDragHandoffCard>
                        {!selected.isEqdb && <QuakeMessageCard quake={selected}/>}
                        {shouldShowNearbyQuakeButton(selected) && (
                          <div style={{ margin: "2px 14px 8px" }}>
                            <PressableButton
                              type="button"
                              onClick={() => {
                                if (scrollRef.current) scrollRef.current.scrollTop = 0;
                                setNearbyOriginId(selected.id);
                                setNearbyQuakeFor(selected.place);
                                setSnapIndex(3);
                              }}
                              style={{
                                width: "100%", padding: "10px 12px", borderRadius: 12,
                                border: "none", cursor: "pointer",
                                background: `rgba(${tokens.ink},0.08)`,
                                boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.14)`,
                                color: tokens.text, fontSize: 13, fontWeight: 600,
                                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                              }}
                            >
                              この震源の近傍で発生した地震
                            </PressableButton>
                          </div>
                        )}
                        {stationPoints.length > 0 && (
                          <StationPointsList points={stationPoints} displayMode={stationListDisplayMode}
                            openKey={stationDetailOpenKey} onOpenKeyChange={setStationDetailOpenKey}/>
                        )}
                        {/* 発震機構解はおおむねM5.0以上でないと気象庁側で解析されないため、
                            それ未満の地震ではボタン自体を出さない。 */}
                        {selected.magnitude != null && selected.magnitude >= 5.0 && (
                          <div style={{ margin: "8px 14px 4px" }}>
                            <PressableButton
                              type="button"
                              onClick={() => {
                                if (scrollRef.current) scrollRef.current.scrollTop = 0;
                                setMechDetailOpen(true);
                                setSnapIndex(3);
                              }}
                              style={{
                                width: "100%", padding: "10px 12px", borderRadius: 12,
                                border: "none", cursor: "pointer",
                                background: `rgba(${tokens.ink},0.08)`,
                                boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.14)`,
                                color: tokens.text, fontSize: 13, fontWeight: 600,
                                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                              }}
                            >
                              この地震の詳細
                            </PressableButton>
                          </div>
                        )}
                      </div>
                    );
                  }

                  // 「検索」モード: 気象庁 震度データベース(eqdb)を期間・M・最大震度で検索するUI。
                  if (quakeViewMode === "search") {
                    return (
                      <QuakeSearchPanel
                        stations={stations}
                        colorScheme={colorScheme}
                        onFoundQuake={onFoundSearchQuake}
                        onSelectQuake={handleSelectQuakeForScroll}
                        search={eqdbSearch}
                        onChangeSearch={setEqdbSearch}
                        onSearchExecuted={() => setSnapIndex(3)}
                        scrollContainerRef={scrollRef}
                        onPointsChange={setSearchEpicenterPoints}
                        onLoadingChange={setSearchEpicenterLoading}
                        epicenterCirclesEnabled={epicenterCirclesEnabled}
                      />
                    );
                  }

                  return (
                    <>
                      {quakes.map((q, i) => (
                        <QuakeListRow
                          key={q.id}
                          quake={q}
                          showDivider={i > 0}
                          colorScheme={colorScheme}
                          onSelect={() => handleSelectQuakeForScroll(q.id)}
                        />
                      ))}
                    </>
                  );
                })()}

                {/* フローティング部分(地震一覧)とボタン類(ナビ行)の境界線 */}
                <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.22)`, margin: "2px 0 0" }}/>
              </>
            ) : active === "tsunami" ? (
              <>
                <TsunamiTabBody
                  tsunamis={tsunamis}
                  status={tsunamiStatus}
                  selectedId={selectedTsunamiId}
                  onSelect={handleSelectTsunamiForScroll}
                  onHandoffToPanelDrag={handlePointerDown}
                  viewMode={tsunamiViewMode}
                  historyItems={tsunamiHistory?.items ?? EMPTY_EQDB_LIST}
                  historyStatus={tsunamiHistory?.status ?? "idle"}
                  historyHasMore={tsunamiHistory?.hasMore ?? true}
                  historyDebug={tsunamiHistory?.debug ?? ""}
                  onLoadMoreHistory={onLoadMoreTsunamiHistory}
                  onFindCausingQuake={handleFindCausingQuake}
                  causingQuakeState={causingQuakeState}
                  showingCausingQuakeFor={showingCausingQuakeFor}
                  onBackFromCausingQuake={handleBackFromCausingQuake}
                  stationListDisplayMode={stationListDisplayMode}
                  causingQuakeStationOpenKey={causingQuakeStationOpenKey}
                  onChangeCausingQuakeStationOpenKey={setCausingQuakeStationOpenKey}
                  tideStations={tideStations}
                  tideStationsStatus={tideStationsStatus}
                  selectedTideStationCode={selectedTideStationCode}
                  onSelectTideStation={onSelectTideStation}
                  tideObsByStation={tideObsByStation}
                  onLoadTideObs={onLoadTideObs}
                  tsunamiHeightByStation={tsunamiHeightByStation}
                  tsunamiHeightTimeByStation={tsunamiHeightTimeByStation}
                />

                {/* フローティング部分(津波情報一覧)とボタン類(ナビ行)の境界線 */}
                <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.22)`, margin: "2px 0 0" }}/>
              </>
            ) : active === "settings" ? (
              <>
                <SettingsBody
                  path={settingsPath}
                  onNavigate={handleSettingsNavigate}
                  colorSchemeId={colorSchemeId}
                  onChangeColorScheme={onChangeQuakeColorScheme}
                  nowcastColorSchemeId={nowcastColorSchemeId}
                  onChangeNowcastColorScheme={onChangeNowcastColorScheme}
                  typhoonForecastIntervalHours={typhoonForecastIntervalHours}
                  onChangeTyphoonForecastIntervalHours={handleChangeTyphoonForecastIntervalHours}
                  estIntensityEnabled={estIntensityEnabled}
                  onChangeEstIntensityEnabled={onChangeEstIntensityEnabled}
                  areaFillEnabled={areaFillEnabled}
                  onChangeAreaFillEnabled={onChangeAreaFillEnabled}
                  faultsEnabled={faultsEnabled}
                  onChangeFaultsEnabled={onChangeFaultsEnabled}
                  plateBoundariesEnabled={plateBoundariesEnabled}
                  onChangePlateBoundariesEnabled={onChangePlateBoundariesEnabled}
                  epicenterCirclesEnabled={epicenterCirclesEnabled}
                  onChangeEpicenterCirclesEnabled={onChangeEpicenterCirclesEnabled}
                  boundaryLineColorId={boundaryLineColorId}
                  onChangeBoundaryLineColorId={onChangeBoundaryLineColorId}
                  quakeFetchLimit={quakeFetchLimit}
                  onChangeQuakeFetchLimit={onChangeQuakeFetchLimit}
                  stationListDisplayMode={stationListDisplayMode}
                  onChangeStationListDisplayMode={onChangeStationListDisplayMode}
                  experimentalFeaturesEnabled={experimentalFeaturesEnabled}
                  onChangeExperimentalFeaturesEnabled={onChangeExperimentalFeaturesEnabled}
                  testTsunami={testTsunami}
                  onBroadcastTestTsunami={onBroadcastTestTsunami}
                  onCancelTestTsunami={onCancelTestTsunami}
                  onClearTestTsunami={onClearTestTsunami}
                  testEews={testEews}
                  onTestEewAction={onTestEewAction}
                  eewTestForm={eewTestForm}
                  eewEpicenterPickActive={eewEpicenterPickActive}
                  testQuake={testQuake}
                  onTestQuakeAction={onTestQuakeAction}
                  quakeTestForm={quakeTestForm}
                  quakeEpicenterPickActive={quakeEpicenterPickActive}
                  quakeTestAutoPlaying={quakeTestAutoPlaying}
                  tsunamiAreaPickActive={tsunamiAreaPickActive}
                  onStartTsunamiAreaPick={onStartTsunamiAreaPick}
                  pickedTsunamiAreas={pickedTsunamiAreas}
                  onRemoveTsunamiAreaPick={onRemoveTsunamiAreaPick}
                  onCycleTsunamiAreaGrade={onCycleTsunamiAreaGrade}
                  pickedTsunamiHeights={pickedTsunamiHeights}
                  onChangeTsunamiHeightPick={onChangeTsunamiHeightPick}
                  onRemoveTsunamiHeightPick={onRemoveTsunamiHeightPick}
                  candidateHeightStations={candidateHeightStations}
                  onAddTsunamiHeightPick={onAddTsunamiHeightPick}
                />

                {/* フローティング部分(設定メニュー)とボタン類(ナビ行)の境界線 */}
                <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.22)`, margin: "2px 0 0" }}/>
              </>
            ) : (active === "weather" || active === "alert") ? (
              <>
                {active === "weather" ? (
                  typhoonEnabled ? (
                    selectedTyphoonInfo ? (
                      <TyphoonDetailCard
                        info={selectedTyphoonInfo}
                        typhoons={typhoonList}
                        onSelectTyphoonDetail={handleSelectTyphoonDetail}
                      />
                    ) : (
                      <TyphoonListPanel
                        typhoons={typhoonList}
                        loadError={typhoonLoadError}
                        onSelectTyphoon={onSelectTyphoon}
                      />
                    )
                  ) : (
                  <WeatherLocationPanel
                    geoState={geoState}
                    onConsentLocation={requestWeatherLocationPermission}
                    onResetLocationConsent={resetWeatherLocationConsent}
                    activeWeatherPoint={activeWeatherPoint}
                    forecastState={weatherForecastState}
                    timeSeriesState={timeSeriesState}
                    registeredWeatherPoint={registeredWeatherPoint}
                    currentMunicipalityName={currentMunicipalityName}
                    weatherSourceMode={weatherSourceMode}
                    onChangeWeatherSourceMode={setWeatherSourceMode}
                    kanaPickerOpen={kanaPickerOpen}
                    onOpenKanaPicker={openKanaPicker}
                    onCloseKanaPicker={closeKanaPicker}
                    kanaPickerStep={kanaPickerStep}
                    onChangeKanaPickerStep={setKanaPickerStep}
                    kanaPickerPref={kanaPickerPref}
                    onChangeKanaPickerPref={setKanaPickerPref}
                    kanaPickerRow={kanaPickerRow}
                    onChangeKanaPickerRow={setKanaPickerRow}
                    kanaPickerCol={kanaPickerCol}
                    onChangeKanaPickerCol={setKanaPickerCol}
                    kanaGroupedMunicipalities={kanaGroupedMunicipalities}
                    municipalityListReady={!!municipalityList}
                    municipalityListError={municipalityListError}
                    onSelectMunicipality={(m) => {
                      setRegisteredWeatherPoint({ name: m.regionname, lat: m.lat, lon: m.lon, regioncode: m.regioncode });
                      setWeatherSourceMode("registered");
                      closeKanaPicker();
                    }}
                  />
                  )
                ) : selectedRiverStation ? (
                  <RiverStationDetailCard properties={selectedRiverStation} />
                ) : selectedWarningArea ? (
                  <WarningAreaDetailCard
                    regioncode={selectedWarningArea}
                    warningLevelMap={warningLevelMap}
                    warningAreaByRegioncode={warningAreaByRegioncode}
                  />
                ) : (
                  <WarningAreaListPanel
                    warningLevelMap={warningLevelMap}
                    warningAreaByRegioncode={warningAreaByRegioncode}
                    onSelectWarningArea={onSelectWarningAreaFromList}
                  />
                )}

                {/* フローティング部分(設定メニュー)とボタン類(ナビ行)の境界線 */}
                <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.22)`, margin: "2px 0 0" }}/>
              </>
            ) : (
              <>
                <div style={{
                  display: "flex", alignItems: "center",
                  padding: "8px 18px 11px",
                  borderBottom: `0.5px solid rgba(${tokens.ink},0.15)`,
                }}>
                  <span style={{ fontSize: 14, fontWeight: 600, flex: 1, color: `rgba(${tokens.ink},0.9)` }}>
                    地図レイヤー
                  </span>
                </div>

                {layers.map((l, i) => (
                  <div key={l.id}>
                    {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.1)`, marginLeft: 18 }}/>}
                    <div style={{ display: "flex", alignItems: "center", padding: "11px 18px", gap: 10 }}>
                      <span style={{ fontSize: 14, color: `rgba(${tokens.ink},0.85)`, flex: 1 }}>
                        {l.label}
                      </span>
                      <Toggle on={l.on} onChange={() => onToggleLayer(l.id)}/>
                    </div>
                  </div>
                ))}

                {/* フローティング部分(レイヤー一覧)とボタン類(ナビ行)の境界線 */}
                <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.22)`, margin: "2px 0 0" }}/>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ナビ行 — 常に表示される、ガラスの“足元”。
          Liquid Glassのハイライトが指の位置に連続追従し、なぞるだけで
          タブを選べる。タップのみの操作もそのまま機能する。
          広い画面(isWide)では、代わりに左端のSideNavRailを使うのでここでは出さない。 */}
      {!isWide && (
      <div
        ref={navRowRef}
        onPointerDown={handleNavPointerDown}
        onPointerMove={handleNavPointerMove}
        onPointerUp={handleNavPointerUp}
        onPointerCancel={handleNavPointerUp}
        style={{
          position: "relative",
          display: "flex", flexDirection: "row",
          padding: `4px ${NAV_PAD_X}px`, gap: 0,
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
          WebkitTouchCallout: "none",     // iOS: 長押しでのコピー/調べる/翻訳メニューを無効化
          WebkitTapHighlightColor: "transparent",
        }}
      >
        {/* ガラスのハイライトピル — %ベースで位置・幅を管理。
            ドラッグ中: transition:none で指に即座追従。
            pointerup 後: spring transition でスナップ位置へ吸い付く。 */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: 4, bottom: 4,
            // 親(ナビ行)基準の % だけだと外側パディングが二重に効かず
            // ハイライトが外枠の縁に接してしまうため、calc() で
            // 内側領域オフセット(NAV_PAD_X)を明示的に加算する。
            left: `calc(${NAV_PAD_X}px + (100% - ${NAV_PAD_X * 2}px) * ${highlightLeft / 100})`,
            width: `calc((100% - ${NAV_PAD_X * 2}px) * ${tabW / 100})`,
            borderRadius: 999,
            background: (navPressed || navDragging) && !glassOpaque ? tokens.glassTint : tokens.navPillBg,
            boxShadow: (navPressed || navDragging) && !glassOpaque
              ? `inset 0 0 0 0.5px ${tokens.rimLight}, inset 0 1px 0 ${tokens.rimHighlight}`
              : tokens.navPillShadow,
            // タッチ/ドラッグ中だけ本物のガラス(backdrop-filter blur)にする。
            backdropFilter: (navPressed || navDragging) && !glassOpaque ? touchGlassBackdropFilter(mode) : "none",
            WebkitBackdropFilter: (navPressed || navDragging) && !glassOpaque ? touchGlassBackdropFilter(mode) : "none",
            // 押している間はわずかに拡大し、Apple Liquid Glass特有の
            // "押し込むとガラスが少し膨らむ" 触覚的な質感を再現する。
            transform: navPressed ? "scale(1.16)" : "scale(1)",
            transformOrigin: "center",
            transition: navDragging
              ? "transform 0.18s cubic-bezier(.22,1,.36,1)"
              : "left 0.38s cubic-bezier(.22,1,.36,1), transform 0.18s cubic-bezier(.22,1,.36,1)",
            pointerEvents: "none",
            zIndex: 0,
          }}
        />

        {NAV.map(({ id, label }, idx) => {
          const isActive = idx === displayIdx;
          return (
            <button
              key={id}
              onClick={() => handleNavClick(id)}
              style={{
                position: "relative", zIndex: 1,
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center",
                gap: 4, flex: 1, minWidth: 0, height: 58,
                borderRadius: 999, border: "none",
                background: "transparent",
                cursor: "pointer",
                color: isActive ? `rgba(${tokens.ink},1)` : `rgba(${tokens.ink},0.6)`,
                transition: "color 0.15s",
                padding: "0 4px",
                touchAction: "none",
                userSelect: "none",
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",   // iOS: 長押しでのコピー/調べる/翻訳メニューを無効化
                WebkitTapHighlightColor: "transparent",
              }}
            >
              {NAV_ICONS[id]}
              <span style={{
                fontSize: 11,
                fontWeight: isActive ? 700 : 500,
                lineHeight: 1,
                letterSpacing: -0.1,
                whiteSpace: "nowrap",
                userSelect: "none",
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",
              }}>
                {label}
              </span>
            </button>
          );
        })}
      </div>
      )}
      </ScaleWrap>
        );
      })()}
      </GlassOrPlain>
        );
      })()}
    </>
  );
}

/* ─────────────────────────────────────────────────────
   QUAKE INTENSITY LEGEND
   選択中の地震の「震度1〜最大震度」までを縦並びで表示する凡例。
   最大震度のバッジだけ枠線で強調する。画面左上に浮かべて使う想定。
   ───────────────────────────────────────────────────── */
const INTENSITY_LEGEND_ORDER = ["1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];

function QuakeIntensityLegend({ maxIntensity, legacyIntensityScale }) {
  const { tokens } = useContext(ThemeContext);
  const schemeId = useContext(QuakeColorSchemeContext);
  const scheme = QUAKE_COLOR_SCHEMES[schemeId] || QUAKE_COLOR_SCHEMES.fill;

  // 旧震度階級(弱/強の区分が無い震度5・6)は、5弱/6弱と同じ色を使っているため、
  // 通常の並び順にそのまま追加すると「5」と「5弱」のように同じ色のバーが
  // 隣り合って重複しているように見えてしまう。そのため通常の並び順には含めず、
  // 震度4(または5強)までの並びに続けて、単独の「5」または「6」バーで
  // 打ち切る形にする。
  // 震度7の場合も、旧震度階級の期間の地震なら5弱/5強・6弱/6強の区別は
  // 存在しないはずなので、legacyIntensityScaleを見て同様に単純化する。
  let levels;
  if (maxIntensity === "5") {
    levels = ["1", "2", "3", "4", "5"];
  } else if (maxIntensity === "6") {
    levels = ["1", "2", "3", "4", "5", "6"];
  } else if (maxIntensity === "7" && legacyIntensityScale) {
    levels = ["1", "2", "3", "4", "5", "6", "7"];
  } else {
    const maxIdx = INTENSITY_LEGEND_ORDER.indexOf(maxIntensity);
    if (maxIdx < 0) return null; // 震度0や不明("?")の場合は凡例を出さない
    levels = INTENSITY_LEGEND_ORDER.slice(0, maxIdx + 1);
  }

  return (
    <Glass
      radius={12}
      style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        padding: "8px 9px",
      }}>
        {levels.map(key => {
          const style = getIntensityStyleFromScheme(scheme, key);
          const isMax = key === maxIntensity;
          return (
            // 設定の震度配色ピッカーのミニプレビューと同じ、隙間の詰まった横一列のバー
            <div
              key={key}
              style={{
                width: 7, height: 16, borderRadius: 2,
                background: style.bg,
                boxShadow: isMax ? `0 0 0 2px rgba(${tokens.ink},0.9)` : "none",
                flexShrink: 0,
              }}
            />
          );
        })}
      </div>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   TSUNAMI GRADE LEGEND — QuakeIntensityLegendと全く同じ見た目
   (横一列に並んだ隙間の詰まった色バー)にした版。
   「一番下(津波予報)〜一番上」までのラダー表示にする。一番上に来るグレードは、
   (a) 実際に発表されている予報区の中で一番高いグレード と
   (b) 観測された津波の最大波から相当するグレード
   のうち、高い方を採用する(例: 警報が出ていても、大津波警報相当の高さが
   観測されていれば、大津波警報の色まで表示する)。
   ───────────────────────────────────────────────────── */
function TsunamiGradeLegend({ areas, tsunamiHeightByStation = {} }) {
  const { tokens } = useContext(ThemeContext);
  const gradesPresent = [...new Set((areas || []).map(a => a.grade))];
  if (gradesPresent.length === 0) return null;

  const declaredMaxWeight = Math.max(...gradesPresent.map(g => tsunamiGradeInfo(g).weight));

  // 観測された津波の最大波(全観測点の中で一番高いもの)から相当グレードを求める。
  const heights = Object.values(tsunamiHeightByStation).map(h => Math.abs(h));
  const maxObservedHeight = heights.length > 0 ? Math.max(...heights) : null;
  const observedGrade = tsunamiHeightBandGrade(maxObservedHeight);
  const observedWeight = observedGrade ? tsunamiGradeInfo(observedGrade).weight : 0;

  const maxWeight = Math.max(declaredMaxWeight, observedWeight);
  // 「津波予報」〜maxWeightまでを順番に並べる(ラダー)。ただし「津波予報」
  // (NonEffective)は、実際にどこかの予報区で発表されている時だけ含める
  // (観測やmaxWeightの都合だけで機械的に一番下へ足さない)。
  const ladderGrades = Object.entries(TSUNAMI_GRADE_INFO)
    .filter(([key, info]) => {
      if (key === "Unknown") return false;
      if (info.weight < 1 || info.weight > maxWeight) return false;
      if (key === "NonEffective" && !gradesPresent.includes("NonEffective")) return false;
      return true;
    })
    .sort((a, b) => a[1].weight - b[1].weight)
    .map(([key]) => key);
  if (ladderGrades.length === 0) return null;

  return (
    <Glass
      radius={12}
      style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        padding: "8px 9px",
      }}>
        {ladderGrades.map(grade => {
          const info = tsunamiGradeInfo(grade);
          const isMax = info.weight === maxWeight;
          return (
            // 震度凡例のミニバーと同じ、隙間の詰まった横一列のバー
            <div
              key={grade}
              style={{
                width: 7, height: 16, borderRadius: 2,
                background: info.color,
                boxShadow: isMax ? `0 0 0 2px rgba(${tokens.ink},0.9)` : "none",
                flexShrink: 0,
              }}
            />
          );
        })}
      </div>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   NOWCAST LEGEND — 震度凡例・津波凡例と同じ見た目(Glassカード+隙間の
   詰まった横一列の色バー)にした、雨雲レーダーの降水強度凡例。
   選択中の配色スキーム(気象庁配色/Yahoo!天気配色)をそのまま反映する。
   ───────────────────────────────────────────────────── */
function NowcastLegend() {
  const { tokens } = useContext(ThemeContext);
  const schemeId = useContext(NowcastColorSchemeContext);
  const scheme = NOWCAST_COLOR_SCHEMES[schemeId] || NOWCAST_COLOR_SCHEMES.jma;
  const colors = scheme.palette || JMA_NOWCAST_SOURCE_PALETTE;
  // colorsの各要素(弱い順)に対応する下限値(mm/h)。並びはJMA_NOWCAST_SOURCE_PALETTE
  // /YAHOO_WEATHER_NOWCAST_PALETTEの区分(0~1,1~5,5~10,10~20,20~30,30~50,50~80,80~)と対応。
  const NOWCAST_LEGEND_LOWER_BOUNDS = ["0", "1", "5", "10", "20", "30", "50", "80"];
  const SWATCH_WIDTH = 22; // 数値ラベルが収まるよう、震度凡例・津波凡例より少し幅広にしている

  return (
    <Glass
      radius={12}
      style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{ display: "flex", flexDirection: "column", padding: "6px 8px 0" }}>
        {/* 単位ラベル。lineHeightを明示的に詰めて、フォントの行送り分の
            余白が上下に出ないようにする(指定しないと文字サイズの見た目以上に
            行の高さを取ってしまい、バーとの間に不自然な余白ができるため)。 */}
        <div style={{
          fontSize: 10, lineHeight: "11px", fontWeight: 700,
          color: `rgba(${tokens.ink},0.6)`, marginBottom: 3, whiteSpace: "nowrap",
        }}>
          mm/h
        </div>
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center" }}>
          {colors.map((rgb, i) => (
            // 隙間なく連結した一続きのバーにし、両端だけ丸める
            <div
              key={i}
              style={{
                width: SWATCH_WIDTH, height: 9,
                borderRadius: i === 0 ? "2px 0 0 2px" : i === colors.length - 1 ? "0 2px 2px 0" : 0,
                background: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`,
                flexShrink: 0,
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center" }}>
          {NOWCAST_LEGEND_LOWER_BOUNDS.map((label, i) => (
            // 各数値はその区分の下限値なので、ボックス中央でなく対応する
            // スウォッチの左端(色の境界線)に揃えて詰まって見えるようにする。
            // lineHeightを詰めて、フォントの行送り分の余白も削る。
            <div
              key={i}
              style={{
                width: SWATCH_WIDTH, flexShrink: 0, textAlign: "left", paddingLeft: 1,
                fontSize: 9, lineHeight: "9px", fontWeight: 600, color: `rgba(${tokens.ink},0.55)`,
              }}
            >
              {label}
            </div>
          ))}
        </div>
      </div>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   PRECIP LEGEND — NowcastLegendと全く同じ見た目・仕組み(Glassカード+隙間の
   詰まった横一列の色バー、配色は選択中のNowcastColorSchemeをそのまま反映)。
   1/3/24時間降水量はモードごとに目盛りの数値が異なる(気象庁の実際の凡例
   画像から採取した値)ため、モード名だけ外から渡してもらう。
   ・1時間: 雨雲レーダーと全く同じ区分(0,1,5,10,20,30,50,80 mm/h)
   ・3時間: 1,20,40,60,80,100,120,150 mm/3h
   ・24時間: 1,50,80,100,150,200,250,300 mm/24h
   ───────────────────────────────────────────────────── */
const PRECIP_LEGEND_LOWER_BOUNDS = {
  precip1h:  ["0", "1", "5", "10", "20", "30", "50", "80"],
  precip3h:  ["1", "20", "40", "60", "80", "100", "120", "150"],
  precip24h: ["1", "50", "80", "100", "150", "200", "250", "300"],
};
const PRECIP_LEGEND_UNIT = {
  precip1h: "mm/h",
  precip3h: "mm/3h",
  precip24h: "mm/24h",
};
function PrecipLegend({ mode }) {
  const { tokens } = useContext(ThemeContext);
  const schemeId = useContext(NowcastColorSchemeContext);
  const scheme = NOWCAST_COLOR_SCHEMES[schemeId] || NOWCAST_COLOR_SCHEMES.jma;
  const colors = scheme.palette || JMA_NOWCAST_SOURCE_PALETTE;
  const bounds = PRECIP_LEGEND_LOWER_BOUNDS[mode] || PRECIP_LEGEND_LOWER_BOUNDS.precip1h;
  const unit = PRECIP_LEGEND_UNIT[mode] || "mm";
  const SWATCH_WIDTH = 22; // NowcastLegendと同じ幅

  return (
    <Glass
      radius={12}
      style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{ display: "flex", flexDirection: "column", padding: "6px 8px 0" }}>
        {/* 単位ラベル。1/3/24時間のどのモードの凡例か分かるよう、雨雲レーダーの
            凡例(NowcastLegend)にはもともと無かった見出しを1行追加している。
            lineHeightを明示的に詰めて、フォントの行送り分の余白が上下に
            出ないようにする。 */}
        <div style={{
          fontSize: 10, lineHeight: "11px", fontWeight: 700,
          color: `rgba(${tokens.ink},0.6)`, marginBottom: 3, whiteSpace: "nowrap",
        }}>
          {unit}
        </div>
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center" }}>
          {colors.map((rgb, i) => (
            <div
              key={i}
              style={{
                width: SWATCH_WIDTH, height: 9,
                borderRadius: i === 0 ? "2px 0 0 2px" : i === colors.length - 1 ? "0 2px 2px 0" : 0,
                background: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`,
                flexShrink: 0,
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center" }}>
          {bounds.map((label, i) => (
            <div
              key={i}
              style={{
                width: SWATCH_WIDTH, flexShrink: 0, textAlign: "left", paddingLeft: 1,
                fontSize: 9, lineHeight: "9px", fontWeight: 600, color: `rgba(${tokens.ink},0.55)`,
              }}
            >
              {label}
            </div>
          ))}
        </div>
      </div>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   WDIST LEGEND — 天気分布予報の凡例。天気分布(晴れ/くもり/雨/雨または雪/雪の
   5分類)は連続的な数値スケールではないカテゴリなので、横一列のバーではなく
   「色見本+ラベル」を縦に並べる形にしている。気温分布は降水量と同じく
   連続的な数値なので、PrecipLegendと同じ横一列のバー形式にしている。
   ⚠️ どちらも色はJMAの実際のタイル配色を確認できていない暫定値。実機で
   確認できたら実際の配色に合わせて直す。
   ───────────────────────────────────────────────────── */
const WDIST_WEATHER_CATEGORIES = [
  { label: "晴れ", color: "#F5A623" },
  { label: "くもり", color: "#9AA0A6" },
  { label: "雨", color: "#4A90D9" },
  { label: "雨または雪", color: "#B48EAD" },
  { label: "雪", color: "#E8EEF5" },
];
// 気温分布用の配色・区分値(℃)。ユーザー提供のJMA凡例画像から採取した実際の
// スケール。画像は縦方向(下=寒い/薄紫〜上=暑い/濃い臙脂)なので、横一列の
// バーに直す際は「左=寒い、右=暑い」の向きにしている(雨雲レーダー・降水量の
// 凡例と同じ、弱い/低い方を左に置く向き)。
// 色は画像から目視で採取した近似値。
const WDIST_TEMP_LEGEND_COLORS = [
  [216, 214, 227], // 〜-25(パレット画像の一番下、パステル紫)
  [178, 175, 201], // -25〜-20
  [147, 143, 175], // -20〜-15
  [90, 86, 120],   // -15〜-10
  [20, 40, 110],   // -10〜-5
  [35, 70, 220],   // -5〜0
  [70, 130, 230],  // 0〜5
  [180, 220, 245], // 5〜10
  [255, 255, 230], // 10〜15
  [255, 255, 150], // 15〜20
  [255, 230, 20],  // 20〜25
  [245, 165, 60],  // 25〜30
  [235, 80, 40],   // 30〜35
  [180, 30, 100],  // 35〜40
  [75, 10, 35],    // 40〜(画像の一番上、濃い臙脂)
];
// 一番左(最も寒い)のバンドは画像でも下限値が示されていないため、先頭だけ
// 空文字にする(1時間降水量の凡例で先頭"0"を省いたのと同じ扱い)。
const WDIST_TEMP_LEGEND_BOUNDS = ["", "-25", "-20", "-15", "-10", "-5", "0", "5", "10", "15", "20", "25", "30", "35", "40"];

function WdistLegend({ mode }) {
  const { tokens } = useContext(ThemeContext);

  if (mode === "temperature") {
    const SWATCH_WIDTH = 17; // 15段あるのでPrecipLegendより少し狭くして詰める
    const barWidth = WDIST_TEMP_LEGEND_COLORS.length * SWATCH_WIDTH;
    return (
      <Glass
        radius={12}
        style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
      >
        <div style={{ display: "flex", flexDirection: "column", padding: "6px 8px 0" }}>
          <div style={{
            fontSize: 10, lineHeight: "11px", fontWeight: 700,
            color: `rgba(${tokens.ink},0.6)`, marginBottom: 3, whiteSpace: "nowrap",
          }}>
            ℃
          </div>
          <div style={{ display: "flex", flexDirection: "row", alignItems: "center" }}>
            {WDIST_TEMP_LEGEND_COLORS.map((rgb, i) => (
              <div
                key={i}
                style={{
                  width: SWATCH_WIDTH, height: 9,
                  borderRadius: i === 0 ? "2px 0 0 2px" : i === WDIST_TEMP_LEGEND_COLORS.length - 1 ? "0 2px 2px 0" : 0,
                  background: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`,
                  flexShrink: 0,
                }}
              />
            ))}
          </div>
          {/* 数字は各色の下ではなく、境界線(色と色の切れ目)のちょうど真上に
              来るよう、絶対配置で中央揃えにする。 */}
          <div style={{ position: "relative", width: barWidth, height: 10 }}>
            {WDIST_TEMP_LEGEND_BOUNDS.map((label, i) => (
              label ? (
                <div
                  key={i}
                  style={{
                    position: "absolute", left: i * SWATCH_WIDTH, top: 0,
                    transform: "translateX(-50%)",
                    fontSize: 8, lineHeight: "9px", fontWeight: 600, color: `rgba(${tokens.ink},0.55)`,
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </div>
              ) : null
            ))}
          </div>

        </div>
      </Glass>
    );
  }

  // mode === "weather"(デフォルト)
  return (
    <Glass
      radius={12}
      style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{ display: "flex", flexDirection: "column", padding: "8px 10px", gap: 5 }}>
        <div style={{
          fontSize: 10, lineHeight: "11px", fontWeight: 700,
          color: `rgba(${tokens.ink},0.6)`, marginBottom: 1, whiteSpace: "nowrap",
        }}>
          天気
        </div>
        {WDIST_WEATHER_CATEGORIES.map(cat => (
          <div key={cat.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{
              width: 12, height: 12, borderRadius: 3, flexShrink: 0,
              background: cat.color,
              boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.15)`,
            }}/>
            <span style={{ fontSize: 11, fontWeight: 600, color: tokens.text, whiteSpace: "nowrap" }}>
              {cat.label}
            </span>
          </div>
        ))}
      </div>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   RISK LEGEND — 警報タブのキキクル(土砂/浸水)レイヤーの凡例。PrecipLegendと
   全く同じ見た目・仕組み(Glassカード+隙間の詰まった横一列の色バー)。
   区分値ではなく危険度レベル(5〜1)なので、目盛りは1〜5の数字にする。
   レベル1(無色)は背景に馴染んで見えなくなるので、薄い枠線を付ける。
   ───────────────────────────────────────────────────── */
const RISK_LEGEND_LEVELS = [
  { level: 1, color: "rgba(255,255,255,0.08)", border: true }, // 注意(無色)
  { level: 2, color: "#f2e700" }, // 警戒
  { level: 3, color: "#ff2800" }, // 非常に危険
  { level: 4, color: "#aa00aa" }, // 極めて危険
  { level: 5, color: "#0c000c" }, // 災害切迫
];
function RiskLegend({ mode }) {
  const { tokens } = useContext(ThemeContext);
  const title = RISK_MODE_CONFIG[mode]?.label || "キキクル";
  const SWATCH_WIDTH = 22; // PrecipLegendと同じ幅

  return (
    <Glass
      radius={12}
      style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{ display: "flex", flexDirection: "column", padding: "6px 8px 0" }}>
        <div style={{
          fontSize: 10, lineHeight: "11px", fontWeight: 700,
          color: `rgba(${tokens.ink},0.6)`, marginBottom: 3, whiteSpace: "nowrap",
        }}>
          {title}
        </div>
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center" }}>
          {RISK_LEGEND_LEVELS.map((item, i) => (
            <div
              key={item.level}
              style={{
                width: SWATCH_WIDTH, height: 9, boxSizing: "border-box",
                borderRadius: i === 0 ? "2px 0 0 2px" : i === RISK_LEGEND_LEVELS.length - 1 ? "0 2px 2px 0" : 0,
                background: item.color,
                border: item.border ? `1px solid rgba(${tokens.ink},0.3)` : "none",
                flexShrink: 0,
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center", paddingBottom: 5 }}>
          {RISK_LEGEND_LEVELS.map((item) => (
            <div
              key={item.level}
              style={{
                width: SWATCH_WIDTH, flexShrink: 0, textAlign: "left", paddingLeft: 1,
                fontSize: 9, lineHeight: "9px", fontWeight: 600, color: `rgba(${tokens.ink},0.55)`,
              }}
            >
              {item.level}
            </div>
          ))}
        </div>
      </div>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   RIVER LEGEND — 警報タブの河川水位観測所レイヤーの凡例。RiskLegendと同じ
   Glassカードだが、区分値がレベル(5段階+通常)ではなく、色付きの丸+ラベルを
   縦に並べる形にする(河川水位は「通常」も含めて意味のある名前が付いているため、
   RiskLegendの数字だけの目盛りよりラベルを出した方が分かりやすい)。
   ───────────────────────────────────────────────────── */
function RiverLegend() {
  const { tokens } = useContext(ThemeContext);
  return (
    <Glass
      radius={12}
      style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{ display: "flex", flexDirection: "column", padding: "6px 8px 7px", gap: 3 }}>
        <div style={{
          fontSize: 10, lineHeight: "11px", fontWeight: 700,
          color: `rgba(${tokens.ink},0.6)`, marginBottom: 1, whiteSpace: "nowrap",
        }}>
          河川水位
        </div>
        {[...RIVER_LEVEL_STEPS].reverse().map((step) => (
          <div key={step.level} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{
              width: 8, height: 8, borderRadius: 999, flexShrink: 0,
              background: step.color,
              border: step.level === 0 ? `1px solid rgba(${tokens.ink},0.3)` : "none",
            }}/>
            <span style={{ fontSize: 9.5, fontWeight: 600, color: `rgba(${tokens.ink},0.6)`, whiteSpace: "nowrap" }}>
              {step.label}
            </span>
          </div>
        ))}
      </div>
    </Glass>
  );
}


/* ─────────────────────────────────────────────────────
   WARNING LEGEND — 警報タブの気象警報・注意報レイヤーの凡例。
   TsunamiGradeLegend/QuakeIntensityLegendと全く同じ見た目(横一列の隙間の
   詰まった色バー)で、実際に発表されている中の最も低いレベルから最も高い
   レベルまでをラダー表示する(例: 注意報と警報が両方出ていれば2段、
   最高が警報だけなら「注意報→警報」の2段まで並べる)。
   ───────────────────────────────────────────────────── */
const WARNING_LEGEND_ORDER = ["chui", "keiho", "kiken", "tokubetsu"];

function WarningLegend({ warningLevelMap }) {
  const { tokens } = useContext(ThemeContext);
  const levelsPresent = [...new Set(Object.values(warningLevelMap || {}).map(v => v.level))];
  if (levelsPresent.length === 0) return null;

  const maxWeight = Math.max(...levelsPresent.map(l => WARNING_LEVEL_PRIORITY[l]));
  const ladderLevels = WARNING_LEGEND_ORDER.filter(key => WARNING_LEVEL_PRIORITY[key] <= maxWeight);

  return (
    <Glass
      radius={12}
      style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        padding: "8px 9px",
      }}>
        {ladderLevels.map(level => {
          const isMax = WARNING_LEVEL_PRIORITY[level] === maxWeight;
          return (
            <div
              key={level}
              style={{
                width: 7, height: 16, borderRadius: 2,
                background: WARNING_LEVEL_COLOR[level],
                boxShadow: isMax ? `0 0 0 2px rgba(${tokens.ink},0.9)` : "none",
                flexShrink: 0,
              }}
            />
          );
        })}
      </div>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   NOWCAST TIME SLIDER — 雨雲レーダーがONで、展開メニュー(WeatherMenuFloating)が
   閉じている間だけ、ボタンバー(下部ナビ行)のすぐ上に浮かべる時刻スライダー。
   実況(過去)+予測(未来60分)を1本のタイムラインとしてドラッグで選べる。
   ───────────────────────────────────────────────────── */
function NowcastTimeSlider({ frames, frameIndex, onChangeFrameIndex }) {
  const { tokens } = useContext(ThemeContext);
  const [isPlaying, setIsPlaying] = useState(false);

  // 自動再生。frames自体が変わった(=一覧が5分おきに取り直された)時や
  // コマが無くなった時は再生を止める。onChangeFrameIndexは実体が
  // useStateのsetterなので関数更新(prev => ...)を渡せる。
  useEffect(() => {
    if (!isPlaying || !frames || frames.length < 2) return;
    const id = setInterval(() => {
      onChangeFrameIndex(prev => ((prev ?? 0) + 1) % frames.length);
    }, 700);
    return () => clearInterval(id);
  }, [isPlaying, frames, onChangeFrameIndex]);

  useEffect(() => {
    if (!frames || frames.length === 0) setIsPlaying(false);
  }, [frames]);

  if (!frames || frames.length === 0) return null;
  const frame = frames[frameIndex] ?? frames[frames.length - 1];
  // 実況→予測の切り替わり(=「現在」)の位置。目盛りをここだけ目立たせる。
  // 「最初の予測コマ」ではなく「最後の実況コマ」を現在とする(予測コマは
  // 現在より先の時刻なので、最初の予測コマを現在扱いにすると実際より
  // 先のコマが「現在」として長く目立ってしまっていた)。
  const firstForecastIndex = frames.findIndex(f => f.kind === "forecast");
  const nowIndex = firstForecastIndex === -1 ? frames.length - 1 : Math.max(0, firstForecastIndex - 1);
  // 目盛りを長くする基準となる「現在時刻」。実況/予測の切り替わり位置の
  // validtimeを基準に、そこからプラマイ1時間ごと(60分刻み)のコマだけ
  // 長い目盛りにする(時計の正時ではなく、あくまで「現在」からの相対時間)。
  const nowFrame = nowIndex >= 0 ? frames[nowIndex] : frames[frames.length - 1];
  const nowMs = nowFrame ? nowcastValidtimeToMs(nowFrame.validtime) : null;

  return (
    <Glass
      radius={14}
      style={{ flex: 1, minWidth: 0, animation: "appear 0.3s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px" }}>
        <button
          onClick={() => setIsPlaying(v => !v)}
          aria-label={isPlaying ? "自動再生を止める" : "自動再生する"}
          style={{
            flexShrink: 0, width: 26, height: 26, borderRadius: 999,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: tokens.text, background: `rgba(${tokens.ink},0.08)`,
          }}
        >
          {isPlaying ? (
            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
              <rect x="5" y="4" width="5" height="16" rx="1.2"/>
              <rect x="14" y="4" width="5" height="16" rx="1.2"/>
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
              <path d="M6 4.2c0-1 1.1-1.7 2-1.1l12 7.8c.8.5.8 1.7 0 2.2l-12 7.8c-.9.6-2-.1-2-1.1z"/>
            </svg>
          )}
        </button>
        {/* 数値ラベル。プロポーショナルフォントだと数字ごとにグリフ幅が違い
            (「1」は「8」より細い等)、コマが変わるたびにこのラベルの実測幅が
            微妙に変わってスライダー本体の長さがガタつく原因になっていたため、
            tabular-numsで数字幅を揃え、かつ幅を固定してレイアウトに影響しない
            ようにする。 */}
        <span style={{
          fontSize: 12.5, fontWeight: 700, color: tokens.text, flexShrink: 0,
          whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
          width: 74, textAlign: "left",
        }}>
          {formatNowcastFrameLabel(frame)}
        </span>
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          {/* トラックとつまみのサイズをブラウザ既定に任せず固定している。
              目盛り側の内側マージン(left/right)もつまみの半幅(5px)に
              揃えることで、各目盛りの位置とスライダーのつまみが実際にその
              値になったときの中心位置が常に一致するようにしている
              (既定のつまみサイズはブラウザ・OSごとにまちまちで、決め打ちの
              マージンとズレることがあったため)。つまみは目盛り線と馴染む
              よう、丸ではなく角の取れた縦長の長方形にしている。 */}
          <style>{`
            .nowcast-range { -webkit-appearance: none; appearance: none; background: transparent; }
            .nowcast-range::-webkit-slider-runnable-track {
              height: 4px; border-radius: 2px; background: rgba(${tokens.ink},0.16);
            }
            .nowcast-range::-webkit-slider-thumb {
              -webkit-appearance: none; appearance: none;
              width: 10px; height: 26px; border-radius: 4px;
              background: #0A84FF; margin-top: -11px; cursor: pointer;
            }
            .nowcast-range::-moz-range-track {
              height: 4px; border-radius: 2px; background: rgba(${tokens.ink},0.16);
            }
            .nowcast-range::-moz-range-thumb {
              width: 10px; height: 26px; border-radius: 4px;
              background: #0A84FF; border: none; cursor: pointer;
            }
          `}</style>
          {/* 目盛り — トラックに重ねて表示する。つまみの半幅ぶん(左右5px)
              内側に収め、つまみの中心と目盛りの位置がずれないように
              している。1コマごとに薄い目盛りを、「現在」からプラマイ1時間
              ごとのコマは少し濃く長い目盛りにし、実況→予測の切り替わり
              (現在そのもの)だけ青く目立たせる。 */}
          <div style={{
            position: "absolute", left: 5, right: 5, top: "50%",
            transform: "translateY(-50%)",
            height: 22, pointerEvents: "none",
          }}>
            {frames.map((f, i) => {
              const pct = frames.length > 1 ? (i / (frames.length - 1)) * 100 : 0;
              const fMs = nowcastValidtimeToMs(f.validtime);
              const diffMin = nowMs != null && fMs != null ? Math.round((fMs - nowMs) / 60000) : null;
              const isHour = diffMin != null && diffMin % 60 === 0;
              const isNow = i === nowIndex;
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute", left: `${pct}%`, top: 0,
                    transform: "translateX(-50%)",
                    width: isNow ? 2 : 1,
                    height: isNow ? 22 : isHour ? 18 : 11,
                    borderRadius: 1,
                    background: isNow ? "#0A84FF" : `rgba(${tokens.ink},${isHour ? 0.35 : 0.16})`,
                  }}
                />
              );
            })}
          </div>
          <input
            className="nowcast-range"
            type="range"
            min={0}
            max={frames.length - 1}
            step={1}
            value={frameIndex}
            onChange={(e) => onChangeFrameIndex(Number(e.target.value))}
            style={{ position: "relative", display: "block", width: "100%" }}
          />
        </div>
      </div>
    </Glass>
  );
}

// 1/3/24時間降水量用の時刻スライダー。NowcastTimeSliderとほぼ同じ見た目・
// 操作感だが、フレームに"kind"(実況/予測)の区別が無い(データ形式が未確認の
// ため)ので、「現在」の位置は現在時刻に一番近いコマ(nowcastNearestIndexToNow)
// から求める。
function PrecipTimeSlider({ frames, frameIndex, onChangeFrameIndex, formatLabel = formatPrecipFrameLabel }) {
  const { tokens } = useContext(ThemeContext);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    if (!isPlaying || !frames || frames.length < 2) return;
    const id = setInterval(() => {
      onChangeFrameIndex(prev => ((prev ?? 0) + 1) % frames.length);
    }, 700);
    return () => clearInterval(id);
  }, [isPlaying, frames, onChangeFrameIndex]);

  useEffect(() => {
    if (!frames || frames.length === 0) setIsPlaying(false);
  }, [frames]);

  if (!frames || frames.length === 0) return null;
  const frame = frames[frameIndex] ?? frames[frames.length - 1];
  const nowIndex = nowcastNearestIndexToNow(frames) ?? frames.length - 1;
  const nowFrame = frames[nowIndex];
  const nowMs = nowFrame ? nowcastValidtimeToMs(nowFrame.validtime) : null;

  return (
    <Glass
      radius={14}
      style={{ flex: 1, minWidth: 0, animation: "appear 0.3s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px" }}>
        <button
          onClick={() => setIsPlaying(v => !v)}
          aria-label={isPlaying ? "自動再生を止める" : "自動再生する"}
          style={{
            flexShrink: 0, width: 26, height: 26, borderRadius: 999,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: tokens.text, background: `rgba(${tokens.ink},0.08)`,
          }}
        >
          {isPlaying ? (
            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
              <rect x="5" y="4" width="5" height="16" rx="1.2"/>
              <rect x="14" y="4" width="5" height="16" rx="1.2"/>
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
              <path d="M6 4.2c0-1 1.1-1.7 2-1.1l12 7.8c.8.5.8 1.7 0 2.2l-12 7.8c-.9.6-2-.1-2-1.1z"/>
            </svg>
          )}
        </button>
        <span style={{
          fontSize: 12.5, fontWeight: 700, color: tokens.text, flexShrink: 0,
          whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
          width: 84, textAlign: "left",
        }}>
          {formatLabel(frame)}
        </span>
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <style>{`
            .precip-range { -webkit-appearance: none; appearance: none; background: transparent; }
            .precip-range::-webkit-slider-runnable-track {
              height: 4px; border-radius: 2px; background: rgba(${tokens.ink},0.16);
            }
            .precip-range::-webkit-slider-thumb {
              -webkit-appearance: none; appearance: none;
              width: 10px; height: 26px; border-radius: 4px;
              background: #0A84FF; margin-top: -11px; cursor: pointer;
            }
            .precip-range::-moz-range-track {
              height: 4px; border-radius: 2px; background: rgba(${tokens.ink},0.16);
            }
            .precip-range::-moz-range-thumb {
              width: 10px; height: 26px; border-radius: 4px;
              background: #0A84FF; border: none; cursor: pointer;
            }
          `}</style>
          <div style={{
            position: "absolute", left: 5, right: 5, top: "50%",
            transform: "translateY(-50%)",
            height: 22, pointerEvents: "none",
          }}>
            {frames.map((f, i) => {
              const pct = frames.length > 1 ? (i / (frames.length - 1)) * 100 : 0;
              const fMs = nowcastValidtimeToMs(f.validtime);
              const diffMin = nowMs != null && fMs != null ? Math.round((fMs - nowMs) / 60000) : null;
              const isHour = diffMin != null && diffMin % 60 === 0;
              const isNow = i === nowIndex;
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute", left: `${pct}%`, top: 0,
                    transform: "translateX(-50%)",
                    width: isNow ? 2 : 1,
                    height: isNow ? 22 : isHour ? 18 : 11,
                    borderRadius: 1,
                    background: isNow ? "#0A84FF" : `rgba(${tokens.ink},${isHour ? 0.35 : 0.16})`,
                  }}
                />
              );
            })}
          </div>
          <input
            className="precip-range"
            type="range"
            min={0}
            max={frames.length - 1}
            step={1}
            value={frameIndex}
            onChange={(e) => onChangeFrameIndex(Number(e.target.value))}
            style={{ position: "relative", display: "block", width: "100%" }}
          />
        </div>
      </div>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   BACK TO LIST BUTTON
   地震を選択中に地図上へ浮かぶ丸い「戻る」ボタン。
   押すと選択を解除し、パネルを「中高」にして一覧表示へ戻る。
   ───────────────────────────────────────────────────── */
/* ─────────────────────────────────────────────────────
   STATION MARKER TOGGLE BUTTON — 地図上の観測点マーカーの表示/非表示を切り替える。
   表示中は点線の円、非表示中は実線の円のアイコンにする(BackToListButtonと
   同じ44×44の丸いGlassボタン)。
   ───────────────────────────────────────────────────── */
function StationMarkerToggleButton({ visible, onClick }) {
  const { tokens } = useContext(ThemeContext);
  const [pressed, setPressed] = useState(false);

  return (
    <Glass
      radius={999}
      style={{
        width: 44, height: 44,
        transform: pressed ? "scale(1.16)" : "scale(1)",
        transformOrigin: "center",
        transition: "transform 0.18s cubic-bezier(.22,1,.36,1)",
      }}
    >
      <button
        onClick={onClick}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerCancel={() => setPressed(false)}
        onPointerLeave={() => setPressed(false)}
        aria-label={visible ? "観測点の表示を消す" : "観測点を表示する"}
        style={{
          position: "relative", zIndex: 1,
          width: "100%", height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: tokens.text,
        }}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none"
             stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="9.5" strokeDasharray={visible ? "3 3" : undefined}/>
        </svg>
      </button>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   WEATHER MENU FLOATING — 気象タブの「一覧」モードで使う、雨雲レーダー等の
   メニューを開閉するボタン。BackToListButtonと同じ44×44の丸いGlassボタンから
   始まり、開くとその同じガラスが上(growUp=true、狭い画面)または下
   (growUp=false、広い画面)へ丸角の帯へと連続的に広がり、中に項目が並ぶ。
   ボタンと展開後のメニューを2つの別要素として重ねるのではなく、
   1枚のGlassの幅・高さ・角丸をアニメーションさせることで「ガラス自体が
   広がる」見た目にしている。
   閉じている間は山が上を向いたくの字(⌃)、開いている間は下向き(⌄)に変わる。
   ───────────────────────────────────────────────────── */
/* ─────────────────────────────────────────────────────
   WEATHER MENU FLOATING — 気象タブの「一覧」モードで使う、雨雲レーダー等の
   メニューを開閉するボタン。BackToListButtonと同じ44×44の丸いGlassボタンから
   始まり、開くとその同じガラスが上(growUp=true、狭い画面)または下
   (growUp=false、広い画面)へ丸角の帯へと連続的に広がり、中に項目が並ぶ。
   ボタンと展開後のメニューを2つの別要素として重ねるのではなく、
   1枚のGlassの幅・高さ・角丸をアニメーションさせることで「ガラス自体が
   広がる」見た目にしている。
   閉じている間は山が上を向いたくの字(⌃)、開いている間は下向き(⌄)に変わる。
   開いている間はトグルボタン自体を一回り小さくして、主役が項目側だと
   分かるようにする。各項目は角がわずかに丸い細長い長方形で囲み、押せる
   ボタンだと分かるようにしている(文字は中央揃え)。
   ───────────────────────────────────────────────────── */
const WEATHER_MENU_ITEMS = [
  { id: "precip1h", label: "1時間降水量" },
  { id: "precip3h", label: "3時間降水量" },
  { id: "precip24h", label: "24時間降水量" },
  { id: "typhoonInfo", label: "台風情報" },
  { id: "rainRadar", label: "雨雲レーダー" },
];
// 2ページ目。天気分布(天気種別)・気温分布の2つ。気温分布は天気分布の下に
// 並べる。
const WEATHER_MENU_PAGE2_ITEMS = [
  { id: "weatherDistribution", label: "天気分布" },
  { id: "temperatureDistribution", label: "気温分布" },
];

const WEATHER_MENU_BUTTON_SIZE = 44;      // 閉じている時のトグルボタン(円)のサイズ
const WEATHER_MENU_BUTTON_SIZE_OPEN = 34; // 開いている時は少し小さく
const WEATHER_MENU_TOGGLE_RECT_HEIGHT = 22; // 開いている時のトグルボタンの長方形の高さ(雨雲レーダー等の項目より細長い)
const WEATHER_MENU_ITEM_HEIGHT = 32;      // 各項目の長方形ボタンの高さ
const WEATHER_MENU_ITEM_GAP = 6;          // 項目同士の間隔
const WEATHER_MENU_ITEMS_PAD = 8;         // 項目ブロックの上下左右の余白
const WEATHER_MENU_PAGE_NAV_HEIGHT = 26;  // ページ送り(左右のくの字)の行の高さ
const WEATHER_MENU_WIDTH = 172;

function WeatherMenuFloating({
  open, onToggle, growUp = true, itemStates = {}, onToggleItem, hasActiveTyphoons = null,
}) {
  const { tokens } = useContext(ThemeContext);
  const [pressed, setPressed] = useState(false);

  // 台風が1つも発生していない(確認済みでfalse)間は、「台風情報」の項目自体を
  // メニューから外す。確認できていない(null、初回問い合わせ中)間は、消えたり
  // 出たりのチラつきを避けるため一旦表示しておく。
  const items = WEATHER_MENU_ITEMS.filter(item => item.id !== "typhoonInfo" || hasActiveTyphoons !== false);

  // ページ送り。1ページ目=既存の項目一式、2ページ目=天気予報分布(ボタンのみ、
  // 今のところ機能は無い)。メニューを閉じて再度開いた時も、直前に見ていた
  // ページをそのまま維持する(あえてリセットしない)。
  const pages = [items, WEATHER_MENU_PAGE2_ITEMS];
  const totalPages = pages.length;
  const [page, setPage] = useState(0);
  const pageItems = pages[page] || items;

  const itemsBlockHeight =
    pageItems.length * WEATHER_MENU_ITEM_HEIGHT +
    Math.max(0, pageItems.length - 1) * WEATHER_MENU_ITEM_GAP +
    WEATHER_MENU_ITEMS_PAD * 2 +
    (totalPages > 1 ? WEATHER_MENU_PAGE_NAV_HEIGHT : 0);

  const width  = open ? WEATHER_MENU_WIDTH : WEATHER_MENU_BUTTON_SIZE;
  const height = open ? WEATHER_MENU_BUTTON_SIZE_OPEN + itemsBlockHeight : WEATHER_MENU_BUTTON_SIZE;
  const buttonSize = open ? WEATHER_MENU_BUTTON_SIZE_OPEN : WEATHER_MENU_BUTTON_SIZE;

  // growUp(下部固定の戻るボタン枠)なら、ボタンを一番下に置いて上へ広がる
  // ように column-reverse。isWide(上部固定)なら、ボタンを上に置いて
  // 下へ広がるように通常の column にする。
  const stackDirection = growUp ? "column-reverse" : "column";

  return (
    <Glass
      radius={open ? 20 : 999}
      style={{
        width, height,
        borderRadius: open ? 20 : 999,
        overflow: "hidden",
        transition: "width 0.3s cubic-bezier(.22,1,.36,1), height 0.3s cubic-bezier(.22,1,.36,1), border-radius 0.3s cubic-bezier(.22,1,.36,1)",
      }}
    >
      <div style={{ display: "flex", flexDirection: stackDirection, width: "100%", height: "100%" }}>
        <div style={{
          flexShrink: 0,
          width: "100%", height: open ? WEATHER_MENU_BUTTON_SIZE_OPEN : WEATHER_MENU_BUTTON_SIZE,
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "height 0.3s cubic-bezier(.22,1,.36,1)",
        }}>
          <button
            onClick={onToggle}
            onPointerDown={() => setPressed(true)}
            onPointerUp={() => setPressed(false)}
            onPointerCancel={() => setPressed(false)}
            onPointerLeave={() => setPressed(false)}
            aria-label={open ? "メニューを閉じる" : "メニューを開く"}
            style={{
              width: open ? WEATHER_MENU_WIDTH - WEATHER_MENU_ITEMS_PAD * 2 : buttonSize,
              height: open ? WEATHER_MENU_TOGGLE_RECT_HEIGHT : buttonSize,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: tokens.text,
              borderRadius: open ? 8 : 999,
              border: open ? `0.75px solid rgba(${tokens.ink},0.22)` : "none",
              background: open ? `rgba(${tokens.ink},0.06)` : "transparent",
              transform: pressed ? "scale(1.06)" : "scale(1)",
              transition: "width 0.3s cubic-bezier(.22,1,.36,1), height 0.3s cubic-bezier(.22,1,.36,1), border-radius 0.3s cubic-bezier(.22,1,.36,1), transform 0.18s cubic-bezier(.22,1,.36,1)",
            }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                 stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
                 style={{ transition: "transform 0.2s cubic-bezier(.22,1,.36,1)", transform: open ? "rotate(180deg)" : "none" }}>
              <polyline points="6 15 12 9 18 15"/>
            </svg>
          </button>
        </div>

        {/* ページ送り(左右のくの字)。雨雲レーダーボタン(1ページ目の最後)と
            開閉トグルボタンの間に置く(DOM順としてもこの2つの間に挟む形にし、
            growUp=true(column-reverse)でもgrowUp=false(通常column)でも、
            見た目上ちょうど間に来るようにしている)。
            くの字アイコン自体は小さいが、タップ領域は行の左半分・右半分
            まるごとに広げてあるので、アイコンの外側(空白部分)を押しても
            ページが切り替わる。 */}
        {open && totalPages > 1 && (
          <div style={{
            flexShrink: 0, width: "100%", height: WEATHER_MENU_PAGE_NAV_HEIGHT,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <PressableButton
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              aria-label="前のページ"
              style={{
                flex: 1, height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
                color: page === 0 ? `rgba(${tokens.ink},0.25)` : tokens.text,
                borderRadius: 8,
              }}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                   stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 6 9 12 15 18"/>
              </svg>
            </PressableButton>
            <span style={{
              flexShrink: 0, fontSize: 10, fontWeight: 600, color: `rgba(${tokens.ink},0.45)`,
              minWidth: 24, textAlign: "center", padding: "0 4px",
            }}>
              {page + 1}/{totalPages}
            </span>
            <PressableButton
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page === totalPages - 1}
              aria-label="次のページ"
              style={{
                flex: 1, height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
                color: page === totalPages - 1 ? `rgba(${tokens.ink},0.25)` : tokens.text,
                borderRadius: 8,
              }}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                   stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 6 15 12 9 18"/>
              </svg>
            </PressableButton>
          </div>
        )}

        {open && (
          <div style={{
            display: "flex", flexDirection: "column", gap: WEATHER_MENU_ITEM_GAP,
            width: "100%", padding: `0 ${WEATHER_MENU_ITEMS_PAD}px ${WEATHER_MENU_ITEMS_PAD}px`,
          }}>
            {pageItems.map((item) => {
              const active = !!itemStates[item.id];
              return (
                <PressableButton
                  key={item.id}
                  onClick={() => {
                    onToggleItem?.(item.id);
                    onToggle(); // 選択したらメニュー自体は閉じる
                  }}
                  style={{
                    height: WEATHER_MENU_ITEM_HEIGHT,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    textAlign: "center",
                    fontSize: 11.5, fontWeight: 600,
                    color: active ? "#fff" : tokens.text,
                    whiteSpace: "nowrap",
                    borderRadius: 10,
                    border: active ? "none" : `0.75px solid rgba(${tokens.ink},0.22)`,
                    background: active ? "#0A84FF" : `rgba(${tokens.ink},0.06)`,
                  }}
                >
                  {item.label}
                </PressableButton>
              );
            })}
          </div>
        )}
      </div>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   ALERT MENU FLOATING — 警報タブの一覧表示中に使う、キキクル(危険度分布)を
   切り替えるくの字メニュー。WeatherMenuFloatingと全く同じ見た目・アニメーション
   (ボタン自体が丸→帯へ連続的に広がる、閉:上向き⌃/開:下向き⌄)を踏襲しつつ、
   項目がページ送り不要な2つ(土砂キキクル・浸水キキクル)だけなのでページ送り行は
   持たない、簡略版。
   ───────────────────────────────────────────────────── */
const ALERT_MENU_ITEMS = [
  { id: "doshaKikkuru", label: "土砂キキクル" },
  { id: "inundKikkuru", label: "浸水キキクル" },
  { id: "riverLevel", label: "河川水位" },
];

function AlertMenuFloating({ open, onToggle, growUp = true, itemStates = {}, onToggleItem }) {
  const { tokens } = useContext(ThemeContext);
  const [pressed, setPressed] = useState(false);

  const itemsBlockHeight =
    ALERT_MENU_ITEMS.length * WEATHER_MENU_ITEM_HEIGHT +
    Math.max(0, ALERT_MENU_ITEMS.length - 1) * WEATHER_MENU_ITEM_GAP +
    WEATHER_MENU_ITEMS_PAD * 2;

  const width  = open ? WEATHER_MENU_WIDTH : WEATHER_MENU_BUTTON_SIZE;
  const height = open ? WEATHER_MENU_BUTTON_SIZE_OPEN + itemsBlockHeight : WEATHER_MENU_BUTTON_SIZE;
  const buttonSize = open ? WEATHER_MENU_BUTTON_SIZE_OPEN : WEATHER_MENU_BUTTON_SIZE;

  // growUp(下部固定の戻るボタン枠)なら、ボタンを一番下に置いて上へ広がるように
  // column-reverse。isWide(上部固定)なら、ボタンを上に置いて下へ広がるように
  // 通常のcolumnにする(WeatherMenuFloatingと同じ考え方)。
  const stackDirection = growUp ? "column-reverse" : "column";

  return (
    <Glass
      radius={open ? 20 : 999}
      style={{
        width, height,
        borderRadius: open ? 20 : 999,
        overflow: "hidden",
        transition: "width 0.3s cubic-bezier(.22,1,.36,1), height 0.3s cubic-bezier(.22,1,.36,1), border-radius 0.3s cubic-bezier(.22,1,.36,1)",
      }}
    >
      <div style={{ display: "flex", flexDirection: stackDirection, width: "100%", height: "100%" }}>
        <div style={{
          flexShrink: 0,
          width: "100%", height: open ? WEATHER_MENU_BUTTON_SIZE_OPEN : WEATHER_MENU_BUTTON_SIZE,
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "height 0.3s cubic-bezier(.22,1,.36,1)",
        }}>
          <button
            onClick={onToggle}
            onPointerDown={() => setPressed(true)}
            onPointerUp={() => setPressed(false)}
            onPointerCancel={() => setPressed(false)}
            onPointerLeave={() => setPressed(false)}
            aria-label={open ? "メニューを閉じる" : "メニューを開く"}
            style={{
              width: open ? WEATHER_MENU_WIDTH - WEATHER_MENU_ITEMS_PAD * 2 : buttonSize,
              height: open ? WEATHER_MENU_TOGGLE_RECT_HEIGHT : buttonSize,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: tokens.text,
              borderRadius: open ? 8 : 999,
              border: open ? `0.75px solid rgba(${tokens.ink},0.22)` : "none",
              background: open ? `rgba(${tokens.ink},0.06)` : "transparent",
              transform: pressed ? "scale(1.06)" : "scale(1)",
              transition: "width 0.3s cubic-bezier(.22,1,.36,1), height 0.3s cubic-bezier(.22,1,.36,1), border-radius 0.3s cubic-bezier(.22,1,.36,1), transform 0.18s cubic-bezier(.22,1,.36,1)",
            }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                 stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
                 style={{ transition: "transform 0.2s cubic-bezier(.22,1,.36,1)", transform: open ? "rotate(180deg)" : "none" }}>
              <polyline points="6 15 12 9 18 15"/>
            </svg>
          </button>
        </div>

        {open && (
          <div style={{
            display: "flex", flexDirection: "column", gap: WEATHER_MENU_ITEM_GAP,
            width: "100%", padding: `0 ${WEATHER_MENU_ITEMS_PAD}px ${WEATHER_MENU_ITEMS_PAD}px`,
          }}>
            {ALERT_MENU_ITEMS.map((item) => {
              const active = !!itemStates[item.id];
              return (
                <PressableButton
                  key={item.id}
                  onClick={() => {
                    onToggleItem?.(item.id);
                    onToggle(); // 選択したらメニュー自体は閉じる
                  }}
                  style={{
                    height: WEATHER_MENU_ITEM_HEIGHT,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    textAlign: "center",
                    fontSize: 11.5, fontWeight: 600,
                    color: active ? "#fff" : tokens.text,
                    whiteSpace: "nowrap",
                    borderRadius: 10,
                    border: active ? "none" : `0.75px solid rgba(${tokens.ink},0.22)`,
                    background: active ? "#0A84FF" : `rgba(${tokens.ink},0.06)`,
                  }}
                >
                  {item.label}
                </PressableButton>
              );
            })}
          </div>
        )}
      </div>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   TYPHOON LIST PANEL — 気象タブで「台風情報」ONの間、WeatherLocationPanelの
   代わりに表示する「現在活動中の台風」一覧。地震一覧・警報一覧と同じ
   パネル枠に、名前(弱化していればグレー)・中心気圧・最大風速を並べる。
   タップすると地図がその台風の中心へflyToする(参考実装のupdateRanking()の
   台風分岐を踏襲)。
   ───────────────────────────────────────────────────── */
// 台風の詳細カード。時刻チップ(予報円)をタップした時と、台風一覧の項目を
// タップした時の両方で使う。infoにforecastTimeが入っていれば「その予報時点」の
// 情報、入っていなければ「現在」の情報として見出しを出し分ける。
// フィールド名(name/category/weakened/pressure/maxWind/maxGust/scale/intensity/
// speed/courseText/speedKmh/timeLabel)はfetchTyphoonData側で両パターンとも
// 揃えてあるので、カードの中身は共通にできる。
// デザインは、ユーザーが参考として共有した「大きな数字+英字サブラベル」風の
// 台風情報表示を下敷きにしつつ、フローティングパネルの限られた高さに収まるよう
// 余白は最小限に詰めている。
// 「大きさ」バッジの色。大型=黄、超大型=赤。それ以外(該当なし)はnull。
function getTyphoonScaleBadgeColor(scale) {
  if (scale === "超大型") return { bg: "#C0392B", fg: "#fff" };
  if (scale === "大型") return { bg: "#E3B62B", fg: "#2B2200" };
  return null;
}
// 「強さ」バッジの色。強い=黄、非常に強い=赤、猛烈な=紫。それ以外はnull。
function getTyphoonIntensityBadgeColor(intensity) {
  if (intensity === "猛烈な") return { bg: "#8E44AD", fg: "#fff" };
  if (intensity === "非常に強い") return { bg: "#C0392B", fg: "#fff" };
  if (intensity === "強い") return { bg: "#E3B62B", fg: "#2B2200" };
  return null;
}

function TyphoonDetailCard({ info, typhoons = [], onSelectTyphoonDetail }) {
  const { tokens } = useContext(ThemeContext);
  const isForecast = info.forecastTime != null;
  const timeLabel = info.timeLabel || (isForecast ? `${info.forecastTime} 予報` : "現在");

  // 予報タイムライン: 「現在」+ この台風の予報点(間引き後、時系列順)。
  // infoが予報時点を見ている時は、同じ台風のtyphoons側の現在情報(=id一致)を
  // 探して先頭に足す。infoが「現在」そのものの時は、info自身が既にforecastsを
  // 持っているのでそれをそのまま使う。
  const parentTyphoon = info.forecastTime != null
    ? typhoons.find(t => t.id === info.id)
    : info;
  const timelineForecasts = parentTyphoon?.forecasts || [];
  const timelineItems = parentTyphoon ? [parentTyphoon, ...timelineForecasts] : [];

  const primaryStats = [
    { label: "中心気圧", value: (info.pressure && info.pressure !== "不明") ? info.pressure : "―", unit: "hPa" },
    { label: "最大風速", value: (info.maxWind && info.maxWind !== "不明") ? info.maxWind : "―", unit: "m/s" },
  ];
  const secondaryStats = [
    { label: "最大瞬間風速", value: (info.maxGust && info.maxGust !== "不明") ? info.maxGust : "―", unit: "m/s" },
    { label: "移動速度", value: info.speedKmh != null ? info.speedKmh : "―", unit: info.speedKmh != null ? "km/h" : "" },
    { label: "移動方向", value: (info.courseText && info.courseText !== "-") ? info.courseText : "ほぼ停滞", unit: "" },
  ];
  if (isForecast && info.radiusKm) {
    secondaryStats.push({ label: "予報円の半径", value: info.radiusKm, unit: "km" });
  }

  const scaleBadgeColor = getTyphoonScaleBadgeColor(info.scale);
  const intensityBadgeColor = getTyphoonIntensityBadgeColor(info.intensity);

  return (
    <div style={{ margin: "0 14px 2px" }}>
      {/* 見出し: 名称の下に「バッジ(左)+発表時刻(右)」を1行にまとめる */}
      <div style={{ padding: "0 4px 4px" }}>
        <div style={{
          fontSize: 17, fontWeight: 800, color: tokens.text, lineHeight: 1.15,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {info.name}
        </div>
        {/* バッジの有無(0〜2個)に関わらず、この行の高さは常に一定にする。
            そうしないと、選ぶ台風/予報時点によってバッジの数が変わるたびに
            下のガラスパネルの位置が上下に押し出されてしまうため。 */}
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 4, minHeight: 18 }}>
          {scaleBadgeColor && (
            <span style={{
              fontSize: 11, fontWeight: 800, padding: "2px 8px", borderRadius: 7,
              background: scaleBadgeColor.bg, color: scaleBadgeColor.fg,
            }}>
              {info.scale}
            </span>
          )}
          {intensityBadgeColor && (
            <span style={{
              fontSize: 11, fontWeight: 800, padding: "2px 8px", borderRadius: 7,
              background: intensityBadgeColor.bg, color: intensityBadgeColor.fg,
            }}>
              {info.intensity}
            </span>
          )}
          <span style={{ flex: 1, minWidth: 4 }}/>
          <span style={{ fontSize: 11, fontWeight: 500, color: `rgba(${tokens.ink},0.5)`, whiteSpace: "nowrap" }}>
            {timeLabel}
          </span>
        </div>
      </div>

      {/* バッジより下の詳細情報(中心気圧〜移動方向まで)を、まとめて1枚のガラスで囲む */}
      <Glass radius={16} style={{ padding: "6px 12px 4px" }}>
        {/* 中心気圧・最大風速 — ひときわ大きい数字で強調する */}
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 8,
          paddingBottom: 3, marginBottom: 3,
          borderBottom: `0.5px solid rgba(${tokens.ink},0.12)`,
        }}>
          {primaryStats.map(stat => (
            <div key={stat.label} style={{ textAlign: "center" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: `rgba(${tokens.ink},0.6)` }}>{stat.label}</div>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 3 }}>
                <span className="mono" style={{ fontSize: 28, fontWeight: 800, color: tokens.text, lineHeight: 1.15 }}>
                  {stat.value}
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: `rgba(${tokens.ink},0.5)` }}>{stat.unit}</span>
              </div>
            </div>
          ))}
        </div>

        {/* その他の項目 — 常に1行(最大4列)に収め、項目同士の間に縦の仕切り線を入れる。
            ただし上の横の仕切り線とは接続しない(セル自体の上端には線を引かず、
            隣同士を区切る縦線だけを立てる)ようにしている。 */}
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${secondaryStats.length}, 1fr)`, columnGap: 6 }}>
          {secondaryStats.map((stat, i) => (
            <div
              key={stat.label}
              style={{
                textAlign: "center",
                borderLeft: i > 0 ? `0.5px solid rgba(${tokens.ink},0.12)` : "none",
                paddingLeft: i > 0 ? 6 : 0,
              }}
            >
              <div style={{ fontSize: 9.5, fontWeight: 700, color: `rgba(${tokens.ink},0.55)`, whiteSpace: "nowrap" }}>
                {stat.label}
              </div>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 2 }}>
                <span className="mono" style={{ fontSize: 15, fontWeight: 700, color: tokens.text, whiteSpace: "nowrap" }}>
                  {stat.value}
                </span>
                {stat.unit && (
                  <span style={{ fontSize: 9.5, fontWeight: 600, color: `rgba(${tokens.ink},0.5)` }}>{stat.unit}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </Glass>

      {/* 予報タイムライン — 「現在」+ この台風の予報点を時系列で並べる。
          タップすると、上の詳細カードの中身がその時刻の予報に切り替わる。
          タイムライン自体は選択中の時刻に関わらず同じ並び("現在"は常に先頭)を
          保つので、行き来しながら見比べられる。 */}
      {timelineItems.length > 1 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ padding: "6px 4px 4px", fontSize: 11.5, fontWeight: 600, color: `rgba(${tokens.ink},0.55)` }}>
            予報の推移
          </div>
          <Glass radius={16} style={{ padding: "2px 4px" }}>
            {timelineItems.map((item, i) => {
              const itemIsForecast = item.forecastTime != null;
              const itemLabel = itemIsForecast ? item.forecastTime : "現在";
              const isSelected = isForecast
                ? (itemIsForecast && item.forecastTime === info.forecastTime)
                : !itemIsForecast;
              const itemScaleColor = getTyphoonScaleBadgeColor(item.scale);
              const itemIntensityColor = getTyphoonIntensityBadgeColor(item.intensity);
              return (
                <div key={itemIsForecast ? `${item.id}-${item.forecastTime}` : `${item.id}-current`}>
                  {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.1)`, marginLeft: 14 }}/>}
                  <PressableButton
                    onClick={() => onSelectTyphoonDetail?.({ ...item, forecasts: timelineForecasts })}
                    style={{
                      width: "100%", display: "flex", alignItems: "center",
                      padding: "9px 14px", gap: 8, textAlign: "left",
                      background: isSelected ? `rgba(${tokens.ink},0.07)` : "transparent",
                      borderRadius: 12,
                    }}
                  >
                    <span style={{
                      fontSize: 13, fontWeight: isSelected ? 800 : 600, flexShrink: 0,
                      color: isSelected ? tokens.text : `rgba(${tokens.ink},0.75)`,
                    }}>
                      {itemLabel}
                    </span>
                    {/* 勢力(強さ)・サイズ(大きさ)の情報がある予報点だけ、小さめのバッジを添える */}
                    {(itemScaleColor || itemIntensityColor) && (
                      <span style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                        {itemScaleColor && (
                          <span style={{
                            fontSize: 9.5, fontWeight: 800, padding: "1px 6px", borderRadius: 6,
                            background: itemScaleColor.bg, color: itemScaleColor.fg, whiteSpace: "nowrap",
                          }}>
                            {item.scale}
                          </span>
                        )}
                        {itemIntensityColor && (
                          <span style={{
                            fontSize: 9.5, fontWeight: 800, padding: "1px 6px", borderRadius: 6,
                            background: itemIntensityColor.bg, color: itemIntensityColor.fg, whiteSpace: "nowrap",
                          }}>
                            {item.intensity}
                          </span>
                        )}
                      </span>
                    )}
                    <span style={{ flex: 1 }}/>
                    <span className="mono" style={{ fontSize: 12.5, color: `rgba(${tokens.ink},0.55)`, whiteSpace: "nowrap" }}>
                      {item.pressure}hPa / {item.maxWind}m/s
                    </span>
                  </PressableButton>
                </div>
              );
            })}
          </Glass>
        </div>
      )}
    </div>
  );
}

function TyphoonListPanel({ typhoons = [], loadError = false, onSelectTyphoon }) {
  const { tokens } = useContext(ThemeContext);

  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center",
        padding: "8px 18px 11px",
        borderBottom: `0.5px solid rgba(${tokens.ink},0.15)`,
      }}>
        <span style={{ fontSize: 14, fontWeight: 600, flex: 1, color: `rgba(${tokens.ink},0.9)` }}>
          現在の台風情報
        </span>
      </div>

      {loadError ? (
        <div style={{ padding: "24px 18px", fontSize: 13, color: `rgba(${tokens.ink},0.5)`, textAlign: "center" }}>
          台風情報の取得に失敗しました。しばらくしてから再度お試しください。
        </div>
      ) : typhoons.length === 0 ? (
        <div style={{ padding: "24px 18px", fontSize: 13, color: `rgba(${tokens.ink},0.5)`, textAlign: "center" }}>
          現在、発生中の台風はありません。
        </div>
      ) : (
        typhoons.map((t, i) => (
          <div key={t.id}>
            {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.1)`, marginLeft: 18 }}/>}
            <PressableButton
              onClick={() => onSelectTyphoon?.(t)}
              style={{
                width: "100%", display: "flex", alignItems: "center",
                padding: "11px 18px", gap: 10, textAlign: "left",
              }}
            >
              <span style={{
                fontSize: 14, fontWeight: 600, flex: 1,
                color: t.weakened ? "#9AA0A6" : "#0A84FF",
              }}>
                {t.name}
              </span>
              <span style={{ fontSize: 13, color: `rgba(${tokens.ink},0.7)`, whiteSpace: "nowrap" }}>
                {t.pressure}hPa / {t.maxWind}m/s
              </span>
            </PressableButton>
          </div>
        ))
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   WARNING AREA LIST PANEL — 警報タブ、非選択時の中身。全国で発表中の
   警報・注意報を、市区町村単位でレベル順(特別警報→危険警報→警報→注意報)に
   ソートして一覧表示する。TyphoonListPanelと同じ構成(見出し+区切り線付き行)。
   ───────────────────────────────────────────────────── */
// BottomDockはドラッグ中のアニメーション等で頻繁に再レンダーされるため、
// memo化して警報一覧タブが開いていない時・propsが変わっていない時の
// 無駄な再レンダーを避ける(内部の重い組み立てはuseMemoで別途対策済み)。
const WarningAreaListPanel = memo(function WarningAreaListPanel({ warningLevelMap = {}, warningAreaByRegioncode = {}, onSelectWarningArea }) {
  const { tokens } = useContext(ThemeContext);

  // 種類ごとの市区町村チップ一覧は、全国的な発表時にかなりの件数になり
  // 一覧が縦に伸びすぎるため、デフォルトは折りたたんでおき、行右端の
  // くの字ボタンを押した時だけ展開する。開閉状態はcode(種類)単位でSetに保持。
  const [expandedKinds, setExpandedKinds] = useState(() => new Set());
  function toggleKindExpanded(code) {
    setExpandedKinds(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  }

  // 種類ごと(例: "大雨警報")に対象の市区町村をまとめる。市区町村1件ずつに
  // バッジ配列を組み立てていた以前の方式は、全国的な発表時に件数が膨らむと
  // 重くなっていたため、種類(最大でも警報種別の定義数、数十件程度)を軸に
  // まとめ直す。市区町村チップは種類の色で統一されるため、行ごとの色計算・
  // ソートも不要になる。warningLevelMap/warningAreaByRegioncodeが実際に
  // 変わった時だけuseMemoで再計算する。
  const groups = useMemo(() => {
    const byKind = new Map(); // key: "code" (種類のcode) → { code, name, level, areas: [{regioncode, name, pref}] }
    for (const [regioncode, entry] of Object.entries(warningLevelMap)) {
      const areaInfo = warningAreaByRegioncode[regioncode];
      const areaName = areaInfo?.name || regioncode;
      // regionnameから都道府県名を推定する(EEWの細分区域名と同じロジック)。
      // 判定不能な場合は「その他」小見出しにまとめる。
      const pref = derivePrefFromEewAreaName(areaInfo?.regionname) || "その他";
      for (const k of entry.kinds) {
        let g = byKind.get(k.code);
        if (!g) {
          g = { code: k.code, name: k.name, level: k.level, areas: [] };
          byKind.set(k.code, g);
        }
        g.areas.push({ regioncode, name: areaName, pref });
      }
    }
    const sortedGroups = [...byKind.values()].sort((a, b) => (WARNING_LEVEL_PRIORITY[b.level] ?? 0) - (WARNING_LEVEL_PRIORITY[a.level] ?? 0));
    // 各種類の中で、都道府県ごとの小グループにまとめる(北→南の固定順。
    // 判定できなかった「その他」は最後に置く)。
    for (const g of sortedGroups) {
      const byPref = new Map();
      for (const a of g.areas) {
        let list = byPref.get(a.pref);
        if (!list) { list = []; byPref.set(a.pref, list); }
        list.push(a);
      }
      g.prefGroups = [...byPref.entries()]
        .sort(([prefA], [prefB]) => {
          const ia = PREF_ORDER.indexOf(prefA), ib = PREF_ORDER.indexOf(prefB);
          return (ia === -1 ? PREF_ORDER.length : ia) - (ib === -1 ? PREF_ORDER.length : ib);
        })
        .map(([pref, areas]) => ({ pref, areas }));
    }
    return sortedGroups;
  }, [warningLevelMap, warningAreaByRegioncode]);

  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center",
        padding: "8px 18px 11px",
        borderBottom: `0.5px solid rgba(${tokens.ink},0.15)`,
      }}>
        <span style={{ fontSize: 14, fontWeight: 600, flex: 1, color: `rgba(${tokens.ink},0.9)` }}>
          発表中の警報・注意報
        </span>
      </div>

      {groups.length === 0 ? (
        <div style={{ padding: "24px 18px", fontSize: 13, color: `rgba(${tokens.ink},0.5)`, textAlign: "center" }}>
          現在、発表中の警報・注意報はありません。
        </div>
      ) : (
        groups.map((g, i) => {
          const isOpen = expandedKinds.has(g.code);
          return (
            <div key={g.code} style={{ padding: "10px 18px", borderTop: i > 0 ? `0.5px solid rgba(${tokens.ink},0.1)` : "none" }}>
              <PressableButton
                onClick={() => toggleKindExpanded(g.code)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  width: "100%",
                  marginBottom: isOpen ? 7 : 0,
                }}
              >
                <WarningKindBadge level={g.level} label={g.name}/>
                <span style={{ fontSize: 12, fontWeight: 600, color: `rgba(${tokens.ink},0.45)` }}>
                  {g.areas.length}市区町村
                </span>
                <span style={{ flex: 1 }}/>
                <ChevronDownIcon open={isOpen}/>
              </PressableButton>
              {isOpen && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {g.prefGroups.map(pg => (
                    <div key={pg.pref}>
                      <div style={{
                        fontSize: 11, fontWeight: 700, color: `rgba(${tokens.ink},0.4)`,
                        marginBottom: 4,
                      }}>
                        {pg.pref}
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                        {pg.areas.map(a => (
                          <PressableButton
                            key={a.regioncode}
                            onClick={() => onSelectWarningArea?.(a.regioncode)}
                            style={{
                              padding: "4px 9px",
                              borderRadius: 7,
                              background: `rgba(${tokens.ink},0.06)`,
                              fontSize: 12.5, fontWeight: 600, color: tokens.text,
                            }}
                          >
                            {a.name}
                          </PressableButton>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
});

/* ─────────────────────────────────────────────────────
   WARNING AREA DETAIL CARD — 警報タブ、選択中の中身。選んだ市区町村で
   発表中の警報・注意報の種別を、レベル順にバッジで一覧表示する。
   TyphoonDetailCardと対の構成。上部に「戻る」ボタンを置く(B要件)。
   ───────────────────────────────────────────────────── */
function WarningAreaDetailCard({ regioncode, warningLevelMap = {}, warningAreaByRegioncode = {} }) {
  const { tokens } = useContext(ThemeContext);
  const area = warningAreaByRegioncode[regioncode];
  const entry = warningLevelMap[regioncode];
  const name = area?.name || regioncode;
  const kinds = [...(entry?.kinds || [])].sort((a, b) =>
    (WARNING_LEVEL_PRIORITY[b.level] ?? 0) - (WARNING_LEVEL_PRIORITY[a.level] ?? 0)
  );

  return (
    <div style={{ margin: "0 14px 2px" }}>
      {/* 戻るボタンは他タブ(地震・津波・設定)と同じく、BottomDock側でフローティング
          外部(右上/右下)に共通の枠で表示するため、ここでは持たない。 */}
      <div style={{ padding: "2px 4px 8px" }}>
        <div style={{
          fontSize: 17, fontWeight: 800, color: tokens.text, lineHeight: 1.15,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {name}
        </div>
      </div>

      {kinds.length === 0 ? (
        <div style={{ padding: "24px 4px", fontSize: 13, color: `rgba(${tokens.ink},0.5)`, textAlign: "center" }}>
          現在、このエリアで発表中の警報・注意報はありません。
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 4px 12px" }}>
          {kinds.map(k => (
            <div
              key={k.code + k.name}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 10px",
                borderRadius: 10,
                background: `rgba(${tokens.ink},0.05)`,
              }}
            >
              <WarningKindBadge level={k.level} label={WARNING_LEVEL_LABEL[k.level]}/>
              <span style={{ fontSize: 13, fontWeight: 600, color: tokens.text }}>
                {k.name}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 警報・注意報のレベル別バッジ。旧ツールの.warn-badgeと同じ配色
// (特別警報=黒/危険警報=紫/警報=赤/注意報=黄、注意報のみ文字を黒にする)。
function WarningKindBadge({ level, label }) {
  return (
    <span style={{
      display: "inline-block",
      fontSize: 10, fontWeight: 700,
      padding: "2px 6px",
      borderRadius: 4,
      whiteSpace: "nowrap",
      background: WARNING_LEVEL_COLOR[level] || "#888",
      color: level === "chui" ? "#000" : "#fff",
      border: level === "tokubetsu" ? "1px solid rgba(255,255,255,0.4)" : "none",
    }}>
      {label}
    </span>
  );
}

/* ─────────────────────────────────────────────────────
   RIVER STATION DETAIL CARD — 警報タブで河川水位観測所のピンをタップした時の
   詳細カード。WarningAreaDetailCardと同じ枠を使い回す(戻るボタンはBottomDock
   側の共通フローティングで持つので、ここでは中身だけ)。
   observed_atはproperties(タップ時点のスナップショット)からそのまま出し、
   水位グラフだけ別途fetchする(タップのたびに取り直す)。
   ───────────────────────────────────────────────────── */
function RiverStationDetailCard({ properties }) {
  const { tokens } = useContext(ThemeContext);
  const [series, setSeries] = useState(null); // null=読込中, {dspFlg, pastValues:[...]}=成功
  const [seriesError, setSeriesError] = useState(false);
  const [rangeDays, setRangeDays] = useState(1); // 1 | 3
  const [thresholds, setThresholds] = useState(null); // null=読込中/失敗, {rsrv_stg,warn_stg,...}=成功

  const obsFcd = properties?.obs_fcd;
  const obsCd = properties?.obs_cd;

  useEffect(() => {
    if (!obsFcd && obsCd == null) return;
    let cancelled = false;
    setSeries(null);
    setSeriesError(false);
    loadRiverStationSeries(obsFcd, obsCd)
      .then((data) => {
        if (cancelled) return;
        if (!data) { setSeriesError(true); return; }
        setSeries(data);
      })
      .catch(() => { if (!cancelled) setSeriesError(true); });
    return () => { cancelled = true; };
  }, [obsFcd, obsCd]);

  useEffect(() => {
    if (!obsFcd) { setThresholds(null); return; }
    let cancelled = false;
    setThresholds(null);
    loadRiverStationThresholds(properties)
      .then((t) => {
        if (cancelled) return;
        console.log("[河川/基準水位] 最終結果:", t);
        setThresholds(t);
      })
      .catch((err) => { console.warn("[河川/基準水位] エラー:", err); if (!cancelled) setThresholds(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obsFcd, properties?.__lon, properties?.__lat]);

  if (!properties) return null;
  const info = riverLevelInfo(properties.stg_ovlvl);
  const name = properties.obs_nm || "観測所";
  // 実機検証で判明した実際のスキーマ: { dspFlg, pastValues: [{ stg, obsTime, ... }] }。
  // ただしpastValuesは「確定済みの過去データ」のアーカイブのようで、当日分の
  // 最新の値が含まれていないことがある(前日24時までで止まる)。観測所ピンの
  // properties(タップ時点の最新値)を末尾に補完して、グラフが実際の「今」まで
  // 繋がるようにする。
  const points = useMemo(() => {
    const base = Array.isArray(series?.pastValues) ? series.pastValues.slice() : null;
    if (!base) return null;
    const latest = { stg: properties.stg_ovdeg, obsTime: properties.obs_time, stgOvlvl: properties.stg_ovlvl };
    const lastInBase = base[base.length - 1];
    const isNewer = !lastInBase?.obsTime || !latest.obsTime || latest.obsTime > lastInBase.obsTime;
    if (latest.stg != null && latest.obsTime && isNewer) base.push(latest);
    return base;
  }, [series, properties.stg_ovdeg, properties.obs_time, properties.stg_ovlvl]);
  const cutoffPoints = points
    ? points.filter(p => {
        if (!p?.obsTime) return true;
        const t = new Date(p.obsTime.replace(/\//g, "-"));
        return Date.now() - t.getTime() <= rangeDays * 24 * 60 * 60 * 1000;
      })
    : null;

  return (
    <div style={{ margin: "0 14px 2px" }}>
      <div style={{ padding: "2px 4px 6px" }}>
        <div style={{
          fontSize: 17, fontWeight: 800, color: tokens.text, lineHeight: 1.15,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {name}
        </div>
        {properties.rvr_cd != null && (
          <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.5)`, marginTop: 2 }}>
            河川コード {properties.rvr_cd}
            {properties.bnk_sct ? ` ・ ${properties.bnk_sct}` : ""}
            {properties.rvr_mouth_dst != null ? ` ・ 河口から${properties.rvr_mouth_dst}m` : ""}
          </div>
        )}
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "8px 10px", margin: "4px 4px 10px",
        borderRadius: 10, background: `rgba(${tokens.ink},0.05)`,
      }}>
        <span style={{
          display: "inline-block", fontSize: 11, fontWeight: 700,
          padding: "3px 8px", borderRadius: 5, whiteSpace: "nowrap",
          background: info.color, color: info.color === "#f2e700" ? "#000" : "#fff",
        }}>
          {info.label}
        </span>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 20, fontWeight: 800, color: tokens.text, lineHeight: 1.1 }}>
            {properties.stg_ovdeg != null ? `${properties.stg_ovdeg} m` : "-- m"}
          </span>
          <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.5)` }}>
            {properties.obs_time || ""} 観測
          </span>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 4px 4px" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: `rgba(${tokens.ink},0.55)` }}>水位の推移</span>
        <div style={{ display: "flex", gap: 4 }}>
          {[{ id: 1, label: "1日" }, { id: 3, label: "3日" }].map(opt => (
            <PressableButton
              key={opt.id}
              onClick={() => setRangeDays(opt.id)}
              style={{
                fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999,
                background: rangeDays === opt.id ? "#0A84FF" : `rgba(${tokens.ink},0.06)`,
                color: rangeDays === opt.id ? "#fff" : tokens.text,
              }}
            >
              {opt.label}
            </PressableButton>
          ))}
        </div>
      </div>

      <div style={{ margin: "0 4px 16px", padding: "10px 10px 4px", borderRadius: 10, background: `rgba(${tokens.ink},0.05)` }}>
        {seriesError ? (
          <div style={{ padding: "16px 4px", fontSize: 12, color: `rgba(${tokens.ink},0.5)`, textAlign: "center" }}>
            水位の推移データを取得できませんでした。
          </div>
        ) : !cutoffPoints ? (
          <div style={{ padding: "16px 4px", fontSize: 12, color: `rgba(${tokens.ink},0.5)`, textAlign: "center" }}>
            読み込み中...
          </div>
        ) : cutoffPoints.length < 2 ? (
          <div style={{ padding: "16px 4px", fontSize: 12, color: `rgba(${tokens.ink},0.5)`, textAlign: "center" }}>
            表示できるデータがありません。
          </div>
        ) : (
          <RiverLevelSparkline points={cutoffPoints} thresholds={thresholds}/>
        )}
      </div>
    </div>
  );
}

// 水位の推移を表す簡易SVGグラフ。旧タブの潮位計チャートと同じく、外部chart
// ライブラリを使わない自前SVG。日付軸ラベル・面グラフ塗り・現在値ドットを
// 加えて、値だけのシンプルな折れ線より状況が掴みやすいようにしている。
// pastValuesの各要素は { stg: 水位(m), obsTime: "YYYY/MM/DD HH:mm", ... }。
function RiverLevelSparkline({ points, thresholds }) {
  const { tokens } = useContext(ThemeContext);
  const W = 280, H = 150;
  const PAD_L = 34, PAD_R = 8, PAD_TOP = 10, PAD_BOTTOM = 30;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_TOP - PAD_BOTTOM;

  const parsed = points
    .map(p => ({ v: Number(p.stg), t: new Date(p.obsTime.replace(/\//g, "-")), lvl: p.stgOvlvl }))
    .filter(p => !Number.isNaN(p.v) && !Number.isNaN(p.t.getTime()));
  if (parsed.length < 2) return null;

  // 基準水位(あれば)を低い順に並べる。水防法の基準水位5段階に相当。
  const THRESHOLD_DEFS = [
    { key: "rsrv_stg",      label: "待機",   color: "#35a86b" },
    { key: "warn_stg",      label: "注意",   color: "#f2e700" },
    { key: "spcl_warn_stg", label: "避難判断", color: "#ff2800" },
    { key: "dng_stg",       label: "危険",   color: "#aa00aa" },
    { key: "fld_stg",       label: "氾濫",   color: "#140014" },
  ];
  const activeThresholds = THRESHOLD_DEFS
    .map(d => ({ ...d, value: thresholds?.[d.key] }))
    .filter(d => typeof d.value === "number");

  const values = parsed.map(p => p.v);
  let minV = Math.min(...values);
  let maxV = Math.max(...values);
  // 基準水位が実測値の範囲より外にある場合(まだ全然届いていない等)も、
  // グラフ内に収まるよう範囲を広げる。
  for (const th of activeThresholds) {
    if (th.value < minV) minV = th.value;
    if (th.value > maxV) maxV = th.value;
  }
  // 値の範囲が全く無い(水位が一定)場合でも線がつぶれないよう、上下に余白を持たせる。
  const range = (maxV - minV) || Math.max(0.1, maxV * 0.05);
  const padV = range * 0.15;
  const yMin = minV - padV, yMax = maxV + padV;

  const stepX = plotW / (parsed.length - 1);
  const toX = (i) => PAD_L + i * stepX;
  const toY = (v) => PAD_TOP + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const linePath = parsed
    .map((p, i) => `${i === 0 ? "M" : "L"} ${toX(i).toFixed(1)} ${toY(p.v).toFixed(1)}`)
    .join(" ");
  const areaPath =
    `M ${toX(0).toFixed(1)} ${(PAD_TOP + plotH).toFixed(1)} ` +
    parsed.map((p, i) => `L ${toX(i).toFixed(1)} ${toY(p.v).toFixed(1)}`).join(" ") +
    ` L ${toX(parsed.length - 1).toFixed(1)} ${(PAD_TOP + plotH).toFixed(1)} Z`;

  // 横軸のラベルは、データ範囲を3等分した位置(始点・中間・終点)に日付+時刻を出す。
  const tickIdxs = [0, Math.floor((parsed.length - 1) / 2), parsed.length - 1];
  const formatTickDate = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  const formatTickTime = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

  const last = parsed[parsed.length - 1];
  const lastColor = riverLevelInfo(last.lvl).color;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
      {/* 横方向のグリッド線(最大・最小の目安) */}
      <line x1={PAD_L} y1={PAD_TOP} x2={W - PAD_R} y2={PAD_TOP} stroke={`rgba(${tokens.ink},0.1)`} strokeWidth="1"/>
      <line x1={PAD_L} y1={PAD_TOP + plotH} x2={W - PAD_R} y2={PAD_TOP + plotH} stroke={`rgba(${tokens.ink},0.1)`} strokeWidth="1"/>

      <defs>
        <linearGradient id="riverSparklineFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0A84FF" stopOpacity="0.28"/>
          <stop offset="100%" stopColor="#0A84FF" stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#riverSparklineFill)" stroke="none"/>

      {/* 基準水位の破線(実測より先に描いて、実測ラインが上に重なるようにする) */}
      {activeThresholds.map(th => (
        <g key={th.key}>
          <line
            x1={PAD_L} x2={W - PAD_R} y1={toY(th.value)} y2={toY(th.value)}
            stroke={th.color} strokeWidth="1.2" strokeDasharray="3,2" opacity="0.85"
          />
          <text x={W - PAD_R} y={toY(th.value) - 2} fontSize="8.5" textAnchor="end" fill={th.color} fontWeight="700">
            {th.label} {th.value.toFixed(2)}
          </text>
        </g>
      ))}

      <path d={linePath} fill="none" stroke="#0A84FF" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>

      {/* 現在値(最新点)を強調するドット */}
      <circle cx={toX(parsed.length - 1)} cy={toY(last.v)} r="4" fill={lastColor} stroke="#fff" strokeWidth="1.5"/>

      {/* 縦軸(最大値・最小値) */}
      <text x={PAD_L - 4} y={PAD_TOP + 4} fontSize="9.5" textAnchor="end" fill={`rgba(${tokens.ink},0.5)`}>{maxV.toFixed(2)}</text>
      <text x={PAD_L - 4} y={PAD_TOP + plotH + 3} fontSize="9.5" textAnchor="end" fill={`rgba(${tokens.ink},0.5)`}>{minV.toFixed(2)}</text>

      {/* 横軸(日付+時刻の2行) */}
      {tickIdxs.map((i, k) => {
        const anchor = k === 0 ? "start" : k === tickIdxs.length - 1 ? "end" : "middle";
        return (
          <g key={i}>
            <text x={toX(i)} y={H - 17} fontSize="9.5" textAnchor={anchor} fill={`rgba(${tokens.ink},0.5)`}>
              {formatTickDate(parsed[i].t)}
            </text>
            <text x={toX(i)} y={H - 5} fontSize="9.5" textAnchor={anchor} fill={`rgba(${tokens.ink},0.5)`}>
              {formatTickTime(parsed[i].t)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}


/* ─────────────────────────────────────────────────────
   WEATHER LOCATION PANEL — 気象タブ「地点(ピン)」モードの中身。フローティング
   の小さなカードではなく、既存の「現在開発中です」プレースホルダーが出ていた
   パネル枠(設定メニュー・地図レイヤー一覧と同じ場所)に、現在地(GPS)または
   登録地点(1件)の天気予報を表示する。
   ───────────────────────────────────────────────────── */
function WeatherLocationPanel({
  geoState, onConsentLocation, onResetLocationConsent,
  activeWeatherPoint, forecastState, timeSeriesState, registeredWeatherPoint, currentMunicipalityName,
  weatherSourceMode, onChangeWeatherSourceMode,
  kanaPickerOpen, onOpenKanaPicker, onCloseKanaPicker,
  kanaPickerStep, onChangeKanaPickerStep,
  kanaPickerPref, onChangeKanaPickerPref,
  kanaPickerRow, onChangeKanaPickerRow, kanaPickerCol, onChangeKanaPickerCol,
  kanaGroupedMunicipalities, municipalityListReady, municipalityListError, onSelectMunicipality,
}) {
  const { tokens } = useContext(ThemeContext);
  const isStandalonePwa = useIsStandalonePwa();
  const [rangeMode, setRangeMode] = useState("3day"); // "3day" | "week"
  // 天気アイコンの縁取りはWeatherIconコンポーネント側(canvas焼き込み)で
  // 処理するため、ここでは何もしない。旧: SVGフィルタ(weather-icon-outline-
  // dark/-light)を<img>に直接filterで適用していたが、Safari/iOSで一部が
  // 透けて見える不具合があったため撤去した。
  // 地点登録(五十音ピッカー)を開いている間は、それ専用の画面をフルで表示する。
  if (kanaPickerOpen) {
    return (
      <KanaMunicipalityPicker
        step={kanaPickerStep} onChangeStep={onChangeKanaPickerStep}
        pref={kanaPickerPref} onChangePref={onChangeKanaPickerPref}
        row={kanaPickerRow} onChangeRow={onChangeKanaPickerRow}
        col={kanaPickerCol} onChangeCol={onChangeKanaPickerCol}
        grouped={kanaGroupedMunicipalities}
        dataReady={municipalityListReady}
        loadError={municipalityListError}
        onSelect={onSelectMunicipality}
        onClose={onCloseKanaPicker}
      />
    );
  }

  // 上部のヘッダー行 — 現在地/登録地点の表示名と、切り替えボタンを同じ行に置く。
  // 切り替えボタンは以前は横幅いっぱいの2分割セグメントだったが、幅を短く
  // (中身の文字幅に合わせた自動幅)している。
  const headerLabel = weatherSourceMode === "registered"
    ? (registeredWeatherPoint?.name || "登録地点")
    : (currentMunicipalityName || "現在地");
  const modeToggle = (
    <div style={{
      display: "flex", padding: 2, borderRadius: 8,
      background: `rgba(${tokens.ink},0.07)`, flexShrink: 0,
    }}>
      {[{ id: "gps", label: "現在地" }, { id: "registered", label: "登録地点" }].map(opt => (
        <PressableButton
          key={opt.id}
          onClick={() => onChangeWeatherSourceMode(opt.id)}
          style={{
            fontSize: 11.5, fontWeight: 600, padding: "4px 9px", borderRadius: 6, textAlign: "center",
            whiteSpace: "nowrap",
            color: weatherSourceMode === opt.id ? tokens.text : `rgba(${tokens.ink},0.55)`,
            background: weatherSourceMode === opt.id ? (tokens.cardBg || `rgba(${tokens.ink},0.16)`) : "transparent",
          }}
        >
          {opt.label}
        </PressableButton>
      ))}
    </div>
  );
  const headerRow = (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
      padding: "14px 18px 4px",
    }}>
      <span style={{
        fontSize: 13, fontWeight: 600, color: `rgba(${tokens.ink},0.6)`,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {headerLabel}
      </span>
      {modeToggle}
    </div>
  );

  // モードごとの案内・エラー画面(activeWeatherPointがまだ無い場合)。
  let body = null;

  if (weatherSourceMode === "registered" && !registeredWeatherPoint) {
    body = (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "36px 18px" }}>
        <span style={{ fontSize: 14, color: `rgba(${tokens.ink},0.6)`, textAlign: "center" }}>
          地点が登録されていません
        </span>
        <PressableButton
          onClick={onOpenKanaPicker}
          style={{
            fontSize: 13.5, fontWeight: 600, color: "#fff",
            padding: "9px 18px", borderRadius: 999, background: "#0A84FF",
          }}
        >
          地点を登録
        </PressableButton>
      </div>
    );
  } else if (weatherSourceMode === "gps" && geoState.status === "awaiting-consent") {
    // ブラウザに位置情報を要求する前に、何のために・どう使うのかをアプリ内で
    // 説明する画面。ここで「現在地を使う」を選んで初めてgeolocationを呼び出す
    // (=続けてブラウザ自体の許可ダイアログが出る)。誤解を避けるため、送信先や
    // 用途を明記する。
    body = (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "30px 22px" }}>
        <PinIcon size={26}/>
        <span style={{ fontSize: 14.5, fontWeight: 700, color: `rgba(${tokens.ink},0.9)`, textAlign: "center" }}>
          現在地の天気を表示しますか?
        </span>
        <span style={{ fontSize: 12.5, color: `rgba(${tokens.ink},0.6)`, textAlign: "center", lineHeight: 1.7 }}>
          位置情報は天気予報を調べる目的にのみ使用します。開発者のサーバーに送信・保存されることはありません。
          「現在地を使う」を選ぶと、続けてお使いのブラウザの位置情報の確認が表示されます。
          以前ブラウザ側で拒否した場合は、ブラウザのサイト設定から改めて許可してください。
        </span>
        <PressableButton
          onClick={onConsentLocation}
          style={{
            fontSize: 13.5, fontWeight: 600, color: "#fff", textAlign: "center",
            padding: "10px 0", borderRadius: 999, background: "#0A84FF", width: "100%", maxWidth: 240,
          }}
        >
          現在地を使う
        </PressableButton>
      </div>
    );
  } else if (weatherSourceMode === "gps" && geoState.status === "loading") {
    body = (
      <div style={{ padding: "36px 18px", textAlign: "center", fontSize: 14, color: `rgba(${tokens.ink},0.6)` }}>
        現在地を取得中…
      </div>
    );
  } else if (weatherSourceMode === "gps" && geoState.status === "error") {
    body = (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "30px 18px" }}>
        <span style={{ fontSize: 14, color: `rgba(${tokens.ink},0.6)`, textAlign: "center", lineHeight: 1.6 }}>
          現在地を取得できませんでした。ブラウザで位置情報の利用がブロックされているか、取得に失敗しました。
        </span>
        <PressableButton
          onClick={onResetLocationConsent}
          style={{
            fontSize: 13.5, fontWeight: 600, color: `rgba(${tokens.ink},0.7)`,
            padding: "9px 18px", borderRadius: 999, background: `rgba(${tokens.ink},0.08)`,
          }}
        >
          もう一度試す
        </PressableButton>
      </div>
    );
  } else if (weatherSourceMode === "gps" && geoState.status === "unsupported") {
    body = (
      <div style={{ padding: "36px 18px", textAlign: "center", fontSize: 14, color: `rgba(${tokens.ink},0.6)`, lineHeight: 1.6 }}>
        この端末・ブラウザでは現在地を利用できません。上の「登録地点」から地点を登録してください。
      </div>
    );
  } else if (!activeWeatherPoint) {
    body = (
      <div style={{ padding: "36px 18px", textAlign: "center", fontSize: 14, color: `rgba(${tokens.ink},0.6)` }}>
        現在地を取得中…
      </div>
    );
  } else if (forecastState.status === "loading" || forecastState.status === "idle") {
    body = (
      <div style={{ padding: "36px 18px", textAlign: "center", fontSize: 14, color: `rgba(${tokens.ink},0.6)` }}>
        天気予報を取得中…
      </div>
    );
  } else if (forecastState.status === "error") {
    body = (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "30px 18px" }}>
        <span style={{ fontSize: 14, color: `rgba(${tokens.ink},0.6)`, textAlign: "center", lineHeight: 1.6 }}>
          天気予報を取得できませんでした
        </span>
        {weatherSourceMode === "registered" && (
          // 登録地点の予報がどうしても取得できない場合(離島など)でも、
          // ここで行き詰まらず別の地点を登録し直せるようにする。
          <PressableButton
            onClick={onOpenKanaPicker}
            style={{
              fontSize: 13.5, fontWeight: 600, color: "#fff",
              padding: "9px 18px", borderRadius: 999, background: "#0A84FF",
            }}
          >
            別の地点を登録
          </PressableButton>
        )}
      </div>
    );
  } else {
    const f = forecastState.data;
    const daily = f.daily || [];
    const visibleDays = rangeMode === "week" ? daily.slice(0, 7) : daily.slice(0, 3);
    body = (
      <div style={{ padding: "6px 18px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
        {weatherSourceMode === "registered" && (
          <PressableButton
            onClick={onOpenKanaPicker}
            style={{ fontSize: 12, fontWeight: 600, color: `rgba(${tokens.ink},0.55)`, alignSelf: "flex-end" }}
          >
            地点を変更
          </PressableButton>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {f.weatherCode != null && (
            <div style={{
              width: 68, height: 68, borderRadius: 16, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              marginLeft: 6,
            }}>
              <WeatherIcon code={f.weatherCode} size={68} alt=""/>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginLeft: 16 }}>
            <span style={{ fontSize: 19, fontWeight: 700, color: `rgba(${tokens.ink},0.92)` }}>{f.telop || "-"}</span>
            <span style={{ fontSize: 14, color: `rgba(${tokens.ink},0.7)` }}>
              {f.tempMax != null ? `${f.tempMax}°` : "--°"} / {f.tempMin != null ? `${f.tempMin}°` : "--°"}
              {f.pop != null ? `　降水確率 ${f.pop}%` : ""}
            </span>
          </div>
        </div>

        {timeSeriesState.status === "ready" && timeSeriesState.data?.entries?.length > 0 && (
          <>
            <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.12)`, margin: "2px 0" }}/>
            <span style={{ fontSize: 12, fontWeight: 600, color: `rgba(${tokens.ink},0.55)` }}>
              地域時系列予報
            </span>
            <div style={{ display: "flex", overflowX: "auto", gap: 2, marginLeft: -18, marginRight: -18, paddingLeft: 18, paddingRight: 18 }}>
              {timeSeriesState.data.entries.map((e, i) => {
                const prevDate = i > 0 ? timeSeriesState.data.entries[i - 1].dateTime : null;
                const dateChanged = formatTimeSeriesDateChanged(e.dateTime, prevDate);
                return (
                  <div
                    key={e.dateTime || i}
                    style={{
                      display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                      flexShrink: 0, width: 62, padding: "6px 0",
                      borderLeft: dateChanged && i > 0 ? `0.5px solid rgba(${tokens.ink},0.15)` : "none",
                    }}
                  >
                    <span style={{ fontSize: 9.5, color: `rgba(${tokens.ink},0.45)`, height: 12 }}>
                      {dateChanged ? formatForecastDayLabel(e.dateTime, 1).replace(/\(.\)$/, "") : ""}
                    </span>
                    <span style={{ fontSize: 11.5, color: `rgba(${tokens.ink},0.7)` }}>
                      {formatTimeSeriesHour(e.dateTime)}
                    </span>
                    {e.weatherCode != null ? (
                      <div style={{
                        width: 34, height: 34, borderRadius: 9, flexShrink: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        <WeatherIcon code={e.weatherCode} size={34} alt={e.weather || ""}/>
                      </div>
                    ) : (
                      <div style={{ width: 34, height: 34 }}/>
                    )}
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: `rgba(${tokens.ink},0.9)` }}>
                      {e.temperature != null ? `${e.temperature}°` : "--°"}
                    </span>
                    {e.wind && (
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, marginTop: 1 }}>
                        <span
                          aria-hidden="true"
                          style={{
                            fontSize: 17, color: `rgba(${tokens.ink},0.85)`, lineHeight: 1,
                            display: "inline-block", fontWeight: 700,
                            transform: `rotate(${windDirectionToDegrees(e.wind.direction) + 180}deg)`,
                          }}
                        >
                          ↑
                        </span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.8)`, whiteSpace: "nowrap" }}>
                          {e.wind.direction}{e.wind.speed != null ? ` ${e.wind.speed}m` : ""}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {daily.length > 0 && (
          <>
            <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.12)`, margin: "2px 0" }}/>

            {/* 3日間/週間の切り替え。iOS設定アプリ等でよく見る、2択の丸みを帯びた
                セグメントコントロール。 */}
            <div style={{
              display: "flex", padding: 2, borderRadius: 9,
              background: `rgba(${tokens.ink},0.07)`, alignSelf: "flex-start",
            }}>
              {[{ id: "3day", label: "3日間" }, { id: "week", label: "週間" }].map(opt => (
                <PressableButton
                  key={opt.id}
                  onClick={() => setRangeMode(opt.id)}
                  style={{
                    fontSize: 12.5, fontWeight: 600, padding: "5px 14px", borderRadius: 7,
                    color: rangeMode === opt.id ? tokens.text : `rgba(${tokens.ink},0.55)`,
                    background: rangeMode === opt.id ? (tokens.cardBg || `rgba(${tokens.ink},0.16)`) : "transparent",
                  }}
                >
                  {opt.label}
                </PressableButton>
              ))}
            </div>

            <div style={{ display: "flex", flexDirection: "column" }}>
              {visibleDays.map((d, i) => (
                <div key={d.date || i}>
                  {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.1)` }}/>}
                  <div style={{ display: "flex", alignItems: "center", padding: "9px 2px", gap: 10 }}>
                    <span style={{ fontSize: 13.5, color: `rgba(${tokens.ink},0.8)`, width: 56, flexShrink: 0 }}>
                      {formatForecastDayLabel(d.date, i)}
                    </span>
                    {d.weatherCode != null ? (
                      <div style={{
                        width: 36, height: 36, borderRadius: 9, flexShrink: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        <WeatherIcon code={d.weatherCode} size={36} alt=""/>
                      </div>
                    ) : (
                      <div style={{ width: 36, height: 36 }}/>
                    )}
                    <span style={{ fontSize: 12.5, color: `rgba(${tokens.ink},0.55)`, width: 44, flexShrink: 0 }}>
                      {d.pop != null ? `${d.pop}%` : ""}
                    </span>
                    <span style={{ fontSize: 13.5, color: `rgba(${tokens.ink},0.9)`, marginLeft: "auto", textAlign: "right" }}>
                      {d.tempMax != null ? `${d.tempMax}°` : "--°"}
                      {" / "}
                      <span style={{ color: `rgba(${tokens.ink},0.55)` }}>
                        {d.tempMin != null ? `${d.tempMin}°` : "--°"}
                      </span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {f.officeCode && (
          <a
            href={`https://www.jma.go.jp/bosai/forecast/#area_type=offices&area_code=${f.officeCode}`}
            {...(isStandalonePwa ? {} : { target: "_blank", rel: "noopener noreferrer" })}
            style={{
              display: "block", textAlign: "center", padding: "10px 0 0",
              fontSize: 12, fontWeight: 600, color: tokens.accentText || "#0A84FF",
              textDecoration: "none",
            }}
          >
            気象庁の該当ページを開く ↗
          </a>
        )}
        {f.officeCode && (
          <a
            href={`https://www.jma.go.jp/bosai/wdist/timeseries.html#area_type=offices&area_code=${f.officeCode}`}
            {...(isStandalonePwa ? {} : { target: "_blank", rel: "noopener noreferrer" })}
            style={{
              display: "block", textAlign: "center", padding: "2px 0 0",
              fontSize: 12, fontWeight: 600, color: tokens.accentText || "#0A84FF",
              textDecoration: "none",
            }}
          >
            地域時系列予報を見る ↗
          </a>
        )}
      </div>
    );
  }

  return (
    <div>
      {headerRow}
      {body}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   KANA MUNICIPALITY PICKER — 地点登録の絞り込み選択。
   都道府県(北→南の固定順)→「あかさたなはまやらわ」(行)→選んだ行の段
   (例:あいうえお)→該当する市区町村の一覧、の4ステップで絞り込む。
   テキスト入力は行わない。
   ───────────────────────────────────────────────────── */
function KanaMunicipalityPicker({
  step, onChangeStep, pref, onChangePref, row, onChangeRow, col, onChangeCol,
  grouped, dataReady, loadError, onSelect, onClose,
}) {
  const { tokens } = useContext(ThemeContext);

  const header = (title, onBack) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px 10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {onBack && (
          <PressableButton
            onClick={onBack}
            style={{ fontSize: 15, fontWeight: 600, color: `rgba(${tokens.ink},0.55)`, padding: "2px 4px" }}
          >
            ←
          </PressableButton>
        )}
        <span style={{ fontSize: 14, fontWeight: 600, color: `rgba(${tokens.ink},0.9)` }}>{title}</span>
      </div>
      <PressableButton onClick={onClose} style={{ fontSize: 12.5, fontWeight: 600, color: `rgba(${tokens.ink},0.55)` }}>
        閉じる
      </PressableButton>
    </div>
  );

  // 市区町村一覧そのものの読み込み中/失敗は、どのステップにいても共通で出す
  // (都道府県だけ選んで次に進めない状態を避けるため)。
  if (!dataReady) {
    return (
      <div>
        {header("地点を登録", null)}
        <div style={{ padding: "36px 18px", textAlign: "center", fontSize: 14, color: `rgba(${tokens.ink},0.6)` }}>
          {loadError ? "市区町村一覧の取得に失敗しました" : "読み込み中…"}
        </div>
      </div>
    );
  }

  if (step === "prefectures") {
    return (
      <div style={{ paddingBottom: 8 }}>
        {header("地点を登録", null)}
        <div style={{ display: "flex", flexDirection: "column", maxHeight: 420, overflowY: "auto", padding: "0 18px" }}>
          {PREF_ORDER.map((p, i) => (
            <div key={p}>
              {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.1)` }}/>}
              <PressableButton
                onClick={() => { onChangePref(p); onChangeStep("rows"); }}
                style={{ textAlign: "left", fontSize: 14, color: `rgba(${tokens.ink},0.85)`, padding: "10px 2px", width: "100%" }}
              >
                {p}
              </PressableButton>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (step === "rows") {
    return (
      <div style={{ paddingBottom: 14 }}>
        {header(pref || "地点を登録", () => onChangeStep("prefectures"))}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8,
          padding: "4px 18px 8px",
        }}>
          {KANA_ROWS.map(r => (
            <PressableButton
              key={r.key}
              onClick={() => { onChangeRow(r.key); onChangeStep("columns"); }}
              style={{
                fontSize: 16, fontWeight: 600, color: tokens.text,
                padding: "14px 0", borderRadius: 12, textAlign: "center",
                background: `rgba(${tokens.ink},0.06)`,
              }}
            >
              {r.key}
            </PressableButton>
          ))}
        </div>
      </div>
    );
  }

  const rowDef = KANA_ROWS.find(r => r.key === row) || KANA_ROWS[0];

  if (step === "columns") {
    return (
      <div style={{ paddingBottom: 14 }}>
        {header(`「${row}」から選ぶ`, () => onChangeStep("rows"))}
        <div style={{
          display: "grid", gridTemplateColumns: `repeat(${rowDef.columns.length}, 1fr)`, gap: 8,
          padding: "4px 18px 8px",
        }}>
          {rowDef.columns.map(c => {
            const count = grouped?.[row]?.[c]?.length || 0;
            return (
              <PressableButton
                key={c}
                disabled={count === 0}
                onClick={() => { onChangeCol(c); onChangeStep("list"); }}
                style={{
                  fontSize: 16, fontWeight: 600, color: count === 0 ? `rgba(${tokens.ink},0.28)` : tokens.text,
                  padding: "14px 0", borderRadius: 12, textAlign: "center",
                  background: `rgba(${tokens.ink},0.06)`,
                }}
              >
                {c}
              </PressableButton>
            );
          })}
        </div>
      </div>
    );
  }

  // step === "list"
  const list = grouped?.[row]?.[col] || [];
  return (
    <div style={{ paddingBottom: 8 }}>
      {header(`「${col}」から選ぶ`, () => onChangeStep("columns"))}
      <div style={{ display: "flex", flexDirection: "column", maxHeight: 320, overflowY: "auto", padding: "0 18px" }}>
        {list.map((m, i) => (
          <div key={m.regioncode}>
            {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.1)` }}/>}
            <PressableButton
              onClick={() => onSelect(m)}
              style={{ textAlign: "left", fontSize: 14, color: `rgba(${tokens.ink},0.85)`, padding: "10px 2px", width: "100%" }}
            >
              {m.regionname}
            </PressableButton>
          </div>
        ))}
        {list.length === 0 && (
          <div style={{ fontSize: 13, color: `rgba(${tokens.ink},0.5)`, padding: "16px 2px" }}>
            該当する市区町村がありません
          </div>
        )}
      </div>
    </div>
  );
}
function BackToListButton({ onClick, label = "地震一覧に戻る" }) {
  const { tokens } = useContext(ThemeContext);
  // ナビ行のガラスハイライトと同じ、"押し込むとガラスが少し膨らむ"演出。
  const [pressed, setPressed] = useState(false);

  return (
    <Glass
      radius={999}
      style={{
        width: 44, height: 44,
        transform: pressed ? "scale(1.16)" : "scale(1)",
        transformOrigin: "center",
        transition: "transform 0.18s cubic-bezier(.22,1,.36,1)",
      }}
    >
      <button
        onClick={onClick}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerCancel={() => setPressed(false)}
        onPointerLeave={() => setPressed(false)}
        aria-label={label}
        style={{
          position: "relative", zIndex: 1,
          width: "100%", height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: tokens.text,
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
             stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 6 9 12 15 18"/>
        </svg>
      </button>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   LAYERS TOGGLE ICON
   ───────────────────────────────────────────────────── */
function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2"/>
      <polyline points="2 17 12 22 22 17"/>
      <polyline points="2 12 12 17 22 12"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   PIN ICON — 地点マーク(📍)アイコン。気象タブの「地点」切り替えボタンで使う。
   ───────────────────────────────────────────────────── */
function PinIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
         stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21.5c-4.3-4.4-6.5-8-6.5-11a6.5 6.5 0 0 1 13 0c0 3-2.2 6.6-6.5 11z"/>
      <circle cx="12" cy="10.5" r="2.4"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   LIST VIEW ICON — 横長長方形が縦に3段積み上がったアイコン
   ───────────────────────────────────────────────────── */
function ListViewIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
      <rect x="3" y="4.5"  width="18" height="4" rx="1.6"/>
      <rect x="3" y="10.25" width="18" height="4" rx="1.6"/>
      <rect x="3" y="16"   width="18" height="4" rx="1.6"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   SEARCH ICON — 虫眼鏡アイコン
   ───────────────────────────────────────────────────── */
function SearchGlassIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
         stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10.5" cy="10.5" r="6.5"/>
      <line x1="15.3" y1="15.3" x2="20.5" y2="20.5"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   HISTORY ICON — 時計(履歴)アイコン。津波タブの「過去」モードで使う。
   ───────────────────────────────────────────────────── */
function HistoryClockIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
         stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12.5" r="8.5"/>
      <path d="M12 8v4.5l3 2"/>
      <path d="M9 2.5h6"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   TIDE GAUGE ICON — 潮位計タブ用。目盛り付きの棒+波線で「水位計」を表す。
   ───────────────────────────────────────────────────── */
function TideGaugeIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
         stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 21V4.5"/>
      <path d="M6 7h2.5"/>
      <path d="M6 11h2.5"/>
      <path d="M6 15h2.5"/>
      <path d="M11 15c1.4-1.6 2.9-1.6 4.3 0s2.9 1.6 4.3 0"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   QUAKE LIST ROW
   地震一覧の1行分。「直近の一覧」と「検索結果一覧」の両方から共通で使う。
   ───────────────────────────────────────────────────── */
function QuakeListRow({ quake: q, showDivider, colorScheme, onSelect, loading = false }) {
  const { tokens } = useContext(ThemeContext);

  const style = getIntensityStyleFromScheme(colorScheme, q.maxIntensity || "1");
  return (
    <div>
      {showDivider && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)`, marginLeft: 18 }}/>}
      <PressableButton
        onClick={loading ? undefined : onSelect}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 10,
          padding: "9px 14px",
          background: "transparent",
          textAlign: "left",
          opacity: loading ? 0.5 : 1,
          pointerEvents: loading ? "none" : "auto",
        }}
      >
        {loading ? (
          <span style={{
            flexShrink: 0, width: 28, height: 22, borderRadius: 6,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <span style={{
              width: 13, height: 13, borderRadius: "50%",
              border: `2px solid rgba(${tokens.ink},0.25)`,
              borderTopColor: `rgba(${tokens.ink},0.9)`,
              animation: "spin 0.8s linear infinite",
              display: "block",
            }}/>
          </span>
        ) : (
          <span style={{
            flexShrink: 0, width: 28, height: 22, borderRadius: 6,
            background: style.bg, color: style.fg,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: q.isForeign ? 9 : (q.maxIntensity === "?" || q.maxIntensity === "5u" ? 7.5 : 11), fontWeight: 800,
            lineHeight: 1.1, textAlign: "center",
          }}>
            {q.isForeign ? "遠地" : q.maxIntensity === "?" ? "調査中" : q.maxIntensity === "5u" ? "未入電" : style.label}
          </span>
        )}
        <span style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 5 }}>
          {!loading && QUAKE_STAGE_LABEL[q.stage] && (
            <span style={{
              flexShrink: 0, fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 5,
              background: `rgba(${tokens.ink},0.1)`, color: `rgba(${tokens.ink},0.65)`,
              whiteSpace: "nowrap", lineHeight: 1.5,
            }}>
              {QUAKE_STAGE_LABEL[q.stage]}
            </span>
          )}
          <span style={{
            minWidth: 0, fontSize: 13, fontWeight: 600, color: tokens.text,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {loading ? `${q.place}を読み込み中…` : q.place}
          </span>
        </span>
        {!loading && (q.magnitude != null || q.depth != null) && (
          <span className="mono" style={{
            fontSize: 11, color: `rgba(${tokens.ink},0.5)`,
            flexShrink: 0, whiteSpace: "nowrap",
          }}>
            M{q.magnitude != null ? q.magnitude.toFixed(1) : "-"}{q.depth != null ? (q.depth === 0 ? "・ごく浅い" : `・深さ${q.depth}km`) : "・深さ-"}
          </span>
        )}
        {!loading && (
          <span className="mono" style={{ fontSize: 10, color: `rgba(${tokens.ink},0.4)`, flexShrink: 0 }}>
            {q.isEqdb ? q.time?.slice(0, 10) : q.time?.slice(5, 16)}
          </span>
        )}
      </PressableButton>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   TSUNAMI LIST ROW — 津波情報一覧の1行(QuakeListRowと対の構成)
   震度のような1〜2文字の共通表記が無いため、バッジは「大津波/警報/注意/予報/解除」
   の短縮ラベルをグレード色の背景で表示する。
   ───────────────────────────────────────────────────── */
function tsunamiShortLabel(card) {
  if (card.cancelled) return "解除";
  return tsunamiGradeShortLabel(card.maxGrade);
}
function tsunamiFullLabel(card) {
  if (card.cancelled) return "津波予報・警報の解除";
  return tsunamiGradeInfo(card.maxGrade).label;
}

function TsunamiListRow({ tsunami: t, showDivider, onSelect, isHistory = false }) {
  const { tokens } = useContext(ThemeContext);

  const color = t.cancelled ? TSUNAMI_GRADE_FALLBACK.color : tsunamiGradeInfo(t.maxGrade).color;
  const areaCount = t.areas.length;

  return (
    <div>
      {showDivider && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)`, marginLeft: 18 }}/>}
      <PressableButton
        onClick={onSelect}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 10,
          padding: "9px 14px",
          background: "transparent",
          textAlign: "left",
        }}
      >
        <span style={{
          flexShrink: 0, width: 40, height: 22, borderRadius: 6,
          background: color, color: "#000",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 11, fontWeight: 800, whiteSpace: "nowrap",
        }}>
          {tsunamiShortLabel(t)}
        </span>
        <span style={{
          flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: tokens.text,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {tsunamiFullLabel(t)}
        </span>
        {t.isTest && (
          <span style={{
            flexShrink: 0, fontSize: 9.5, fontWeight: 800, color: "#fff",
            background: "#FF453A", borderRadius: 4, padding: "2px 5px",
          }}>
            テスト
          </span>
        )}
        {!t.cancelled && areaCount > 0 && (
          <span className="mono" style={{
            fontSize: 11, color: `rgba(${tokens.ink},0.5)`,
            flexShrink: 0, whiteSpace: "nowrap",
          }}>
            {areaCount}区域
          </span>
        )}
        <span className="mono" style={{ fontSize: 10, color: `rgba(${tokens.ink},0.4)`, flexShrink: 0 }}>
          {isHistory ? t.time?.slice(0, 10) : t.time?.slice(5, 16)}
        </span>
      </PressableButton>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   TSUNAMI DETAIL CARD — QuakeDetailCardと対の構成。
   最大グレードを大きく表示し、発表時刻を添える。
   ───────────────────────────────────────────────────── */
function TsunamiDetailCard({ tsunami: t, onFindCausingQuake }) {
  const { tokens, mode } = useContext(ThemeContext);
  const color = t.cancelled ? TSUNAMI_GRADE_FALLBACK.color : tsunamiGradeInfo(t.maxGrade).color;
  const textColor = mode === "dark" ? "#ffffff" : "#000000";

  return (
    <div
      style={{
        position: "relative",
        margin: "2px 14px 4px",
        borderRadius: 16,
        padding: "7px 16px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        background: `linear-gradient(135deg, ${color}22, ${color}0E)`,
        boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.12)`,
        animation: "appear 0.35s cubic-bezier(.25,1,.5,1)",
      }}
    >
      {t.isTest && (
        <span style={{
          position: "absolute", top: 6, left: 10,
          fontSize: 9.5, fontWeight: 800, color: "#fff",
          background: "#FF453A", borderRadius: 4, padding: "2px 6px",
        }}>
          テスト配信
        </span>
      )}
      {/* グレード名を表示する、色付き枠線の角丸バッジ(横幅2倍・QuakeDetailCardと同じ高さ)。
          枠線のさらに外側を白い線(box-shadowのリング)で囲っている。 */}
      <div style={{ flexShrink: 0 }}>
        <div
          style={{
            width: 128, height: 80,
            borderRadius: 14,
            border: `2px solid ${color}`,
            background: `${color}14`,
            boxShadow: "0 0 0 2px #ffffff",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "4px 6px",
          }}
        >
          <span style={{ fontSize: 20, fontWeight: 800, color: textColor, textAlign: "center", lineHeight: 1.15 }}>
            {tsunamiFullLabel(t)}
          </span>
        </div>
      </div>

      {/* 発表時刻(小さめ)。右下のボタンと重ならないよう、少し上寄りに配置する。 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, paddingBottom: 16 }}>
        <span className="mono" style={{ fontSize: 14, fontWeight: 800, color: tokens.text, lineHeight: 1.2, whiteSpace: "nowrap" }}>
          {formatTsunamiTimeShort(t.time)}
        </span>
        <span style={{ fontSize: 12, fontWeight: 500, color: `rgba(${tokens.ink},0.5)` }}>
          {t.cancelled ? "解除" : "発表"}
        </span>
      </div>

      {/* 「↪︎津波を引き起こした地震」— 右下に絶対配置し、カードの高さには影響させない */}
      {onFindCausingQuake && (
        <PressableButton
          type="button"
          onClick={onFindCausingQuake}
          style={{
            position: "absolute", right: 8, bottom: 6,
            display: "flex", alignItems: "center", gap: 3,
            padding: "3px 8px", borderRadius: 999,
            border: "none", cursor: "pointer",
            background: `rgba(${tokens.ink},0.08)`,
            color: `rgba(${tokens.ink},0.7)`,
            fontSize: 10, fontWeight: 600, whiteSpace: "nowrap",
          }}
        >
          ↪︎津波を引き起こした地震
        </PressableButton>
      )}
    </div>
  );
}

// 津波予報区1件分の行。グレード色で背景・左枠線をつけ、到達予想時刻(または
// 「ただちに」等の文言)・予想の高さを添える。
// 津波予報区1件分の行(震度観測点リストのStationPointsList「一覧」表示と対の構成)。
// グレード色の短縮バッジ+予報区名+到達予想時刻や高さの補足、という並びにしている。
function tsunamiGradeShortLabel(grade) {
  const map = { MajorWarning: "大津波", Warning: "警報", Watch: "注意", NonEffective: "予報", Unknown: "情報" };
  return map[grade] || "情報";
}

function TsunamiAreaRow({ area, showDivider, observedStations = [], onSelectStation }) {
  const { tokens } = useContext(ThemeContext);
  const info = tsunamiGradeInfo(area.grade);

  let timeText = null;
  if (area.immediate) timeText = "ただちに津波が到達";
  else if (area.firstHeightCondition) timeText = area.firstHeightCondition;
  else if (area.firstHeightTime) timeText = formatQuakeTimeShort(area.firstHeightTime);
  const metaText = [area.maxHeightDescription, timeText].filter(Boolean).join("・");

  return (
    <div>
      {showDivider && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)`, marginLeft: 12 }}/>}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px" }}>
        <span style={{
          flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
          background: info.color, color: "#000",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 11, fontWeight: 800,
        }}>
          {tsunamiGradeShortLabel(area.grade)}
        </span>
        <span style={{
          flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: tokens.text,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {area.name}
        </span>
        {metaText && (
          <span style={{
            fontSize: 11, color: `rgba(${tokens.ink},0.4)`,
            flexShrink: 0, whiteSpace: "nowrap",
          }}>
            {metaText}
          </span>
        )}
      </div>
      {/* この予報区に属する観測点で、実際に観測された津波の高さ(微弱でないもの)を
          観測点ごとに1行ずつ、最大波を観測した日時と一緒に並べる。観測が無い
          予報区では何も出さない。行自体をボタンにしていて、押すとその観測点の
          潮位が(地図のピンをタップした時と同じく)その場で見られる。 */}
      {observedStations.length > 0 && (
        <div style={{ padding: "0 12px 8px 46px", display: "flex", flexDirection: "column", gap: 2 }}>
          {observedStations.map(st => {
            const color = tsunamiHeightBandColor(st.heightM);
            const timeText = formatTsunamiMaxWaveTime(st.timeMs);
            return (
              <PressableButton
                key={st.name}
                type="button"
                onClick={() => onSelectStation?.(st.code)}
                style={{
                  display: "flex", alignItems: "baseline", gap: 6, padding: "6px 8px",
                  margin: "0 -6px", borderRadius: 8,
                  border: `0.5px solid rgba(${tokens.ink},0.12)`,
                  background: `rgba(${tokens.ink},0.035)`, cursor: "pointer",
                  textAlign: "left", width: "calc(100% + 12px)",
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: 999, background: color, flexShrink: 0, alignSelf: "center" }}/>
                <span style={{
                  fontSize: 13, fontWeight: 700, color: tokens.text,
                  flexShrink: 0, maxWidth: "38%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {st.name}
                </span>
                <span style={{ fontSize: 11.5, color: `rgba(${tokens.ink},0.5)`, flexShrink: 0 }}>
                  最大波{timeText && `　${timeText}`}
                </span>
                <span style={{
                  fontSize: 14, fontWeight: 800, color, marginLeft: "auto", flexShrink: 0,
                  // ダークモードでグレードの色(特に薄い色)が背景に沈んで見づらいことが
                  // あるため、白い縁取りを付けて視認性を確保する。
                  textShadow: "-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 0 3px rgba(255,255,255,0.8)",
                }}>
                  {Math.abs(st.heightM).toFixed(1)}m
                </span>
              </PressableButton>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   TSUNAMI TAB BODY — 津波タブ本体。選択中の津波情報があれば詳細(グレード+
   予報区一覧)を、無ければ一覧を表示する。地震タブのQuakeListRow⇄QuakeDetailCard
   と同じ「同じスクロール領域内でその場を差し替える」構成。
   ───────────────────────────────────────────────────── */
function TsunamiTabBody({
  tsunamis, status, selectedId, onSelect,
  onHandoffToPanelDrag,
  // 「過去」モード関連。viewModeが"history"の間は、直近一覧(tsunamis)の代わりに
  // historyItems(/history APIをoffsetで遡って追加取得した一覧)を表示する。
  // 選択中の詳細は、直近一覧・過去一覧のどちらから選んでも見られるよう両方から探す
  // (地震タブのquakes⇄searchQuakeと同じ考え方)。
  viewMode = "recent",
  historyItems = EMPTY_EQDB_LIST, historyStatus = "idle", historyHasMore = true, historyDebug = "",
  onLoadMoreHistory,
  // 「↪︎ 津波を引き起こした地震」関連。
  onFindCausingQuake, causingQuakeState = {}, showingCausingQuakeFor, onBackFromCausingQuake,
  stationListDisplayMode = "list", causingQuakeStationOpenKey, onChangeCausingQuakeStationOpenKey,
  // 「潮位計」モード関連。
  tideStations = EMPTY_EQDB_LIST, tideStationsStatus = "idle",
  selectedTideStationCode, onSelectTideStation, tideObsByStation = {}, onLoadTideObs,
  // 観測点ごとの「観測された津波の高さ」。予報区一覧の各行に、その予報区に属する
  // 観測点の実測最大波を表示するために使う(未観測・微弱の間はnullなので、
  // その観測点は表示対象から外す)。
  tsunamiHeightByStation = {}, tsunamiHeightTimeByStation = {},
}) {
  const { tokens } = useContext(ThemeContext);

  // 観測点が選ばれたら観測値を読み込む(潮位計モードに限らない — 直近一覧などを
  // 見ながら地図のピンをタップした場合も同じ)。早期returnより前でしかhooksを
  // 呼べないため、ここで無条件に呼んでおき、中で条件分岐する。
  useEffect(() => {
    if (selectedTideStationCode != null) {
      onLoadTideObs?.(selectedTideStationCode);
    }
  }, [selectedTideStationCode, onLoadTideObs]);

  // 「観測された津波の高さ」欄の注意書き(気象庁公式の値とは異なる旨)の開閉状態。
  // 初期は閉じておく。
  const [obsHeightNoteOpen, setObsHeightNoteOpen] = useState(false);

  // 潮位観測点が選ばれている間は、今見ているモード(直近一覧・過去一覧・潮位計の
  // いずれでも)に関わらず、その場で観測点の詳細を最優先で表示する。モードを
  // 切り替えないことで、見終わった後は元のモードへ自動的に戻る(「戻る」は
  // 選択解除だけを行う。BottomDockのhandleBackFromTsunami参照)。
  if (selectedTideStationCode != null) {
    const station = tideStations.find(s => s.code === selectedTideStationCode);
    const obs = tideObsByStation[selectedTideStationCode];
    return (
      <TideStationDetail
        station={station}
        obs={obs}
      />
    );
  }

  const selected = tsunamis.find(t => t.id === selectedId)
    || historyItems.find(t => t.id === selectedId)
    || null;

  if (selected) {
    const sortedAreas = [...selected.areas].sort((a, b) => tsunamiGradeInfo(b.grade).weight - tsunamiGradeInfo(a.grade).weight);
    // この予報区に実際に属していて、かつ観測された高さがある(=微弱でない)観測点だけを
    // 対象にする(高い順)。注意書きを出すかどうかの判定にも使う。
    // 一覧の並び順は、まず予報区自体の警報グレードの高い順(注意報より警報が上、など)。
    // 同じグレードの予報区が複数ある場合だけ、その中でより高い最大波が観測された
    // 予報区を上に表示する。
    const areasWithObserved = sortedAreas
      .map(area => ({
        area,
        observedStations: tideStations
          .filter(st => st.tsunamiAreaName === area.name && tsunamiHeightByStation[st.code] != null)
          .map(st => ({ code: st.code, name: st.name, heightM: tsunamiHeightByStation[st.code], timeMs: tsunamiHeightTimeByStation[st.code] }))
          .sort((a, b) => Math.abs(b.heightM) - Math.abs(a.heightM)),
      }))
      .map(x => ({ ...x, gradeWeight: tsunamiGradeInfo(x.area.grade).weight, maxObservedHeight: x.observedStations[0] ? Math.abs(x.observedStations[0].heightM) : -1 }))
      .sort((a, b) => (b.gradeWeight - a.gradeWeight) || (b.maxObservedHeight - a.maxObservedHeight));
    const hasAnyObservedHeight = areasWithObserved.some(x => x.observedStations.length > 0);
    const showingCausingQuake = showingCausingQuakeFor === selected.id;
    const causingState = causingQuakeState[selected.id];

    return (
      <>
        <PanelDragHandoffCard onHandoffToPanelDrag={onHandoffToPanelDrag}>
          <TsunamiDetailCard tsunami={selected} onFindCausingQuake={() => onFindCausingQuake?.(selected)}/>
        </PanelDragHandoffCard>
        {showingCausingQuake ? (
          <div style={{ margin: "2px 0 8px" }}>
            <PressableButton
              type="button"
              onClick={onBackFromCausingQuake}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                margin: "0 14px 4px", padding: "6px 2px",
                background: "transparent", border: "none", cursor: "pointer",
                fontSize: 12.5, fontWeight: 600, color: `rgba(${tokens.ink},0.6)`,
              }}
            >
              ← 予報区一覧に戻る
            </PressableButton>
            {(!causingState || causingState.status === "loading") ? (
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                gap: 8, margin: "0 14px", padding: "18px 0", color: `rgba(${tokens.ink},0.45)`,
              }}>
                <div style={{
                  width: 16, height: 16, borderRadius: "50%",
                  border: `2px solid rgba(${tokens.ink},0.15)`,
                  borderTopColor: `rgba(${tokens.ink},0.6)`,
                  animation: "spin 0.8s linear infinite",
                }}/>
                <span style={{ fontSize: 12 }}>地震を読み込み中…</span>
              </div>
            ) : causingState.status === "notfound" ? (
              <div style={{ margin: "0 14px", padding: "18px 16px", textAlign: "center" }}>
                <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)`, lineHeight: 1.8 }}>
                  該当する地震が気象庁 震度データベースに見つかりませんでした。遠地地震の可能性があります。
                </span>
              </div>
            ) : causingState.status === "error" ? (
              <div style={{ margin: "0 14px", padding: "18px 16px", textAlign: "center" }}>
                <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>地震の検索に失敗しました</span>
              </div>
            ) : (
              <>
                <PanelDragHandoffCard onHandoffToPanelDrag={onHandoffToPanelDrag}>
                  <QuakeDetailCard quake={causingState.quake}/>
                </PanelDragHandoffCard>
                {Array.isArray(causingState.quake.resolvedPoints) && causingState.quake.resolvedPoints.length > 0 && (
                  <StationPointsList
                    points={causingState.quake.resolvedPoints}
                    displayMode={stationListDisplayMode}
                    openKey={causingQuakeStationOpenKey}
                    onOpenKeyChange={onChangeCausingQuakeStationOpenKey}
                  />
                )}
              </>
            )}
          </div>
        ) : selected.cancelled ? (
          <div style={{
            margin: "8px 14px", padding: 14, borderRadius: 12,
            background: `rgba(${tokens.ink},0.04)`,
            fontSize: 12.5, color: `rgba(${tokens.ink},0.6)`, lineHeight: 1.8,
          }}>
            発表されていた津波の予報・警報は解除されました。
          </div>
        ) : sortedAreas.length > 0 ? (
          <div style={{ margin: "2px 14px 8px" }}>
            {hasAnyObservedHeight && (
              <div style={{ marginBottom: 6 }}>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <PressableButton
                    type="button"
                    onClick={() => setObsHeightNoteOpen(v => !v)}
                    style={{
                      display: "flex", alignItems: "center", gap: 4,
                      padding: "6px 2px",
                      background: "transparent", border: "none", cursor: "pointer",
                      fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.45)`,
                      textAlign: "right",
                    }}
                  >
                    ⓘ「最大波」の表示について
                    <span style={{
                      display: "inline-block", transition: "transform 0.2s",
                      transform: obsHeightNoteOpen ? "rotate(90deg)" : "rotate(0deg)",
                    }}>
                      ›
                    </span>
                  </PressableButton>
                </div>
                {obsHeightNoteOpen && (
                  <div style={{
                    margin: "2px 2px 6px", padding: "10px 12px", borderRadius: 10,
                    background: `rgba(${tokens.ink},0.04)`,
                    fontSize: 11.5, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.8,
                  }}>
                    「最大波」は、潮位観測データの潮位偏差(実測潮位−天文潮位)からMeteoQuakeが
                    独自に算出した参考値です。気象庁が発表する津波情報・観測値ではなく、公表値と
                    一致しない場合があります。
                  </div>
                )}
              </div>
            )}
            <div style={{
              padding: "6px 2px",
              fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.5)`,
            }}>
              {hasAnyObservedHeight ? "対象の予報区と津波の最大波(参考値)" : "対象の予報区"}
            </div>
            <div style={{
              borderRadius: 12,
              overflow: "hidden",
              background: `rgba(${tokens.ink},0.04)`,
              boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
            }}>
              {areasWithObserved.map(({ area, observedStations }, i) => (
                <TsunamiAreaRow key={`${area.name}-${i}`} area={area} showDivider={i > 0} observedStations={observedStations} onSelectStation={onSelectTideStation}/>
              ))}
            </div>
          </div>
        ) : (
          <div style={{
            margin: "8px 14px", padding: 14, borderRadius: 12,
            background: `rgba(${tokens.ink},0.04)`,
            fontSize: 12.5, color: `rgba(${tokens.ink},0.6)`,
          }}>
            対象区域の詳細データがありません。
          </div>
        )}
      </>
    );
  }

  // 「潮位計」モード: 観測点が選ばれていない間は、一覧から選べるようにする
  // (選ばれている間の詳細表示は、モードによらず上のブロックで既に処理済み)。
  if (viewMode === "tidegauge") {
    if (tideStationsStatus === "loading" || tideStationsStatus === "error" || tideStations.length === 0) {
      return (
        <div style={{ padding: "28px 18px", textAlign: "center" }}>
          <TideGaugeIcon size={28}/>
          <div style={{ marginTop: 10, fontSize: 12.5, color: `rgba(${tokens.ink},0.45)`, lineHeight: 1.8 }}>
            {tideStationsStatus === "loading"
              ? "潮位観測点を読み込み中…"
              : tideStationsStatus === "error"
              ? "潮位観測点の取得に失敗しました"
              : "潮位観測点が見つかりませんでした"}
          </div>
        </div>
      );
    }

    const sortedStations = [...tideStations].sort((a, b) => {
      const aw = a.activeGrade ? tsunamiGradeInfo(a.activeGrade).weight : -1;
      const bw = b.activeGrade ? tsunamiGradeInfo(b.activeGrade).weight : -1;
      if (aw !== bw) return bw - aw; // 警報グレードが高い(大津波→警報→注意報→予報)ものを先に
      const areaCmp = (a.areaName || "").localeCompare(b.areaName || "", "ja");
      return areaCmp !== 0 ? areaCmp : (a.name || "").localeCompare(b.name || "", "ja");
    });

    return (
      <>
        <div style={{ padding: "2px 14px 6px", fontSize: 11, color: `rgba(${tokens.ink},0.45)`, textAlign: "center" }}>
          地図のピンをタップするか、一覧から観測点を選んでください({sortedStations.length}地点)
        </div>
        {sortedStations.map((st, i) => (
          <TideStationListRow key={st.code} station={st} showDivider={i > 0} onSelect={() => onSelectTideStation?.(st.code)}/>
        ))}
      </>
    );
  }

  // 「過去」モード: /history APIをoffsetで遡って取得した過去の津波情報一覧を表示する。
  // 末尾に「もっと見る」ボタンを置き、押すたびにさらに古い分を追加取得する。
  if (viewMode === "history") {
    if (historyStatus === "loading" && historyItems.length === 0) {
      return (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          gap: 8, padding: "18px 0", color: `rgba(${tokens.ink},0.45)`,
        }}>
          <div style={{
            width: 16, height: 16, borderRadius: "50%",
            border: `2px solid rgba(${tokens.ink},0.15)`,
            borderTopColor: `rgba(${tokens.ink},0.6)`,
            animation: "spin 0.8s linear infinite",
          }}/>
          <span style={{ fontSize: 12 }}>過去の津波情報を取得中…</span>
        </div>
      );
    }

    if (historyStatus === "error" && historyItems.length === 0) {
      return (
        <div style={{ padding: "18px 16px", textAlign: "center" }}>
          <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>過去の津波情報の取得に失敗しました</span>
          {historyDebug && (
            <div style={{ marginTop: 6, fontSize: 11, color: `rgba(${tokens.ink},0.35)`, wordBreak: "break-all" }}>{historyDebug}</div>
          )}
        </div>
      );
    }

    if (historyItems.length === 0) {
      return (
        <div style={{ padding: "18px 16px", textAlign: "center" }}>
          <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>過去の津波情報が見つかりませんでした</span>
          {historyDebug && (
            <div style={{ marginTop: 6, fontSize: 11, color: `rgba(${tokens.ink},0.35)`, wordBreak: "break-all" }}>{historyDebug}</div>
          )}
        </div>
      );
    }

    return (
      <>
        <div style={{ padding: "2px 14px 6px", fontSize: 11, color: `rgba(${tokens.ink},0.45)`, textAlign: "center" }}>
          {historyItems.length}件を表示中
        </div>
        {historyItems.map((t, i) => (
          <TsunamiListRow key={t.id} tsunami={t} showDivider={i > 0} onSelect={() => onSelect(t.id)} isHistory/>
        ))}
        {historyHasMore && (
          <div style={{ margin: "12px 14px 6px" }}>
            <PressableButton
              type="button"
              onClick={onLoadMoreHistory}
              disabled={historyStatus === "loading"}
              style={{
                width: "100%", padding: "10px 12px", borderRadius: 12,
                border: "none", cursor: "pointer",
                background: `rgba(${tokens.ink},0.06)`,
                boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.12)`,
                color: `rgba(${tokens.ink},0.75)`, fontSize: 13, fontWeight: 600,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                opacity: historyStatus === "loading" ? 0.55 : 1,
              }}
            >
              {historyStatus === "loading" ? (
                <>
                  <div style={{
                    width: 13, height: 13, borderRadius: "50%",
                    border: `2px solid rgba(${tokens.ink},0.2)`,
                    borderTopColor: `rgba(${tokens.ink},0.7)`,
                    animation: "spin 0.8s linear infinite",
                  }}/>
                  <span>読み込み中…</span>
                </>
              ) : (
                <>
                  <HistoryClockIcon size={14}/>
                  <span>もっと見る</span>
                </>
              )}
            </PressableButton>
          </div>
        )}
      </>
    );
  }

  if (status === "loading" && tsunamis.length === 0) {
    return (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        gap: 8, padding: "18px 0", color: `rgba(${tokens.ink},0.45)`,
      }}>
        <div style={{
          width: 16, height: 16, borderRadius: "50%",
          border: `2px solid rgba(${tokens.ink},0.15)`,
          borderTopColor: `rgba(${tokens.ink},0.6)`,
          animation: "spin 0.8s linear infinite",
        }}/>
        <span style={{ fontSize: 12 }}>津波情報を取得中…</span>
      </div>
    );
  }

  if (status === "error" && tsunamis.length === 0) {
    return (
      <div style={{ padding: "28px 18px", textAlign: "center", fontSize: 12.5, color: `rgba(${tokens.ink},0.45)`, lineHeight: 1.8 }}>
        津波情報の取得に失敗しました。
      </div>
    );
  }

  if (tsunamis.length === 0) {
    return (
      <div style={{ padding: "28px 18px", textAlign: "center", fontSize: 12.5, color: `rgba(${tokens.ink},0.45)` }}>
        現在発表されている津波予報・警報はありません
      </div>
    );
  }

  return (
    <>
      {tsunamis.map((t, i) => (
        <TsunamiListRow key={t.id} tsunami={t} showDivider={i > 0} onSelect={() => onSelect(t.id)}/>
      ))}
    </>
  );
}


/* ─────────────────────────────────────────────────────
   TIDE STATION DETAIL — 潮位計モードで地点を選んだ時の表示。
   気象庁の潮位観測ページ(map.html#contents=tidelevel)のグラフ画面を
   参考に、タイトルバー+潮位グラフ+潮位偏差グラフの構成にしている。
   ───────────────────────────────────────────────────── */
// tide_area.jsonのmax.datetimeは"200409080732"のような12桁(秒無し)形式。
function tideMaxDatetimeDisplay(id) {
  if (!id || id.length < 12) return "";
  return `${id.slice(0, 4)}/${id.slice(4, 6)}/${id.slice(6, 8)} ${id.slice(8, 10)}:${id.slice(10, 12)}`;
}

const TIDE_RANGE_OPTIONS = [
  { id: "1h",  label: "1時間",  hours: 1 },
  { id: "6h",  label: "6時間",  hours: 6 },
  { id: "12h", label: "12時間", hours: 12 },
  { id: "24h", label: "1日",   hours: 24 },
];

/* ─────────────────────────────────────────────────────
   TIDE STATION LIST ROW — 潮位観測点一覧の1行分。
   地震・津波の一覧行と同じ「区切り線+タップ可能な行」構成。
   ───────────────────────────────────────────────────── */
function TideStationListRow({ station, showDivider, onSelect }) {
  const { tokens } = useContext(ThemeContext);
  // addrは"北海道 小樽市 築港"のように"都道府県 市区町村 地区"の空白区切りなので、
  // 先頭(都道府県名)だけ取り出して、市区町村名(areaName)の前にスペース区切りで添える。
  const prefName = (station.addr || "").split(/[ 　]/)[0] || "";
  const gradeInfo = station.activeGrade ? tsunamiGradeInfo(station.activeGrade) : null;
  return (
    <div>
      {showDivider && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)`, marginLeft: 14 }}/>}
      <PressableButton
        onClick={onSelect}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 10,
          padding: "9px 14px",
          background: "transparent",
          textAlign: "left",
        }}
      >
        {gradeInfo && (
          <span style={{
            flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
            background: gradeInfo.color, color: "#000",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 800,
          }}>
            {tsunamiGradeShortLabel(station.activeGrade)}
          </span>
        )}
        <span style={{
          flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: tokens.text,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {station.name}
        </span>
        <span style={{
          fontSize: 11, color: `rgba(${tokens.ink},0.45)`,
          flexShrink: 0, whiteSpace: "nowrap", maxWidth: "40%",
          overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {prefName} {station.areaName}
        </span>
      </PressableButton>
    </div>
  );
}

function TideStationDetail({ station, obs }) {
  const { tokens, mode } = useContext(ThemeContext);
  const [rangeId, setRangeId] = useState("24h");
  const isStandalonePwa = useIsStandalonePwa();

  // ダーク/ライトそれぞれで見やすい配色。
  // (ダークでは黒基準線が見えなくなるため、ダーク時は白系に切り替える)
  const tideColor  = mode === "dark" ? "#64D2FF" : "#0A5FCC";
  const astroColor = mode === "dark" ? "#FFD60A" : "#FF9500";
  const depColor   = mode === "dark" ? "#64D2FF" : "#0A5FCC";
  const level5Color = mode === "dark" ? "#F2F2F7" : "#1C1C1E";
  const level4Color = "#BF5AF2";
  const maxColor     = "#30D158";

  if (!station) {
    return (
      <div style={{ padding: "18px 16px", textAlign: "center" }}>
        <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>観測点の情報が見つかりませんでした</span>
      </div>
    );
  }

  // tide(実測潮位)とdeparture(潮位偏差 = 実測−天文潮位)から、天文潮位を逆算する。
  const tideValues = obs?.data?.tide;
  const departureValues = obs?.data?.departure;
  const astroValues = (Array.isArray(tideValues) && Array.isArray(departureValues))
    ? tideValues.map((v, i) => (v == null || departureValues[i] == null) ? null : v - departureValues[i])
    : null;

  // 選択中の表示期間(1時間〜1日)ぶんだけ、末尾から切り出す。
  const intervalSec = obs?.data?.interval || 15;
  const samplesPerHour = 3600 / intervalSec;
  const rangeHours = TIDE_RANGE_OPTIONS.find(r => r.id === rangeId)?.hours ?? 24;
  const windowSamples = Math.max(1, Math.round(rangeHours * samplesPerHour));
  const fullLen = Array.isArray(tideValues) ? tideValues.length : 0;
  const windowStartIndex = Math.max(0, fullLen - windowSamples);
  const windowSlice = arr => (Array.isArray(arr) ? arr.slice(windowStartIndex) : []);
  const tideWindowed = windowSlice(tideValues);
  const astroWindowed = astroValues ? windowSlice(astroValues) : null;
  const departureWindowed = windowSlice(departureValues);
  const dayStart = obs?.data?.time ? new Date(obs.data.time) : null;
  const windowStartTime = dayStart ? new Date(dayStart.getTime() + windowStartIndex * intervalSec * 1000) : null;

  return (
    <div style={{ padding: "2px 14px 12px" }}>
      {/* タイトルバー — 気象庁の潮位ページと同じ「市町村名 観測所:地点名[種別]」表記 */}
      <div style={{
        borderRadius: 10, padding: "10px 12px", marginBottom: 10,
        background: "#0A84FF", color: "#ffffff",
      }}>
        <span style={{ fontSize: 13.5, fontWeight: 700 }}>
          {station.areaName}　観測所：{station.name}[{station.typeName}]
        </span>
      </div>

      {!obs || obs.status === "loading" ? (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          gap: 8, padding: "18px 0", color: `rgba(${tokens.ink},0.45)`,
        }}>
          <div style={{
            width: 16, height: 16, borderRadius: "50%",
            border: `2px solid rgba(${tokens.ink},0.15)`,
            borderTopColor: `rgba(${tokens.ink},0.6)`,
            animation: "spin 0.8s linear infinite",
          }}/>
          <span style={{ fontSize: 12 }}>潮位データを読み込み中…</span>
        </div>
      ) : obs.status === "error" ? (
        <div style={{ padding: "18px 16px", textAlign: "center" }}>
          <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
            本日分の潮位データがまだ無いか、取得に失敗しました。
          </span>
        </div>
      ) : (
        <>
          {/* 表示期間(横軸の範囲)の切り替え */}
          <div style={{ display: "flex", gap: 6, padding: "2px 2px 8px" }}>
            {TIDE_RANGE_OPTIONS.map(opt => (
              <PressableButton
                key={opt.id}
                type="button"
                onClick={() => setRangeId(opt.id)}
                style={{
                  padding: "5px 10px", borderRadius: 999, border: "none", cursor: "pointer",
                  fontSize: 11.5, fontWeight: 600,
                  background: rangeId === opt.id ? "#0A84FF" : `rgba(${tokens.ink},0.08)`,
                  color: rangeId === opt.id ? "#ffffff" : `rgba(${tokens.ink},0.7)`,
                }}
              >
                {opt.label}
              </PressableButton>
            ))}
          </div>

          <Glass radius={16} style={{ padding: "10px 8px 12px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.5)`, padding: "2px 2px 4px" }}>
              潮位(cm)
            </div>
            <TideLineChart
              series={[
                // 実際の潮位を最後(=一番手前)に描くことで、天文潮位・基準線より前面に出す。
                ...(astroWindowed ? [{ name: "天文潮位", color: astroColor, values: astroWindowed }] : []),
                { name: "実際の潮位", color: tideColor, values: tideWindowed || [] },
              ]}
              thresholds={[
                ...(station.level5 != null ? [{ label: `レベル5特別警報基準(${station.level5}cm)`, value: station.level5, color: level5Color }] : []),
                ...(station.level4 != null ? [{ label: `レベル4危険警報基準(${station.level4}cm)`, value: station.level4, color: level4Color }] : []),
                ...(station.max?.level != null ? [{ label: `過去最高潮位(${station.max.level}cm)`, value: station.max.level, color: maxColor, dashed: true }] : []),
              ]}
              startTime={windowStartTime}
              intervalSec={intervalSec}
            />

            <div style={{ fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.5)`, padding: "10px 2px 4px" }}>
              潮位偏差(cm)
            </div>
            <TideLineChart
              series={[{ name: "潮位偏差", color: depColor, values: departureWindowed || [] }]}
              zeroLine
              startTime={windowStartTime}
              intervalSec={intervalSec}
            />
          </Glass>

          {station.max && (
            <div style={{ marginTop: 8, fontSize: 11, color: `rgba(${tokens.ink},0.45)`, lineHeight: 1.7 }}>
              過去最高潮位: {station.max.level}cm({tideMaxDatetimeDisplay(station.max.datetime)}・{station.max.description})
            </div>
          )}

          {station.class20Code && station.class30Code && (
            <a
              href={`https://www.jma.go.jp/bosai/tidelevel/#area_type=class20s&area_code=${station.class20Code}&point_code=${station.code}&class30s=${station.class30Code}&filter=0`}
              {...(isStandalonePwa ? {} : { target: "_blank", rel: "noopener noreferrer" })}
              style={{
                display: "block", textAlign: "center", padding: "10px 0",
                fontSize: 12, fontWeight: 600, color: tokens.accentText || "#0A84FF",
                textDecoration: "none",
              }}
            >
              気象庁の該当ページを開く ↗
            </a>
          )}
        </>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   TIDE LINE CHART — 簡易SVG折れ線グラフ。潮位・潮位偏差の両方で使う共通部品。
   ───────────────────────────────────────────────────── */
function TideLineChart({ series, thresholds = [], height = 150, zeroLine = false, startTime, intervalSec }) {
  const { tokens } = useContext(ThemeContext);
  const containerRef = useRef(null);
  const [measuredWidth, setMeasuredWidth] = useState(320);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setMeasuredWidth(w);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const width = Math.max(160, measuredWidth);
  const padding = { top: 10, right: 10, bottom: 18, left: 32 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const allValues = series.flatMap(s => (s.values || []).filter(v => v != null))
    .concat(thresholds.map(t => t.value));
  if (allValues.length === 0) {
    return (
      <div style={{ padding: "18px 0", textAlign: "center", fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
        表示できるデータがありません
      </div>
    );
  }
  let dataMin = Math.min(...allValues, zeroLine ? 0 : allValues[0]);
  let dataMax = Math.max(...allValues, zeroLine ? 0 : allValues[0]);
  if (dataMin === dataMax) { dataMin -= 1; dataMax += 1; }
  const marginPad = (dataMax - dataMin) * 0.08;
  dataMin -= marginPad; dataMax += marginPad;
  const span = dataMax - dataMin || 1;
  const yScale = v => padding.top + innerH - ((v - dataMin) / span) * innerH;

  const n = Math.max(...series.map(s => (s.values || []).length), 1);
  const xScale = i => padding.left + (i / (n - 1 || 1)) * innerW;

  const pathFor = (values) => {
    let d = "";
    let started = false;
    values.forEach((v, i) => {
      if (v == null) { started = false; return; }
      d += `${started ? "L" : "M"} ${xScale(i).toFixed(1)} ${yScale(v).toFixed(1)} `;
      started = true;
    });
    return d.trim();
  };

  const tickCount = 5;
  const ticks = Array.from({ length: tickCount }, (_, i) => dataMin + (span * i) / (tickCount - 1));

  // 横軸(時刻)の目盛り。startTime(この配列の先頭のオリジナル時刻)+intervalSec(1件あたりの秒数)から
  // 各目盛り位置の実際の時刻を逆算する。日をまたぐ場合は日付も添える。
  const xTickCount = 6;
  const xTicks = (startTime && intervalSec)
    ? Array.from({ length: xTickCount }, (_, j) => {
        const idx = Math.round((j / (xTickCount - 1)) * (n - 1));
        const t = new Date(startTime.getTime() + idx * intervalSec * 1000);
        return { x: xScale(idx), t };
      })
    : [];
  let lastDateLabel = null;

  return (
    <div ref={containerRef}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} style={{ display: "block" }}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padding.left} x2={width - padding.right} y1={yScale(t)} y2={yScale(t)}
              stroke={`rgba(${tokens.ink},0.08)`} strokeWidth="1"/>
            <text x={padding.left - 5} y={yScale(t) + 3} fontSize="9" textAnchor="end" fill={`rgba(${tokens.ink},0.45)`}>
              {Math.round(t)}
            </text>
          </g>
        ))}
        {zeroLine && dataMin < 0 && dataMax > 0 && (
          <line x1={padding.left} x2={width - padding.right} y1={yScale(0)} y2={yScale(0)}
            stroke={`rgba(${tokens.ink},0.35)`} strokeWidth="1"/>
        )}
        {thresholds.map((t, i) => (
          t.value >= dataMin && t.value <= dataMax && (
            <line key={i} x1={padding.left} x2={width - padding.right} y1={yScale(t.value)} y2={yScale(t.value)}
              stroke={t.color} strokeWidth="2" strokeDasharray={t.dashed ? "5 3" : undefined}/>
          )
        ))}
        {series.map((s, i) => (
          <path key={i} d={pathFor(s.values || [])} fill="none" stroke={s.color} strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round"/>
        ))}
        {/* 横軸(時刻) */}
        {xTicks.length > 0 && (
          <line x1={padding.left} x2={width - padding.right} y1={padding.top + innerH} y2={padding.top + innerH}
            stroke={`rgba(${tokens.ink},0.18)`} strokeWidth="1"/>
        )}
        {xTicks.map((tick, j) => {
          const hh = String(tick.t.getHours()).padStart(2, "0");
          const mm = String(tick.t.getMinutes()).padStart(2, "0");
          const dateLabel = `${tick.t.getMonth() + 1}/${tick.t.getDate()}`;
          const showDate = dateLabel !== lastDateLabel;
          lastDateLabel = dateLabel;
          return (
            <text key={j} x={tick.x} y={height - 4} fontSize="9" textAnchor="middle" fill={`rgba(${tokens.ink},0.45)`}>
              {showDate ? `${dateLabel} ${hh}:${mm}` : `${hh}:${mm}`}
            </text>
          );
        })}
      </svg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", padding: "4px 2px 0" }}>
        {series.map((s, i) => (
          <div key={`s${i}`} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 10, height: 2, background: s.color, borderRadius: 1 }}/>
            <span style={{ fontSize: 10, color: `rgba(${tokens.ink},0.5)` }}>{s.name}</span>
          </div>
        ))}
        {thresholds.map((t, i) => (
          <div key={`t${i}`} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 10, height: 2, background: t.color, borderRadius: 1 }}/>
            <span style={{ fontSize: 10, color: `rgba(${tokens.ink},0.5)` }}>{t.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────
   EQDB FORM FIELD — 検索フォームの1項目(ラベル+入力欄)の共通ラッパー
   ───────────────────────────────────────────────────── */
// 開始日/終了日(input[type=date])・OptionPickerの見た目を統一するための共通スタイル。
// 高さを固定(34px)して、日付欄とピッカー欄で縦の揃いがずれないようにする。
// 「中高」パネル(290px固定)に検索ボタンまで収まるよう、あえて少しコンパクトにしている。
// ライト/ダークで色が変わるため、固定オブジェクトではなくtokensを受け取る関数にしている。
function eqdbInputStyle(tokens, mode) {
  return {
    width: "100%", height: 34, boxSizing: "border-box",
    background: `rgba(${tokens.ink},0.06)`, color: tokens.text,
    border: `1px solid rgba(${tokens.ink},0.16)`, borderRadius: 8,
    padding: "0 10px", fontSize: 13, outline: "none",
    colorScheme: mode === "light" ? "light" : "dark",
  };
}

function EqdbFormField({ label, full, children }) {
  const { tokens } = useContext(ThemeContext);

  return (
    <div style={{ flex: full ? "1 1 100%" : 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 9, fontWeight: 600, color: `rgba(${tokens.ink},0.5)`, lineHeight: 1.2 }}>{label}</span>
      {children}
    </div>
  );
}

// "YYYY-MM-DD" (input[type=date]の値形式)に整形する
function eqdbDateValue(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

/* ─────────────────────────────────────────────────────
   気象庁 震度データベースの実際の収録期間
   これまでは終了日の上限を「現在の2日前」という決め打ちの目安値で計算していたが、
   実際のデータベースへの反映にはこれより長いタイムラグが生じることがあり、
   その場合は「まだ収録されていない期間」を終了日に指定してしまい、検索そのものが
   エラーになっていた(地震の内容に関わらず、その時点でのタイムラグの長さ次第で
   毎回失敗する形になっていた)。
   date.json(https://www.data.jma.go.jp/eqdb/data/shindo/js/date.json)に
   実際の収録期間 { st: "1919-01-01", en: "YYYY-MM-DD" } が公開されているため、
   これを取得して実際の範囲に合わせる。取得できるまで・取得に失敗した場合は、
   従来の決め打ち値をフォールバックとして使う。
   ───────────────────────────────────────────────────── */
const EQDB_DATE_RANGE_URL = "https://www.data.jma.go.jp/eqdb/data/shindo/js/date.json";

let eqdbDateRangePromise = null;
function loadEqdbDateRange() {
  if (!eqdbDateRangePromise) {
    eqdbDateRangePromise = fetch(EQDB_DATE_RANGE_URL)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        if (!data || typeof data.st !== "string" || typeof data.en !== "string") {
          throw new Error("date.jsonの形式が想定と異なります");
        }
        return { st: data.st, en: data.en };
      })
      .catch(err => {
        eqdbDateRangePromise = null; // 失敗時は次回呼び出しで再取得を試みられるようにする
        throw err;
      });
  }
  return eqdbDateRangePromise;
}

// 実際の収録期間(date.json)を取得して { st, en } | null を返すフック。
// 未取得・取得失敗の間はnullを返すので、呼び出し側は従来のフォールバック値
// (EQDB_MIN_DATE / eqdbMaxEndDate())と組み合わせて使う。
function useEqdbDateRange() {
  const [range, setRange] = useState(null);
  useEffect(() => {
    let cancelled = false;
    loadEqdbDateRange()
      .then(r => { if (!cancelled) setRange(r); })
      .catch(err => { console.error("震度データベースの収録期間(date.json)の取得に失敗しました:", err); });
    return () => { cancelled = true; };
  }, []);
  return range;
}

// 開始日に指定できる最も古い日付のフォールバック値。実際の収録期間(date.json のst)が
// 取得できていればそちらを優先する(理論上は常に1919-01-01のはずだが、念のため)。
const EQDB_MIN_DATE = "1919-01-01";

// 終了日に指定できる最新日のフォールバック値(=現在の2日前という決め打ちの目安)。
// 実際の収録期間(date.jsonのen)が取得できていればそちらを優先して使うべきで、
// これはあくまで取得できるまでの・取得に失敗した場合の暫定値。
function eqdbMaxEndDate(realEn) {
  if (realEn) return realEn;
  const d = new Date();
  d.setDate(d.getDate() - 2);
  return eqdbDateValue(d);
}

// 検索フォームの初期値。開始日=1か月前、終了日=選べる最新日(現在の2日前が目安)。
function defaultEqdbDateRange() {
  const start = new Date();
  start.setMonth(start.getMonth() - 1);
  return { start: eqdbDateValue(start), end: eqdbMaxEndDate() };
}

// input[type=date](ネイティブのカレンダーから選ぶ方式)専用のスタイル。
// フォントサイズを16px未満にすると、iOSがフォーカス時に画面を自動的に拡大し、
// そのまま(user-scalable=noのため)手動で縮小できなくなる不具合があるため、
// 必ず16px以上にする。
const EQDB_DATE_INPUT_STYLE_EXTRA = {
  fontSize: 16,
  WebkitAppearance: "none",
  appearance: "none",
};

function eqdbDateInputStyle(tokens, mode) {
  return { ...eqdbInputStyle(tokens, mode), ...EQDB_DATE_INPUT_STYLE_EXTRA };
}

// 下向き山形アイコン(OptionPickerの右端に置く。開いている間は上下反転する)
function ChevronDownIcon({ open }) {
  const { tokens } = useContext(ThemeContext);

  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
         stroke={`rgba(${tokens.ink},0.45)`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
         style={{ flexShrink: 0, marginLeft: 6, transition: "transform 0.15s", transform: open ? "rotate(180deg)" : "none" }}>
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   OPTION PICKER
   ネイティブの<select>や<input type="date">はiOS Safariだと背景・高さを
   自前のCSSで統一できず、他の項目と見た目が揃わなくなる(ネイティブのピル状
   UIが被さって見えてしまう)ため、代わりにこのアプリの他の設定画面と同じ
   「ボタン+SVGの山形アイコン」で選択肢を開閉する自前のドロップダウンを使う。
   ───────────────────────────────────────────────────── */
function OptionPicker({ value, options, onChange, style }) {
  const { tokens, mode } = useContext(ThemeContext);
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState(null); // {left, width, top?, bottom?}
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const selected = options.find(o => o.value === value);

  // ボトムシートは自身のスクロール領域でoverflowを切っているため、通常の
  // position:absoluteな子要素だと上下どちらに開いてもシートの外にはみ出た分が
  // 見切れてしまう。それを避けるため、メニュー自体はdocument.bodyへportalし、
  // position:fixedでボタンの実際の画面上の位置から浮かせて表示する
  // (=シートのoverflowに一切影響されない)。
  function computeAndOpen() {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) { setOpen(true); return; }
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const openUpward = spaceBelow < 240 && spaceAbove > spaceBelow;
    setMenuRect({
      left: rect.left, width: rect.width,
      ...(openUpward ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    });
    setOpen(true);
  }

  // 開いている間にシートやページがスクロールされると、固定座標がボタンと
  // ずれてしまうため、その場合はメニューを閉じる。
  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      // メニュー自身(選択肢一覧)のスクロールでは閉じない。ボトムシート側など
      // 外側のスクロールでボタンとメニューの位置がずれた場合だけ閉じる。
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <div style={{ position: "relative" }}>
      <PressableButton
        ref={btnRef}
        type="button"
        onClick={() => (open ? setOpen(false) : computeAndOpen())}
        style={{
          ...eqdbInputStyle(tokens, mode), ...style,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          cursor: "pointer",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected?.label ?? value}
        </span>
        <ChevronDownIcon open={open}/>
      </PressableButton>

      {open && menuRect && createPortal(
        <>
          {/* 背面タップで閉じるための透明オーバーレイ */}
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 9998 }}/>
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              left: menuRect.left, width: menuRect.width,
              ...(menuRect.top != null ? { top: menuRect.top } : { bottom: menuRect.bottom }),
              zIndex: 9999,
              maxHeight: 220, overflowY: "auto",
              borderRadius: 10,
              background: tokens.glassOpaqueBg,
              boxShadow: `0 10px 28px rgba(0,0,0,0.35), inset 0 0 0 0.5px rgba(${tokens.ink},0.14)`,
            }}
          >
            {options.map((o, i) => (
              <PressableButton
                key={o.value}
                type="button"
                onClick={() => { onChange(o.value); setOpen(false); }}
                style={{
                  width: "100%", textAlign: "left", padding: "9px 12px",
                  background: o.value === value ? `rgba(${tokens.ink},0.08)` : "transparent",
                  border: "none", borderTop: i > 0 ? `0.5px solid rgba(${tokens.ink},0.08)` : "none",
                  color: tokens.text, fontSize: 13,
                }}
              >
                {o.label}
              </PressableButton>
            ))}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   NEARBY QUAKES PANEL
   「この震源の近傍で発生した地震」。選択中のP2P地震情報(リアルタイム)の
   震源地名と同じ震源地名を持つ地震を、気象庁 震度データベース(eqdb)全期間から
   検索して一覧表示する。eqdbの検索APIには震央地名そのものを条件にする項目が
   無い(震央地域はコード化された階層選択のみ)ため、期間全体を対象に検索した
   上で、返ってきた各件の震源地名(name)が選択中の地震の震源地名と完全一致する
   ものだけをクライアント側で絞り込む。
   ───────────────────────────────────────────────────── */
const NEARBY_SORT_BUTTONS = [
  { key: "time", label: "日時" },
  { key: "mag", label: "M" },
  { key: "maxInt", label: "最大震度" },
  { key: "depth", label: "深さ" },
];

// 近傍地震一覧の検索結果キャッシュ(震源地名→結果一覧)。
// NearbyQuakesPanelは、近傍一覧→他の地震の詳細→近傍一覧、と行き来するたびに
// (selectedQuakeIdの変化でキーが変わるため)Reactコンポーネントとしては毎回
// 作り直される。componentのstateはその度に失われるので、再訪問時に検索し直さず
// 済むよう、コンポーネントの外(モジュールスコープ)にキャッシュを持たせる。
const nearbyQuakeSearchCache = new Map();

function NearbyQuakesPanel({ place, stations, colorScheme, onFoundQuake, onSelectQuake, onPointsChange, onLoadingChange, epicenterCirclesEnabled }) {
  const { tokens } = useContext(ThemeContext);

  const cached = nearbyQuakeSearchCache.get(place);
  const [status, setStatus] = useState(cached ? "done" : "loading"); // loading | error | done
  const [results, setResults] = useState(cached || []);
  const [sortKey, setSortKey] = useState("maxInt");
  const [sortDesc, setSortDesc] = useState(true);
  const [loadingId, setLoadingId] = useState(null);

  // 実際の震度データベースの収録期間(date.json)。取得できるまでは
  // nullなので、fetchEqdbSearchの呼び出し側でフォールバック値と組み合わせる。
  const eqdbDateRange = useEqdbDateRange();

  // 震央分布(地図上の丸)用に、resultsの座標をバックグラウンドで少しずつ解決し、
  // 呼び出し元(BottomDock)へ伝える。まだ解決しきっていない間はonLoadingChangeで
  // 「読み込み中」も伝え、地図上にローディング表示を出せるようにする。
  // 設定でOFFの場合は、そもそも表示しないデータを無駄に取得しないよう、
  // 解決対象を空配列にしてバックグラウンド取得自体を行わない。
  const { points: epicenterPoints, loading: epicenterLoading } = useEqdbEpicenterPoints(epicenterCirclesEnabled ? results : EMPTY_EQDB_LIST);
  useEffect(() => {
    onPointsChange?.(epicenterPoints);
  }, [epicenterPoints]);
  useEffect(() => {
    onLoadingChange?.(epicenterLoading);
    return () => onLoadingChange?.(false);
  }, [epicenterLoading]);

  useEffect(() => {
    if (nearbyQuakeSearchCache.has(place)) return; // キャッシュ済みなら検索し直さない
    let cancelled = false;
    (async () => {
      setStatus("loading");
      try {
        const startDate = eqdbDateRange?.st || EQDB_MIN_DATE;
        const endDate = eqdbMaxEndDate(eqdbDateRange?.en);
        console.log("[nearby-quake-diag] 検索開始", { place, startDate, endDate });
        const { list, errMsg, summary } = await fetchEqdbSearch({
          startDate, endDate,
          minMag: 0, maxInt: "1", sort: "S2", epi: place,
        });
        if (cancelled) return;
        console.log("[nearby-quake-diag] 検索結果", {
          place, errMsg, summary, 件数: list.length,
        });
        if (errMsg) { setStatus("error"); setResults([]); return; }
        // eqdbのepi[]は本来コード化された地域選択用の項目で、震源地名の
        // 文字列そのものを条件にする項目はAPIに無いため、念のため返ってきた
        // 結果を震源地名の完全一致でもクライアント側から絞り込んでおく
        // (epi[]が実際に地名文字列でどこまで絞り込んでくれているか不明なため、
        // 二重チェックとして残す。ここでの絞り込みで結果が0件になる場合、
        // epi[]側では絞り込めていなかった可能性が高い)。
        const filtered = list.filter(eq => eq.name === place);
        console.log("[nearby-quake-diag] 震源地名完全一致で絞り込み後", {
          place, 絞り込み前: list.length, 絞り込み後: filtered.length,
        });
        nearbyQuakeSearchCache.set(place, filtered);
        setResults(filtered);
        setStatus("done");
      } catch (e) {
        console.error("[nearby-quake-diag] 検索失敗(例外)", { place, message: e?.message, name: e?.name });
        if (!cancelled) { setStatus("error"); setResults([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [place, eqdbDateRange]);

  const sorted = useMemo(() => {
    const arr = [...results];
    const valueOf = (eq) => {
      if (sortKey === "time") return eq.id || "";
      if (sortKey === "mag") return parseFloat(eq.mag) || 0;
      if (sortKey === "depth") return parseInt((eq.dep || "").match(/\d+/)?.[0] || "0", 10);
      return eqdbIntensityStringToScale(eq.maxI || "");
    };
    arr.sort((a, b) => {
      const av = valueOf(a), bv = valueOf(b);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDesc ? -cmp : cmp;
    });
    return arr;
  }, [results, sortKey, sortDesc]);

  function handleSortTap(key) {
    if (sortKey === key) { setSortDesc(d => !d); return; }
    setSortKey(key);
    setSortDesc(true);
  }

  async function handlePick(eq) {
    if (loadingId) return;
    setLoadingId(eq.id);
    try {
      const [detail, geo] = await Promise.all([fetchEqdbEventCached(eq.id), loadGeoData()]);
      if (!detail) return;
      const card = buildEqdbQuakeCard(detail, eq, stations, geo?.areas);
      onFoundQuake(card);
      onSelectQuake(card.id);
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <div>
      <div style={{ padding: "10px 14px 2px" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: tokens.text }}>
          この震源({place})の近傍で発生した地震
        </span>
      </div>

      <div style={{ display: "flex", gap: 6, padding: "8px 14px 10px", flexWrap: "wrap" }}>
        {NEARBY_SORT_BUTTONS.map(b => (
          <PressableButton
            key={b.key}
            type="button"
            onClick={() => handleSortTap(b.key)}
            style={{
              padding: "5px 10px", borderRadius: 8, fontSize: 12, fontWeight: 600,
              border: "none", cursor: "pointer",
              background: sortKey === b.key ? `rgba(${tokens.ink},0.18)` : `rgba(${tokens.ink},0.06)`,
              color: sortKey === b.key ? tokens.text : `rgba(${tokens.ink},0.6)`,
            }}
          >
            {b.label}{sortKey === b.key ? (sortDesc ? " ↓" : " ↑") : ""}
          </PressableButton>
        ))}
      </div>

      {status === "loading" && (
        <div style={{ padding: "18px 0", textAlign: "center", color: `rgba(${tokens.ink},0.45)`, fontSize: 12 }}>
          検索中…
        </div>
      )}
      {status === "error" && (
        <div style={{ padding: "18px 16px", textAlign: "center", color: "rgba(255,140,140,0.9)", fontSize: 12 }}>
          取得に失敗しました
        </div>
      )}
      {status === "done" && sorted.length === 0 && (
        <div style={{ padding: "18px 16px", textAlign: "center", color: `rgba(${tokens.ink},0.45)`, fontSize: 12 }}>
          同じ震源地の地震は見つかりませんでした
        </div>
      )}
      {status === "done" && sorted.map((eq, i) => (
        <QuakeListRow
          key={eq.id}
          quake={eqdbListItemToPreview(eq)}
          showDivider={i > 0}
          colorScheme={colorScheme}
          onSelect={() => handlePick(eq)}
          loading={loadingId === eq.id}
        />
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   QUAKE SEARCH PANEL
   「検索」モードの中身。気象庁 震度データベース(eqdb)を期間・マグニチュード・
   最大震度で検索するフォーム + 結果一覧。
   結果一覧の1件をタップすると、その地震の観測点別震度(mode=event)を取得し、
   通常の地震カード(QuakeDetailCard等)と全く同じ見た目で表示できる形に変換して
   onFoundQuakeで親(App)に渡し、onSelectQuakeで選択状態にする。
   ───────────────────────────────────────────────────── */
function QuakeSearchPanel({ stations, colorScheme, onFoundQuake, onSelectQuake, search, onChangeSearch, onSearchExecuted, scrollContainerRef, onPointsChange, onLoadingChange, epicenterCirclesEnabled }) {
  const { tokens, mode } = useContext(ThemeContext);

  // 実際の震度データベースの収録期間(date.json)。取得できるまでは
  // nullなので、従来の決め打ちのフォールバック値と組み合わせて使う。
  const eqdbDateRange = useEqdbDateRange();
  const minStartDate = eqdbDateRange?.st || EQDB_MIN_DATE;
  const maxEndDate = eqdbMaxEndDate(eqdbDateRange?.en); // 終了日に選べる最新日(収録期間の実際の終端、取得できるまでは現在の2日前が目安)。

  // 収録期間が(取得前の目安値より)実際には手前までしか無かった場合、既に
  // フォームにセットされている終了日がそれを超えていることがあるため、実際の
  // 範囲が判明した時点で一度だけ補正する(ユーザーが日付を選び直す手間を省く)。
  useEffect(() => {
    if (!eqdbDateRange) return;
    onChangeSearch(prev => {
      let next = prev;
      if (prev.endDate && prev.endDate > maxEndDate) next = { ...next, endDate: maxEndDate };
      if (next.startDate && next.startDate < minStartDate) next = { ...next, startDate: minStartDate };
      return next;
    });
  }, [eqdbDateRange]);

  const {
    startDate, endDate, minMag, maxInt, sort, epicenterName,
    status, isSearching, hasSearched, results, loadingId,
  } = search;

  // 震源地名の選択肢(プルダウン)。EEW・地震情報テスト配信の「地図をタップして
  // 震源を指定」で使っているep.json(気象庁の震央地名区域)をそのまま流用し、
  // 収録されている震央地名を重複無く並べたものを選択肢にする。
  // カタカナ表記の震源地名(海外の地名など。例:「アリューシャン列島」)は、
  // 五十音順だと国内の地名の間に混ざってしまい探しにくいため、まとめて
  // 末尾に回す(カタカナ同士は引き続き五十音順)。
  const [epicenterNameOptions, setEpicenterNameOptions] = useState(EQDB_EPICENTER_NAME_OPTIONS_DEFAULT);
  useEffect(() => {
    let cancelled = false;
    loadEpicenterNamesData()
      .then(geojson => {
        if (cancelled || !geojson?.features) return;
        const startsWithKatakana = s => /^[\u30A0-\u30FF]/.test(s);
        const names = Array.from(new Set(
          geojson.features.map(f => f.properties?.name).filter(Boolean)
        )).sort((a, b) => {
          const aKana = startsWithKatakana(a);
          const bKana = startsWithKatakana(b);
          if (aKana !== bKana) return aKana ? 1 : -1;
          return a.localeCompare(b, "ja");
        });
        setEpicenterNameOptions([
          { value: "", label: "指定なし" },
          ...names.map(n => ({ value: n, label: n })),
        ]);
      })
      .catch(err => console.error("震央地名データの読み込みに失敗しました:", err));
    return () => { cancelled = true; };
  }, []);


  // 震央分布(地図上の丸)用に、resultsの座標をバックグラウンドで少しずつ解決し、
  // 呼び出し元(BottomDock)へ伝える。まだ解決しきっていない間はonLoadingChangeで
  // 「読み込み中」も伝え、地図上にローディング表示を出せるようにする。
  // 設定でOFFの場合は、そもそも表示しないデータを無駄に取得しないよう、
  // 解決対象を空配列にしてバックグラウンド取得自体を行わない。
  const { points: epicenterPoints, loading: epicenterLoading } = useEqdbEpicenterPoints(epicenterCirclesEnabled ? results : EMPTY_EQDB_LIST);
  useEffect(() => {
    onPointsChange?.(epicenterPoints);
  }, [epicenterPoints]);
  useEffect(() => {
    onLoadingChange?.(epicenterLoading);
    return () => onLoadingChange?.(false);
  }, [epicenterLoading]);

  // 検索条件・結果一覧の状態は、選択解除で再マウントされても消えないよう
  // 親(BottomDock)側で保持している。ここでは差分だけをマージして書き戻す。
  function patch(p) {
    onChangeSearch(prev => ({ ...prev, ...p }));
  }

  // 検索を実行したら、パネルの高さは「中高」のまま、結果一覧の先頭が
  // パネル上部に来る位置までスクロールする。
  // (「戻る」で選択解除された後の再マウント時など、ユーザー操作を伴わない
  //  タイミングでは動かしたくないため、実際にhandleSearchが呼ばれた時だけ
  //  フラグを立てて、検索が完了した瞬間(isSearchingがtrue→falseになった瞬間)に発火する)
  const justSearchedRef = useRef(false);
  const resultsAnchorRef = useRef(null);
  useEffect(() => {
    if (justSearchedRef.current && !isSearching) {
      justSearchedRef.current = false;
      onSearchExecuted?.();
      // パネルの高さが変わるアニメーション(0.4s)が落ち着いてからスクロールする。
      // scrollIntoView()は「overflow:hiddenだが技術的にはスクロール可能な
      // 祖先要素」まで対象にしてしまうことがあり(例えば角丸クリップ用の
      // overflow:hidden要素)、本来スクロールさせたいスクロールコンテナ
      // (scrollContainerRef)ではなく見えない場所を動かしてしまうことがある。
      // そのため、対象となるスクロールコンテナに対して直接scrollTopを
      // 計算して設定する。
      setTimeout(() => {
        const container = scrollContainerRef?.current;
        const anchor = resultsAnchorRef.current;
        if (container && anchor) {
          const containerRect = container.getBoundingClientRect();
          const anchorRect = anchor.getBoundingClientRect();
          const delta = anchorRect.top - containerRect.top;
          container.scrollTo({ top: container.scrollTop + delta, behavior: "smooth" });
        } else {
          anchor?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 420);
    }
  }, [isSearching, onSearchExecuted]);

  async function handleSearch() {
    if (isSearching) return;
    justSearchedRef.current = true;

    // 検索前に、終了日が実際の収録期間の終端を超えていないか・開始日が終了日より後や
    // 収録期間の始端より前になっていないかを念のため補正する
    // (input[type=date]のmax/min属性で通常は防げるが、念のためここでも二重にチェックしておく)。
    let effectiveEnd = endDate > maxEndDate ? maxEndDate : endDate;
    let effectiveStart = startDate > effectiveEnd ? effectiveEnd : startDate;
    if (effectiveStart < minStartDate) effectiveStart = minStartDate;

    if (!effectiveStart || !effectiveEnd) { patch({ status: "開始日・終了日を指定してください" }); justSearchedRef.current = false; return; }

    patch({
      startDate: effectiveStart, endDate: effectiveEnd,
      isSearching: true, hasSearched: true,
      status: "気象庁 震度データベースを検索中…",
    });
    try {
      const minMagNum = parseFloat(minMag) || 0;
      const { list, errMsg, summary } = await fetchEqdbSearch({
        startDate: effectiveStart, endDate: effectiveEnd, minMag: minMagNum, maxInt, sort,
        epi: epicenterName || undefined,
      });
      if (errMsg) {
        patch({ status: `⚠ ${errMsg}`, results: [] });
        return;
      }
      const maxIntScale = EQDB_MAX_INT_SCALE[maxInt] || 10;
      const filtered = list.filter(eq => {
        const magOk = minMagNum <= 0 || parseFloat(eq.mag) >= minMagNum;
        const intOk = maxInt === "1" || eqdbIntensityThresholdScale(eq.maxI || "") >= maxIntScale;
        // epi[]はコード化された地域選択用の項目で、震源地名の文字列そのものを
        // 条件にする項目がAPIに無いため、念のためクライアント側でも震源地名の
        // 完全一致で絞り込んでおく(近傍地震検索と同じ理由・同じやり方)。
        const nameOk = !epicenterName || eq.name === epicenterName;
        return magOk && intOk && nameOk;
      });
      if (sort === "S2") {
        filtered.sort((a, b) => eqdbIntensityStringToScale(b.maxI || "") - eqdbIntensityStringToScale(a.maxI || "") || parseFloat(b.mag) - parseFloat(a.mag));
      } else if (sort === "S3") {
        filtered.sort((a, b) => parseFloat(b.mag) - parseFloat(a.mag) || eqdbIntensityStringToScale(b.maxI || "") - eqdbIntensityStringToScale(a.maxI || ""));
      }
      patch({
        results: filtered,
        status: filtered.length !== list.length
          ? `${filtered.length}件（取得${list.length}件から絞り込み）`
          : (summary || `${filtered.length}件`),
      });
    } catch (e) {
      patch({ status: `検索中にエラーが発生しました: ${e.message}`, results: [] });
    } finally {
      patch({ isSearching: false });
    }
  }

  async function handleSelect(eq) {
    if (loadingId) return;
    patch({ loadingId: eq.id, status: `「${eq.name}」の震度データを取得中…` });
    try {
      const [detail, geo] = await Promise.all([fetchEqdbEventCached(eq.id), loadGeoData()]);
      if (!detail) {
        patch({ status: "詳細データの取得に失敗しました" });
        return;
      }
      const card = buildEqdbQuakeCard(detail, eq, stations, geo?.areas);
      onFoundQuake(card);
      onSelectQuake(card.id);
    } catch (e) {
      patch({ status: `詳細データの取得に失敗しました: ${e.message}` });
    } finally {
      patch({ loadingId: null });
    }
  }

  return (
    <div>
      {/* 検索条件フォーム */}
      <div style={{ padding: "2px 14px 6px", display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <EqdbFormField label="開始日">
            <input type="date" value={startDate} min={minStartDate} max={endDate || maxEndDate}
              onChange={e => patch({ startDate: e.target.value < minStartDate ? minStartDate : e.target.value })} style={eqdbDateInputStyle(tokens, mode)}/>
          </EqdbFormField>
          <EqdbFormField label="終了日">
            <input type="date" value={endDate} min={startDate || minStartDate} max={maxEndDate}
              onChange={e => patch({ endDate: e.target.value > maxEndDate ? maxEndDate : e.target.value })} style={eqdbDateInputStyle(tokens, mode)}/>
          </EqdbFormField>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <EqdbFormField label="最小M">
            <OptionPicker value={minMag} options={EQDB_MIN_MAG_OPTIONS} onChange={v => patch({ minMag: v })}/>
          </EqdbFormField>
          <EqdbFormField label="最大震度">
            <OptionPicker value={maxInt} options={EQDB_MAX_INT_OPTIONS} onChange={v => patch({ maxInt: v })}/>
          </EqdbFormField>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <EqdbFormField label="並び順">
            <OptionPicker value={sort} options={EQDB_SORT_OPTIONS} onChange={v => patch({ sort: v })}/>
          </EqdbFormField>
          <EqdbFormField label="震源地名">
            <OptionPicker value={epicenterName} options={epicenterNameOptions} onChange={v => patch({ epicenterName: v })}/>
          </EqdbFormField>
        </div>

        <PressableButton
          onClick={handleSearch}
          disabled={isSearching}
          style={{
            marginTop: 1, padding: "8px 0", borderRadius: 10,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
            border: "1px solid rgba(10,132,255,0.9)",
            background: "#0A84FF", color: "#ffffff",
            fontSize: 14, fontWeight: 700,
            opacity: isSearching ? 0.5 : 1,
          }}
        >
          <SearchGlassIcon size={15}/>
          <span>{isSearching ? "検索中…" : "検索"}</span>
        </PressableButton>

        {status !== "" && (
          <div style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, textAlign: "center" }}>
            {status}
          </div>
        )}
      </div>

      {/* 検索結果一覧 — refは「検索」実行後にここまでスクロールするための目印 */}
      <div ref={resultsAnchorRef}/>
      {!hasSearched ? (
        <div style={{ padding: "18px 16px", textAlign: "center" }}>
          <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
            条件を指定して検索してください
          </span>
        </div>
      ) : results.length === 0 ? (
        !isSearching && (
          <div style={{ padding: "18px 16px", textAlign: "center" }}>
            <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
              該当する地震が見つかりませんでした
            </span>
          </div>
        )
      ) : (
        results.map((eq, i) => (
          <QuakeListRow
            key={eq.id}
            quake={eqdbListItemToPreview(eq)}
            showDivider={i > 0}
            colorScheme={colorScheme}
            onSelect={() => handleSelect(eq)}
            loading={loadingId === eq.id}
          />
        ))
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   QUAKE LIST TOOLBAR
   地震タブの一覧最上部（ハンドル直下）に固定表示するミニバー。
   ハイライトピルの動き(指の位置に連続追従するドラッグ、離した位置の
   タブへスナップ、押している間のスケール膨張)は、ボトムドック本体の
   ナビ行(NAVタブ)と全く同じロジックを2項目版として踏襲している。
   - リストボタン: 直近の地震一覧（既存のP2P地震情報フィード）を表示
   - 検索ボタン:   気象庁 震度データベースの検索UIに切り替える
   ───────────────────────────────────────────────────── */
const QUAKE_TOOLBAR_ITEMS = [
  { id: "recent", label: "地震一覧", icon: ListViewIcon },
  { id: "search", label: "地震検索", icon: SearchGlassIcon },
];

// 津波タブ版の切り替え項目。地震タブの「一覧⇄検索」と同じ考え方で、
// 直近一覧⇄過去の津波情報を切り替える(過去分は/history APIをoffsetで
// 遡って追加取得するTsunamiHistoryのモード)。
const TSUNAMI_TOOLBAR_ITEMS = [
  { id: "recent",    label: "津波情報",   icon: ListViewIcon },
  { id: "history",   label: "過去の津波", icon: HistoryClockIcon },
  { id: "tidegauge", label: "潮位計",     icon: TideGaugeIcon },
];

function QuakeListToolbar({ mode, onModeChange, onHandoffToPanelDrag, items = QUAKE_TOOLBAR_ITEMS }) {
  // このコンポーネント自身のpropに"mode"(表示モード: list/search)があるため、
  // ThemeContextの方はthemeModeという別名で受け取る。
  const { tokens, mode: themeMode } = useContext(ThemeContext);
  const { opaque: glassOpaque } = useContext(GlassOpaqueContext);

  // ナビ行と同じ %ベース連続追従方式。PAD_X はJSX側のpaddingと必ず一致させる。
  const PAD_X = 3;
  const rowRef      = useRef(null);
  const pointerId    = useRef(null);
  const moved        = useRef(false);
  const startX       = useRef(0);
  const startY       = useRef(0);
  const N     = items.length;
  const tabW  = 100 / N; // 1タブの幅[%]（内側領域基準）

  const activeIndex = items.findIndex(item => item.id === mode);
  const [highlightLeft, setHighlightLeft] = useState(activeIndex * tabW);
  const [dragging,      setDragging]      = useState(false);
  const [pressed,       setPressed]       = useState(false);
  const [previewIdx,    setPreviewIdx]    = useState(null);

  // mode が外部から変わった時（タップ以外の切替）にハイライトを追従させる
  useEffect(() => {
    if (!dragging) setHighlightLeft(activeIndex * tabW);
  }, [activeIndex, dragging, tabW]);

  function clientXToLeft(clientX) {
    const row = rowRef.current;
    if (!row) return activeIndex * tabW;
    const { left, width } = row.getBoundingClientRect();
    const innerLeft  = left + PAD_X;
    const innerWidth = width - PAD_X * 2;
    const ratio = Math.max(0, Math.min(1, (clientX - innerLeft) / innerWidth));
    return ratio * 100;
  }

  function clientXToIndex(clientX) {
    const pct = clientXToLeft(clientX);
    return Math.max(0, Math.min(N - 1, Math.round(pct / tabW - 0.5)));
  }

  function handlePointerDown(e) {
    pointerId.current = e.pointerId;
    moved.current      = false;
    startX.current     = e.clientX;
    startY.current     = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    const idx = clientXToIndex(e.clientX);
    setPreviewIdx(idx);
    setPressed(true);
    setHighlightLeft(idx * tabW);
  }

  function handlePointerMove(e) {
    if (pointerId.current !== e.pointerId) return;

    if (!moved.current) {
      const dx = e.clientX - startX.current;
      const dy = e.clientY - startY.current;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        moved.current = true;

        // 縦方向優位の動き = すぐ上にあるドラッグハンドルを掴もうとして
        // 指が少しずれてこのバーの上で始まってしまったケース。
        // このバーのトグル操作としては扱わず、パネル本体のリサイズドラッグへ
        // そのまま引き渡す(ハイライトは元の位置に戻して動かさない)。
        if (Math.abs(dy) > Math.abs(dx)) {
          setPressed(false);
          setPreviewIdx(null);
          setHighlightLeft(activeIndex * tabW);
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
          pointerId.current = null;
          onHandoffToPanelDrag?.(e);
          return;
        }

        setDragging(true);
      }
    }

    const idx = clientXToIndex(e.clientX);
    setPreviewIdx(idx);
    if (moved.current) {
      const raw = clientXToLeft(e.clientX) - tabW / 2;
      setHighlightLeft(Math.max(0, Math.min(100 - tabW, raw)));
    } else {
      setHighlightLeft(idx * tabW);
    }
  }

  function handlePointerUp(e) {
    if (pointerId.current !== e.pointerId) return;
    pointerId.current = null;
    const idx = clientXToIndex(e.clientX);
    setDragging(false);
    setPressed(false);
    setPreviewIdx(null);
    setHighlightLeft(idx * tabW);
    onModeChange(items[idx].id);
  }

  function handleClick(id) {
    if (moved.current) return; // ドラッグ完了後(縦方向への引き渡しを含む)の二重発火を防ぐ
    const idx = items.findIndex(item => item.id === id);
    setHighlightLeft(idx * tabW);
    onModeChange(id);
  }

  const displayIdx = dragging && previewIdx != null ? previewIdx : activeIndex;

  return (
    <div style={{ flexShrink: 0, padding: "2px 14px 8px" }}>
      <div
        ref={rowRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          position: "relative",
          display: "flex",
          height: 34,
          borderRadius: 999,
          background: `rgba(${tokens.ink},0.05)`,
          boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.14)`,
          padding: PAD_X,
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
          WebkitTouchCallout: "none",
          WebkitTapHighlightColor: "transparent",
        }}
      >
        {/* スライドするハイライトピル — ナビ行と同じ%ベースのleft/width計算 */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: PAD_X, bottom: PAD_X,
            left: `calc(${PAD_X}px + (100% - ${PAD_X * 2}px) * ${highlightLeft / 100})`,
            width: `calc((100% - ${PAD_X * 2}px) * ${tabW / 100})`,
            borderRadius: 999,
            background: (pressed || dragging) && !glassOpaque ? tokens.glassTint : tokens.navPillBg,
            boxShadow: (pressed || dragging) && !glassOpaque
              ? `inset 0 0 0 0.5px ${tokens.rimLight}, inset 0 1px 0 ${tokens.rimHighlight}`
              : tokens.navPillShadow,
            // タッチ/ドラッグ中だけ本物のガラス(backdrop-filter blur)にする。
            backdropFilter: (pressed || dragging) && !glassOpaque ? touchGlassBackdropFilter(themeMode) : "none",
            WebkitBackdropFilter: (pressed || dragging) && !glassOpaque ? touchGlassBackdropFilter(themeMode) : "none",
            transform: pressed ? "scale(1.16)" : "scale(1)",
            transformOrigin: "center",
            transition: dragging
              ? "transform 0.18s cubic-bezier(.22,1,.36,1)"
              : "left 0.38s cubic-bezier(.22,1,.36,1), transform 0.18s cubic-bezier(.22,1,.36,1)",
            pointerEvents: "none",
            zIndex: 0,
          }}
        />
        {items.map(({ id, label, icon: Icon }, idx) => {
          const isActive = idx === displayIdx;
          return (
            <button
              key={id}
              onClick={() => handleClick(id)}
              aria-label={label}
              style={{
                position: "relative", zIndex: 1, flex: 1,
                display: "flex", alignItems: "center", justifyContent: "center",
                border: "none", background: "transparent", borderRadius: 999,
                cursor: "pointer",
                color: isActive ? `rgba(${tokens.ink},1)` : `rgba(${tokens.ink},0.5)`,
                transition: "color 0.15s",
                touchAction: "none",
                userSelect: "none",
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <Icon size={16}/>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   SETTINGS TAB — 階層メニュー
   設定タブを開くとまずカテゴリ一覧(地震/津波/気象/警報/詳細設定)を表示し、
   カテゴリを選ぶとその中の項目一覧へ、項目を選ぶと実際の設定内容へ、と
   BottomDockパネルの中身をその場で差し替えながら掘り下げていく構成。
   現在地は親(BottomDock)がsettingsPath(配列)として持ち、このコンポーネントは
   それを受け取って該当する画面を描くだけの純粋な表示コンポーネントにしている。

   見た目は「地図レイヤー」一覧(フチなし全幅リスト+下線ヘッダー)をそのまま
   流用せず、震度配色ピッカーで元々使っていた「角丸のグループ化カード」を
   基本デザインとして統一している。
   ───────────────────────────────────────────────────── */
// 設定トップの一覧。「利用規約等・注意事項」(ライセンスもこの中に含む)は
// 詳細設定の下ではなくトップ階層に置く。
const SETTINGS_MENU = [
  { id: "tabSettings", label: "タブ設定" },
  { id: "terms",       label: "利用規約等・注意事項" },
  { id: "advanced",    label: "詳細設定" },
];

// 「タブ設定」配下の一覧。以前のSETTINGS_MENUそのもの。
// pathとしては ["tabSettings", "quake", ...] のように先頭にtabSettingsが付く形になる。
const TAB_SETTINGS_CATEGORIES = [
  { id: "quake",    label: "地震" },
  { id: "tsunami",  label: "津波" },
  { id: "weather",  label: "気象" },
  { id: "alert",    label: "警報" },
];

// カテゴリごとの項目一覧。地震・利用規約等の各カテゴリはSettingsBody内で専用に
// 組み立てるためここには含めない。他のカテゴリは現状すべて骨組み(空のプレースホルダー画面)。
const SETTINGS_ITEMS = {
  advanced: [
    { id: "appearance", label: "外観" },
    { id: "experimental", label: "実験的・テスト機能" },
    { id: "logs", label: "ログ" },
  ],
  weather: [
    { id: "nowcastColorScheme", label: "雨雲レーダー配色" },
    { id: "typhoonForecastInterval", label: "台風予報円の表示間隔" },
  ],
};

// 設定画面共通のヘッダー。「地図レイヤー」のような下線区切りは使わず、
// 太字の大きめタイトルにすることで独自の見た目にしている。
// 戻る操作は地震タブと同じ丸いフローティングボタン(BackToListButton)に
// 統一したので、ヘッダー自体には戻るボタンを持たせていない。
function SettingsHeader({ title }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <div style={{ padding: "12px 14px 6px" }}>
      <span style={{ fontSize: 16, fontWeight: 700, color: tokens.text }}>
        {title}
      </span>
    </div>
  );
}

// カテゴリ/項目一覧を包む角丸のグループ化カード。震度配色ピッカーと同じ見た目の箱。
function SettingsCard({ children }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <div style={{ margin: "6px 14px 8px" }}>
      <div style={{
        borderRadius: 12,
        overflow: "hidden",
        background: tokens.cardBg,
        boxShadow: `inset 0 0 0 0.5px ${tokens.cardBorder}`,
      }}>
        {children}
      </div>
    </div>
  );
}

function SettingsCardDivider() {
  const { tokens } = useContext(ThemeContext);
  return <div style={{ height: 0.5, background: tokens.divider, marginLeft: 12 }}/>;
}

// カード内の1行。右端に「>」を出して、掘り下げられることを示す。
function SettingsMenuRow({ label, onClick }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <PressableButton
      onClick={onClick}
      style={{
        width: "100%", display: "flex", alignItems: "center", gap: 10,
        padding: "12px 14px", background: "transparent", border: "none",
        cursor: "pointer", textAlign: "left",
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 600, color: tokens.text, flex: 1 }}>
        {label}
      </span>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
           stroke={tokens.textTertiary} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 6 15 12 9 18"/>
      </svg>
    </PressableButton>
  );
}

// カード内の1行(ON/OFF切り替え用)。SettingsMenuRowと同じ余白・見た目で、
// 右端は「>」の代わりに丸いスイッチ(Toggle)を出す。
function SettingsToggleRow({ label, description, checked, onChange, disabled = false }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <div style={{
      width: "100%", display: "flex", alignItems: "center", gap: 10,
      padding: "12px 14px",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: tokens.text }}>{label}</div>
        {description && (
          <div style={{ fontSize: 11, color: tokens.textSecondary, marginTop: 3, lineHeight: 1.4 }}>
            {description}
          </div>
        )}
      </div>
      <Toggle on={checked} onChange={onChange} disabled={disabled}/>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   TSUNAMI TEST BROADCAST PANEL — 実験的機能の1つ。
   実際のP2P地震情報とは完全に別のダミーデータ(isTest: true)を津波タブに
   一時的に流し込み、UIの動作確認(一覧・カード・地図の塗り分け・凡例・
   潮位観測点への警報反映など)ができるようにする。
   ───────────────────────────────────────────────────── */
const TEST_TSUNAMI_GRADE_OPTIONS = [
  { value: "MajorWarning", label: "大津波警報" },
  { value: "Warning",      label: "津波警報" },
  { value: "Watch",        label: "津波注意報" },
  { value: "NonEffective", label: "津波予報" },
];

// テスト配信で観測点の高さを選ぶ時のプルダウン候補(m)。0.2m(微弱ルールの境目)から
// 10.0mまで0.1m刻み。浮動小数の誤差が出ないよう、整数(0.1m単位)で回してから
// 10で割っている。
const TSUNAMI_HEIGHT_PICK_OPTIONS = Array.from({ length: 99 }, (_, i) => (i + 2) / 10);

// 実験的機能: 緊急地震速報テスト配信パネル。
// プリセット(通常/PLUM法/予報)をワンタップで発報できるほか、地震タブの
// カスタムEEWエディタ(index.html版)に相当する、震央地名・緯度経度・深さ・M・
// 最大震度・警報/PLUM法を自由に指定できるフォームも用意している。
// 複数のテストEEWを同時に発報でき、それぞれ独立して「続報」(報番号を1つ進める)・
// 「最終報」・「取消」・「削除」ができる。動作確認用のダミーデータはEewPanel・
// 地図上のP波S波円と震源マーカーに、実際のデータと同様に反映される。
// 深さ: 0〜600kmを10km刻み。マグニチュード: 3.5〜9.9を0.1刻み
// (浮動小数点の誤差を避けるため、10倍の整数で回してから/10する)。
const EEW_TEST_DEPTH_OPTIONS = Array.from({ length: 61 }, (_, i) => i * 10);
const EEW_TEST_MAGNITUDE_OPTIONS = Array.from({ length: 65 }, (_, i) => Math.round((3.5 + i * 0.1) * 10) / 10);

function EewTestBroadcastPanel({ testEews, onAction, eewTestForm, eewEpicenterPickActive }) {
  const { tokens } = useContext(ThemeContext);
  const f = eewTestForm;
  const isEditing = !!f.editingId;

  const inputStyle = {
    width: "100%", padding: "8px 10px", borderRadius: 8, border: "none",
    background: `rgba(${tokens.ink},0.08)`, color: tokens.text,
    fontSize: 13, fontWeight: 600, boxSizing: "border-box",
  };
  const labelStyle = {
    display: "block", fontSize: 11, fontWeight: 600,
    color: `rgba(${tokens.ink},0.5)`, marginBottom: 4,
  };
  function pillBtnStyle(color) {
    return {
      padding: "6px 12px", borderRadius: 999, border: `1px solid ${color}55`, cursor: "pointer",
      background: `${color}1F`, color, fontSize: 12, fontWeight: 700,
    };
  }

  function patchForm(patch) {
    onAction?.("patchForm", patch);
  }

  return (
    <>
      <div style={{ margin: "-4px 14px 10px", fontSize: 11, color: `rgba(${tokens.ink},0.45)`, lineHeight: 1.7 }}>
        実際の気象庁発表ではない、動作確認用のダミーデータです。複数を同時に発報して
        重なった時の見え方も確認できます。それぞれ個別に続報・最終報・取消・削除ができるほか、
        一覧の「編集」から続報の内容を書き換えて発報できます。各地域の予測震度はM・深さ・
        震源からの距離をもとにした減衰式で自動計算され、震度4以上の地域だけ地図に塗られます。
      </div>

      {/* カスタムEEWエディタ — 震源は地図タップで指定し(震央地名・緯度・経度は
          その結果として自動で入る)、深さ・M・警報/PLUM法だけ数値・選択肢で指定する。
          各地域の予測最大震度はM・深さ・震源距離による減衰式で発報時に自動計算するため、
          ここでの手動選択は無い。「編集」から呼ばれた場合はeditingIdが立ち、発報時に
          新規追加ではなく該当イベントへの続報として扱われる。 */}
      <div style={{ margin: "18px 14px 6px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: `rgba(${tokens.ink},0.7)` }}>
          カスタムEEWエディタ{isEditing ? "(続報を編集中)" : ""}
        </span>
        {isEditing && (
          <PressableButton
            type="button"
            onClick={() => onAction?.("resetForm")}
            style={{ padding: "4px 8px", border: "none", cursor: "pointer", background: "transparent", fontSize: 12, fontWeight: 700, color: `rgba(${tokens.ink},0.5)` }}
          >
            新規に戻す
          </PressableButton>
        )}
      </div>
      <SettingsCard>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label style={labelStyle}>震源</label>
            <PressableButton
              type="button"
              onClick={() => onAction?.(eewEpicenterPickActive ? "cancelEpicenterPick" : "startEpicenterPick")}
              style={{
                width: "100%", padding: "10px 12px", borderRadius: 8, border: "none", cursor: "pointer",
                textAlign: "left",
                background: eewEpicenterPickActive ? "rgba(255,69,58,0.18)" : `rgba(${tokens.ink},0.08)`,
                color: eewEpicenterPickActive ? "#FF453A" : tokens.text,
              }}
            >
              {eewEpicenterPickActive ? (
                <span style={{ fontSize: 13, fontWeight: 700 }}>地図をタップして震源を指定してください…</span>
              ) : (
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{f.place || "(震源未指定)"}</div>
                  <div style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, marginTop: 2 }}>
                    北緯{f.latitude?.toFixed?.(2) ?? "-.--"}° ・ 東経{f.longitude?.toFixed?.(2) ?? "-.--"}° ・ タップして地図で選び直す
                  </div>
                </div>
              )}
            </PressableButton>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label style={labelStyle}>深さ(km)</label>
              <select
                value={f.depth}
                onChange={e => patchForm({ depth: parseFloat(e.target.value) })}
                style={inputStyle}
              >
                {EEW_TEST_DEPTH_OPTIONS.map(d => (
                  <option key={d} value={d}>{d}km</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label style={labelStyle}>M(マグニチュード)</label>
              <select
                value={f.magnitude}
                onChange={e => patchForm({ magnitude: parseFloat(e.target.value) })}
                style={inputStyle}
              >
                {EEW_TEST_MAGNITUDE_OPTIONS.map(m => (
                  <option key={m} value={m}>{m.toFixed(1)}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 2 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: tokens.text, cursor: "pointer" }}>
              <input type="checkbox" checked={f.isPlum} onChange={e => patchForm({ isPlum: e.target.checked })} style={{ accentColor: "#BF5AF2" }}/>
              PLUM法
            </label>
          </div>
          <div style={{ fontSize: 11, color: `rgba(${tokens.ink},0.45)`, lineHeight: 1.6 }}>
            警報/予報は自動判定(最大震度5弱以上で警報)。一度警報になった後は、
            続報で震度が下がっても予報には戻りません。
          </div>
        </div>
        <SettingsCardDivider/>
        <PressableButton
          type="button"
          onClick={() => onAction?.("dispatchForm", {
            editingId: f.editingId,
            place: f.place || "テスト震源",
            latitude: typeof f.latitude === "number" && !Number.isNaN(f.latitude) ? f.latitude : 35.2,
            longitude: typeof f.longitude === "number" && !Number.isNaN(f.longitude) ? f.longitude : 139.3,
            depth: typeof f.depth === "number" && !Number.isNaN(f.depth) ? f.depth : 20,
            magnitude: typeof f.magnitude === "number" && !Number.isNaN(f.magnitude) ? f.magnitude : 5.0,
            isPlum: f.isPlum,
          })}
          style={{
            width: "100%", padding: "12px 14px", border: "none", cursor: "pointer",
            background: "transparent", textAlign: "center",
            fontSize: 14, fontWeight: 700, color: "#30D158",
          }}
        >
          {isEditing ? "このパラメータで続報を発報" : "このパラメータで追加発報"}
        </PressableButton>
      </SettingsCard>

      {/* 配信中のテストEEW一覧 — 複数同時発報にそれぞれ個別対応。「編集」で
          そのイベントの現在値をカスタムEEWエディタへ読み込み、続報の内容を書き換えられる。 */}
      {testEews.length > 0 && (
        <>
          <div style={{ margin: "18px 14px 6px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: `rgba(${tokens.ink},0.7)` }}>
              配信中のテストEEW({testEews.length}件)
            </span>
            <PressableButton
              type="button"
              onClick={() => onAction?.("clearAll")}
              style={{ padding: "4px 8px", border: "none", cursor: "pointer", background: "transparent", fontSize: 12, fontWeight: 700, color: "#FF453A" }}
            >
              全て削除
            </PressableButton>
          </div>
          <SettingsCard>
            {testEews.map((e, i) => (
              <Fragment key={e.id}>
                {i > 0 && <SettingsCardDivider/>}
                <div style={{
                  padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8,
                  background: f.editingId === e.id ? "rgba(48,209,88,0.08)" : undefined,
                }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: tokens.text }}>
                    {e.place} ・ 第{e.serial}報{e.isFinal ? "(最終)" : ""}{e.cancelled ? "(取消)" : ""}
                  </div>
                  <div style={{ fontSize: 11, color: `rgba(${tokens.ink},0.5)` }}>
                    最大震度{INTENSITY_LABEL[e.maxIntensityKey] ?? "?"} ・ M{e.magnitude?.toFixed?.(1) ?? "-.-"} ・
                    {e.isWarnLevel === false ? "予報" : "警報"}{e.isPlum ? "・PLUM法" : ""}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {!e.cancelled && (
                      <>
                        <PressableButton type="button" onClick={() => onAction?.("editLoad", { id: e.id })} style={pillBtnStyle("#30D158")}>編集して続報</PressableButton>
                        <PressableButton type="button" onClick={() => onAction?.("update", { id: e.id })} style={pillBtnStyle("#0A84FF")}>続報</PressableButton>
                        <PressableButton type="button" onClick={() => onAction?.("finalize", { id: e.id })} style={pillBtnStyle("#FF9F0A")}>最終報</PressableButton>
                        <PressableButton type="button" onClick={() => onAction?.("cancel", { id: e.id })} style={pillBtnStyle("#FF453A")}>取消</PressableButton>
                      </>
                    )}
                    <PressableButton type="button" onClick={() => onAction?.("remove", { id: e.id })} style={pillBtnStyle(`rgba(${tokens.ink},0.55)`)}>削除</PressableButton>
                  </div>
                </div>
              </Fragment>
            ))}
          </SettingsCard>
        </>
      )}
    </>
  );
}

// 地震情報テスト配信専用: 確定報(③)で使う津波判定の選択肢。調査中(Checking)は
// ①②で自動的に使われるため、③で手動選択する対象からは外している。
const QUAKE_TEST_TSUNAMI_OPTIONS = [
  { value: "None", label: "心配なし" },
  { value: "NonEffective", label: "若干の海面変動" },
  { value: "Watch", label: "津波注意報等" },
  { value: "Warning", label: "津波警報等" },
  { value: "MajorWarning", label: "大津波警報等" },
];

function QuakeTestBroadcastPanel({ testQuake, onAction, quakeTestForm, quakeEpicenterPickActive, quakeTestAutoPlaying }) {
  const { tokens } = useContext(ThemeContext);
  const f = quakeTestForm;

  const inputStyle = {
    width: "100%", padding: "8px 10px", borderRadius: 8, border: "none",
    background: `rgba(${tokens.ink},0.08)`, color: tokens.text,
    fontSize: 13, fontWeight: 600, boxSizing: "border-box",
  };
  const labelStyle = {
    display: "block", fontSize: 11, fontWeight: 600,
    color: `rgba(${tokens.ink},0.5)`, marginBottom: 4,
  };
  function stageBtnStyle(color, disabled) {
    return {
      flex: 1, padding: "10px 8px", borderRadius: 10, border: "none", cursor: disabled ? "default" : "pointer",
      background: `${color}1F`, color, fontSize: 12, fontWeight: 700, textAlign: "center",
      opacity: disabled ? 0.4 : 1,
    };
  }
  function patchForm(patch) {
    onAction?.("patchForm", patch);
  }

  const disabled = !!quakeTestAutoPlaying;

  return (
    <>
      <div style={{ margin: "-4px 14px 10px", fontSize: 11, color: `rgba(${tokens.ink},0.45)`, lineHeight: 1.7 }}>
        実際の気象庁発表ではない、動作確認用のダミーデータです。①震度速報→②震源に関する情報→
        ③震度に関する情報、と実際の発表段階を再現して個別に配信できるほか、まとめて自動再生も
        できます。①②の震度分布はM・深さ・震源からの距離による減衰式で自動計算されます
        (簡略化のため、実際の観測点単位ではなく細分区域単位で生成しています)。
        「配信を削除」で元に戻ります。
      </div>

      <div style={{ margin: "18px 14px 6px" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: `rgba(${tokens.ink},0.7)` }}>
          震源(②③で使用。①は震源不明のまま配信されます)
        </span>
      </div>
      <SettingsCard>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label style={labelStyle}>震源</label>
            <PressableButton
              type="button"
              onClick={() => onAction?.(quakeEpicenterPickActive ? "cancelEpicenterPick" : "startEpicenterPick")}
              disabled={disabled}
              style={{
                width: "100%", padding: "10px 12px", borderRadius: 8, border: "none", cursor: disabled ? "default" : "pointer",
                textAlign: "left",
                background: quakeEpicenterPickActive ? "rgba(255,69,58,0.18)" : `rgba(${tokens.ink},0.08)`,
                color: quakeEpicenterPickActive ? "#FF453A" : tokens.text,
                opacity: disabled ? 0.5 : 1,
              }}
            >
              {quakeEpicenterPickActive ? (
                <span style={{ fontSize: 13, fontWeight: 700 }}>地図をタップして震源を指定してください…</span>
              ) : (
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{f.place || "(震源未指定)"}</div>
                  <div style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, marginTop: 2 }}>
                    北緯{f.latitude?.toFixed?.(2) ?? "-.--"}° ・ 東経{f.longitude?.toFixed?.(2) ?? "-.--"}° ・ タップして地図で選び直す
                  </div>
                </div>
              )}
            </PressableButton>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label style={labelStyle}>深さ(km)</label>
              <select
                value={f.depth}
                onChange={e => patchForm({ depth: parseFloat(e.target.value) })}
                disabled={disabled}
                style={inputStyle}
              >
                {EEW_TEST_DEPTH_OPTIONS.map(d => (
                  <option key={d} value={d}>{d}km</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label style={labelStyle}>M(マグニチュード)</label>
              <select
                value={f.magnitude}
                onChange={e => patchForm({ magnitude: parseFloat(e.target.value) })}
                disabled={disabled}
                style={inputStyle}
              >
                {EEW_TEST_MAGNITUDE_OPTIONS.map(m => (
                  <option key={m} value={m}>{m.toFixed(1)}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label style={labelStyle}>津波判定(③確定報で使用)</label>
            <select
              value={f.domesticTsunami}
              onChange={e => patchForm({ domesticTsunami: e.target.value })}
              disabled={disabled}
              style={inputStyle}
            >
              {QUAKE_TEST_TSUNAMI_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div style={{ fontSize: 11, color: `rgba(${tokens.ink},0.45)`, lineHeight: 1.6 }}>
            ①②は津波「調査中」で固定配信されます(実際の電文と同じ挙動)。③でここの判定に切り替わります。
          </div>
        </div>
      </SettingsCard>

      <div style={{ margin: "18px 14px 6px" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: `rgba(${tokens.ink},0.7)` }}>
          段階を配信
        </span>
      </div>
      <SettingsCard>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <PressableButton type="button" onClick={() => onAction?.("broadcastStage", { stage: "prompt" })} disabled={disabled} style={stageBtnStyle("#FF9F0A", disabled)}>
              ① 震度速報
            </PressableButton>
            <PressableButton type="button" onClick={() => onAction?.("broadcastStage", { stage: "destination" })} disabled={disabled} style={stageBtnStyle("#0A84FF", disabled)}>
              ② 震源情報
            </PressableButton>
            <PressableButton type="button" onClick={() => onAction?.("broadcastStage", { stage: "detail" })} disabled={disabled} style={stageBtnStyle("#30D158", disabled)}>
              ③ 確定
            </PressableButton>
          </div>
          <PressableButton
            type="button"
            onClick={() => onAction?.("autoPlaySequence")}
            disabled={disabled}
            style={{
              width: "100%", padding: "10px 14px", borderRadius: 10, border: "none",
              cursor: disabled ? "default" : "pointer",
              background: "rgba(191,90,242,0.16)", color: "#BF5AF2",
              fontSize: 13, fontWeight: 700, textAlign: "center",
              opacity: disabled ? 0.6 : 1,
            }}
          >
            {quakeTestAutoPlaying ? "自動配信中…(①→②→③を3秒間隔で配信しています)" : "①→②→③を自動配信(新規)"}
          </PressableButton>
          <div style={{ fontSize: 11, color: `rgba(${tokens.ink},0.45)`, lineHeight: 1.6 }}>
            ①②③は好きな順番・組み合わせで押せます(実際の電文の届く順序が前後することがあるため)。
            同じテスト地震への続報として、これまでの配信内容と自動的に統合されます
            (震源は分かっている方を、震度分布はより詳しい方を優先)。新しい地震として最初からやり直すには
            「配信を削除」を押してください。
          </div>
        </div>
      </SettingsCard>

      <SettingsCard>
        <PressableButton
          type="button"
          onClick={() => onAction?.("clearAll")}
          style={{
            width: "100%", padding: "12px 14px", border: "none", cursor: "pointer",
            background: "transparent", textAlign: "center",
            fontSize: 14, fontWeight: 600, color: `rgba(${tokens.ink},0.45)`,
          }}
        >
          配信を削除(片付ける)
        </PressableButton>
      </SettingsCard>

      {testQuake && (
        <div style={{ margin: "6px 14px 10px", fontSize: 11, color: `rgba(${tokens.ink},0.5)`, lineHeight: 1.7 }}>
          現在の配信状況: {QUAKE_STAGE_LABEL[testQuake.stage] || "確定"}
          ・{testQuake.place}・最大震度{testQuake.maxIntensity === "?" ? "不明" : testQuake.maxIntensity}
        </div>
      )}
    </>
  );
}

function TsunamiTestBroadcastPanel({
  testTsunami, onBroadcast, onCancel, onClear,
  tsunamiAreaPickActive, onStartAreaPick, pickedAreas = [], onRemoveAreaPick, onCycleAreaGrade,
  pickedHeights = [], onChangeHeightPick, onRemoveHeightPick,
  candidateHeightStations = [], onAddHeightPick,
}) {
  const { tokens } = useContext(ThemeContext);
  // 追加先の候補: すでに選択済みの観測点は除いておく(二重追加を防ぐ)。
  const availableCandidates = candidateHeightStations.filter(
    st => !pickedHeights.some(h => h.code === st.code)
  );

  return (
    <>
      <div style={{ margin: "-4px 14px 10px", fontSize: 11, color: `rgba(${tokens.ink},0.45)`, lineHeight: 1.7 }}>
        実際の気象庁発表ではない、動作確認用のダミーデータです。津波タブの一覧・カード・地図の塗り分け・
        潮位観測点への反映などが、このデータを使って表示されます。「配信を削除」で元に戻ります。
      </div>

      <SettingsCard>
        <div style={{ padding: "12px 14px 4px", fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.5)` }}>
          予報区とグレード(複数選択可・予報区ごとに別グレードも可)
        </div>
        <div style={{ padding: "0 14px 12px" }}>
          {pickedAreas.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {pickedAreas.map(({ name, grade }) => {
                const color = tsunamiGradeInfo(grade).color;
                return (
                  <div key={name} style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    padding: "6px 6px 6px 6px", borderRadius: 999,
                    background: `${color}26`, // 選択中グレードの色を薄く敷いて、配信時の色を予感させる
                  }}>
                    <PressableButton
                      type="button"
                      onClick={() => onCycleAreaGrade?.(name)}
                      aria-label={`${name}のグレードを変更(現在: ${tsunamiGradeInfo(grade).label})`}
                      style={{
                        display: "flex", alignItems: "center", gap: 6,
                        padding: "3px 8px 3px 10px", borderRadius: 999, border: "none", cursor: "pointer",
                        background: "transparent",
                      }}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: 999, background: color, flexShrink: 0 }}/>
                      <span style={{ fontSize: 13, fontWeight: 600, color: tokens.text }}>{name}</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color }}>{tsunamiGradeInfo(grade).label}</span>
                    </PressableButton>
                    <PressableButton
                      type="button"
                      onClick={() => onRemoveAreaPick?.(name)}
                      aria-label={`${name}を選択解除`}
                      style={{
                        width: 20, height: 20, borderRadius: 999, border: "none", cursor: "pointer",
                        background: `rgba(${tokens.ink},0.1)`, display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 12, fontWeight: 700, color: `rgba(${tokens.ink},0.6)`, lineHeight: 1, flexShrink: 0,
                      }}
                    >
                      ×
                    </PressableButton>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)`, marginBottom: 10 }}>
              まだ予報区が選ばれていません
            </div>
          )}
          <PressableButton
            type="button"
            onClick={() => onStartAreaPick?.()}
            style={{
              width: "100%", padding: "10px 14px", borderRadius: 10, border: "none", cursor: "pointer",
              background: tsunamiAreaPickActive ? "#FF9F0A" : "rgba(10,132,255,0.14)",
              fontSize: 13, fontWeight: 700, textAlign: "center",
              color: tsunamiAreaPickActive ? "#fff" : "#0A84FF",
            }}
          >
            {tsunamiAreaPickActive ? "地図で選択中…" : "地図で選択"}
          </PressableButton>
        </div>
        <div style={{ margin: "-6px 14px 12px", fontSize: 11, color: `rgba(${tokens.ink},0.4)`, lineHeight: 1.6 }}>
          「地図で選択」を押すと地図が全画面に表示され、パレットで選んだグレードを海岸線タップで割り当てられます。
          選択済みの予報区名をタップすると、地図に戻らずグレードだけ変更できます。
        </div>
      </SettingsCard>

      <SettingsCard>
        <div style={{ padding: "12px 14px 4px", fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.5)` }}>
          観測点ごとの津波の高さ(テスト用・任意)
        </div>
        <div style={{ padding: "0 14px 12px" }}>
          {pickedHeights.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
              {pickedHeights.map(({ code, name, heightM }) => (
                <div key={code} style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "6px 6px 6px 12px", borderRadius: 10,
                  background: `rgba(${tokens.ink},0.045)`,
                }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: tokens.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {name}
                  </span>
                  <select
                    value={heightM}
                    onChange={e => onChangeHeightPick?.(code, parseFloat(e.target.value))}
                    style={{
                      padding: "6px 8px", borderRadius: 8, border: "none",
                      background: `rgba(${tokens.ink},0.08)`, color: tokens.text,
                      fontSize: 13, fontWeight: 600,
                    }}
                  >
                    {TSUNAMI_HEIGHT_PICK_OPTIONS.map(v => (
                      <option key={v} value={v}>{v.toFixed(1)}m</option>
                    ))}
                  </select>
                  <PressableButton
                    type="button"
                    onClick={() => onRemoveHeightPick?.(code)}
                    aria-label={`${name}の高さ設定を解除`}
                    style={{
                      width: 20, height: 20, borderRadius: 999, border: "none", cursor: "pointer",
                      background: `rgba(${tokens.ink},0.1)`, display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 12, fontWeight: 700, color: `rgba(${tokens.ink},0.6)`, lineHeight: 1, flexShrink: 0,
                    }}
                  >
                    ×
                  </PressableButton>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)`, marginBottom: 10 }}>
              まだ観測点が選ばれていません(未設定の間は、実際の潮位データから自動計算されます)
            </div>
          )}
          {pickedAreas.length === 0 ? (
            <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
              先に予報区を選ぶと、その予報区に属する観測点をここから選べるようになります
            </div>
          ) : availableCandidates.length === 0 ? (
            <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
              選択中の予報区に属する観測点は、もうすべて追加済みです
            </div>
          ) : (
            <select
              value=""
              onChange={e => { if (e.target.value) onAddHeightPick?.(e.target.value); }}
              style={{
                width: "100%", padding: "10px 12px", borderRadius: 10, border: "none", cursor: "pointer",
                background: "rgba(10,132,255,0.14)", color: "#0A84FF",
                fontSize: 13, fontWeight: 700,
              }}
            >
              <option value="">+ 観測点を追加…</option>
              {availableCandidates.map(st => (
                <option key={st.code} value={st.code}>{st.name}({st.tsunamiAreaName})</option>
              ))}
            </select>
          )}
        </div>
        <div style={{ margin: "-6px 14px 12px", fontSize: 11, color: `rgba(${tokens.ink},0.4)`, lineHeight: 1.6 }}>
          上の予報区に実際に属する観測点だけが候補に出ます。±0.2m未満は微弱として扱われ、
          実際の表示と同様バーは出ません。
        </div>
      </SettingsCard>

      <SettingsCard>
        <PressableButton
          type="button"
          onClick={() => onBroadcast?.({ areas: pickedAreas, heightOverrides: pickedHeights })}
          style={{
            width: "100%", padding: "12px 14px", border: "none", cursor: "pointer",
            background: "transparent", textAlign: "center",
            fontSize: 14, fontWeight: 700, color: "#FF453A",
          }}
        >
          テスト配信する
        </PressableButton>
        {testTsunami && !testTsunami.cancelled && (
          <>
            <SettingsCardDivider/>
            <PressableButton
              type="button"
              onClick={onCancel}
              style={{
                width: "100%", padding: "12px 14px", border: "none", cursor: "pointer",
                background: "transparent", textAlign: "center",
                fontSize: 14, fontWeight: 600, color: `rgba(${tokens.ink},0.7)`,
              }}
            >
              解除を配信する
            </PressableButton>
          </>
        )}
        {testTsunami && (
          <>
            <SettingsCardDivider/>
            <PressableButton
              type="button"
              onClick={onClear}
              style={{
                width: "100%", padding: "12px 14px", border: "none", cursor: "pointer",
                background: "transparent", textAlign: "center",
                fontSize: 14, fontWeight: 600, color: `rgba(${tokens.ink},0.45)`,
              }}
            >
              配信を削除(片付ける)
            </PressableButton>
          </>
        )}
      </SettingsCard>

      {testTsunami && (
        <div style={{ margin: "6px 14px 10px", fontSize: 11, color: `rgba(${tokens.ink},0.5)`, lineHeight: 1.7 }}>
          現在の配信状況: {testTsunami.cancelled ? "解除済み" : tsunamiGradeInfo(testTsunami.maxGrade).label}
          ({testTsunami.areas?.[0]?.name})・{testTsunami.time}
        </div>
      )}
    </>
  );
}


// 地震一覧の取得件数の設定画面。スライダー(左右に動かして数値を決める) + よく使う件数のプリセットチップ。
// 以前は数値入力欄だったが、タップした瞬間にiOS側でページ全体がズームされてしまうため、
// テキスト入力を使わずスライダーだけで完結するようにしている。
function QuakeFetchLimitSettings({ value, onChange }) {
  const { tokens } = useContext(ThemeContext);

  const presets = [50, 100, 300, 500, 1000];

  return (
    <SettingsCard>
      <div style={{ padding: "14px 14px 12px" }}>
        <div style={{ fontSize: 11, color: `rgba(${tokens.ink},0.4)`, marginBottom: 12, lineHeight: 1.5 }}>
          地震一覧を取得する最大件数です。{QUAKE_FETCH_LIMIT_MIN}〜{QUAKE_FETCH_LIMIT_MAX}件の範囲で指定できます
          (デフォルト{QUAKE_FETCH_LIMIT_DEFAULT}件)。100件を超える件数を指定すると複数回に分けて取得するため、
          件数が多いほど取得に時間がかかります。また、直近1週間より前の情報は取得できない仕様のため、
          地震の少ない期間は指定した件数に満たないことがあります。
        </div>

        <div style={{ textAlign: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 30, fontWeight: 800, color: tokens.text }}>{value}</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: `rgba(${tokens.ink},0.5)`, marginLeft: 4 }}>件</span>
        </div>

        <input
          type="range"
          min={QUAKE_FETCH_LIMIT_MIN}
          max={QUAKE_FETCH_LIMIT_MAX}
          step={1}
          value={value}
          onChange={e => onChange(clampQuakeFetchLimit(e.target.value))}
          style={{
            width: "100%", height: 28,
            accentColor: "#0A84FF",
            touchAction: "none",
          }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
          <span style={{ fontSize: 10, color: `rgba(${tokens.ink},0.35)` }}>{QUAKE_FETCH_LIMIT_MIN}</span>
          <span style={{ fontSize: 10, color: `rgba(${tokens.ink},0.35)` }}>{QUAKE_FETCH_LIMIT_MAX}</span>
        </div>
      </div>
      <SettingsCardDivider/>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "12px 14px" }}>
        {presets.map(p => (
          <PressableButton
            key={p}
            onClick={() => onChange(p)}
            style={{
              padding: "6px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600,
              border: `1px solid rgba(${tokens.ink},0.16)`,
              background: value === p ? "rgba(10,132,255,0.9)" : `rgba(${tokens.ink},0.08)`,
              color: tokens.text, cursor: "pointer",
            }}
          >
            {p}件
          </PressableButton>
        ))}
      </div>
    </SettingsCard>
  );
}

// 震度配色の選択画面。元のQuakeSettingsBodyと同じ見た目のリスト。
function QuakeColorSchemeSettings({ colorSchemeId, onChangeColorScheme }) {
  const { tokens } = useContext(ThemeContext);

  const entries = Object.entries(QUAKE_COLOR_SCHEMES);
  return (
    <SettingsCard>
      {entries.map(([id, scheme], i) => {
        const selected = colorSchemeId === id;
        return (
          <div key={id}>
            {i > 0 && <SettingsCardDivider/>}
            <PressableButton
              onClick={() => onChangeColorScheme(id)}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 12,
                padding: "11px 12px",
                background: selected ? `rgba(${tokens.ink},0.07)` : "transparent",
                border: "none", cursor: "pointer", textAlign: "left",
              }}
            >
              {/* ミニプレビュー(震度1〜7の色見本を並べる) */}
              <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                {["1","2","3","4","5-","5+","6-","6+","7"].map(key => (
                  <div key={key} style={{
                    width: 7, height: 16, borderRadius: 2,
                    background: scheme.colors[key].bg,
                  }}/>
                ))}
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: tokens.text, flex: 1 }}>
                {scheme.label}
              </span>
              {selected && (
                <span style={{ fontSize: 13, color: `rgba(${tokens.ink},0.85)` }}>✓</span>
              )}
            </PressableButton>
          </div>
        );
      })}
    </SettingsCard>
  );
}

// 雨雲レーダー配色の一覧選択画面(震度配色ピッカーと全く同じ見た目・作り)。
function NowcastColorSchemeSettings({ colorSchemeId, onChangeColorScheme }) {
  const { tokens } = useContext(ThemeContext);

  const entries = Object.entries(NOWCAST_COLOR_SCHEMES);
  return (
    <SettingsCard>
      {entries.map(([id, scheme], i) => {
        const selected = colorSchemeId === id;
        const previewColors = scheme.palette || JMA_NOWCAST_SOURCE_PALETTE;
        return (
          <div key={id}>
            {i > 0 && <SettingsCardDivider/>}
            <PressableButton
              onClick={() => onChangeColorScheme(id)}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 12,
                padding: "11px 12px",
                background: selected ? `rgba(${tokens.ink},0.07)` : "transparent",
                border: "none", cursor: "pointer", textAlign: "left",
              }}
            >
              {/* ミニプレビュー(弱い雨→猛烈な雨の色見本を並べる) */}
              <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                {previewColors.map((rgb, ci) => (
                  <div key={ci} style={{
                    width: 7, height: 16, borderRadius: 2,
                    background: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`,
                  }}/>
                ))}
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: tokens.text, flex: 1 }}>
                {scheme.label}
              </span>
              {selected && (
                <span style={{ fontSize: 13, color: `rgba(${tokens.ink},0.85)` }}>✓</span>
              )}
            </PressableButton>
          </div>
        );
      })}
    </SettingsCard>
  );
}

// 台風予報円の表示間隔(3/6/12/24時間ごと)の選択画面。台風接近時、気象庁は
// 3時間ごとに予報を出すため、全部表示すると予報円が密集して見づらくなる。
// 「現在から○時間ごと」の予報円だけを間引いて表示するための設定で、初期値は12時間。
const TYPHOON_FORECAST_INTERVAL_OPTIONS = [
  { hours: 3,  label: "3時間ごと" },
  { hours: 6,  label: "6時間ごと" },
  { hours: 12, label: "12時間ごと" },
  { hours: 24, label: "24時間ごと" },
];

function TyphoonForecastIntervalSettings({ intervalHours, onChangeIntervalHours }) {
  const { tokens } = useContext(ThemeContext);

  return (
    <SettingsCard>
      {TYPHOON_FORECAST_INTERVAL_OPTIONS.map((opt, i) => {
        const selected = intervalHours === opt.hours;
        return (
          <div key={opt.hours}>
            {i > 0 && <SettingsCardDivider/>}
            <PressableButton
              onClick={() => onChangeIntervalHours(opt.hours)}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 12,
                padding: "11px 12px",
                background: selected ? `rgba(${tokens.ink},0.07)` : "transparent",
                border: "none", cursor: "pointer", textAlign: "left",
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: tokens.text, flex: 1 }}>
                {opt.label}
              </span>
              {selected && (
                <span style={{ fontSize: 13, color: `rgba(${tokens.ink},0.85)` }}>✓</span>
              )}
            </PressableButton>
          </div>
        );
      })}
    </SettingsCard>
  );
}


// 下にプレビュー用のサンプルデータを添えて、選んだ表示方法がどう見えるかその場で分かるようにする。
const STATION_DISPLAY_PREVIEW_SAMPLE = [
  { pref: "東京都",   city: "千代田区", addr: "千代田区大手町", intensityKey: "3" },
  { pref: "神奈川県", city: "横浜市",   addr: "横浜市中区山下町", intensityKey: "3" },
];

function StationListDisplayModePreview({ mode }) {
  const { tokens } = useContext(ThemeContext);

  const schemeId = useContext(QuakeColorSchemeContext);
  const scheme = QUAKE_COLOR_SCHEMES[schemeId] || QUAKE_COLOR_SCHEMES.fill;
  const sorted = [...STATION_DISPLAY_PREVIEW_SAMPLE].sort(
    (a, b) => INTENSITY_ORDER.indexOf(b.intensityKey) - INTENSITY_ORDER.indexOf(a.intensityKey)
  );

  return (
    <div style={{ margin: "18px 14px 2px" }}>
      <div style={{ padding: "0 2px 6px", fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.5)` }}>
        プレビュー
      </div>
      <div style={{
        borderRadius: 12, overflow: "hidden",
        background: `rgba(${tokens.ink},0.04)`,
        boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
        pointerEvents: "none", // プレビューはあくまで見本。タップでの開閉はさせない
      }}>
        {mode === "grouped" ? (
          (() => {
            const map = new Map();
            for (const p of sorted) {
              if (!map.has(p.intensityKey)) map.set(p.intensityKey, []);
              map.get(p.intensityKey).push(p);
            }
            return [...map.entries()].map(([key, groupPoints], gi) => {
              const style = getIntensityStyleFromScheme(scheme, key);
              const prefs = [...new Set(groupPoints.map(p => p.pref))];
              return (
                <div key={key}>
                  {gi > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)` }}/>}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px" }}>
                    <span style={{
                      flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
                      background: style.bg, color: style.fg,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 11, fontWeight: 800,
                    }}>
                      {style.label}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: tokens.text }}>震度{style.label}</div>
                      <div style={{ fontSize: 13, color: `rgba(${tokens.ink},0.65)`, marginTop: 3, lineHeight: 1.6 }}>
                        {prefs.map((pref, pi) => (
                          <span key={pref} style={{ whiteSpace: "nowrap" }}>
                            {pref}{pi < prefs.length - 1 ? "、" : ""}
                          </span>
                        ))}
                      </div>
                    </div>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                         stroke={`rgba(${tokens.ink},0.3)`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 6 15 12 9 18"/>
                    </svg>
                  </div>
                </div>
              );
            });
          })()
        ) : (
          sorted.map((p, i) => {
            const style = getIntensityStyleFromScheme(scheme, p.intensityKey);
            return (
              <div key={`${p.pref}-${p.addr}-${i}`}>
                {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)`, marginLeft: 12 }}/>}
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px" }}>
                  <span style={{
                    flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
                    background: style.bg, color: style.fg,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontWeight: 800,
                  }}>
                    {style.label}
                  </span>
                  <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.4)`, flexShrink: 0 }}>
                    {p.pref}
                  </span>
                  <span style={{
                    flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: tokens.text,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {p.addr}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function StationListDisplayModeSettings({ value, onChange }) {
  const { tokens } = useContext(ThemeContext);

  const entries = Object.entries(STATION_LIST_DISPLAY_MODES);
  return (
    <>
      <SettingsCard>
        {entries.map(([id, mode], i) => {
          const selected = value === id;
          return (
            <div key={id}>
              {i > 0 && <SettingsCardDivider/>}
              <PressableButton
                onClick={() => onChange(id)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 12,
                  padding: "11px 12px",
                  background: selected ? `rgba(${tokens.ink},0.07)` : "transparent",
                  border: "none", cursor: "pointer", textAlign: "left",
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: tokens.text, flex: 1 }}>
                  {mode.label}
                </span>
                {selected && (
                  <span style={{ fontSize: 13, color: `rgba(${tokens.ink},0.85)` }}>✓</span>
                )}
              </PressableButton>
            </div>
          );
        })}
      </SettingsCard>
      <StationListDisplayModePreview mode={value}/>
    </>
  );
}

// 「詳細設定」→「ログ」の中身。useDebugLog()で購読しているリングバッファを
// そのまま新しい順に一覧表示する。実機で不具合を再現した直後にこの画面を開けば、
// PCの開発者ツールに繋がなくてもconsole.log/warn/error(および未捕捉の例外)の
// 内容をその場で確認・全文コピーできる。
const LOG_LEVEL_FILTERS = [
  { id: "all",   label: "すべて" },
  { id: "error", label: "error" },
  { id: "warn",  label: "warn" },
  { id: "log",   label: "log/info" },
];

function logLevelColor(level, tokens) {
  if (level === "error") return "#FF6B6B";
  if (level === "warn") return "#FFD60A";
  return `rgba(${tokens.ink},0.75)`;
}

function formatDebugLogTime(date) {
  // 秒未満まで見えないと、短時間に連続するログの前後関係が分かりにくいため、
  // ミリ秒3桁まで表示する(toLocaleTimeStringにはミリ秒オプションが無いため手組み)。
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function LogViewerPanel() {
  const { tokens } = useContext(ThemeContext);
  const logs = useDebugLog();
  const [levelFilter, setLevelFilter] = useState("all");
  const [copyState, setCopyState] = useState("idle"); // idle | copied | failed

  const filtered = levelFilter === "all"
    ? logs
    : levelFilter === "log"
      ? logs.filter(l => l.level === "log" || l.level === "info")
      : logs.filter(l => l.level === levelFilter);

  // 新しいログを上にする(直近の再現手順を追うのに読みやすいため)。
  const displayed = filtered.slice().reverse();

  async function handleCopy() {
    const text = filtered
      .map(l => `[${formatDebugLogTime(l.time)}] ${l.level.toUpperCase()}: ${l.text}`)
      .join("\n");
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // クリップボードAPIが使えない環境(非HTTPS等)向けのフォールバック。
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    setTimeout(() => setCopyState("idle"), 2000);
  }

  return (
    <>
      <div style={{ margin: "0 14px 8px", fontSize: 11, color: `rgba(${tokens.ink},0.4)`, lineHeight: 1.5 }}>
        console.log/info/warn/errorの出力(および未捕捉のエラー)を、直近{DEBUG_LOG_MAX}件までこの画面から確認できます。
        アプリを再読み込みすると消去されます。
      </div>

      <div style={{ margin: "0 14px 8px", display: "flex", flexWrap: "wrap", gap: 6 }}>
        {LOG_LEVEL_FILTERS.map(f => (
          <PressableButton
            key={f.id}
            onClick={() => setLevelFilter(f.id)}
            style={{
              padding: "5px 11px", borderRadius: 999, fontSize: 11, fontWeight: 600,
              border: `1px solid rgba(${tokens.ink},0.16)`,
              background: levelFilter === f.id ? "rgba(10,132,255,0.9)" : `rgba(${tokens.ink},0.08)`,
              color: levelFilter === f.id ? "#fff" : tokens.text,
              cursor: "pointer",
            }}
          >
            {f.label}
          </PressableButton>
        ))}
      </div>

      <div style={{ margin: "0 14px 10px", display: "flex", gap: 8 }}>
        <PressableButton
          onClick={handleCopy}
          disabled={filtered.length === 0}
          style={{
            flex: 1, padding: "9px 12px", borderRadius: 10, fontSize: 12, fontWeight: 700,
            border: "none", cursor: filtered.length === 0 ? "default" : "pointer",
            background: `rgba(${tokens.ink},0.08)`, color: tokens.text,
            opacity: filtered.length === 0 ? 0.4 : 1,
          }}
        >
          {copyState === "copied" ? "コピーしました" : copyState === "failed" ? "コピーに失敗しました" : "表示中のログを全文コピー"}
        </PressableButton>
        <PressableButton
          onClick={() => clearDebugLog()}
          style={{
            padding: "9px 14px", borderRadius: 10, fontSize: 12, fontWeight: 700,
            border: "none", cursor: "pointer",
            background: "rgba(255,69,58,0.16)", color: "#FF6B6B",
          }}
        >
          クリア
        </PressableButton>
      </div>

      <SettingsCard>
        {displayed.length === 0 ? (
          <div style={{ padding: "28px 18px", textAlign: "center", fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
            ログはまだありません
          </div>
        ) : (
          displayed.map((entry, i) => (
            <div key={entry.id}>
              {i > 0 && <SettingsCardDivider/>}
              <div style={{ padding: "8px 12px" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 2 }}>
                  <span style={{ fontSize: 10, fontFamily: "monospace", color: `rgba(${tokens.ink},0.4)` }}>
                    {formatDebugLogTime(entry.time)}
                  </span>
                  <span style={{ fontSize: 10, fontWeight: 800, color: logLevelColor(entry.level, tokens) }}>
                    {entry.level.toUpperCase()}
                  </span>
                </div>
                <div style={{
                  fontSize: 11.5, fontFamily: "monospace", color: tokens.text,
                  whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.5,
                }}>
                  {entry.text}
                </div>
              </div>
            </div>
          ))
        )}
      </SettingsCard>
    </>
  );
}

// リポジトリ直下のLICENSEファイル(MIT)を実行時に取得して、そのまま表示するカード。
// ビルド時に埋め込むのではなく、デプロイ先で公開されている実ファイルを毎回fetchすることで、
// LICENSEファイルの内容が変わっても表示側の修正なしに追従できるようにしている。
// 前提: Viteの public/ ディレクトリに LICENSE ファイルが置かれていること。
// (このプロジェクトは vite.config.ts を使っており、GitHub Pagesには
//  skotm.github.io/ewwt/ というサブパスで公開されている。publicディレクトリの
//  中身はビルド時にそのままそのサブパス配下にコピーされるため、リポジトリ直下に
//  置いただけのファイルはビルド成果物に含まれず配信されない。
//  import.meta.env.BASE_URL でサブパスを解決しているので、コード側での
//  対応はこれで済むが、LICENSEファイル自体を public/LICENSE にも
//  配置(またはコピー)しておく必要がある)
function LicenseFileCard() {
  const { tokens } = useContext(ThemeContext);

  const [state, setState] = useState({ status: "loading", text: "" });

  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}LICENSE`)
      .then(res => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.text();
      })
      .then(text => { if (!cancelled) setState({ status: "ready", text }); })
      .catch(err => {
        console.warn("LICENSEファイルを取得できませんでした:", err);
        if (!cancelled) setState({ status: "error", text: "" });
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <SettingsCard>
      <div style={{ padding: "14px 14px", textAlign: "left" }}>
        {state.status === "loading" && (
          <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>読み込み中…</div>
        )}
        {state.status === "error" && (
          <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
            LICENSEファイルを読み込めませんでした。
          </div>
        )}
        {state.status === "ready" && (
          <pre style={{
            margin: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 11, lineHeight: 1.7, color: `rgba(${tokens.ink},0.65)`,
            whiteSpace: "pre-wrap", wordBreak: "break-word", textAlign: "left",
          }}>
            {state.text}
          </pre>
        )}
      </div>
    </SettingsCard>
  );
}

// **強調** と [文字列](URL) の簡易インライン処理。genuine Markdownパーサーではなく、
// こちらで用意する定型文書(利用規約・注意事項等)のみを想定したサブセット。
// リンクはhttp(s)スキームのみ許可し、javascript:等は文字列として素通しする
// (このファイル群はこちらで用意するものだが、念のための防御)。
function renderInlineMarkdown(text, keyPrefix) {
  const parts = text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>;
    }
    const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (linkMatch) {
      const [, label, url] = linkMatch;
      if (!/^https?:\/\//i.test(url)) {
        return <Fragment key={`${keyPrefix}-${i}`}>{label}</Fragment>;
      }
      return (
        <a
          key={`${keyPrefix}-${i}`}
          href={url}
          onClick={(e) => {
            // iOSのホーム画面PWA(standalone表示)では、target="_blank"だけだと
            // 別ウィンドウ(Safari)に離脱せず同じスタンドアロン画面内で遷移して
            // しまうことがあり、その状態で「戻る」とアプリ全体がリロードされて
            // しまう(=それまでのReactの状態が失われる)。window.openを明示的に
            // 呼んで新しいブラウジングコンテキストを開くことで、この画面はその場に
            // 留まったまま、リンク先だけを別枠(Safari等)で開くようにする。
            e.preventDefault();
            window.open(url, "_blank", "noopener,noreferrer");
          }}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#0A84FF", textDecoration: "underline", wordBreak: "break-all" }}
        >
          {label}
        </a>
      );
    }
    return <Fragment key={`${keyPrefix}-${i}`}>{part}</Fragment>;
  });
}

// ごく簡易的なMarkdown→JSXレンダラー。任意のMarkdown全般には対応せず、
// 見出し(#/##/###)・箇条書き(-/・)・区切り線(---)・**強調**・
// 空行区切りの段落のみを扱う、利用規約等の定型文書専用のサブセット実装。
// dangerouslySetInnerHTMLは一切使わず常にReact要素として組み立てるため、
// 万一ファイル内容に任意のHTML/スクリプトが混入していても実行されない。
function renderMarkdownLite(text, tokens) {
  const lines = (text || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let listBuffer = [];

  function flushList() {
    if (listBuffer.length === 0) return;
    const items = listBuffer;
    listBuffer = [];
    blocks.push(
      <ul key={`ul-${blocks.length}`} style={{ margin: "4px 0 12px", paddingLeft: 20, textAlign: "left" }}>
        {items.map((item, i) => (
          <li key={i} style={{ marginBottom: 4 }}>{renderInlineMarkdown(item, `li-${blocks.length}-${i}`)}</li>
        ))}
      </ul>
    );
  }

  lines.forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (line.startsWith("### ")) {
      flushList();
      blocks.push(<div key={i} style={{ fontSize: 13, fontWeight: 700, color: tokens.text, margin: "14px 0 4px", textAlign: "left" }}>{renderInlineMarkdown(line.slice(4), `h3-${i}`)}</div>);
    } else if (line.startsWith("## ")) {
      flushList();
      blocks.push(<div key={i} style={{ fontSize: 14, fontWeight: 700, color: tokens.text, margin: "18px 0 6px", textAlign: "left" }}>{renderInlineMarkdown(line.slice(3), `h2-${i}`)}</div>);
    } else if (line.startsWith("# ")) {
      flushList();
      blocks.push(<div key={i} style={{ fontSize: 16, fontWeight: 800, color: tokens.text, margin: "4px 0 10px", textAlign: "left" }}>{renderInlineMarkdown(line.slice(2), `h1-${i}`)}</div>);
    } else if (/^-{3,}$/.test(line)) {
      flushList();
      blocks.push(<div key={i} style={{ height: 1, background: `rgba(${tokens.ink},0.1)`, margin: "14px 0" }}/>);
    } else if (line.startsWith("- ") || line.startsWith("・")) {
      listBuffer.push(line.startsWith("- ") ? line.slice(2) : line.slice(1));
    } else if (line === "") {
      flushList();
    } else {
      flushList();
      blocks.push(<p key={i} style={{ margin: "0 0 10px", lineHeight: 1.9, textAlign: "left" }}>{renderInlineMarkdown(line, `p-${i}`)}</p>);
    }
  });
  flushList();
  return blocks;
}

// public/配下のMarkdownファイル(利用規約・注意事項・プライバシーポリシー等)を
// 実行時に取得し、renderMarkdownLiteで整形して表示するカード。LicenseFileCardと
// 同じ理由(ビルドし直さずファイル編集だけで内容を更新できるように)で、
// ビルド時埋め込みではなく実行時fetchにしている。
// 前提: Viteの public/ ディレクトリに対象のMarkdownファイルが置かれていること
// (LicenseFileCardと同様、BASE_URL配下に配置する必要がある)。
function MarkdownFileCard({ fileName }) {
  const { tokens } = useContext(ThemeContext);
  const [state, setState] = useState({ status: "loading", text: "" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", text: "" });
    fetch(`${import.meta.env.BASE_URL}${fileName}`)
      .then(res => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.text();
      })
      .then(text => { if (!cancelled) setState({ status: "ready", text }); })
      .catch(err => {
        console.warn(`${fileName}を取得できませんでした:`, err);
        if (!cancelled) setState({ status: "error", text: "" });
      });
    return () => { cancelled = true; };
  }, [fileName]);

  return (
    <SettingsCard>
      <div style={{ padding: "14px 16px", textAlign: "left" }}>
        {state.status === "loading" && (
          <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>読み込み中…</div>
        )}
        {state.status === "error" && (
          <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
            {fileName}を読み込めませんでした。
          </div>
        )}
        {state.status === "ready" && (
          <div style={{ fontSize: 12.5, color: `rgba(${tokens.ink},0.7)` }}>
            {renderMarkdownLite(state.text, tokens)}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}

// 断層・プレート境界の「枠内の色」選択部分。色名は出さず、色つきの丸(スウォッチ)を
// 横に並べるだけのシンプルなUIにする。選択中の丸には白いチェックマークを重ねる。
// 他のトグル行と同じSettingsCard内に収める前提のため、自前のカードは持たず、
// 小さな見出しとスウォッチ行だけを返すコンパクトな作りにしている
// (パネルの高さ「中高」だけでスクロールなしに収まるようにするため)。
function BoundaryLineColorSettings({ boundaryLineColorId, onChangeBoundaryLineColorId }) {
  const { tokens } = useContext(ThemeContext);

  const entries = Object.entries(BOUNDARY_LINE_COLORS);
  return (
    <div style={{ padding: "10px 14px 12px" }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: tokens.textSecondary, marginBottom: 9 }}>
        枠内の色
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "center" }}>
        {entries.map(([id, entry]) => {
          const selected = boundaryLineColorId === id;
          const checkColor = entry.checkColor || "#fff";
          return (
            <PressableButton
              key={id}
              onClick={() => onChangeBoundaryLineColorId(id)}
              aria-label={entry.label}
              style={{
                width: 30, height: 30, borderRadius: 15, flexShrink: 0,
                background: entry.color,
                border: "none", padding: 0, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: selected
                  ? `0 0 0 2px ${tokens.pageBg}, 0 0 0 3.5px rgba(${tokens.ink},0.4)`
                  : `0 0 0 1px rgba(${tokens.ink},0.15)`,
              }}
            >
              {selected && (
                <span style={{ fontSize: 13, fontWeight: 700, color: checkColor, lineHeight: 1 }}>✓</span>
              )}
            </PressableButton>
          );
        })}
      </div>
    </div>
  );
}


function SettingsBody({
  path, onNavigate, colorSchemeId, onChangeColorScheme,
  nowcastColorSchemeId, onChangeNowcastColorScheme,
  typhoonForecastIntervalHours, onChangeTyphoonForecastIntervalHours,
  estIntensityEnabled, onChangeEstIntensityEnabled,
  areaFillEnabled, onChangeAreaFillEnabled,
  faultsEnabled, onChangeFaultsEnabled,
  plateBoundariesEnabled, onChangePlateBoundariesEnabled,
  epicenterCirclesEnabled, onChangeEpicenterCirclesEnabled,
  boundaryLineColorId, onChangeBoundaryLineColorId,
  quakeFetchLimit, onChangeQuakeFetchLimit,
  stationListDisplayMode, onChangeStationListDisplayMode,
  experimentalFeaturesEnabled, onChangeExperimentalFeaturesEnabled,
  testTsunami, onBroadcastTestTsunami, onCancelTestTsunami, onClearTestTsunami,
  testEews = EMPTY_EQDB_LIST, onTestEewAction,
  eewTestForm, eewEpicenterPickActive,
  testQuake, onTestQuakeAction, quakeTestForm, quakeEpicenterPickActive, quakeTestAutoPlaying,
  tsunamiAreaPickActive, onStartTsunamiAreaPick, pickedTsunamiAreas,
  onRemoveTsunamiAreaPick, onCycleTsunamiAreaGrade,
  pickedTsunamiHeights, onChangeTsunamiHeightPick, onRemoveTsunamiHeightPick,
  candidateHeightStations, onAddTsunamiHeightPick,
}) {
  // 「フローティングを不透明にする」トグル用。BottomDock経由でpropsを何段も
  // 通す代わりに、Appのトップレベルで配信しているcontextを直接購読する。
  const {
    opaque: glassOpaqueEnabled,
    suspectedBroken: glassOpaqueSuspectedBroken,
    setOverride: onChangeGlassOpaqueOverride,
  } = useContext(GlassOpaqueContext);

  // ライト/ダークモード切り替え用。同じくcontext経由で直接購読する。
  const { mode: themeMode, tokens, modePref: themeModePref, setModePref: onChangeThemeModePref } = useContext(ThemeContext);

  // 「津波警報テスト配信」「緊急地震速報テスト配信」「地震情報テスト配信」画面を開いたまま
  // 実験的機能がOFFに戻された場合、一つ上の階層(実験的・テスト機能メニュー)へ自動的に戻す。
  // (通常はBottomDock側でトグルOFF時にpickモードごと片付けるが、念のためここでも
  // 画面遷移そのものの整合性を保証しておく。setStateはrender中ではなくeffect内で行う。)
  useEffect(() => {
    if (
      path.length >= 2 &&
      (path[path.length - 1] === "tsunamiTestBroadcast" || path[path.length - 1] === "eewTestBroadcast" || path[path.length - 1] === "quakeTestBroadcast") &&
      path[path.length - 2] === "experimental" &&
      !experimentalFeaturesEnabled
    ) {
      onNavigate(path.slice(0, -1));
    }
  }, [path, experimentalFeaturesEnabled, onNavigate]);

  // トップメニュー(カテゴリ一覧)
  if (path.length === 0) {
    return (
      <>
        <SettingsHeader title="設定"/>
        <SettingsCard>
          {SETTINGS_MENU.map((item, i) => (
            <div key={item.id}>
              {i > 0 && <SettingsCardDivider/>}
              <SettingsMenuRow label={item.label} onClick={() => onNavigate([item.id])}/>
            </div>
          ))}
        </SettingsCard>
        <div style={{ padding: "10px 14px 20px", textAlign: "center", fontSize: 11, color: `rgba(${tokens.ink},0.3)` }}>
          Developed by skotm
          <br/>
          v{APP_VERSION}
        </div>
      </>
    );
  }

  // 「タブ設定」の中身(地震・津波・気象・警報への入口)。
  if (path.length === 1 && path[0] === "tabSettings") {
    return (
      <>
        <SettingsHeader title="タブ設定"/>
        <SettingsCard>
          {TAB_SETTINGS_CATEGORIES.map((item, i) => (
            <div key={item.id}>
              {i > 0 && <SettingsCardDivider/>}
              <SettingsMenuRow label={item.label} onClick={() => onNavigate([...path, item.id])}/>
            </div>
          ))}
        </SettingsCard>
      </>
    );
  }

  // 地震・津波・気象・警報は「タブ設定」配下に移動したため、実際のpathは
  // ["tabSettings", "quake", ...] のように先頭にtabSettingsが付く。以降の
  // ルーティングは以前と同じcategory/leaf/subの2〜3階層で判定したいので、
  // その場合だけ先頭のtabSettingsを取り除いたものをlogicalPathとして扱う。
  const logicalPath = path[0] === "tabSettings" ? path.slice(1) : path;
  const [category, leaf, sub] = logicalPath;
  const categoryLabel = (SETTINGS_MENU.find(m => m.id === category)
    || TAB_SETTINGS_CATEGORIES.find(m => m.id === category))?.label || "";

  // 震度配色(地震カテゴリの項目)の中身
  if (category === "quake" && leaf === "colorScheme") {
    return (
      <>
        <SettingsHeader title="震度配色"/>
        <QuakeColorSchemeSettings colorSchemeId={colorSchemeId} onChangeColorScheme={onChangeColorScheme}/>
      </>
    );
  }

  // 雨雲レーダー配色(気象カテゴリの項目)の中身
  if (category === "weather" && leaf === "nowcastColorScheme") {
    return (
      <>
        <SettingsHeader title="雨雲レーダー配色"/>
        <NowcastColorSchemeSettings
          colorSchemeId={nowcastColorSchemeId}
          onChangeColorScheme={onChangeNowcastColorScheme}
        />
      </>
    );
  }

  // 台風予報円の表示間隔(気象カテゴリの項目)の中身
  if (category === "weather" && leaf === "typhoonForecastInterval") {
    return (
      <>
        <SettingsHeader title="台風予報円の表示間隔"/>
        <div style={{ padding: "0 14px 10px", fontSize: 12, color: `rgba(${tokens.ink},0.5)` }}>
          台風接近時は気象庁の予報が3時間おきに増えるため、予報円が密集しがちです。
          「現在から○時間ごと」の予報円だけを間引いて表示します。
        </div>
        <TyphoonForecastIntervalSettings
          intervalHours={typhoonForecastIntervalHours}
          onChangeIntervalHours={onChangeTyphoonForecastIntervalHours}
        />
      </>
    );
  }

  // 地図塗りつぶし(地震カテゴリの項目)の中身。
  // 「細分区域を震度で塗りつぶす」「推計震度分布を表示」の2つのON/OFFをまとめる。
  if (category === "quake" && leaf === "mapFill") {
    return (
      <>
        <SettingsHeader title="地図塗りつぶし"/>
        <SettingsCard>
          <SettingsToggleRow
            label="細分区域を震度で塗りつぶす"
            description="観測点の震度をもとに、気象庁の細分区域単位で地図を塗り分けます。"
            checked={areaFillEnabled}
            onChange={() => onChangeAreaFillEnabled(!areaFillEnabled)}
          />
          <SettingsCardDivider/>
          <SettingsToggleRow
            label="推計震度分布を表示"
            description="震度5弱以上の地震選択時、気象庁の推計震度分布を地図に重ねて表示します。"
            checked={estIntensityEnabled}
            onChange={() => onChangeEstIntensityEnabled(!estIntensityEnabled)}
          />
        </SettingsCard>
      </>
    );
  }

  // 断層・プレート境界(地震カテゴリの項目)の中身。
  // いずれもファイルサイズが大きいデータのため、初期設定は両方OFF。
  // 縁取り(halo)はライト/ダーク共通の固定色だが、枠内の色はここで選べる。
  // ヘッダー・カードを1つにまとめてコンパクトにし、パネルの高さ「中高」
  // (MIDHIGH_FIXED)だけでスクロールなしに全項目が収まるようにしている。
  if (category === "quake" && leaf === "boundaries") {
    return (
      <>
        <SettingsHeader title="断層・プレート境界"/>
        <SettingsCard>
          <SettingsToggleRow
            label="断層を表示"
            description="日本の主な活断層を表示します。"
            checked={faultsEnabled}
            onChange={() => onChangeFaultsEnabled(!faultsEnabled)}
          />
          <SettingsCardDivider/>
          <SettingsToggleRow
            label="プレート境界を表示"
            description="世界のプレート境界を表示します。"
            checked={plateBoundariesEnabled}
            onChange={() => onChangePlateBoundariesEnabled(!plateBoundariesEnabled)}
          />
          <SettingsCardDivider/>
          <BoundaryLineColorSettings
            boundaryLineColorId={boundaryLineColorId}
            onChangeBoundaryLineColorId={onChangeBoundaryLineColorId}
          />
        </SettingsCard>
      </>
    );
  }

  // 各地の震度リストの表示方法(地震カテゴリの項目)の中身
  if (category === "quake" && leaf === "stationListDisplay") {
    return (
      <>
        <SettingsHeader title="各地の震度の表示方法"/>
        <StationListDisplayModeSettings value={stationListDisplayMode} onChange={onChangeStationListDisplayMode}/>
      </>
    );
  }

  // 取得件数(地震カテゴリの項目)の中身
  if (category === "quake" && leaf === "fetchLimit") {
    return (
      <>
        <SettingsHeader title="取得件数"/>
        <QuakeFetchLimitSettings value={quakeFetchLimit} onChange={onChangeQuakeFetchLimit}/>
      </>
    );
  }

  // 地震カテゴリのトップ(震度配色・地図塗りつぶし・取得件数への入口)。
  // 他のカテゴリと違い項目を専用に組み立てているため、汎用のitems一覧ループとは別扱いにする。
  if (category === "quake" && !leaf) {
    return (
      <>
        <SettingsHeader title="地震"/>
        <SettingsCard>
          <SettingsMenuRow label="震度配色" onClick={() => onNavigate([...path, "colorScheme"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="地図塗りつぶし" onClick={() => onNavigate([...path, "mapFill"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="断層・プレート境界" onClick={() => onNavigate([...path, "boundaries"])}/>
          <SettingsCardDivider/>
          <SettingsToggleRow
            label="震央分布を表示"
            description="近傍/データベース検索の地震一覧を開いた時、地図上に震央の丸を表示します。震度が大きい地震ほど上に重なって表示されます。"
            checked={epicenterCirclesEnabled}
            onChange={() => onChangeEpicenterCirclesEnabled(!epicenterCirclesEnabled)}
          />
          <SettingsCardDivider/>
          <SettingsMenuRow label="各地の震度の表示方法" onClick={() => onNavigate([...path, "stationListDisplay"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="取得件数" onClick={() => onNavigate([...path, "fetchLimit"])}/>
        </SettingsCard>
      </>
    );
  }

  // 外観(詳細設定カテゴリの項目)の中身。
  // 「デバイスの設定に合わせる」が初期設定(ON)で、端末のライト/ダーク設定に
  // 自動追従する。OFFにした場合のみ、ライト/ダークを手動で選べる。
  // ここではUIチューム(背景・カード・文字色など)の基礎トークンだけを
  // 切り替えており、地図の基本配色や震度配色スキームは対象外
  // (別途テーマ対応が必要)。
  if (category === "advanced" && leaf === "appearance") {
    const followSystem = themeModePref === "system";
    return (
      <>
        <SettingsHeader title="外観"/>
        <SettingsCard>
          <SettingsToggleRow
            label="デバイスの設定に合わせる"
            description="オンにすると、端末のライト/ダークモード設定に自動で追従します(初期設定)。"
            checked={followSystem}
            onChange={() => onChangeThemeModePref(followSystem ? themeMode : "system")}
          />
          {!followSystem && (
            <>
              <SettingsCardDivider/>
              <SettingsToggleRow
                label="ライトモード"
                description="オフのときはダークモードです。"
                checked={themeModePref === "light"}
                onChange={() => onChangeThemeModePref(themeModePref === "light" ? "dark" : "light")}
              />
            </>
          )}
        </SettingsCard>
        <SettingsCard>
          <SettingsToggleRow
            label="フローティングを不透明にする"
            description={
              glassOpaqueSuspectedBroken
                ? "この端末・ブラウザではぼかし効果が正しく表示されない可能性があるため、自動的に不透明表示に固定されています。"
                : "オンにすると、地図パネルなどの半透明・ぼかし表示をやめて、はっきり見える不透明な背景にします。"
            }
            checked={glassOpaqueEnabled}
            onChange={() => onChangeGlassOpaqueOverride(glassOpaqueEnabled ? "off" : "on")}
            disabled={glassOpaqueSuspectedBroken}
          />
        </SettingsCard>
      </>
    );
  }

  // 実験的・テスト機能(詳細設定の項目)の中身。
  if (category === "advanced" && leaf === "experimental" && !sub) {
    return (
      <>
        <SettingsHeader title="実験的・テスト機能"/>
        <SettingsCard>
          <SettingsToggleRow
            label="実験的機能を有効にする"
            description="開発中・テスト用の機能を使えるようにします。実際の防災情報とは異なる場合があるため、通常時はOFFのままにしてください。"
            checked={experimentalFeaturesEnabled}
            onChange={() => onChangeExperimentalFeaturesEnabled(!experimentalFeaturesEnabled)}
          />
        </SettingsCard>
        {experimentalFeaturesEnabled && (
          <SettingsCard>
            <SettingsMenuRow
              label="津波警報テスト配信"
              onClick={() => onNavigate([...path, "tsunamiTestBroadcast"])}
            />
            <SettingsCardDivider/>
            <SettingsMenuRow
              label="緊急地震速報テスト配信"
              onClick={() => onNavigate([...path, "eewTestBroadcast"])}
            />
            <SettingsCardDivider/>
            <SettingsMenuRow
              label="地震情報テスト配信"
              onClick={() => onNavigate([...path, "quakeTestBroadcast"])}
            />
          </SettingsCard>
        )}
      </>
    );
  }

  // 実験的機能: 津波警報テスト配信メニュー。実験的機能そのものがOFFに戻された場合の
  // 画面遷移は上部のuseEffectが行うので、ここでは切り替わるまでの一瞬だけ何も
  // 描画しないようにする。
  if (category === "advanced" && leaf === "experimental" && sub === "tsunamiTestBroadcast") {
    if (!experimentalFeaturesEnabled) return null;
    return (
      <>
        <SettingsHeader title="津波警報テスト配信"/>
        <TsunamiTestBroadcastPanel
          testTsunami={testTsunami}
          onBroadcast={onBroadcastTestTsunami}
          onCancel={onCancelTestTsunami}
          onClear={onClearTestTsunami}
          tsunamiAreaPickActive={tsunamiAreaPickActive}
          onStartAreaPick={onStartTsunamiAreaPick}
          pickedAreas={pickedTsunamiAreas}
          onRemoveAreaPick={onRemoveTsunamiAreaPick}
          onCycleAreaGrade={onCycleTsunamiAreaGrade}
          pickedHeights={pickedTsunamiHeights}
          onChangeHeightPick={onChangeTsunamiHeightPick}
          onRemoveHeightPick={onRemoveTsunamiHeightPick}
          candidateHeightStations={candidateHeightStations}
          onAddHeightPick={onAddTsunamiHeightPick}
        />
      </>
    );
  }

  // 実験的機能: 緊急地震速報テスト配信メニュー。
  if (category === "advanced" && leaf === "experimental" && sub === "eewTestBroadcast") {
    if (!experimentalFeaturesEnabled) return null;
    return (
      <>
        <SettingsHeader title="緊急地震速報テスト配信"/>
        <EewTestBroadcastPanel
          testEews={testEews}
          onAction={onTestEewAction}
          eewTestForm={eewTestForm}
          eewEpicenterPickActive={eewEpicenterPickActive}
        />
      </>
    );
  }

  // 実験的機能: 地震情報テスト配信メニュー。
  if (category === "advanced" && leaf === "experimental" && sub === "quakeTestBroadcast") {
    if (!experimentalFeaturesEnabled) return null;
    return (
      <>
        <SettingsHeader title="地震情報テスト配信"/>
        <QuakeTestBroadcastPanel
          testQuake={testQuake}
          onAction={onTestQuakeAction}
          quakeTestForm={quakeTestForm}
          quakeEpicenterPickActive={quakeEpicenterPickActive}
          quakeTestAutoPlaying={quakeTestAutoPlaying}
        />
      </>
    );
  }

  // 利用規約等・注意事項(トップ階層のカテゴリ)の中身。文書一覧。
  // ライセンスもこの中に含める。
  if (category === "terms" && !leaf) {
    return (
      <>
        <SettingsHeader title="利用規約等・注意事項"/>
        <SettingsCard>
          <SettingsMenuRow label="利用規約" onClick={() => onNavigate([...path, "tou"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="注意事項" onClick={() => onNavigate([...path, "notices"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="プライバシーポリシー" onClick={() => onNavigate([...path, "privacy"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="ライセンス" onClick={() => onNavigate([...path, "license"])}/>
        </SettingsCard>
      </>
    );
  }

  // 利用規約本文。public/terms-of-use.md を実行時に取得して表示する。
  if (category === "terms" && leaf === "tou") {
    return (
      <>
        <SettingsHeader title="利用規約"/>
        <MarkdownFileCard fileName="terms-of-use.md"/>
      </>
    );
  }

  // 注意事項本文。public/notices.md を実行時に取得して表示する。
  if (category === "terms" && leaf === "notices") {
    return (
      <>
        <SettingsHeader title="注意事項"/>
        <MarkdownFileCard fileName="notices.md"/>
      </>
    );
  }

  // プライバシーポリシー本文。public/privacy-policy.md を実行時に取得して表示する。
  if (category === "terms" && leaf === "privacy") {
    return (
      <>
        <SettingsHeader title="プライバシーポリシー"/>
        <MarkdownFileCard fileName="privacy-policy.md"/>
      </>
    );
  }

  // ライセンス(利用規約等・注意事項カテゴリの項目)の中身
  if (category === "terms" && leaf === "license" && !sub) {
    return (
      <>
        <SettingsHeader title="ライセンス"/>
        <SettingsCard>
          <div style={{ padding: "14px 14px", fontSize: 12, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.8, textAlign: "left" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: tokens.text, marginBottom: 4 }}>
              データ提供
            </div>
            気象庁 / 国土地理院 / Natural Earth / P2P地震情報
          </div>
          <SettingsCardDivider/>
          <div style={{ padding: "14px 14px", fontSize: 12, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.8, textAlign: "left" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: tokens.text, marginBottom: 4 }}>
              オープンソースソフトウェア
            </div>
            React
          </div>
        </SettingsCard>
        <SettingsCard>
          <SettingsMenuRow label="MIT License 2026 skotm" onClick={() => onNavigate([...path, "mit"])}/>
        </SettingsCard>
      </>
    );
  }

  // MITライセンス本文(ライセンス項目のさらに下の階層)。新しくモーダルを作らず、
  // 他の設定画面と同じ「パネル内をその場で差し替える」ナビゲーションで表示する。
  if (category === "terms" && leaf === "license" && sub === "mit") {
    return (
      <>
        <SettingsHeader title="MIT License 2026 skotm"/>
        <LicenseFileCard/>
      </>
    );
  }

  // ログ(詳細設定カテゴリの項目)の中身。console.log等を横取りして溜めている
  // リングバッファ(useDebugLog)をそのまま一覧表示する。実機のPWAで発生した
  // 不具合をPCのdevtools無しで調査できるようにするためのデバッグ機能。
  if (category === "advanced" && leaf === "logs") {
    return (
      <>
        <SettingsHeader title="ログ"/>
        <LogViewerPanel/>
      </>
    );
  }

  // カテゴリ内の項目一覧(地震カテゴリは上で処理済みのため、それ以外のカテゴリ用)
  const items = SETTINGS_ITEMS[category] || [];
  if (!leaf) {
    return (
      <>
        <SettingsHeader title={categoryLabel}/>
        {items.length > 0 ? (
          <SettingsCard>
            {items.map((item, i) => (
              <div key={item.id}>
                {i > 0 && <SettingsCardDivider/>}
                <SettingsMenuRow label={item.label} onClick={() => onNavigate([...path, item.id])}/>
              </div>
            ))}
          </SettingsCard>
        ) : (
          <div style={{ padding: "28px 18px", textAlign: "center", fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
            現在、設定できる項目はありません
          </div>
        )}
      </>
    );
  }

  // 想定外のパス(念のためのフォールバック)
  return <SettingsHeader title={categoryLabel}/>;
}

/* ─────────────────────────────────────────────────────
   TERMS CONSENT GATE
   利用規約・プライバシーポリシー・注意事項への同意を、既存のフローティングUI
   (BottomDock等)とは別の全画面オーバーレイで確認する。未同意の間はこれが
   画面全体を覆い、他の操作を一切受け付けない。

   「同意済みか」はTERMS_AGREEMENT_STORAGE_KEY(localStorage)に保存した
   各文書のハッシュで判定するため、開発者はMarkdownファイルの中身を
   書き換えるだけでよく、バージョン番号の手動管理は不要。

   フェイルオープンの方針: 本アプリは災害時にも使われることを想定しているため、
   「過去に同意した記録があるユーザー」を単なる通信不調で締め出すことは避ける。
   文書の取得に失敗した場合:
     - 過去に同意した記録がある → ブロックせずそのまま利用させる
     - 一度も同意したことがない(真の初回) → 同意対象を表示できないため、
       再読み込みを促す画面のみ出す(この場合だけブロックが続く)

   ファイル名は意図的に日本語ではなくASCIIにしている。日本語ファイル名
   (特に濁点・半濁点付きのカタカナ)はmacOS等でNFD(濁点が分解された形)で
   保存されることがあり、ブラウザが要求するNFC表記のURLとバイト単位で
   一致せず404になることがあるため。
   ───────────────────────────────────────────────────── */
const TERMS_GATE_FILES = {
  tou: "terms-of-use.md",
  privacy: "privacy-policy.md",
  notices: "notices.md",
};
const TERMS_GATE_TABS = [
  { id: "tou",     label: "利用規約" },
  { id: "privacy", label: "プライバシーポリシー" },
  { id: "notices", label: "注意事項" },
];

function TermsConsentGate() {
  const { tokens } = useContext(ThemeContext);
  const [status, setStatus] = useState("checking"); // checking | ok | needsConsent | unavailable
  const [docs, setDocs] = useState(null); // { tou, privacy, notices }
  const [pendingHashes, setPendingHashes] = useState(null);
  const [activeTab, setActiveTab] = useState("tou");
  const [agreeChecked, setAgreeChecked] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("checking");

    function withTimeout(promise, ms) {
      return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
      ]);
    }

    const stored = loadStoredTermsAgreement();

    Promise.allSettled(
      Object.entries(TERMS_GATE_FILES).map(([key, fileName]) =>
        withTimeout(
          fetch(`${import.meta.env.BASE_URL}${fileName}`).then(res => {
            if (!res.ok) throw new Error(`status ${res.status}`);
            return res.text();
          }),
          8000
        ).then(text => ({ key, text }))
      )
    ).then(results => {
      if (cancelled) return;

      const texts = {};
      let allOk = true;
      results.forEach(r => {
        if (r.status === "fulfilled") texts[r.value.key] = r.value.text;
        else allOk = false;
      });

      if (!allOk) {
        setStatus(stored ? "ok" : "unavailable");
        return;
      }

      const hashes = {
        tou: simpleHash(texts.tou),
        privacy: simpleHash(texts.privacy),
        notices: simpleHash(texts.notices),
      };
      const upToDate = !!stored
        && stored.tou === hashes.tou
        && stored.privacy === hashes.privacy
        && stored.notices === hashes.notices;

      if (upToDate) {
        setStatus("ok");
      } else {
        setDocs(texts);
        setPendingHashes(hashes);
        setAgreeChecked(false);
        setActiveTab("tou");
        setStatus("needsConsent");
      }
    });

    return () => { cancelled = true; };
  }, [retryToken]);

  if (status === "ok") return null;

  // 「取得中」は通常一瞬で終わるが、その間に下のUIが一瞬でも見えてしまうのを
  // 避けるため、判定が終わるまでは最小限の全画面プレースホルダーだけを出す。
  if (status === "checking") {
    return (
      <div style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: tokens.pageBg,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <div style={{
          width: 22, height: 22, borderRadius: "50%",
          border: `2.5px solid rgba(${tokens.ink},0.2)`,
          borderTopColor: `rgba(${tokens.ink},0.7)`,
          animation: "spin 0.8s linear infinite",
        }}/>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: tokens.pageBg,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24,
      }}>
        <div style={{ maxWidth: 360, textAlign: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: tokens.text, marginBottom: 10 }}>
            利用規約等を読み込めませんでした
          </div>
          <div style={{ fontSize: 13, color: `rgba(${tokens.ink},0.6)`, lineHeight: 1.8, marginBottom: 20 }}>
            ご利用の開始には、利用規約・プライバシーポリシー・注意事項への同意が必要です。通信環境をご確認のうえ、もう一度お試しください。
          </div>
          <PressableButton
            onClick={() => setRetryToken(n => n + 1)}
            style={{
              padding: "10px 24px", borderRadius: 999,
              border: "1px solid rgba(10,132,255,0.9)",
              background: "#0A84FF", color: "#ffffff",
              fontSize: 14, fontWeight: 700,
            }}
          >
            再読み込み
          </PressableButton>
        </div>
      </div>
    );
  }

  // status === "needsConsent"
  const activeText = docs?.[activeTab] || "";
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: tokens.pageBg,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{ padding: "calc(20px + env(safe-area-inset-top, 0px)) 20px 12px", textAlign: "center", flexShrink: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: tokens.text, marginBottom: 4 }}>
          利用規約等のご確認
        </div>
        <div style={{ fontSize: 12.5, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.7 }}>
          ご利用の前に、以下の内容をご確認のうえ同意してください。
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, padding: "0 16px 10px", justifyContent: "center", flexShrink: 0 }}>
        {TERMS_GATE_TABS.map(tab => (
          <PressableButton
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "7px 12px", borderRadius: 999,
              background: activeTab === tab.id ? "#0A84FF" : `rgba(${tokens.ink},0.06)`,
              color: activeTab === tab.id ? "#ffffff" : tokens.text,
              fontSize: 12.5, fontWeight: 700,
            }}
          >
            {tab.label}
          </PressableButton>
        ))}
      </div>

      <div key={activeTab} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 16px 16px" }}>
        <div style={{
          borderRadius: 16,
          background: `rgba(${tokens.ink},0.04)`,
          padding: "16px 16px",
        }}>
          {renderMarkdownLite(activeText, tokens)}
        </div>
      </div>

      <div style={{
        padding: "12px 16px calc(16px + env(safe-area-inset-bottom, 0px))",
        borderTop: `1px solid rgba(${tokens.ink},0.08)`,
        flexShrink: 0,
      }}>
        <PressableButton
          onClick={() => setAgreeChecked(v => !v)}
          style={{
            width: "100%", display: "flex", alignItems: "center", gap: 10,
            padding: "10px 4px", background: "transparent", textAlign: "left",
          }}
        >
          <span style={{
            flexShrink: 0, width: 20, height: 20, borderRadius: 6,
            border: `1.5px solid rgba(${tokens.ink},${agreeChecked ? 0 : 0.3})`,
            background: agreeChecked ? "#0A84FF" : "transparent",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {agreeChecked && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M4 12.5L9.5 18L20 6" stroke="#fff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </span>
          <span style={{ fontSize: 13, color: tokens.text }}>
            利用規約・プライバシーポリシー・注意事項の内容を確認し、同意します
          </span>
        </PressableButton>

        <PressableButton
          disabled={!agreeChecked}
          onClick={() => {
            if (!pendingHashes) return;
            saveStoredTermsAgreement({ ...pendingHashes, agreedAt: new Date().toISOString() });
            setStatus("ok");
          }}
          style={{
            width: "100%", marginTop: 10, padding: "13px 0", borderRadius: 999,
            background: agreeChecked ? "#0A84FF" : `rgba(${tokens.ink},0.12)`,
            color: agreeChecked ? "#ffffff" : `rgba(${tokens.ink},0.4)`,
            fontSize: 15, fontWeight: 800, textAlign: "center",
          }}
        >
          同意して利用を開始する
        </PressableButton>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   APP ROOT
   ───────────────────────────────────────────────────── */
export default function App() {
  const [activeNav, setActiveNav] = useState("quake");
  // WebSocketの受信ハンドラ(古いクロージャのまま生き続ける)から常に最新の
  // activeNavを参照できるようにするためのref。緊急地震速報の自動表示切り替えに使う。
  const activeNavRef = useRef(activeNav);
  useEffect(() => { activeNavRef.current = activeNav; }, [activeNav]);

  // タブバーで、既にアクティブなタブをもう一度タップした時に、フローティングを
  // 開閉トグルさせるための信号。値そのものに意味は無く、変化すること自体を
  // BottomDock側のuseEffectで検知してsnapIndexを切り替える。
  const [navCollapseSignal, setNavCollapseSignal] = useState(0);
  // 既にアクティブなタブをダブルタップした時に、フローティングを「高」まで一気に
  // 開かせるための信号。navCollapseSignalと同様、値の変化自体をBottomDock側で検知する。
  const [navDoubleTapSignal, setNavDoubleTapSignal] = useState(0);
  // SideNavRail・狭幅ナビはどちらも、1回の物理的なタップに対してhandlePointerUp
  // (ポインタを離した時)とhandleClick(単純クリック時)の両方からonNavを呼ぶ作りに
  // なっている(ドラッグでタブを選べるようにするための設計)。そのため、まず
  // 「ごく短時間(80ms未満)内の連続呼び出し」を同一タップ由来の二重発火として無視し、
  // 残った「論理的な1タップ」だけを数える。
  // 通常のタップ操作(開閉トグル)は待たせず即座に実行する。その代わり、フローティングの
  // 開閉アニメーション中(BottomDockのheightトランジションは0.4秒)にもう一度タップされた
  // 場合だけ、それを「動作の途中のタップ」とみなして「高」まで一気に開く。
  // この猶予は実際のトランジション時間(400ms)ちょうどにはせず、80ms分のバッファを
  // 上乗せしている(scheduleSettleが同じ0.4sのトランジションに対して460msの猶予を
  // 持たせているのと同じ考え方)。ちょうど同じ値にしてしまうと、指の反応や
  // イベント発火・再描画にかかるわずかな遅延だけで「連打のつもりが400msをわずかに
  // 超えて届く」ことになり、ダブルタップのはずが単発タップの開閉トグル(=閉じる方向)
  // として誤判定され、開いている途中で閉じてしまう不具合につながっていた。
  const NAV_TRANSITION_MS = 480;
  const navTapStateRef = useRef({ rawTime: 0, logicalTapTime: 0 });
  function handleNavTap(id) {
    if (id !== activeNav) {
      setActiveNav(id);
      return;
    }
    const now = Date.now();
    if (now - navTapStateRef.current.rawTime < 80) {
      navTapStateRef.current.rawTime = now;
      return;
    }
    navTapStateRef.current.rawTime = now;

    const sinceLastLogicalTap = now - navTapStateRef.current.logicalTapTime;
    if (navTapStateRef.current.logicalTapTime && sinceLastLogicalTap < NAV_TRANSITION_MS) {
      // 直前の開閉トグルがまだアニメーション中 → 「高」まで一気に開く
      navTapStateRef.current.logicalTapTime = 0;
      setNavDoubleTapSignal(s => s + 1);
      return;
    }
    navTapStateRef.current.logicalTapTime = now;
    setNavCollapseSignal(s => s + 1);
  }
  const [layers,    setLayers]    = useState(LAYERS);
  const [layerOpen, setLayerOpen] = useState(false);
  const [map,       setMap]       = useState(null);
  const isWide = useIsWideLayout(); // 横画面スマホ・タブレット・PCなどの広い画面かどうか
  const wideUIScale = useWideUIScale(isWide); // 横画面で画面が低い(=スマホ横持ち)場合の縮小率
  const isStandalonePwa = useIsStandalonePwa(); // ホーム画面に追加したPWAとして起動しているか

  // Liquid Glassのぼかしが実効しない(疑いがある)場合の不透明フォールバック。
  // "auto"時はWebGLレンダラー文字列からのヒューリスティック判定に従い、
  // 手動で "on"(常に不透明)/"off"(常にぼかし優先)にも上書きできる
  // (設定タブなどから handleChangeGlassOpaqueOverride を呼んで切り替える)。
  const [glassOpaqueOverride, setGlassOpaqueOverrideState] = useState(loadGlassOpaqueOverride);
  const [suspectedBackdropFilterBroken] = useState(detectSuspectedBackdropFilterBreakage);

  function handleChangeGlassOpaqueOverride(next) {
    // ぼかしが実効しない疑いがある場合、不透明のまま固定する
    // (設定画面のトグルはdisabled表示にしているが、念のためここでも二重に防ぐ)。
    if (suspectedBackdropFilterBroken) return;
    setGlassOpaqueOverrideState(next);
    saveGlassOpaqueOverride(next);
  }

  const glassOpaque =
    suspectedBackdropFilterBroken ? true : // ぼかしが効かない疑いがある場合は常に不透明固定
    glassOpaqueOverride === "on"  ? true  :
    glassOpaqueOverride === "off" ? false :
    false; // "auto" かつ疑いがない場合はぼかしを使う

  const glassOpaqueContextValue = useMemo(() => ({
    opaque: glassOpaque,
    override: glassOpaqueOverride,
    suspectedBroken: suspectedBackdropFilterBroken,
    setOverride: handleChangeGlassOpaqueOverride,
  }), [glassOpaque, glassOpaqueOverride, suspectedBackdropFilterBroken, handleChangeGlassOpaqueOverride]);

  // ライト/ダークモード。設定タブの「詳細設定」→「外観」から切り替える。
  // 初期設定は"system"(デバイスの設定に合わせる)。ユーザーの選択は
  // localStorageに保存し、次回起動時も復元する。
  // "system"のときはuseSystemThemeMode()でデバイスのprefers-color-schemeを
  // ライブ監視し、それをそのまま実際の表示モードとして使う。
  const [themeModePref, setThemeModePrefState] = useState(loadStoredThemeModePref); // "system" | "light" | "dark"
  const systemThemeMode = useSystemThemeMode(); // "dark" | "light"(デバイス設定、リアルタイム反映)
  const themeMode = themeModePref === "system" ? systemThemeMode : themeModePref; // 実際に適用中のモード

  function handleChangeThemeModePref(next) {
    setThemeModePrefState(next);
    saveThemeModePref(next);
  }

  const themeContextValue = useMemo(() => ({
    mode: themeMode,
    tokens: THEME_TOKENS[themeMode],
    modePref: themeModePref,
    setModePref: handleChangeThemeModePref,
  }), [themeMode, themeModePref]);

  // App自身はThemeContext.Providerを作る側なので、自分に対してはuseContextせず
  // 計算済みのthemeContextValueから直接参照する。
  const tokens = themeContextValue.tokens;

  // 震度配色。設定タブの「地震」→「震度配色」から切り替える。
  // 選択したスキームはlocalStorageに保存し、次回起動時も復元する。
  const [quakeColorScheme, setQuakeColorScheme] = useState(loadStoredQuakeColorScheme); // "legacy" | "jma" | "fill"

  function handleChangeQuakeColorScheme(schemeId) {
    setQuakeColorScheme(schemeId);
    saveQuakeColorScheme(schemeId);
  }

  // 雨雲レーダー配色。設定タブの「気象」→「雨雲レーダー配色」から切り替える。
  // 選択したスキームはlocalStorageに保存し、次回起動時も復元する。
  const [nowcastColorScheme, setNowcastColorScheme] = useState(loadStoredNowcastColorScheme); // "jma" | "yahoo"

  function handleChangeNowcastColorScheme(schemeId) {
    setNowcastColorScheme(schemeId);
    saveNowcastColorScheme(schemeId);
  }

  // 推計震度分布の表示ON/OFF。地図レイヤーパネルの「推計震度分布」トグルと
  // 設定タブ「地震」内のトグルの、両方から操作できる単一の状態(localStorageに永続化)。
  const [estIntensityEnabled, setEstIntensityEnabledState] = useState(loadStoredEstIntensityEnabled);

  function handleChangeEstIntensityEnabled(next) {
    setEstIntensityEnabledState(next);
    saveEstIntensityEnabled(next);
  }

  // 細分区域を震度の色で塗りつぶすかどうか。推計震度分布と同じく設定タブで操作し、localStorageに永続化する。
  const [areaFillEnabled, setAreaFillEnabledState] = useState(loadStoredAreaFillEnabled);

  function handleChangeAreaFillEnabled(next) {
    setAreaFillEnabledState(next);
    saveAreaFillEnabled(next);
  }

  // 実験的・テスト機能のON/OFF。設定「詳細設定」内のトグルで操作し、localStorageに永続化する。
  const [experimentalFeaturesEnabled, setExperimentalFeaturesEnabledState] = useState(loadStoredExperimentalFeaturesEnabled);

  function handleChangeExperimentalFeaturesEnabled(next) {
    setExperimentalFeaturesEnabledState(next);
    saveExperimentalFeaturesEnabled(next);
    // OFFに戻したら、テスト配信中のダミー津波情報も片付けておく
    // (OFFなのにテストデータだけ残り続ける事故を防ぐ)。
    if (!next) {
      clearTestTsunami();
      setTsunamiAreaPickActive(false);
      setPickedTsunamiAreas([]);
    }
  }

  // 警報タブ: 気象警報・注意報。regioncode → {level, kinds} のマップ。
  // 警報タブを開いている間だけ10分おきにポーリングする(EEW等の常時監視系と違い、
  // 警報・注意報は数分単位で急変するものではないため)。
  const [warningLevelMap, setWarningLevelMap] = useState({});
  // 直近の取得時刻。タブを行ったり来たりするたびに毎回APIを叩き直さないよう、
  // 直近1分以内に取得済みなら再取得をスキップする(定期ポーリングのタイマーは
  // forceで無視する)。
  const warningLevelMapFetchedAtRef = useRef(0);
  useEffect(() => {
    if (activeNav !== "alert") return;
    let cancelled = false;
    const refresh = (force = false) => {
      if (!force && Date.now() - warningLevelMapFetchedAtRef.current < 60 * 1000) return;
      fetchWarningLevelMap_combined()
        .then((map) => {
          if (cancelled) return;
          warningLevelMapFetchedAtRef.current = Date.now();
          setWarningLevelMap(map);
        })
        .catch((err) => console.error("警報・注意報データの取得に失敗しました:", err));
    };
    refresh();
    const intervalId = setInterval(() => refresh(true), 10 * 60 * 1000);
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [activeNav]);

  // 警報タブ: 市区町村の名称インデックス(1,821件、regioncode→{name, geometry})。
  // 以前はloadWarningAreaMunicipalities()(1,821件全部のcentroidを毎回計算する
  // 重い版、五十音ピッカー専用)を流用していたが、警報タブを開いた瞬間に
  // 発表の有無に関わらず全市区町村分の座標計算が走ってしまい、体感の重さの
  // 原因になっていた。ここでは名称とジオメトリを受け渡すだけの軽量版
  // loadWarningAreaNameIndex()を使い、座標(centroid)は下のuseMemoで
  // 「実際に発表中の数件」だけ遅延計算する。
  const [warningAreaNameIndex, setWarningAreaNameIndex] = useState(null);
  const warningAreaNameIndexLoadedRef = useRef(false);
  useEffect(() => {
    if (activeNav !== "alert" || warningAreaNameIndexLoadedRef.current) return;
    warningAreaNameIndexLoadedRef.current = true;
    loadWarningAreaNameIndex()
      .then(setWarningAreaNameIndex)
      .catch((err) => {
        console.error("警報エリアの名称マスタの読み込みに失敗しました:", err);
        warningAreaNameIndexLoadedRef.current = false; // 失敗時は次回開いた時に再試行できるようにする
      });
  }, [activeNav]);
  // regioncode → {name, lat, lon} の逆引きテーブル。一覧表示・詳細カードの
  // 両方で使う。centroid計算は「現在warningLevelMapに載っている(=発表中の)
  // regioncodeだけ」に絞ることで、全1,821件分の計算を避けている。
  const warningAreaByRegioncode = useMemo(() => {
    const map = {};
    if (!warningAreaNameIndex) return map;
    // 名称は全1,821件分マップしておく(地図タップは発表の有無を問わず全国が
    // 対象になったため、発表なしのエリアでも名前だけは詳細カードで出したい)。
    // centroid計算(polygonRoughCentroid)は依然として重いので、一覧・flyToで
    // 実際に必要になる「発表中」の分だけに絞って計算する。
    for (const regioncode of Object.keys(warningAreaNameIndex)) {
      const entry = warningAreaNameIndex[regioncode];
      if (!entry) continue;
      const centroid = warningLevelMap[regioncode] ? polygonRoughCentroid(entry.geometry) : null;
      map[regioncode] = { name: entry.name, regionname: entry.regionname, lat: centroid?.lat ?? null, lon: centroid?.lon ?? null };
    }
    return map;
  }, [warningLevelMap, warningAreaNameIndex]);

  // 警報タブ: タップ/一覧選択中のエリア(regioncode) | null。
  // タブを離れたら選択解除する(津波タブの選択解除と同じ考え方)。
  const [selectedWarningArea, setSelectedWarningArea] = useState(null);
  useEffect(() => {
    if (activeNav !== "alert") setSelectedWarningArea(null);
  }, [activeNav]);
  // 一覧の項目をタップした時のflyTo先。{lon, lat, nonce} | null
  // (nonceは同じエリアを連続でタップしても再度flyToが発火するようにするため)。
  const [warningAreaFlyToRequest, setWarningAreaFlyToRequest] = useState(null);
  // 地図の塗り分けをタップした時。地図タップは警報レイヤーの全ポリゴン
  // (発表の有無を問わず日本全国)に対して判定される。以前は発表中でない
  // エリアのタップを無視していたが、warningAreaByRegioncodeが名称だけは
  // 全件分持つようになったため、発表なしのエリアもそのまま選択して
  // 詳細カード側で「発表中の警報・注意報はありません」と出す。
  function handleSelectWarningArea(regioncode) {
    setSelectedWarningArea(regioncode);
  }
  // 一覧の項目をタップした時。選択に加えて、代表座標が分かっていればflyToする。
  // useCallbackで参照を安定させ、WarningAreaListPanel(memo化済み)がBottomDockの
  // 再レンダー(ドラッグ中のアニメーション等)のたびに再レンダーされるのを防ぐ。
  const handleSelectWarningAreaFromList = useCallback((regioncode) => {
    setSelectedWarningArea(regioncode);
    const area = warningAreaByRegioncode[regioncode];
    if (area && area.lat != null && area.lon != null) {
      setWarningAreaFlyToRequest({ lon: area.lon, lat: area.lat, nonce: Date.now() });
    }
  }, [warningAreaByRegioncode]);
  // 詳細カードの「戻る」ボタン。
  function handleBackFromWarningArea() {
    setSelectedWarningArea(null);
  }

  // 断層(faults.geojson)の表示ON/OFF。設定タブ「地震」内のトグルで操作し、
  // localStorageに永続化する。ファイルサイズが大きいためデフォルトはOFF。
  const [faultsEnabled, setFaultsEnabledState] = useState(loadStoredFaultsEnabled);

  function handleChangeFaultsEnabled(next) {
    setFaultsEnabledState(next);
    saveFaultsEnabled(next);
  }

  // プレート境界(plate-boundaries.json)の表示ON/OFF。断層と同様。
  const [plateBoundariesEnabled, setPlateBoundariesEnabledState] = useState(loadStoredPlateBoundariesEnabled);

  function handleChangePlateBoundariesEnabled(next) {
    setPlateBoundariesEnabledState(next);
    savePlateBoundariesEnabled(next);
  }

  // 震央分布(地図上の丸)の表示ON/OFF。設定タブ「地震」内のトグルで操作し、
  // localStorageに永続化する。デフォルトはOFF。
  const [epicenterCirclesEnabled, setEpicenterCirclesEnabledState] = useState(loadStoredEpicenterCirclesEnabled);

  function handleChangeEpicenterCirclesEnabled(next) {
    setEpicenterCirclesEnabledState(next);
    saveEpicenterCirclesEnabled(next);
  }

  // 断層・プレート境界の「枠内の色」。設定タブ「地震」内の色選択で操作し、localStorageに永続化する。
  const [boundaryLineColorId, setBoundaryLineColorIdState] = useState(loadStoredBoundaryLineColorId);

  function handleChangeBoundaryLineColorId(next) {
    setBoundaryLineColorIdState(next);
    saveBoundaryLineColorId(next);
  }

  // 震度観測点リスト(各地の震度)の表示方法。"grouped"(階層表示、既定) | "list"(一覧表示)。
  // 設定タブ「地震」内から切り替え、localStorageに永続化する。
  const [stationListDisplayMode, setStationListDisplayModeState] = useState(loadStoredStationListDisplayMode);

  function handleChangeStationListDisplayMode(next) {
    setStationListDisplayModeState(next);
    saveStationListDisplayMode(next);
  }

  // 地震一覧の取得件数(1〜1000、デフォルト100)。設定タブで変更すると一覧を取り直す。
  const [quakeFetchLimit, setQuakeFetchLimitState] = useState(loadStoredQuakeFetchLimit);

  function handleChangeQuakeFetchLimit(next) {
    const clamped = clampQuakeFetchLimit(next);
    setQuakeFetchLimitState(clamped);
    saveQuakeFetchLimit(clamped);
  }

  // 地震情報(P2P地震情報API)
  const [quakes,          setQuakes]          = useState([]);
  const [quakeStatus,     setQuakeStatus]     = useState("loading"); // loading | ready | error
  const [selectedQuakeId, setSelectedQuakeId] = useState(null);
  // WebSocketのイベントハンドラ(古いクロージャのまま生き続ける)から常に最新の
  // selectedQuakeIdを参照できるようにするためのref。
  // 以前はuseEffect(selectedQuakeIdの変化を見て同期)で更新していたが、それだと
  // 「地震を選択した直後(レンダー→コミット→エフェクト実行、が終わる前)に、
  // 同じ地震の続報がWebSocketで届いてidが差し替わる」という、選択とほぼ同時に
  // 起こるケースでrefの反映が間に合わず、続報側の「選択中の地震を後継idへ
  // 引き継ぐ」処理(下のconnectQuakeWebSocket・/history統合の両方)が発火条件を
  // 満たせず素通りしてしまい、選択がズレたまま戻せなくなる不具合があった
  // (戻るボタンが出ない/ツールバーが引っ込まないという形で表面化していた)。
  // → refの更新をuseEffect任せにせず、selectedQuakeIdを変更する箇所すべてで
  //   このselectQuake()を通すことで、state更新と完全に同じタイミング(同期的)
  //   でrefも更新されるようにする。
  const selectedQuakeIdRef = useRef(null);
  const selectQuake = useCallback((id) => {
    console.log("[quake-select-diag][selectQuake]", { from: selectedQuakeIdRef.current, to: id });
    selectedQuakeIdRef.current = id;
    setSelectedQuakeId(id);
  }, []);

  // 津波情報(P2P地震情報API)。地震情報と同じWebSocket接続を共有する(下のuseEffect参照)。
  const [tsunamis,          setTsunamis]          = useState([]);
  const [tsunamiStatus,     setTsunamiStatus]     = useState("loading"); // loading | ready | error
  const [selectedTsunamiId, setSelectedTsunamiId] = useState(null);

  /* ─────────────────────────────────────────────────────
     緊急地震速報(P2P地震情報 EEW, code:556)。地震・津波情報と同じWebSocket接続を
     共有する(下のuseEffect参照)。/historyでの初期取得は行わず、ライブ受信のみ。
     eventIdごとに最新のレコードだけを保持する(続報が来るたびに上書き)。
     ・取消(cancelled)を一度受信したら、以後に遅れて届く非取消の続報では
       上書きしない(取消の表示を覆さないため)。
     ・「最終報」を判定できるフィールドがAPIに無いため、受信のたびに
       receivedLocalAtを更新し、EEW_STALE_MS間続報が無ければ自動的に一覧から外す
       (別のuseEffectでタイマー管理。下方)。
     ───────────────────────────────────────────────────── */
  const [eews, setEews] = useState([]);

  function handleIncomingEew(newEew) {
    setEews(prev => {
      const idx = prev.findIndex(e => e.eventId === newEew.eventId);
      if (idx === -1) {
        const withLocal = { ...newEew, receivedLocalAt: Date.now(), cancelledLocalAt: newEew.cancelled ? Date.now() : null };
        // 新規の(続報ではない)緊急地震速報が来た時、設定タブ以外を見ていれば
        // 自動でEEW詳細画面に切り替える。設定タブだけは対象外
        // (設定変更中に画面が奪われて操作が中断されるのを避けるため)。
        if (activeNavRef.current !== "settings") setEewDetailOpen(true);
        return [withLocal, ...prev].slice(0, EEW_MAX_CONCURRENT);
      }
      const existing = prev[idx];
      // Wolfxを優先する方針: 既にWolfx由来のデータがある場合、P2P地震情報からの
      // 更新では上書きしない(Wolfx自身の更新は常に反映する)。
      if (existing.source === "wolfx" && newEew.source !== "wolfx") return prev;
      if (existing.cancelled && !newEew.cancelled) return prev; // 取消済みは以後の続報で覆さない
      const next = [...prev];
      next[idx] = {
        ...newEew,
        receivedLocalAt: Date.now(),
        cancelledLocalAt: newEew.cancelled ? (existing.cancelledLocalAt || Date.now()) : null,
      };
      return next;
    });
  }

  // 続報・取消が一定時間来ないEEWを定期的に取り除く(タイムアウト方式のライフサイクル管理)。
  useEffect(() => {
    const id = setInterval(() => {
      setEews(prev => {
        const now = Date.now();
        const next = prev.filter(e => {
          if (e.cancelled) return now - (e.cancelledLocalAt || 0) < EEW_CANCEL_LINGER_MS;
          return now - (e.receivedLocalAt || 0) < EEW_STALE_MS;
        });
        return next.length === prev.length ? prev : next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  /* ─────────────────────────────────────────────────────
     実験的機能: 緊急地震速報テスト配信
     実際のeews(WebSocketで更新され続ける)とは別のstateに持たせ、本物のデータ更新に
     巻き込まれて消えてしまわないようにする(津波テスト配信のtestTsunamiと同じ考え方)。
     index.html版の「複数EEW同時発報」「カスタムパラメータでの発報」に相当する機能を
     持たせるため、単一オブジェクトではなく配列(testEews)で複数のテストイベントを
     独立して保持し、それぞれ個別に続報・最終報・取消・削除ができるようにしている。
     ───────────────────────────────────────────────────── */
  const [testEews, setTestEews] = useState([]);

  // カスタムパラメータ(地震タブのカスタムEEWエディタ相当)から1件のテストEEWカードを組み立てる。
  // areas・maxIntensityKeyは呼び出し側で(距離減衰式により)計算済みのものを渡す。
  // idを指定した場合はそのidを使う(発報後も同じイベントを編集し続けるため、
  // フォームのeditingIdと一致させる必要がある)。
  function buildTestEewCard({ id, place, latitude, longitude, depth, magnitude, areas, maxIntensityKey, isWarnLevel, isPlum }) {
    const now = new Date();
    const originTimeStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    const resolvedId = id || `test_${now.getTime()}_${Math.floor(Math.random() * 1000)}`;
    return {
      id: resolvedId, eventId: resolvedId,
      serial: "1",
      cancelled: false,
      isTraining: false,
      originTime: originTimeStr,
      arrivalTime: null,
      isAssumedHypocenter: false,
      place: place || "テスト震源",
      reducedPlace: "テスト",
      latitude, longitude, depth,
      magnitude,
      areas,
      maxIntensityKey,
      isTest: true,
      source: "test",
      isFinal: false,
      isWarnLevel: !!isWarnLevel,
      isPlum: !!isPlum,
      receivedLocalAt: Date.now(),
      cancelledLocalAt: null,
    };
  }

  // カスタムEEWエディタの初期値・「新規」に戻した時の値。
  function defaultEewTestForm() {
    return {
      editingId: null, // nullなら「新規発報」、既存イベントのidが入っていれば「そのイベントへの続報」
      place: "テスト震源(相模湾)",
      latitude: 35.2,
      longitude: 139.3,
      depth: 20,
      magnitude: 5.8,
      isPlum: false,
    };
  }
  const [eewTestForm, setEewTestForm] = useState(defaultEewTestForm);

  // 「地図をタップして震源を指定」モード。ONの間はMapCanvas側のクリックが
  // 震源ピックとして扱われる(津波警報テスト配信のtsunamiAreaPickActiveと同じ考え方)。
  const [eewEpicenterPickActive, setEewEpicenterPickActive] = useState(false);

  /**
   * テスト配信パネルからの操作を一手に受け付ける単一ディスパッチャ。
   * action:
   *   "dispatchForm" 現在のフォーム内容で発報。editingIdがあれば該当イベントへの
   *                  続報(震度・位置などを書き換えつつreportを1つ進める)、
   *                  無ければ新規イベントとして追加する。各地域の予測震度は
   *                  M・深さ・震源からの距離による減衰式でそのつど計算する
   *   "editLoad"     既存イベント(id)の現在値をフォームに読み込み、続報編集モードにする
   *   "resetForm"    フォームを初期値に戻し、続報編集モードを解除する(「新規」ボタン用)
   *   "startEpicenterPick" / "cancelEpicenterPick"  地図タップでの震源指定モードの開始/終了
   *   "update"(続報。パラメータは変えずreportだけ1つ進める) | "finalize"(最終報として発報) |
   *   "cancel"(取消を発報) | "remove"(一覧から削除) | "clearAll"(全部削除)
   */
  function handleTestEewAction(action, payload) {
    if (action === "dispatchForm") {
      const { editingId, ...params } = payload;
      // editingIdが現在のtestEewsに実在するかをここで(setState前に)確定させる。
      // idもここで一度だけ発行し、そのidをそのままフォームのeditingIdへ書き戻すことで、
      // 発報後も「このイベントを編集中」の状態を保つ(index.html版のcurrentSimEventIdと
      // 同じ考え方。以前はdefaultEewTestForm()でeditingIdごと消していたため、続けて
      // 「追加発報」を押すと毎回別イベント扱いになってしまっていた)。
      const idx = editingId ? testEews.findIndex(e => e.id === editingId) : -1;
      const isNew = idx === -1;
      const resultId = isNew ? `test_${Date.now()}_${Math.floor(Math.random() * 1000)}` : testEews[idx].id;
      setEewTestForm(prev => ({ ...prev, editingId: resultId }));

      // 各地域の予測最大震度は細分区域.jsonが要るため、距離減衰式の計算自体は
      // loadGeoData()の解決を待ってから行う(地図表示時に読み込み済みなので、
      // 実際にはほぼ即座に解決する)。
      loadGeoData().then(({ areas: areasGeoJSON }) => {
        const { areas, maxIntensityKey } = calcTestEewAreasByAttenuation(
          areasGeoJSON, params.latitude, params.longitude, params.magnitude, params.depth, params.isPlum
        );
        // 警報/予報はテスト機能限定のルール: 最大震度5弱以上を警報、4以下を予報として
        // 自動判定する。一度警報級になったイベントは、その後の続報で計算上の震度が
        // 下がっても予報には戻さない(気象庁の実運用でも警報は取消されるまで解除されない)。
        const computedIsWarnLevel = isTestWarnLevel(maxIntensityKey);
        if (isNew) {
          setTestEews(prev => [...prev, buildTestEewCard({
            ...params, id: resultId, areas, maxIntensityKey, isWarnLevel: computedIsWarnLevel,
          })]);
        } else {
          setTestEews(prev => {
            const i = prev.findIndex(e => e.id === resultId);
            if (i === -1) return prev;
            const next = [...prev];
            const isWarnLevel = next[i].isWarnLevel === true ? true : computedIsWarnLevel;
            next[i] = {
              ...next[i],
              ...params,
              areas,
              maxIntensityKey,
              isWarnLevel,
              serial: String((parseInt(next[i].serial, 10) || 1) + 1),
              receivedLocalAt: Date.now(),
            };
            return next;
          });
        }
      }).catch(err => {
        console.error("細分区域データの読み込みに失敗しました(震度分布テスト):", err);
      });
      return;
    }
    if (action === "editLoad") {
      const target = testEews.find(e => e.id === payload?.id);
      if (!target) return;
      setEewTestForm({
        editingId: target.id,
        place: target.place,
        latitude: target.latitude,
        longitude: target.longitude,
        depth: target.depth,
        magnitude: target.magnitude,
        isPlum: !!target.isPlum,
      });
      return;
    }
    if (action === "resetForm") {
      setEewTestForm(defaultEewTestForm());
      return;
    }
    if (action === "patchForm") {
      setEewTestForm(prev => ({ ...prev, ...payload }));
      return;
    }
    if (action === "startEpicenterPick") {
      setEewEpicenterPickActive(true);
      return;
    }
    if (action === "cancelEpicenterPick") {
      setEewEpicenterPickActive(false);
      return;
    }
    if (action === "clearAll") {
      setTestEews([]);
      setEewTestForm(defaultEewTestForm());
      return;
    }
    // 以降は既存の特定イベント(id)に対する操作
    const { id } = payload || {};
    setTestEews(prev => {
      if (action === "remove") return prev.filter(e => e.id !== id);
      return prev.map(e => {
        if (e.id !== id) return e;
        if (action === "update") {
          return { ...e, serial: String((parseInt(e.serial, 10) || 1) + 1), receivedLocalAt: Date.now() };
        }
        if (action === "finalize") {
          return { ...e, serial: String((parseInt(e.serial, 10) || 1) + 1), isFinal: true, receivedLocalAt: Date.now() };
        }
        if (action === "cancel") {
          return { ...e, cancelled: true, cancelledLocalAt: Date.now(), receivedLocalAt: Date.now() };
        }
        return e;
      });
    });
    if (action === "remove" && eewTestForm.editingId === id) setEewTestForm(defaultEewTestForm());
  }

  // 地図タップで震源が確定した時のハンドラ(MapCanvasのonPickEewEpicenterから呼ばれる)。
  // 震央地名が判定できなかった場合(ep.jsonの読み込み失敗・データ範囲外など)は、
  // 前回の値を使い回さず、タップした座標そのものを地名欄に表示する。
  function handlePickEewEpicenter(lat, lon, placeName) {
    setEewTestForm(prev => ({
      ...prev,
      latitude: lat,
      longitude: lon,
      place: placeName || `テスト震源(北緯${lat.toFixed(2)}度 東経${lon.toFixed(2)}度)`,
    }));
    setEewEpicenterPickActive(false);
  }

  // テスト配信中は、実際の一覧の先頭にテストデータを合成する。地図・パネルとも、
  // 以降のEEW関連の判定はこちら(effectiveEews)を使う。
  const effectiveEews = testEews.length > 0 ? [...testEews, ...eews] : eews;

  // 緊急地震速報の詳細フローティングカードを表示中かどうか。左上のEewFabButtonを
  // 押すとtrueになり、専用の「戻る」ボタンで閉じるとfalseに戻る。既存のタブ
  // バー(NAV/activeNav)とは独立させ、どのタブを見ている最中でも割り込んで
  // 開けるようにしている。表示中の全EEWが無くなったら自動的に閉じる。
  // FAB/戻るボタン自体と、詳細カードの実際の描画はBottomDock側(戻るボタンと
  // 同じbackButtonBottom基準の高さに出すため)で行う。
  const [eewDetailOpen, setEewDetailOpen] = useState(false);
  useEffect(() => {
    if (eewDetailOpen && effectiveEews.length === 0) setEewDetailOpen(false);
  }, [eewDetailOpen, effectiveEews.length]);
  // FAB(!ボタン)を押すたびに1増える信号。eewDetailOpenは既にtrueのままだと
  // 値が変化せず「開いた瞬間」を検知するuseEffectが反応しないため、既に開いている
  // 状態でFABを押し直した時(例: 手元でパネルを閉じた後、再度確認したい時)にも
  // 確実にパネルの高さを開き直せるよう、別の信号として持たせている。
  const [eewOpenSignal, setEewOpenSignal] = useState(0);

  /* ─────────────────────────────────────────────────────
     実験的機能: 地震情報テスト配信
     設定の「実験的・テスト機能」がONの時だけ使える、UI確認用のダミー地震情報。
     緊急地震速報・津波警報のテスト配信と同じ考え方で、実際のquakes(WebSocketで
     更新され続ける)とは別のstateに持たせ、使う場面(effectiveQuakes)でだけ合成する。
     ①震度速報→②震源に関する情報→③震度に関する情報、と段階を追って配信できる
     ようにし、実際のmergeQuakeCards(dedupeQuakeList)がそのまま使えることを
     確認できるようにする。EEWと違い複数イベントを同時管理する必要は薄いため、
     testEews(配列)ではなく1件のtestQuakeだけを持つ簡易な設計にしている。
     ───────────────────────────────────────────────────── */
  function defaultQuakeTestForm() {
    return {
      place: "テスト震源(相模湾)",
      latitude: 35.2,
      longitude: 139.3,
      depth: 20,
      magnitude: 5.8,
      domesticTsunami: "None", // ③確定報で使う津波判定
    };
  }
  const [quakeTestForm, setQuakeTestForm] = useState(defaultQuakeTestForm);
  const [testQuake, setTestQuake] = useState(null); // mergeQuakeCardsで段階的に更新される1件のテスト地震
  const [quakeEpicenterPickActive, setQuakeEpicenterPickActive] = useState(false);
  const [quakeTestAutoPlaying, setQuakeTestAutoPlaying] = useState(false);
  // 配信中のテスト地震の発生時刻(time)。①〜③を同じ地震の続報として統合するための
  // グループキー。「新規」でクリアするまで、続けて②③を押しても同じ地震として扱われる。
  const testQuakeTimeRef = useRef(null);

  /**
   * 地震情報テスト配信パネルからの操作を受け付けるディスパッチャ。
   * action:
   *   "patchForm"           フォームの値を部分更新する
   *   "broadcastStage"      { stage: "prompt"|"destination"|"detail" } の段階を配信する。
   *                         同じテスト地震(testQuakeTimeRef)への続報として、既存の
   *                         testQuakeとmergeQuakeCardsで統合する。
   *   "autoPlaySequence"    新規のテスト地震を①→②→③の順に数秒間隔で自動配信する
   *   "startEpicenterPick" / "cancelEpicenterPick"  地図タップでの震源指定モードの開始/終了
   *   "resetForm"           フォームを初期値に戻す
   *   "clearAll"            配信中のテスト地震・フォームをすべて片付ける
   */
  function handleTestQuakeAction(action, payload) {
    if (action === "patchForm") {
      setQuakeTestForm(prev => ({ ...prev, ...payload }));
      return;
    }
    if (action === "startEpicenterPick") {
      setQuakeEpicenterPickActive(true);
      return;
    }
    if (action === "cancelEpicenterPick") {
      setQuakeEpicenterPickActive(false);
      return;
    }
    if (action === "resetForm") {
      setQuakeTestForm(defaultQuakeTestForm());
      return;
    }
    if (action === "clearAll") {
      setTestQuake(null);
      testQuakeTimeRef.current = null;
      setQuakeTestAutoPlaying(false);
      setQuakeTestForm(defaultQuakeTestForm());
      return;
    }
    if (action === "broadcastStage") {
      const { stage } = payload;
      if (!testQuakeTimeRef.current) {
        const now = new Date();
        const pad2 = n => String(n).padStart(2, "0");
        testQuakeTimeRef.current = `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
      }
      const time = testQuakeTimeRef.current;
      const now2 = new Date();
      const pad2b = n => String(n).padStart(2, "0");
      const issueTimeStr = `${now2.getFullYear()}/${pad2b(now2.getMonth() + 1)}/${pad2b(now2.getDate())} ${pad2b(now2.getHours())}:${pad2b(now2.getMinutes())}:${pad2b(now2.getSeconds())}`;
      // 各地域の震度分布は細分区域.jsonが要るため、loadGeoData()の解決を待ってから計算する
      // (地図表示時に読み込み済みなので、実際にはほぼ即座に解決する)。
      loadGeoData().then(({ areas: areasGeoJSON }) => {
        const card = buildTestQuakeStageCard(stage, quakeTestForm, time, issueTimeStr, areasGeoJSON);
        setTestQuake(prev => {
          const merged = mergeQuakeCards(prev, card);
          // 段階が進むとtestQuakeのid(test_..._prompt→test_..._destination等)が
          // 変わるため、実際のP2P地震情報のWebSocket受信時と同じ理由で、選択中の
          // まま何もしないと選択が外れて詳細画面が一覧表示に戻ってしまう。
          // 選択中のテスト地震がこの続報の対象そのものであれば、新しいidへ
          // 選択を引き継ぐ。
          if (prev && selectedQuakeIdRef.current === prev.id && merged.id !== prev.id) {
            selectQuake(merged.id);
          }
          return merged;
        });
      }).catch(err => {
        console.error("細分区域データの読み込みに失敗しました(地震情報テスト):", err);
      });
      return;
    }
    if (action === "autoPlaySequence") {
      // 新規のテスト地震として、①→②→③を数秒間隔で自動配信する。
      testQuakeTimeRef.current = null;
      setTestQuake(null);
      setQuakeTestAutoPlaying(true);
      const stages = ["prompt", "destination", "detail"];
      let i = 0;
      const step = () => {
        handleTestQuakeAction("broadcastStage", { stage: stages[i] });
        i += 1;
        if (i < stages.length) {
          setTimeout(step, 3000);
        } else {
          setQuakeTestAutoPlaying(false);
        }
      };
      step();
      return;
    }
  }

  // 地図タップで震源が確定した時のハンドラ(MapCanvasのonPickEewEpicenterから呼ばれる。
  // 「今どちらのテスト配信パネルを開いているか」で行き先を切り替えるのではなく、
  // quakeEpicenterPickActiveがtrueの間だけこちらへ、そうでなければEEW側へ、という
  // 単純な排他制御にしている(両方同時にONにはならない)。
  function handlePickQuakeEpicenter(lat, lon, placeName) {
    setQuakeTestForm(prev => ({
      ...prev,
      latitude: lat,
      longitude: lon,
      place: placeName || `テスト震源(北緯${lat.toFixed(2)}度 東経${lon.toFixed(2)}度)`,
    }));
    setQuakeEpicenterPickActive(false);
  }

  // テスト配信中は、実際の一覧の先頭にテストデータを合成する。地震タブに関する
  // App側の判定(一覧・選択中の地震・地図表示)は、以降すべてこちらを使う。
  const effectiveQuakes = testQuake ? [testQuake, ...quakes] : quakes;

  /* ─────────────────────────────────────────────────────
     実験的機能: 津波警報テスト配信
     設定の「実験的・テスト機能」がONの時だけ使える、UI確認用のダミー津波情報。
     実際のtsunamis(WebSocketで更新され続ける)とは別のstateに持たせ、
     使う場面(effectiveTsunamis)でだけ合成することで、本物のデータ更新に
     巻き込まれて消えてしまわないようにしている。
     ───────────────────────────────────────────────────── */
  const [testTsunami, setTestTsunami] = useState(null); // { ...tsunamiカード, isTest: true } | null

  function broadcastTestTsunami({ areas, heightOverrides }) {
    const now = new Date();
    const pad2 = n => String(n).padStart(2, "0");
    const timeStr = `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    const list = (areas && areas.length > 0) ? areas : [{ name: "テスト予報区", grade: "Warning" }];
    // 実際の津波情報(toTsunamiCard)と同じ考え方で、選んだ予報区の中で最も危険度が
    // 高いgradeを代表(maxGrade)として使う。予報区ごとに異なるグレードを選べるため。
    let maxGrade = null;
    let maxWeight = -1;
    list.forEach(a => {
      const w = tsunamiGradeInfo(a.grade).weight;
      if (w > maxWeight) { maxWeight = w; maxGrade = a.grade; }
    });
    // 観測点コード→高さ(m)の対応表。tsunamiHeightByStationの計算で、実際の
    // 潮位データから求めた値より優先して使われる(App側参照)。
    const heightOverridesMap = {};
    (heightOverrides || []).forEach(h => { heightOverridesMap[h.code] = h.heightM; });
    setTestTsunami({
      id: `test_${now.getTime()}`,
      time: timeStr,
      cancelled: false,
      areas: list.map(a => ({
        name: a.name, grade: a.grade,
        immediate: false, firstHeightCondition: null, firstHeightTime: null, maxHeightDescription: null,
      })),
      maxGrade,
      isTest: true,
      heightOverrides: heightOverridesMap,
    });
  }
  function cancelTestTsunami() {
    setTestTsunami(prev => (prev ? { ...prev, cancelled: true, maxGrade: null } : null));
  }
  function clearTestTsunami() {
    setTestTsunami(null);
  }

  // テスト配信中は、実際の一覧の先頭にテストデータを合成する。以降、津波タブに
  // 関するApp側の判定(現在有効な津波・選択中の津波・地図表示)は、すべてこちらを使う。
  const effectiveTsunamis = testTsunami ? [testTsunami, ...tsunamis] : tsunamis;

  /* ─────────────────────────────────────────────────────
     津波警報テスト配信: 予報区を「地図上の海岸線タップ」で選ぶモード(複数選択・
     予報区ごとに異なるグレードの割り当てが可能)。
     予報区名を手入力する代わりに、地図に表示される津波予報区の海岸線を
     直接タップして選べるようにする。ピックモード中は「今どのグレードで塗るか」を
     activePickGradeで管理し(バナーのパレットで切り替え)、タップした瞬間の
     activePickGradeがその予報区に割り当てられる。
       ・未選択の予報区をタップ → activePickGradeで新規追加
       ・すでにactivePickGradeと同じグレードで選択済みの予報区をタップ → 選択解除
       ・すでに別のグレードで選択済みの予報区をタップ → activePickGradeに塗り替え
     ON中はBottomDock側がフローティングを低くたたんで地図を見せ(BottomDockの
     useEffectでtsunamiAreaPickActiveを監視)、MapCanvas側は全予報区の海岸線を薄く
     表示してタップを受け付け、選択済みの予報区は各自のグレードに応じた実際の
     津波警報と同じ配色で強調表示する(MapCanvas参照。buildTsunamiAreaColorExprを
     そのまま再利用)。
     1回のタップごとに閉じるのではなく、「完了」で確定・「キャンセル」でピック開始時点の
     選択に戻す、という明示的な操作でモードを終える。
     ───────────────────────────────────────────────────── */
  const [tsunamiAreaPickActive, setTsunamiAreaPickActive] = useState(false);
  const [pickedTsunamiAreas, setPickedTsunamiAreas] = useState([]); // [{ name, grade }]
  const [activePickGrade, setActivePickGrade] = useState("Warning"); // 今タップしたら何グレードで塗るか
  const pickedTsunamiAreasSnapshotRef = useRef([]); // キャンセル時に戻す先

  function startTsunamiAreaPick() {
    pickedTsunamiAreasSnapshotRef.current = pickedTsunamiAreas;
    pickedTsunamiHeightsSnapshotRef.current = pickedTsunamiHeights;
    setTsunamiAreaPickActive(true);
  }
  function finishTsunamiAreaPick() {
    setTsunamiAreaPickActive(false);
  }
  function cancelTsunamiAreaPick() {
    setPickedTsunamiAreas(pickedTsunamiAreasSnapshotRef.current);
    setPickedTsunamiHeights(pickedTsunamiHeightsSnapshotRef.current);
    setTsunamiAreaPickActive(false);
  }
  function handlePickTsunamiArea(name) {
    setPickedTsunamiAreas(prev => {
      const idx = prev.findIndex(a => a.name === name);
      if (idx === -1) return [...prev, { name, grade: activePickGrade }]; // 新規選択
      if (prev[idx].grade === activePickGrade) return prev.filter(a => a.name !== name); // 同じグレードの再タップ→解除
      const next = [...prev]; // 別グレードでの再タップ→塗り替え
      next[idx] = { name, grade: activePickGrade };
      return next;
    });
  }
  // テスト配信パネル側の一覧チップの×ボタンから、地図タップ(ピックモード)を
  // 経由せずに直接1件だけ選択解除する。
  function removeTsunamiAreaPick(name) {
    setPickedTsunamiAreas(prev => prev.filter(a => a.name !== name));
  }
  // パネルの一覧チップから、地図に戻らず直接そのグレードを変更する
  // (TEST_TSUNAMI_GRADE_OPTIONSの並び順で次のグレードへ巡回)。
  function cycleTsunamiAreaGrade(name) {
    const order = TEST_TSUNAMI_GRADE_OPTIONS.map(o => o.value);
    setPickedTsunamiAreas(prev => prev.map(a => {
      if (a.name !== name) return a;
      const next = order[(order.indexOf(a.grade) + 1) % order.length];
      return { ...a, grade: next };
    }));
  }

  /* ─────────────────────────────────────────────────────
     津波警報テスト配信: 観測点(潮位計)の「観測された津波の高さ」もテストできるように、
     実在の観測点をタップして高さ(m)を手入力できるようにする。予報区ピックと同じ
     ピックモード・同じ地図タップ操作を共有し(handleSelectTideStationOnMap内で分岐)、
     海岸線をタップすれば予報区、観測点の丸をタップすれば高さ入力、という使い分けに
     なる。ここで設定した値は、実際の潮位データから計算する値の代わりに使われる
     (App側のtsunamiHeightByStation参照)。
     ───────────────────────────────────────────────────── */
  const [pickedTsunamiHeights, setPickedTsunamiHeights] = useState([]); // [{ code, name, heightM }]
  const pickedTsunamiHeightsSnapshotRef = useRef([]); // キャンセル時に戻す先

  const TSUNAMI_HEIGHT_PICK_DEFAULT_M = 1.0;
  function addTsunamiHeightPick(code) {
    if (!code || pickedTsunamiHeights.some(h => h.code === code)) return;
    const st = candidateHeightStations.find(s => s.code === code);
    if (!st) return;
    setPickedTsunamiHeights(prev => [...prev, { code: st.code, name: st.name, heightM: TSUNAMI_HEIGHT_PICK_DEFAULT_M }]);
  }
  function changeTsunamiHeightPick(code, heightM) {
    setPickedTsunamiHeights(prev => prev.map(h => (h.code === code ? { ...h, heightM } : h)));
  }
  function removeTsunamiHeightPick(code) {
    setPickedTsunamiHeights(prev => prev.filter(h => h.code !== code));
  }

  // 津波タブ「過去」モード用。直近一覧(tsunamis)とは別に、/history APIを
  // offsetで遡りながら追加取得した過去の津波情報を保持する(地震タブの
  // searchQuakeと同じ理由でWebSocketの新着・件数上限の影響を受けないようにする)。
  const [tsunamiHistory, setTsunamiHistory] = useState({
    items: [], offset: 0, status: "idle", hasMore: true, debug: "",
  }); // status: idle | loading | ready | error

  async function loadMoreTsunamiHistory() {
    if (tsunamiHistory.status === "loading" || !tsunamiHistory.hasMore) return;
    setTsunamiHistory(prev => ({ ...prev, status: "loading" }));
    const debugParts = [];
    try {
      // 初回は、気象庁の公式一覧(list.json)と、P2P地震情報の津波予報専用API
      // (/v2/jma/tsunami)の先頭2ページ(offset 0, 100)をまとめて取得して統合する。
      if (tsunamiHistory.offset === 0 && tsunamiHistory.items.length === 0) {
        const [jmaItems, p2pPage1, p2pPage2] = await Promise.all([
          fetchJmaTsunamiHistory()
            .then(r => { debugParts.push(`気象庁:${r.length}件`); return r; })
            .catch(err => { console.error("気象庁 津波情報一覧の取得に失敗:", err); debugParts.push(`気象庁:失敗(${err.message})`); return []; }),
          fetchTsunamiHistoryPage(0, TSUNAMI_HISTORY_PAGE_SIZE)
            .then(r => { debugParts.push(`P2P#1:${r.length}件`); return r; })
            .catch(err => { console.error("P2P地震情報 過去の津波情報の取得に失敗:", err); debugParts.push(`P2P#1:失敗(${err.message})`); return []; }),
          fetchTsunamiHistoryPage(TSUNAMI_HISTORY_PAGE_SIZE, TSUNAMI_HISTORY_PAGE_SIZE)
            .then(r => { debugParts.push(`P2P#2:${r.length}件`); return r; })
            .catch(err => { console.error("P2P地震情報 過去の津波情報の取得に失敗:", err); debugParts.push(`P2P#2:失敗(${err.message})`); return []; }),
        ]);
        const p2pItems = [...p2pPage1, ...p2pPage2];
        setTsunamiHistory({
          items: mergeTsunamiSources(jmaItems, p2pItems),
          offset: TSUNAMI_HISTORY_PAGE_SIZE * 2,
          status: "ready",
          hasMore: p2pPage2.length >= TSUNAMI_HISTORY_PAGE_SIZE,
          debug: debugParts.join(" / "),
        });
        return;
      }

      // 2回目以降の「もっと見る」は、P2P地震情報側のoffsetをさらに進めて補う。
      const page = await fetchTsunamiHistoryPage(tsunamiHistory.offset, TSUNAMI_HISTORY_PAGE_SIZE);
      setTsunamiHistory(prev => ({
        items: mergeTsunamiSources(prev.items, page),
        offset: prev.offset + TSUNAMI_HISTORY_PAGE_SIZE,
        status: "ready",
        hasMore: page.length >= TSUNAMI_HISTORY_PAGE_SIZE,
        debug: `P2P追加:${page.length}件`,
      }));
    } catch (err) {
      console.error("過去の津波情報の取得に失敗:", err);
      setTsunamiHistory(prev => ({ ...prev, status: "error", debug: err.message || String(err) }));
    }
  }

  /* ─────────────────────────────────────────────────────
     潮位計(津波タブ「潮位計」モード)
     ・tsunamiViewModeはBottomDock内のローカルstateなので、地図にピンを出すか
       どうかの判断のためだけに、ここへも同じ値を通知してもらう
       (causingQuakeCardと同じ「report up」パターン)。
     ・観測点一覧(tideStations)は初めて潮位計モードを開いた時に1回だけ取得し、
       以降はキャッシュを使い回す。
     ・観測値(tideObsByStation)は地点コードごとにキャッシュし、選び直しても
       同じ日ならAPIを叩き直さない。
     ───────────────────────────────────────────────────── */
  const [tsunamiViewModeTop, setTsunamiViewModeTop] = useState("recent");
  const showTideGaugeLayer = !eewDetailOpen && activeNav === "tsunami" && tsunamiViewModeTop === "tidegauge";

  // 気象タブ「地点」モードでGPS取得できている間だけBottomDock側から伝わってくる、
  // 現在地の緯度経度(地図の青丸表示用)。それ以外は常にnull。
  const [currentLocationPoint, setCurrentLocationPoint] = useState(null);
  // 雨雲レーダーがON中の現在の時刻コマ({basetime, validtime})。BottomDock側から
  // 伝わってくる。OFFの間・未読込の間はnull。
  const [nowcastFrame, setNowcastFrame] = useState(null);
  // 前後の先読み対象コマ(コマ切り替え時に一瞬レーダーが消えないよう、地図側で
  // バックグラウンドにタイルを読み込んでおくために使う)。
  const [nowcastPreloadFrames, setNowcastPreloadFrames] = useState([]);
  // 実況+予測の全validtime一覧(5分おきに更新される)。地図側のキャッシュのうち、
  // もうどのコマにも該当しなくなった(=特に予測コマは更新のたびにほぼ丸ごと
  // 入れ替わる)ものを掃除するために使う。
  const [nowcastKnownValidtimes, setNowcastKnownValidtimes] = useState([]);
  // BottomDock側のonNowcastChangeは{frame, preloadFrames, knownValidtimes} | nullを渡してくる。
  // 3つのstateへ振り分ける。
  const handleNowcastChange = useCallback((payload) => {
    setNowcastFrame(payload ? payload.frame : null);
    setNowcastPreloadFrames(payload ? payload.preloadFrames : []);
    setNowcastKnownValidtimes(payload ? payload.knownValidtimes : []);
  }, []);
  // 1/3/24時間降水量がON中の現在のモード・時刻コマ。BottomDock側から伝わってくる。
  // 雨雲レーダーとは排他なので、オンになるのはどちらか一方だけ。
  const [precipMode, setPrecipMode] = useState(null);
  const [precipFrame, setPrecipFrame] = useState(null);
  // 現在のモードの全validtime一覧(5分おきの一覧更新で変わる)。地図側のキャッシュの
  // うち、もうどのコマにも該当しなくなったレイヤーの掃除に使う(雨雲レーダーの
  // nowcastKnownValidtimesと同じ考え方)。
  const [precipKnownValidtimes, setPrecipKnownValidtimes] = useState([]);
  const handlePrecipChange = useCallback((payload) => {
    setPrecipMode(payload ? payload.mode : null);
    setPrecipFrame(payload ? payload.frame : null);
    setPrecipKnownValidtimes(payload ? payload.knownValidtimes : []);
  }, []);
  // 天気分布予報がON中の現在のモード・時刻コマ。BottomDock側から伝わってくる。
  // 雨雲レーダー・降水量とは排他なので、オンになるのはどれか1つだけ。
  const [wdistMode, setWdistMode] = useState(null);
  const [wdistFrame, setWdistFrame] = useState(null);
  const [wdistKnownValidtimes, setWdistKnownValidtimes] = useState([]);
  const handleWdistChange = useCallback((payload) => {
    setWdistMode(payload ? payload.mode : null);
    setWdistFrame(payload ? payload.frame : null);
    setWdistKnownValidtimes(payload ? payload.knownValidtimes : []);
  }, []);
  // 台風情報がON中の現在のgeojson。BottomDock側から伝わってくる。OFFの間はnull。
  const [typhoonGeojson, setTyphoonGeojson] = useState(null);
  const handleTyphoonChange = useCallback((geojson) => {
    setTyphoonGeojson(geojson);
  }, []);
  // 警報タブのくの字メニューで選択中のキキクル(土砂/浸水)。BottomDock側から
  // {mode, frame, knownValidtimes} | null で伝わってくる(1/3/24時間降水量と
  // 全く同じ形)。MapCanvas側のriskVisible/riskMode/riskFrame/riskKnownValidtimes
  // に振り分ける。
  // 「今どの項目が選ばれているか」(alertLayerMode)は、キキクルの時刻コマの
  // 有無に関係なく常に正しく分かる必要がある(河川水位選択中は時刻コマが
  // そもそも存在しないため)。そのため、キキクルの時刻コマ通知
  // (handleAlertLayerChange)とは別経路(handleAlertModeChange)で管理する。
  const [alertLayerMode, setAlertLayerMode] = useState(null);
  const [alertLayerFrame, setAlertLayerFrame] = useState(null);
  const [alertLayerKnownValidtimes, setAlertLayerKnownValidtimes] = useState([]);
  const handleAlertModeChange = useCallback((mode) => {
    setAlertLayerMode(mode);
  }, []);
  const handleAlertLayerChange = useCallback((payload) => {
    setAlertLayerFrame(payload ? payload.frame : null);
    setAlertLayerKnownValidtimes(payload ? payload.knownValidtimes : []);
  }, []);

  // 警報タブのくの字メニューで選択中の「河川水位」。BottomDock側からGeoJSON
  // FeatureCollection | null で伝わってくる。MapCanvas側のriverVisible/
  // riverStationsに振り分ける。タップ中の観測所(詳細カード用)もここで持つ。
  const [riverStations, setRiverStations] = useState(null);
  const handleRiverLayerChange = useCallback((geojson) => {
    setRiverStations(geojson);
  }, []);
  const [selectedRiverStation, setSelectedRiverStation] = useState(null); // properties | null
  const handleSelectRiverStation = useCallback((properties) => {
    setSelectedRiverStation(properties || null);
  }, []);
  useEffect(() => {
    if (alertLayerMode !== "riverLevel") setSelectedRiverStation(null);
  }, [alertLayerMode]);
  // 台風の中心点/予報円をタップした時のproperties。BottomDock側のTyphoonDetailCardで
  // 表示する(時刻チップ=予報円タップ、台風一覧タップの両方でここに入る)。
  const [selectedTyphoonInfo, setSelectedTyphoonInfo] = useState(null);
  const handleSelectTyphoonCenter = useCallback((properties) => {
    setSelectedTyphoonInfo(properties || null);
  }, []);
  // 台風詳細の選択解除。「戻る」ボタン、およびフローティングを閉じた時にBottomDock側
  // から呼ばれる。
  const handleClearSelectedTyphoon = useCallback(() => {
    setSelectedTyphoonInfo(null);
  }, []);
  // 台風一覧の項目をタップした時、地図をその台風の強風域(無ければ暴風域、それも
  // 無ければ中心のみ)が画面に収まるズーム倍率でflyToするためのリクエスト。
  // {lon, lat, areaRadiusKm, areaLon, areaLat, nonce} | null。nonceは同じ地点を
  // 連続でタップしても毎回flyToが起きるようにするための単純カウンタ。
  const [typhoonFlyToRequest, setTyphoonFlyToRequest] = useState(null);
  const handleSelectTyphoon = useCallback((typhoon) => {
    if (!typhoon) return;
    setSelectedTyphoonInfo(typhoon);
    if (typhoon.lon != null && typhoon.lat != null) {
      setTyphoonFlyToRequest({
        lon: typhoon.lon, lat: typhoon.lat,
        areaRadiusKm: typhoon.areaRadiusKm ?? null,
        areaLon: typhoon.areaLon ?? typhoon.lon,
        areaLat: typhoon.areaLat ?? typhoon.lat,
        nonce: Date.now(),
      });
    }
  }, []);
  // 現在進行形で有効な(解除されていない)津波情報があるかどうか。潮位観測点
  // マスタの取得トリガー・自動表示の判定の両方で使う軽量な判定。
  const hasActiveTsunami = effectiveTsunamis.some(t => !t.cancelled);

  const [tideStations, setTideStations] = useState(EMPTY_EQDB_LIST);
  const [tideStationsStatus, setTideStationsStatus] = useState("idle"); // idle | loading | ready | error
  useEffect(() => {
    // 潮位計モードを開いた時・有効な津波情報がある間に加えて、津波警報テスト配信の
    // 予報区ピックモード中も取得しておく(テスト用の観測点タップ選択で実在の
    // 観測点一覧が必要なため)。
    if ((!showTideGaugeLayer && !hasActiveTsunami && !tsunamiAreaPickActive) || tideStationsStatus !== "idle") return;
    setTideStationsStatus("loading");
    fetchTideStations()
      .then(list => { setTideStations(list); setTideStationsStatus("ready"); })
      .catch(err => { console.error("潮位観測点一覧の取得に失敗:", err); setTideStationsStatus("error"); });
  }, [showTideGaugeLayer, hasActiveTsunami, tsunamiAreaPickActive, tideStationsStatus]);

  const [selectedTideStationCode, setSelectedTideStationCode] = useState(null);
  // 津波タブそのものを離れたら選択を解除する(戻ってきた時に地図のピンと表示が
  // ズレないように)。以前はtidegaugeモードを離れたタイミングで解除していたが、
  // 地図タップでの観測点選択が「潮位計」モードへ切り替えずその場(直近一覧など)で
  // 完結するようになったため、tidegaugeモードの出入りとは切り離す必要がある。
  useEffect(() => {
    if (activeNav !== "tsunami") setSelectedTideStationCode(null);
  }, [activeNav]);

  // 形: { [stationCode]: { date: "YYYYMMDD", days, status: "loading"|"ready"|"error", data } }
  const [tideObsByStation, setTideObsByStation] = useState({});
  // forceがtrueの時は、すでに読み込み済み(status: "ready")でも取得し直す。
  // 津波の観測値表示(観測点詳細)は1回読めば十分だが、地図上の「観測された津波の
  // 高さ」バーは警報等が続く間ずっと最新の最大波を追いたいので、そちらの定期更新
  // からはforce=trueで呼ぶ。
  async function loadTideObs(stationCode, force = false) {
    const dateStr = toTideDateStr(new Date());
    const cur = tideObsByStation[stationCode];
    if (cur && cur.status === "loading") return; // 進行中なら常にスキップ(forceでも二重発火は防ぐ)

    // 現在有効な津波警報・注意報・予報の対象予報区に属する観測点は、最大波の
    // 判定に必要な期間を確実にカバーするため、その現象の第１報の日付〜当日までを
    // 取得する。ただし第１報が当日発表の場合でも、前日分との比較(潮汐の推算誤差
    // チェック等)のため最低2日分(前日+当日)は必ず取得する。
    const isWarnedStation = activeTsunami != null &&
      tideStationsWithGrade.some(st => st.code === stationCode && st.activeGrade);
    const days = isWarnedStation && activeTsunamiEpisodeStartTime
      ? Math.max(2, daysBetweenDates(activeTsunamiEpisodeStartTime, new Date()))
      : 2;

    // 通常時は読み込み済みならスキップ。ただし、以前は非発令(2日分)で読み込んだ
    // 観測点が新たに発令対象になり、必要な日数が増えた場合は、forceでなくても
    // 取得し直す(そうしないと第１報以降の古いデータが欠けたままになるため)。
    if (!force && cur && cur.date === dateStr && cur.status === "ready" && (cur.days || 2) >= days) return;

    setTideObsByStation(prev => ({ ...prev, [stationCode]: { date: dateStr, days, status: "loading", data: null } }));
    try {
      const data = await fetchTideObsRange(stationCode, days);
      setTideObsByStation(prev => ({ ...prev, [stationCode]: { date: dateStr, days, status: "ready", data } }));
    } catch (err) {
      console.error("潮位観測値の取得に失敗:", err);
      setTideObsByStation(prev => ({ ...prev, [stationCode]: { date: dateStr, days, status: "error", data: null } }));
    }
  }

  // 観測点マスタ(緯度経度付き)。points[]との突き合わせに使う。
  const [stations, setStations] = useState(null);

  // 細分区域.json(EEWの地域塗り分けで使っているものと同じデータ)。
  // 震度速報(ScalePrompt)のisArea:trueな点は観測点マスタでは解決できず、
  // 地域名→区域コードのこちらの変換が必要なため、resolveStationPointsに渡す。
  // loadGeoData()はモジュール内でPromiseをキャッシュしているため、地図側で
  // 既に読み込み済みであれば実質即座に解決する。
  const [areasGeoJSON, setAreasGeoJSON] = useState(null);
  useEffect(() => {
    let cancelled = false;
    loadGeoData()
      .then(({ areas }) => { if (!cancelled) setAreasGeoJSON(areas); })
      .catch(err => console.error("細分区域データの取得に失敗:", err));
    return () => { cancelled = true; };
  }, []);

  // 気象庁 震度データベース(eqdb)検索で開いた地震。直近一覧(quakes)には混ぜず、
  // ここだけで別管理する(P2P地震情報のWebSocket更新・件数上限に巻き込まれないようにするため)。
  const [searchQuake, setSearchQuake] = useState(null);

  // 震央分布(地図上の丸)。今どの一覧(P2P一覧/近傍地震検索/データベース検索)を
  // 表示中かに応じて、BottomDock側で計算した点の配列をそのまま受け取る。
  const [epicenterPoints, setEpicenterPoints] = useState([]);
  // 震央分布の丸が、まだ全件分バックグラウンド解決しきっていない間true。
  // 地図側でローディング表示を出すために使う。
  const [epicenterLoading, setEpicenterLoading] = useState(false);

  // 震央分布の丸をタップして選択するたびに1増える信号。BottomDock側では
  // この値が変わるたびに、フローティングの高さを「中」に揃える
  // (一覧内から選んだ時のhandleSelectQuakeForScrollと同じ挙動にするため)。
  const [mapSelectSignal, setMapSelectSignal] = useState(0);

  // 震央分布の丸がタップされた時の選択処理。
  // ・P2P地震一覧由来の点(id=通常の地震ID)は、そのままselectedQuakeIdにする。
  // ・近傍地震検索・データベース検索由来の点(id="eqdb_"始まり)は、
  //   プリフェッチ済みのeqdb詳細(_eqdbDetail)を使って即座に検索結果と同じ形の
  //   quakeカードを組み立て、searchQuakeにセットしてから選択する
  //   (座標を取得済みということは詳細も取得済みなので、再取得は不要)。
  function handleSelectEpicenterPoint(id) {
    if (typeof id === "string" && id.startsWith("eqdb_")) {
      const point = epicenterPoints.find(p => p.id === id);
      if (!point || !point._eqdbDetail) return;
      loadGeoData().then(geo => {
        const card = buildEqdbQuakeCard(point._eqdbDetail, point._eqdbListItem, stations, geo?.areas);
        setSearchQuake(card);
        selectQuake(card.id);
        setMapSelectSignal(n => n + 1);
      });
      return;
    }
    selectQuake(id);
    setMapSelectSignal(n => n + 1);
  }

  const toggleLayer = id => {
    // 「推計震度分布」レイヤーだけは、layers配列ではなく設定と共有のestIntensityEnabled側で管理する
    if (id === "estIntensity") {
      handleChangeEstIntensityEnabled(!estIntensityEnabled);
      return;
    }
    setLayers(prev => prev.map(l => l.id === id ? { ...l, on: !l.on } : l));
  };

  // レイヤーパネルに渡す一覧。「推計震度分布」の見た目上のon/offは、layers配列の
  // 初期値ではなく、常にestIntensityEnabled(設定と共有・永続化されている値)を反映させる。
  const layersForPanel = useMemo(
    () => layers.map(l => l.id === "estIntensity" ? { ...l, on: estIntensityEnabled } : l),
    [layers, estIntensityEnabled]
  );

  // 観測点マスタは全地震で共通なので、起動時に一度だけ取得する
  useEffect(() => {
    let cancelled = false;
    loadStations()
      .then(list => { if (!cancelled) setStations(list); })
      .catch(err => console.error("観測点マスタの取得に失敗:", err));
    return () => { cancelled = true; };
  }, []);

  // 選択中の地震 + 観測点マスタが揃ったら、観測点ごとの震度に緯度経度を割り当てる。
  // 気象庁 震度データベース検索から開いた地震(searchQuake)は quakes には入っていないため、
  // そちらも見つからなかった場合のフォールバックとして探す。
  // (effectiveQuakesを使うことで、地震情報テスト配信中のダミー地震も選択・表示できる)
  const selectedQuake = effectiveQuakes.find(q => q.id === selectedQuakeId)
    || (searchQuake && searchQuake.id === selectedQuakeId ? searchQuake : null);

  // 観測点データが多い地震(震度データベース検索由来ではない、通常の地震一覧からの選択)は、
  // 観測点マスタとの突き合わせ(resolveStationPoints)が重くなり、選択直後に一瞬固まって
  // 見えることがある。selectedQuakeが変わった直後にまずローディング表示を出し、
  // 次のタスクにずらして計算することで、その間に「観測点データを処理中…」を描画させる。
  const [selectedQuakePoints, setSelectedQuakePoints] = useState([]);
  const [stationPointsProcessing, setStationPointsProcessing] = useState(false);
  useEffect(() => {
    if (!selectedQuake) {
      setSelectedQuakePoints([]);
      setStationPointsProcessing(false);
      return;
    }
    // eqdb由来の地震は、観測点の緯度経度を自前で解決済み(resolvedPoints)なのでそのまま使う。
    if (selectedQuake.resolvedPoints) {
      setSelectedQuakePoints(selectedQuake.resolvedPoints);
      setStationPointsProcessing(false);
      return;
    }
    if (!stations) {
      setSelectedQuakePoints([]);
      return;
    }
    setStationPointsProcessing(true);
    const points = selectedQuake.points;
    const timer = setTimeout(() => {
      setSelectedQuakePoints(resolveStationPoints(points, stations, areasGeoJSON));
      setStationPointsProcessing(false);
    }, 0);
    return () => clearTimeout(timer);
  }, [selectedQuake, stations, areasGeoJSON]);

  // 震源(バツ印表示・ズーム用)。複数震源(eqdbのhypocenters)があればその全件、
  // 無ければ従来通り単一のlatitude/longitudeを1件だけの配列にして使う。
  // 緯度経度が無い地震(震源不明)では空配列のまま。
  const selectedHypocenters = useMemo(() => {
    if (!selectedQuake) return [];
    if (Array.isArray(selectedQuake.hypocenters) && selectedQuake.hypocenters.length > 0) {
      return selectedQuake.hypocenters;
    }
    if (selectedQuake.latitude == null || selectedQuake.longitude == null) return [];
    return [{ latitude: selectedQuake.latitude, longitude: selectedQuake.longitude }];
  }, [selectedQuake]);

  // 津波タブの「↪︎津波を引き起こした地震」で見つかった地震(BottomDock内の
  // ローカルなcausingQuakeStateから、表示中の1件だけをここに通知してもらう)。
  // 地震タブのselectedQuakeとは別に持ち、津波タブを見ている間だけ地図に
  // 震源のバツ印・観測点の震度を表示するために使う。
  const [causingQuakeCard, setCausingQuakeCard] = useState(null);
  // 津波タブを離れたら、地図に出している「引き起こした地震」の表示は必ずクリアする。
  // これをやらないと、地震タブに移った時にそちらで選択中の地震ではなく、
  // 津波タブで最後に見ていた地震の震源・観測点が残って表示されてしまう。
  useEffect(() => {
    if (activeNav !== "tsunami") setCausingQuakeCard(null);
  }, [activeNav]);
  const causingQuakeHypocenters = useMemo(() => {
    if (!causingQuakeCard) return [];
    if (Array.isArray(causingQuakeCard.hypocenters) && causingQuakeCard.hypocenters.length > 0) {
      return causingQuakeCard.hypocenters;
    }
    if (causingQuakeCard.latitude == null || causingQuakeCard.longitude == null) return [];
    return [{ latitude: causingQuakeCard.latitude, longitude: causingQuakeCard.longitude }];
  }, [causingQuakeCard]);

  // 地図上の観測点マーカーの表示/非表示。地震タブ・津波タブ(引き起こした地震表示中)の
  // 両方で共有する(パネルの外に浮かぶ丸ボタンから切り替える)。
  const [stationMarkersVisible, setStationMarkersVisible] = useState(true);
  // 地震タブで地震を開くたびに、必ず「表示」状態からスタートする。
  useEffect(() => {
    if (selectedQuakeId != null) setStationMarkersVisible(true);
  }, [selectedQuakeId]);
  // 津波タブで「引き起こした地震」が見つかった時は、逆に「非表示」状態からスタートする
  // (津波タブでは観測点よりも津波の予報区の塗り分けを見たいことが多いため)。
  useEffect(() => {
    if (causingQuakeCard != null) setStationMarkersVisible(false);
  }, [causingQuakeCard]);

  // 起動時に /history で最新一覧を1回だけ取得し、以降はWebSocketで新着分を随時追加する。
  // quakeFetchLimit(設定タブで変更可能)が変わった場合も、この効果全体をやり直して
  // 新しい件数で一覧を取得し直す。
  const [wsStatus, setWsStatus] = useState("connecting"); // connecting | open | closed
  useEffect(() => {
    let cancelled = false;

    fetchRecentQuakes(quakeFetchLimit)
      .then(list => {
        if (cancelled) return;
        setQuakes(prev => {
          // /historyの完了より先にWebSocketで新着が届いていた場合、
          // ここで単純に上書き(setQuakes(list))してしまうと、
          // 「WebSocketで先に届いて選択していた地震」が/historyの
          // レスポンスにまだ反映されていない(配信の遅延)ことがあり、
          // 選択中の地震ごと一覧から消えてしまうことがあった。
          // → prev(それまでの一覧、WebSocket分を含む)とlist(/history)を
          //   idで統合し、どちらか一方にしか無い分もすべて残す。
          const byId = new Map();
          for (const q of list) byId.set(q.id, q);
          for (const q of prev) if (!byId.has(q.id)) byId.set(q.id, q);
          const merged = Array.from(byId.values())
            .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
            .slice(0, quakeFetchLimit);
          const result = dedupeQuakeList(merged);

          // 選択中の地震が、統合後もなお一覧に存在しない場合の後始末。
          // ただし気象庁 震度データベース検索由来(id が "eqdb_" 始まり)の地震は
          // そもそもこの一覧(P2P地震情報)には入らないため、対象外にする。
          // WebSocket受信時(下のconnectQuakeWebSocket側)と同じ理由で、
          // dedupeQuakeList側が「同じ地震のより情報量の多いレコード」を優先して
          // 別idを採用することがある(アプリを開いている間に新着地震を選択した
          // 直後、/historyの取得が完了してより詳細なレコードに差し替わる場合など)。
          // ここでも同様に、消えたレコードのidだけを見て即座に選択解除するのでは
          // なく、まず「同じ発生時刻」の後継レコードを探し、見つかれば
          // そちらに選択を引き継ぐ(見つからない場合だけ選択解除する)。これが
          // 無いと、新着地震を選んだ直後に選択が解除され、詳細画面が一覧表示に
          // 戻ってしまう(ボタンバーは出たまま、戻るボタンは出ない)不具合になる。
          // (以前はtime+placeの一致で判定していたが、震度速報→震源に関する情報の
          // 間でplaceが「震源地不明」→実際の地名に変わるため、時刻のみで判定する)
          const selId = selectedQuakeIdRef.current;
          if (selId != null && !String(selId).startsWith("eqdb_") && !result.some(q => q.id === selId)) {
            const prevSelected = prev.find(q => q.id === selId) || null;
            const successor = prevSelected
              ? result.find(q => q.time === prevSelected.time)
              : null;
            console.log("[quake-select-diag][history-merge] 選択中の地震が一覧から消失", {
              selId,
              prevSelected: prevSelected && { id: prevSelected.id, time: prevSelected.time, place: prevSelected.place },
              successor: successor ? { id: successor.id, time: successor.time, place: successor.place } : null,
              引き継ぎ結果: successor ? `成功(id=${successor.id}へ引き継ぎ)` : "失敗(選択解除)",
            });
            selectQuake(successor ? successor.id : null);
          }

          return result;
        });
        setQuakeStatus("ready");
      })
      .catch(err => {
        console.error("地震情報の取得に失敗:", err);
        if (cancelled) return;
        setQuakeStatus("error");
      });

    fetchRecentTsunamis(TSUNAMI_FETCH_LIMIT)
      .then(list => {
        if (cancelled) return;
        setTsunamis(prev => {
          // 地震情報と同じ理由(WebSocketの新着が/historyより先に届くことがある)で、
          // idで統合してどちらか一方にしか無い分も残す。
          const byId = new Map();
          for (const t of list) byId.set(t.id, t);
          for (const t of prev) if (!byId.has(t.id)) byId.set(t.id, t);
          return dedupeTsunamiList(Array.from(byId.values())).slice(0, TSUNAMI_FETCH_LIMIT);
        });
        setTsunamiStatus("ready");
      })
      .catch(err => {
        console.error("津波情報の取得に失敗:", err);
        if (cancelled) return;
        setTsunamiStatus("error");
      });

    // 緊急地震速報の起動時バックフィル。アプリを開いた時点で既にEEWが発表されて
    // いた場合、WebSocketは「接続後に届いたもの」しか拾えず、次の続報が来るまで
    // 何も表示されないという抜けが起きる。それを防ぐため、/historyを1回だけ見て、
    // 十分新しければ(EEW_HISTORY_FRESHNESS_MS以内)通常のWebSocket受信と同じ経路
    // (handleIncomingEew)に流し込む。以降の続報・取消はWebSocketで通常通り届く。
    // P2P地震情報・Wolfxの両方から同時に取りに行き、どちらが先に届いても
    // handleIncomingEew側のマージロジックがWolfx優先で正しく解決する。
    fetchLatestFreshEew()
      .then(eew => {
        if (cancelled || !eew) return;
        handleIncomingEew(eew);
      })
      .catch(err => {
        console.error("緊急地震速報の起動時取得(P2P地震情報)に失敗:", err);
        // ここで失敗しても、以降のWebSocketライブ受信には影響しない。
      });
    fetchLatestFreshEewFromWolfx()
      .then(eew => {
        if (cancelled || !eew) return;
        handleIncomingEew(eew);
      })
      .catch(err => {
        console.error("緊急地震速報の起動時取得(Wolfx)に失敗:", err);
      });

    const socket = connectQuakeWebSocket(
      (newQuake) => {
        if (cancelled) return;
        console.log("[quake-select-diag][ws-receive] 新着地震をWebSocketで受信", {
          id: newQuake.id, time: newQuake.time, place: newQuake.place,
          pointsCount: Array.isArray(newQuake.points) ? newQuake.points.length : 0,
          現在選択中のid: selectedQuakeIdRef.current,
        });
        setQuakes(prev => {
          // 選択中の地震(あれば)を、差し替え前に控えておく。
          // dedupeQuakeList等で「同じ地震の新しいレコード」に統合された場合、
          // 選択状態をそちらへ引き継ぐために使う。
          const prevSelected = prev.find(q => q.id === selectedQuakeIdRef.current) || null;

          // 同一idの重複配信を除外しつつ、新着を先頭に追加する。
          // 件数は/historyの初期取得と揃えて設定値(quakeFetchLimit)までに抑える。
          const deduped = prev.filter(q => q.id !== newQuake.id);
          const merged = [newQuake, ...deduped].slice(0, quakeFetchLimit);
          // 同じ地震の「震度を持つレコード」と「震源だけの空レコード」が
          // 別々に届くことがあるため、都度まとめて重複排除しておく。
          const result = dedupeQuakeList(merged);

          // 選択中だった地震が、上記の処理で一覧から消えていないか確認する。
          // 消えていて、かつ「同じ発生時刻」の後継レコードが
          // 残っている場合は、そちらに選択状態を引き継ぐ(カード表示が
          // 突然一覧表示に戻ってしまう・戻るボタンだけ残る、といった
          // ズレを防ぐため)。完全に消えた(後継も無い)場合は選択解除する。
          // (M・深さ・placeは電文の段階が進むにつれて修正・確定されることが
          // あるため、一致条件には含めず時刻のみで判定する)
          if (prevSelected && !result.some(q => q.id === prevSelected.id)) {
            const successor = result.find(q => q.time === prevSelected.time);
            console.log("[quake-select-diag][ws-receive] 選択中の地震が一覧から消失", {
              prevSelected: { id: prevSelected.id, time: prevSelected.time, place: prevSelected.place },
              newQuake: { id: newQuake.id, time: newQuake.time, place: newQuake.place },
              successor: successor ? { id: successor.id, time: successor.time, place: successor.place } : null,
              引き継ぎ結果: successor ? `成功(id=${successor.id}へ引き継ぎ)` : "失敗(選択解除)",
            });
            selectQuake(successor ? successor.id : null);
          }

          return result;
        });
        setQuakeStatus("ready");
      },
      (newTsunami) => {
        if (cancelled) return;
        setTsunamis(prev => {
          const deduped = prev.filter(t => t.id !== newTsunami.id);
          return dedupeTsunamiList([newTsunami, ...deduped]).slice(0, TSUNAMI_FETCH_LIMIT);
        });
        setTsunamiStatus("ready");
      },
      (newEew) => {
        if (cancelled) return;
        handleIncomingEew(newEew);
      },
      (status) => { if (!cancelled) setWsStatus(status); }
    );

    return () => { cancelled = true; socket.close(); };
  }, [quakeFetchLimit]);

  // Wolfxの緊急地震速報WebSocket。P2P地震情報とは完全に別のドメイン・接続なので、
  // 専用のuseEffectで独立して繋ぐ(quakeFetchLimitの変更などで無駄に再接続
  // されないよう、依存配列は空にしている)。
  useEffect(() => {
    let cancelled = false;
    const wolfxSocket = connectWolfxEewWebSocket(
      (newEew) => {
        if (cancelled) return;
        handleIncomingEew(newEew);
      },
      () => {} // 接続状態の表示は今のところP2P側(wsStatus)のみを見せているため無視
    );
    return () => { cancelled = true; wolfxSocket.close(); };
  }, []);

  // 断層・プレート境界・観測点マーカー・推計震度分布・震央分布など、地震情報に
  // 関する地図表示は、地震タブ・設定タブを見ている間だけ出す。津波・気象・警報
  // タブを開いている間は表示をクリアする。ここで切り替えているのはMapCanvasに
  // 渡す「実効値」だけで、faultsEnabled等の設定値そのものは変えない
  // (地震タブに戻れば、元の設定のまま再び表示される)。
  // ただし津波タブで「↪︎津波を引き起こした地震」を表示している間だけは例外的に、
  // その地震の震源・観測点を地図に出す(causingQuakeCard参照)。
  // どちらのタブを見ていても、緊急地震速報の詳細画面(eewDetailOpen)を開いている
  // 間はEEW以外の表示を一切出さない(震源・観測点・断層・津波予報区の色分け等、
  // 緊急地震速報の内容に集中してもらうため)。
  const showQuakeMapLayers = !eewDetailOpen && (activeNav === "quake" || activeNav === "settings" || (activeNav === "tsunami" && causingQuakeCard != null));

  // 断層・プレート境界だけは例外。showQuakeMapLayers(震源・観測点・震度塗り分け等)は
  // 緊急地震速報の表示中はすべて隠すが、断層・プレート境界は地理的な背景情報であり、
  // EEWの震源位置を見る上でもむしろ有用なため、EEW表示中でも(元のタブに関わらず)
  // 設定のON/OFF(faultsEnabled/plateBoundariesEnabled)に従って表示できるようにする。
  const showFaultPlateLayers = showQuakeMapLayers || eewDetailOpen;

  // 津波予報区の色分けは、津波タブ・設定タブを見ている間に出す。
  // 実際にどの回の予報区を塗るかはtsunamiForMapDisplay(下)が決める。
  const showTsunamiMapLayers = !eewDetailOpen && (activeNav === "tsunami" || activeNav === "settings");
  const selectedFromRecent = effectiveTsunamis.find(t => t.id === selectedTsunamiId) || null;
  const selectedFromHistory = !selectedFromRecent
    ? (tsunamiHistory.items.find(t => t.id === selectedTsunamiId) || null)
    : null;
  const selectedTsunami = selectedFromRecent || selectedFromHistory;

  // 現在進行形で有効な(解除されていない)、一番新しい津波情報。
  // effectiveTsunamisは新しい順にソート済みなので、先頭の1件だけを見る。以前は
  // find(t => !t.cancelled)としており、一番新しい報が「解除」だった場合に
  // それを読み飛ばして1つ前の(すでに解除済みの)警報を「現在進行形」として
  // 扱ってしまっていた(解除後も地図の塗り分けが古い警報のまま残り続けるバグ)。
  const newestTsunami = effectiveTsunamis[0] || null;
  const activeTsunami = newestTsunami && !newestTsunami.cancelled ? newestTsunami : null;

  // 地図に出す海岸線の色分けは「直近一覧・履歴を問わず、何か選んでいればそれを
  // 最優先」する。選んでいる間は必ずその回の予報区が出る(=他の過去の津波を
  // 開けば、現在発表中の警報ではなくその回自体が表示される)。何も選んでいない
  // (一覧を眺めているだけ)時だけ、現在進行形で有効なactiveTsunamiを自動的に
  // 見せる。
  const tsunamiForMapDisplay = selectedTsunami || activeTsunami;

  // 今見せているのが「現在進行形で有効な津波情報(activeTsunami)」そのものか
  // どうか。潮位観測点ピン・観測された津波の高さバー(下のshowActiveTsunamiTideStations
  // 参照)は、リアルタイム観測データなので、activeTsunami以外(=他の過去の津波を
  // 見ている間)には出さない。
  const isViewingActiveTsunami =
    activeTsunami != null && (!selectedTsunami || selectedTsunami.id === activeTsunami.id);

  // activeTsunamiが属する「一連の現象」の第１報(最初の発表)の時刻。
  // TsunamiTab側の「引き起こした地震」検索(handleFindCausingQuake)と同じ
  // ヒューリスティック(隣り合う発表の間隔が24時間以内なら同じ現象とみなす)を使う。
  // 潮位データの取得範囲・最大波の探索開始時刻の両方の起点として使う
  // (続報のたびにactiveTsunami.timeは新しくなってしまうため、それをそのまま
  // 使うと第１報〜続報までの間の最大波を取りこぼす)。
  //
  // 直近一覧(effectiveTsunamis、最大50件)だけで24時間以内の間隔が一覧の先頭まで
  // 途切れず続いていた場合は、現象がその50件より前から続いている可能性がある
  // (=第１報を取りこぼす)ため、/jma/tsunami の履歴APIをページングして遡って
  // 本当の第１報を探す(レート制限が厳しいAPIのため、遡るページ数には上限を設ける)。
  function walkTsunamiEpisodeBack(sortedAsc, idx) {
    const GAP_LIMIT_MS = 24 * 60 * 60 * 1000; // 24時間以上の空きで別の現象とみなす
    let episodeStart = new Date(sortedAsc[idx].time);
    for (let i = idx; i > 0; i--) {
      const cur = new Date(sortedAsc[i].time);
      const prevTime = new Date(sortedAsc[i - 1].time);
      if (cur.getTime() - prevTime.getTime() > GAP_LIMIT_MS) return { episodeStart, reachedBoundary: true };
      episodeStart = prevTime;
    }
    return { episodeStart, reachedBoundary: false }; // 一覧の先頭に達してもなお空きが見つからなかった
  }

  // walkTsunamiEpisodeBackの逆(先へ辿る)版。過去の津波情報を選んで見ている時、
  // 「一連の現象」の解除時刻を求めるために使う(同じ24時間ギリギリのヒューリスティック)。
  // 解除(cancelled)報が見つかればそこで確定、見つからないまま一覧の末尾(=最新)に
  // 達した場合はreachedBoundary:falseを返す(=まだ解除報を確認できていない=
  // 現象が継続中の可能性がある、という意味)。
  function walkTsunamiEpisodeForward(sortedAsc, idx) {
    const GAP_LIMIT_MS = 24 * 60 * 60 * 1000;
    if (sortedAsc[idx].cancelled) return { episodeEnd: new Date(sortedAsc[idx].time), reachedBoundary: true };
    let cur = sortedAsc[idx];
    for (let i = idx; i < sortedAsc.length - 1; i++) {
      const next = sortedAsc[i + 1];
      if (new Date(next.time).getTime() - new Date(cur.time).getTime() > GAP_LIMIT_MS) {
        return { episodeEnd: null, reachedBoundary: true }; // ここで現象が途切れた=解除報を伴わずに終わった
      }
      cur = next;
      if (cur.cancelled) return { episodeEnd: new Date(cur.time), reachedBoundary: true };
    }
    return { episodeEnd: null, reachedBoundary: false }; // 一覧の末尾に達してもなお解除報が見つからなかった
  }

  const effectiveTsunamisRef = useRef(effectiveTsunamis);
  effectiveTsunamisRef.current = effectiveTsunamis;

  const tsunamiHistoryItemsRef = useRef(tsunamiHistory.items);
  tsunamiHistoryItemsRef.current = tsunamiHistory.items;

  const [activeTsunamiEpisodeStartTime, setActiveTsunamiEpisodeStartTime] = useState(null);
  useEffect(() => {
    if (!activeTsunami) { setActiveTsunamiEpisodeStartTime(null); return; }
    let cancelled = false;

    async function resolve() {
      let pool = dedupeTsunamiList(effectiveTsunamisRef.current);
      let sorted = [...pool].sort((a, b) => new Date(a.time) - new Date(b.time));
      let idx = sorted.findIndex(t => t.id === activeTsunami.id);
      if (idx < 0) { if (!cancelled) setActiveTsunamiEpisodeStartTime(new Date(activeTsunami.time)); return; }

      let { episodeStart, reachedBoundary } = walkTsunamiEpisodeBack(sorted, idx);

      const MAX_HISTORY_PAGES = 5; // 10リクエスト/分の制限があるAPIなので、遡りすぎないよう上限を設ける
      let offset = 0;
      while (!reachedBoundary && !cancelled && offset / TSUNAMI_HISTORY_PAGE_SIZE < MAX_HISTORY_PAGES) {
        let older;
        try {
          older = await fetchTsunamiHistoryPage(offset, TSUNAMI_HISTORY_PAGE_SIZE);
        } catch {
          break; // 取得に失敗したら、それまでに分かっている範囲で確定させる
        }
        if (!older || older.length === 0) break;
        const beforeCount = pool.length;
        pool = dedupeTsunamiList([...pool, ...older]);
        if (pool.length === beforeCount) break; // 追加分が全部重複だった→これ以上遡っても無駄
        sorted = [...pool].sort((a, b) => new Date(a.time) - new Date(b.time));
        idx = sorted.findIndex(t => t.id === activeTsunami.id);
        if (idx < 0) break;
        ({ episodeStart, reachedBoundary } = walkTsunamiEpisodeBack(sorted, idx));
        offset += TSUNAMI_HISTORY_PAGE_SIZE;
      }
      if (!cancelled) setActiveTsunamiEpisodeStartTime(episodeStart);
    }
    resolve();
    return () => { cancelled = true; };
  }, [activeTsunami?.id]);

  // 今見せているのが、activeTsunamiではない「過去の津波情報」かどうか。
  // (選んでいない=activeTsunamiをそのまま自動表示している間はfalse)
  const isViewingPastTsunami =
    selectedTsunami != null && (!activeTsunami || selectedTsunami.id !== activeTsunami.id);

  // 過去の津波情報を選んで見ている間、その「一連の現象」の開始(第１報)〜
  // 終了(解除報)の日時。潮位データの取得範囲(=第１報〜解除まで)と、その中での
  // 最大波の探索に使う。解除報が見つからない場合はend:null(=解除されないまま
  // 一覧が途切れている。まれなケースだが、その場合は「開始から一覧にある最後の
  // 報の時刻まで」を範囲とみなす)。
  const [selectedTsunamiEpisodeRange, setSelectedTsunamiEpisodeRange] = useState(null); // {start, end} | null
  useEffect(() => {
    if (!isViewingPastTsunami || !selectedTsunami) { setSelectedTsunamiEpisodeRange(null); return; }
    let cancelled = false;

    async function resolve() {
      let pool = dedupeTsunamiList([...effectiveTsunamisRef.current, ...tsunamiHistoryItemsRef.current]);
      let sorted = [...pool].sort((a, b) => new Date(a.time) - new Date(b.time));
      let idx = sorted.findIndex(t => t.id === selectedTsunami.id);
      if (idx < 0) {
        if (!cancelled) {
          const t = new Date(selectedTsunami.time);
          setSelectedTsunamiEpisodeRange({ start: t, end: selectedTsunami.cancelled ? t : t });
        }
        return;
      }

      let { episodeStart, reachedBoundary: startBoundary } = walkTsunamiEpisodeBack(sorted, idx);
      let { episodeEnd, reachedBoundary: endBoundary } = walkTsunamiEpisodeForward(sorted, idx);

      const MAX_HISTORY_PAGES = 5; // 10リクエスト/分の制限があるAPIなので、遡りすぎないよう上限を設ける
      let offset = 0;
      while ((!startBoundary || !endBoundary) && !cancelled && offset / TSUNAMI_HISTORY_PAGE_SIZE < MAX_HISTORY_PAGES) {
        let older;
        try {
          older = await fetchTsunamiHistoryPage(offset, TSUNAMI_HISTORY_PAGE_SIZE);
        } catch {
          break; // 取得に失敗したら、それまでに分かっている範囲で確定させる
        }
        if (!older || older.length === 0) break;
        const beforeCount = pool.length;
        pool = dedupeTsunamiList([...pool, ...older]);
        if (pool.length === beforeCount) break; // 追加分が全部重複だった→これ以上遡っても無駄
        sorted = [...pool].sort((a, b) => new Date(a.time) - new Date(b.time));
        idx = sorted.findIndex(t => t.id === selectedTsunami.id);
        if (idx < 0) break;
        if (!startBoundary) ({ episodeStart, reachedBoundary: startBoundary } = walkTsunamiEpisodeBack(sorted, idx));
        if (!endBoundary) ({ episodeEnd, reachedBoundary: endBoundary } = walkTsunamiEpisodeForward(sorted, idx));
        offset += TSUNAMI_HISTORY_PAGE_SIZE;
      }
      // 解除報がどうしても見つからない場合は、一覧にある最後(=一連の現象の中で
      // 一番新しい)報の時刻を終了時刻の代わりに使う(潮位データを取りこぼさないため、
      // 少し余裕を持たせた範囲になる)。
      if (!episodeEnd) {
        idx = sorted.findIndex(t => t.id === selectedTsunami.id);
        if (idx < 0) {
          episodeEnd = episodeStart; // 見失った場合は開始時刻をそのまま終了時刻とする
        } else {
          let lastIdx = idx;
          for (let i = idx; i < sorted.length - 1; i++) {
            if (new Date(sorted[i + 1].time).getTime() - new Date(sorted[i].time).getTime() > 24 * 60 * 60 * 1000) break;
            lastIdx = i + 1;
          }
          episodeEnd = new Date(sorted[lastIdx].time);
        }
      }
      if (!cancelled) setSelectedTsunamiEpisodeRange({ start: episodeStart, end: episodeEnd });
    }
    resolve();
    return () => { cancelled = true; };
  }, [isViewingPastTsunami, selectedTsunami?.id]);

  const tsunamiAreasForMap =
    !showTsunamiMapLayers || !tsunamiForMapDisplay || tsunamiForMapDisplay.cancelled
      ? EMPTY_EQDB_LIST
      : tsunamiForMapDisplay.areas;

  // 潮位観測点ごとに「一番近い津波予報区」を、都道府県名などのあいまいな情報ではなく、
  // 地図の海岸線描画に実際使っているtsunami-areas.json(座標データ)との距離計算で
  // 幾何学的に求める。観測点は動かないため、1回計算できればあとは使い回せる。
  const [tsunamiAreasGeoData, setTsunamiAreasGeoData] = useState(null);
  useEffect(() => {
    if (tideStations.length === 0 || tsunamiAreasGeoData) return;
    loadTsunamiAreasData()
      .then(setTsunamiAreasGeoData)
      .catch(err => console.error("津波予報区データ(座標)の取得に失敗:", err));
  }, [tideStations.length, tsunamiAreasGeoData]);

  const tideStationsWithArea = useMemo(() => {
    if (!tsunamiAreasGeoData || tideStations.length === 0) return tideStations;
    return tideStations.map(st => {
      const nearest = findNearestTsunamiArea(st.lat, st.lon, tsunamiAreasGeoData);
      return nearest ? { ...st, tsunamiAreaName: nearest.name, tsunamiAreaCode: nearest.code } : st;
    });
  }, [tideStations, tsunamiAreasGeoData]);

  // 津波警報テスト配信で「予報区」として選んでいる(まだ配信前の作業中の)ものに
  // 実際に属する観測点の候補一覧。地図タップではなく、この一覧からプルダウンで
  // 選べるようにすることで、配信後に必ずactiveGradeが付く(=バーがちゃんと出る)
  // 組み合わせだけを選ばせられる。
  const candidateHeightStations = useMemo(() => {
    const areaNames = new Set(pickedTsunamiAreas.map(a => a.name));
    if (areaNames.size === 0) return EMPTY_EQDB_LIST;
    return tideStationsWithArea.filter(st => st.tsunamiAreaName && areaNames.has(st.tsunamiAreaName));
  }, [pickedTsunamiAreas, tideStationsWithArea]);

  // 予報区の選択を後から変えて、既に高さを設定していた観測点が対象外になった場合は
  // 一覧からも取り除く(配信しても反映されない設定が残り続けるのを防ぐ)。
  useEffect(() => {
    setPickedTsunamiHeights(prev => {
      const validCodes = new Set(candidateHeightStations.map(st => st.code));
      const next = prev.filter(h => validCodes.has(h.code));
      return next.length === prev.length ? prev : next;
    });
  }, [candidateHeightStations]);

  // 潮位観測点に、現在有効な津波情報の警報グレードを対応付ける。上で求めた
  // 「一番近い予報区の正式名称」と、津波情報側のareas[].nameを完全一致で照合するため、
  // 都道府県名だけで大まかに合わせていた以前の方式より正確なはず。
  const tideStationsWithGrade = useMemo(() => {
    if (!activeTsunami || activeTsunami.cancelled || !Array.isArray(activeTsunami.areas) || activeTsunami.areas.length === 0) {
      return tideStationsWithArea;
    }
    return tideStationsWithArea.map(st => {
      if (!st.tsunamiAreaName) return st;
      const match = activeTsunami.areas.find(a => a.name === st.tsunamiAreaName);
      return match ? { ...st, activeGrade: match.grade } : st;
    });
  }, [tideStationsWithArea, activeTsunami]);

  // 過去の(activeTsunamiではない)津波情報を選んで見ている間、その回の対象予報区に
  // 属する観測点一覧。tideStationsWithGradeはactiveTsunami(ライブ監視)専用なので、
  // 過去分はここで別途、selectedTsunami.areasと照合して求める。
  const selectedTsunamiTideStations = useMemo(() => {
    if (!isViewingPastTsunami || !selectedTsunami || !Array.isArray(selectedTsunami.areas) || selectedTsunami.areas.length === 0) {
      return EMPTY_EQDB_LIST;
    }
    const result = [];
    for (const st of tideStationsWithArea) {
      if (!st.tsunamiAreaName) continue;
      const match = selectedTsunami.areas.find(a => a.name === st.tsunamiAreaName);
      if (match) result.push({ ...st, activeGrade: match.grade });
    }
    return result;
  }, [isViewingPastTsunami, selectedTsunami, tideStationsWithArea]);

  // 潮位観測点(発令中の予報区分)の表示/非表示。地震タブの観測点表示ボタンと
  // 同じ考え方で、パネルの外に浮かぶ丸ボタンから切り替える。
  const [tideStationMarkersVisible, setTideStationMarkersVisible] = useState(true);
  // 新しく津波情報が有効になるたびに、必ず「表示」状態からスタートする
  // (前回OFFにしたまま覚えておくと、次の警報で見落とす恐れがあるため)。
  useEffect(() => {
    if (activeTsunami != null) setTideStationMarkersVisible(true);
  }, [activeTsunami?.id]);

  // 潮位観測点ピンの自動表示: 有効な津波情報がある間・かつ「引き起こした地震」を
  // 見ていない間だけ(その間は震度観測点の表示に専念させたいため、地震タブ同様
  // stationMarkersVisibleがfalseから始まる=causingQuakeCardのuseEffect参照)。
  // それに加えて、今見ている津波情報がactiveTsunami自身である間だけに限定する
  // (isViewingActiveTsunami)。これが無いと、他の過去の津波を開いている間も
  // activeTsunami分の観測点ピンが残ってしまう。
  // 潮位計モード(手動で観測点一覧を見ている間)は、そちらの全件表示が優先されるため
  // ここでは判定しない(下のtideStationPoints算出側でshowTideGaugeLayerを優先している)。
  const showActiveTsunamiTideStations =
    showTsunamiMapLayers && causingQuakeCard == null && isViewingActiveTsunami && tideStationMarkersVisible;

  /* ─────────────────────────────────────────────────────
     観測された津波の高さ(地図上のバー表示)。
     気象庁の電文(有料)は使わず、既に取得している潮位観測データ(潮位偏差=
     実測潮位−天文潮位。TideStationDetailで表示しているものと同じ値)から、
     警報等の発表時刻以降で絶対値が最大になった値を「観測された津波の高さ」として
     使う(computeMaxTsunamiHeightCm参照。気象庁の考え方に沿った近似値)。
     ・対象は発令中の予報区の観測点のみ(全国の観測点を取りに行くと重くなるため)。
     ・同時リクエスト数を絞ったワーカープールで順に取得する(fetchTideStations等と
       同じ考え方)。
     ・警報等が続く間は最大波が更新され得るので、数分おきに再取得する。
     ・±0.2m未満は「微弱」として扱い、バー自体を表示しない
       (気象庁も同程度の小さい値は数値を出さない運用のため)。
     ───────────────────────────────────────────────────── */
  const warnedStationCodesKey = useMemo(
    () => tideStationsWithGrade.filter(s => s.activeGrade).map(s => s.code).sort().join(","),
    [tideStationsWithGrade]
  );
  useEffect(() => {
    if (!activeTsunami || !warnedStationCodesKey) return;
    const overrides = activeTsunami.heightOverrides || null;
    // テスト配信で手入力の高さを設定済みの観測点は、実データが無くても表示できるので
    // 取得をスキップする(無駄なリクエストを増やさないため)。
    const codes = warnedStationCodesKey.split(",").filter(code => !(overrides && overrides[code] != null));
    if (codes.length === 0) return;
    let cancelled = false;
    const CONCURRENCY = 4; // 同時に投げる数を絞って、重くならないようにする

    async function runPool(force) {
      let nextIndex = 0;
      async function worker() {
        while (!cancelled) {
          const i = nextIndex++;
          if (i >= codes.length) return;
          await loadTideObs(codes[i], force);
        }
      }
      const workers = [];
      for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
      await Promise.all(workers);
    }

    runPool(false); // 初回は「未取得の分だけ」取得する

    // 警報等が続いている間、最大波が更新されていないか3分おきに取得し直す。
    const REFRESH_MS = 3 * 60 * 1000;
    const intervalId = setInterval(() => { if (!cancelled) runPool(true); }, REFRESH_MS);

    return () => { cancelled = true; clearInterval(intervalId); };
  }, [warnedStationCodesKey, activeTsunami != null]);

  // 観測点コードごとの、観測された津波の高さ(メートル、符号付き)。
  // ±0.2m未満は「微弱」としてnull扱いにする(バーを出さない)。
  const TSUNAMI_HEIGHT_NEGLIGIBLE_M = 0.2;
  const tsunamiHeightByStation = useMemo(() => {
    if (!activeTsunami) return {};
    const startMs = new Date(activeTsunami.time).getTime(); // テスト配信の手入力値用の近似時刻
    // 実データの最大波探索は、続報のたびに更新されるactiveTsunami.timeではなく、
    // 一連の現象の第１報の時刻を起点にする(そうしないと第１報〜続報までの間の
    // 最大波を取りこぼすため)。
    const episodeStartMs = activeTsunamiEpisodeStartTime ? activeTsunamiEpisodeStartTime.getTime() : startMs;
    if (!Number.isFinite(startMs)) return {};
    const overrides = activeTsunami.heightOverrides || null; // テスト配信用の手入力値(App側参照)
    const result = {};
    tideStationsWithGrade.forEach(st => {
      if (!st.activeGrade) return;
      if (overrides && overrides[st.code] != null) {
        const m = overrides[st.code];
        if (Math.abs(m) >= TSUNAMI_HEIGHT_NEGLIGIBLE_M) result[st.code] = m; // 手入力値も微弱ルールは同様に適用
        return;
      }
      const obs = tideObsByStation[st.code];
      if (!obs || obs.status !== "ready" || !obs.data) return;
      const max = computeMaxTsunamiHeightCm(obs.data, episodeStartMs);
      if (max == null) return;
      const m = max.cm / 100;
      if (Math.abs(m) < TSUNAMI_HEIGHT_NEGLIGIBLE_M) return; // 微弱
      result[st.code] = m;
    });
    return result;
  }, [activeTsunami, activeTsunamiEpisodeStartTime, tideStationsWithGrade, tideObsByStation]);

  // 観測点コードごとの、最大波を観測した時刻(エポックms)。テスト配信の手入力値には
  // 実際の観測時刻が無いため、代わりに配信時刻(activeTsunami.time)を使う
  // (近似だが、テスト用途としては十分)。
  const tsunamiHeightTimeByStation = useMemo(() => {
    if (!activeTsunami) return {};
    const startMs = new Date(activeTsunami.time).getTime();
    if (!Number.isFinite(startMs)) return {};
    const episodeStartMs = activeTsunamiEpisodeStartTime ? activeTsunamiEpisodeStartTime.getTime() : startMs;
    const overrides = activeTsunami.heightOverrides || null;
    const result = {};
    tideStationsWithGrade.forEach(st => {
      if (!st.activeGrade || tsunamiHeightByStation[st.code] == null) return;
      if (overrides && overrides[st.code] != null) {
        result[st.code] = startMs; // テスト配信: 配信時刻を代わりに使う
        return;
      }
      const obs = tideObsByStation[st.code];
      if (!obs || obs.status !== "ready" || !obs.data) return;
      const max = computeMaxTsunamiHeightCm(obs.data, episodeStartMs);
      if (max?.timeMs != null) result[st.code] = max.timeMs;
    });
    return result;
  }, [activeTsunami, activeTsunamiEpisodeStartTime, tideStationsWithGrade, tideObsByStation, tsunamiHeightByStation]);

  /* ─────────────────────────────────────────────────────
     過去の津波情報を選んで見ている間の潮位データ・最大波。
     activeTsunami用(tideObsByStation)は「当日を含む直近日」しか取得しないため、
     過去の任意の期間には使えない。ここでは、対象観測点それぞれについて
     「一連の現象」の第１報の日〜解除の日までを個別に取得し(historicalTideObsByStation、
     `${tsunamiId}::${code}`をキーにしてactiveTsunami用のキャッシュとは独立させる)、
     その範囲内で潮位偏差が正の値(山)の最大のものを最大波として計算する。
     ───────────────────────────────────────────────────── */
  // 形: { "tsunamiId::stationCode": { status: "loading"|"ready"|"error", data } }
  const [historicalTideObsByStation, setHistoricalTideObsByStation] = useState({});
  const historicalTideObsRequestedRef = useRef(new Set()); // 取得を開始済みのキー(重複フェッチ防止)
  useEffect(() => {
    if (!isViewingPastTsunami || !selectedTsunami || !selectedTsunamiEpisodeRange || selectedTsunamiTideStations.length === 0) return;
    let cancelled = false;
    const { start, end } = selectedTsunamiEpisodeRange;
    const endDate = end || new Date(); // 稀に解除が確認できなかった場合は現在時刻まで
    const tsunamiId = selectedTsunami.id;

    // 気象庁の潮位観測値(tide_obs)は直近1週間程度分しか提供されておらず、
    // それより古い日付を指定するとエラーになる。対象期間の終端(=取得対象の
    // うち最も新しい日)がすでに1週間以上前なら、取得を試みるだけ無駄なので
    // APIを叩かずに「取得不可」として扱う。
    const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const isTooOldToFetch = Date.now() - endDate.getTime() > ONE_WEEK_MS;

    async function run() {
      for (const st of selectedTsunamiTideStations) {
        if (cancelled) return;
        const key = `${tsunamiId}::${st.code}`;
        if (historicalTideObsRequestedRef.current.has(key)) continue; // 取得済み・取得中ならスキップ
        historicalTideObsRequestedRef.current.add(key);
        if (isTooOldToFetch) {
          // 1週間以上前のデータは気象庁側に無くエラーになるだけなので、
          // リクエストを送らずに直接「取得失敗」扱いにする。
          setHistoricalTideObsByStation(prev => ({ ...prev, [key]: { status: "error", data: null } }));
          continue;
        }
        setHistoricalTideObsByStation(prev => ({ ...prev, [key]: { status: "loading", data: null } }));
        try {
          const data = await fetchTideObsForDateRange(st.code, start, endDate);
          if (cancelled) return;
          setHistoricalTideObsByStation(prev => ({ ...prev, [key]: { status: "ready", data } }));
        } catch (err) {
          console.error(`過去の津波の潮位観測値の取得に失敗(${st.code}):`, err);
          if (cancelled) return;
          setHistoricalTideObsByStation(prev => ({ ...prev, [key]: { status: "error", data: null } }));
        }
      }
    }
    run();
    return () => { cancelled = true; };
  }, [isViewingPastTsunami, selectedTsunami, selectedTsunamiEpisodeRange, selectedTsunamiTideStations]);

  // 観測点コードごとの、過去の津波で観測された最大波(メートル、正の値のみ)。
  const historicalTsunamiHeightByStation = useMemo(() => {
    if (!isViewingPastTsunami || !selectedTsunami || !selectedTsunamiEpisodeRange) return {};
    const startMs = selectedTsunamiEpisodeRange.start.getTime();
    const result = {};
    selectedTsunamiTideStations.forEach(st => {
      const entry = historicalTideObsByStation[`${selectedTsunami.id}::${st.code}`];
      if (!entry || entry.status !== "ready" || !entry.data) return;
      const max = computeMaxTsunamiHeightCm(entry.data, startMs);
      if (max == null) return;
      const m = max.cm / 100;
      if (m < TSUNAMI_HEIGHT_NEGLIGIBLE_M) return; // 微弱
      result[st.code] = m;
    });
    return result;
  }, [isViewingPastTsunami, selectedTsunami, selectedTsunamiEpisodeRange, selectedTsunamiTideStations, historicalTideObsByStation]);

  // 観測点コードごとの、過去の津波で最大波を観測した時刻(エポックms)。
  const historicalTsunamiHeightTimeByStation = useMemo(() => {
    if (!isViewingPastTsunami || !selectedTsunami || !selectedTsunamiEpisodeRange) return {};
    const startMs = selectedTsunamiEpisodeRange.start.getTime();
    const result = {};
    selectedTsunamiTideStations.forEach(st => {
      if (historicalTsunamiHeightByStation[st.code] == null) return;
      const entry = historicalTideObsByStation[`${selectedTsunami.id}::${st.code}`];
      if (!entry || entry.status !== "ready" || !entry.data) return;
      const max = computeMaxTsunamiHeightCm(entry.data, startMs);
      if (max?.timeMs != null) result[st.code] = max.timeMs;
    });
    return result;
  }, [isViewingPastTsunami, selectedTsunami, selectedTsunamiEpisodeRange, selectedTsunamiTideStations, historicalTideObsByStation, historicalTsunamiHeightByStation]);

  // 地図に表示する観測点一覧。丸の色(dotColor)は、予報区の公式グレードではなく
  // 実際に観測された津波の高さ(tsunamiHeightByStation)から決める
  // (tsunamiHeightBandColor参照。未観測・微弱の間は薄グレー)。
  const tideStationsForMap = useMemo(() => {
    return tideStationsWithGrade.map(st => ({
      ...st,
      dotColor: tsunamiHeightBandColor(tsunamiHeightByStation[st.code]),
    }));
  }, [tideStationsWithGrade, tsunamiHeightByStation]);

  // 発令中の予報区の観測点一覧(地図の自動表示用)。選択中の観測点は、続報の
  // 反映タイミング等で一瞬対象予報区から外れても一覧に残すようにする。そうしないと
  // 選択中の丸が地図から消えてしまい、「タップしても強調されない」ように見えるため。
  const warnedTideStationsForMap = useMemo(() => {
    const warned = tideStationsForMap.filter(s => s.activeGrade);
    if (selectedTideStationCode != null && !warned.some(s => s.code === selectedTideStationCode)) {
      const selected = tideStationsForMap.find(s => s.code === selectedTideStationCode);
      if (selected) return [...warned, selected];
    }
    return warned;
  }, [tideStationsForMap, selectedTideStationCode]);

  // 地図に描く「観測された津波の高さ」バー。高さ(m)を0〜1に正規化した値(heightT)に
  // しておき、実際のピクセル上のバーの長さはMapCanvas側で決める(ズームで見た目の
  // 長さが変わらないよう、アイコンのピクセルサイズとして描画するため)。色は観測点の
  // 丸と同じtsunamiHeightBandColorを使い、2つのレイヤーの色がズレないようにする。
  const TSUNAMI_HEIGHT_BAR_MAX_M = 10;
  const tsunamiHeightBars = useMemo(() => {
    return tideStationsWithGrade
      .filter(st => st.activeGrade && tsunamiHeightByStation[st.code] != null)
      .map(st => {
        const heightM = tsunamiHeightByStation[st.code];
        const clamped = Math.min(Math.abs(heightM), TSUNAMI_HEIGHT_BAR_MAX_M);
        const heightT = (clamped - TSUNAMI_HEIGHT_NEGLIGIBLE_M) / (TSUNAMI_HEIGHT_BAR_MAX_M - TSUNAMI_HEIGHT_NEGLIGIBLE_M);
        return {
          code: st.code,
          name: st.name,
          heightM,
          heightT,
          color: tsunamiHeightBandColor(heightM),
          lng: st.lon,
          lat: st.lat,
        };
      });
  }, [tideStationsWithGrade, tsunamiHeightByStation]);

  // 過去の津波を選んで見ている間に地図に出す観測点(丸)・バー。ライブ監視用の
  // tideStationsForMap/tsunamiHeightBarsと全く同じ組み立て方を、対象データだけ
  // selectedTsunamiTideStations/historicalTsunamiHeightByStationに差し替えて使う。
  // 潮位データが取得できていない(未取得・取得中・失敗)観測点は表示しない
  // ——ライブ監視と違い、過去分は「観測点はあるが値はまだ来ていない」という
  // 状態が長く続くことは無い(取得済みか失敗かのどちらか)ため、取得できたものだけに絞る。
  const historicalTideStationsForMap = useMemo(() => {
    return selectedTsunamiTideStations
      .filter(st => {
        const entry = historicalTideObsByStation[`${selectedTsunami?.id}::${st.code}`];
        return entry?.status === "ready";
      })
      .map(st => ({
        ...st,
        dotColor: tsunamiHeightBandColor(historicalTsunamiHeightByStation[st.code]),
      }));
  }, [selectedTsunamiTideStations, historicalTsunamiHeightByStation, historicalTideObsByStation, selectedTsunami]);

  const historicalTsunamiHeightBars = useMemo(() => {
    return selectedTsunamiTideStations
      .filter(st => historicalTsunamiHeightByStation[st.code] != null)
      .map(st => {
        const heightM = historicalTsunamiHeightByStation[st.code];
        const clamped = Math.min(heightM, TSUNAMI_HEIGHT_BAR_MAX_M);
        const heightT = (clamped - TSUNAMI_HEIGHT_NEGLIGIBLE_M) / (TSUNAMI_HEIGHT_BAR_MAX_M - TSUNAMI_HEIGHT_NEGLIGIBLE_M);
        return {
          code: st.code,
          name: st.name,
          heightM,
          heightT,
          color: tsunamiHeightBandColor(heightM),
          lng: st.lon,
          lat: st.lat,
        };
      });
  }, [selectedTsunamiTideStations, historicalTsunamiHeightByStation]);

  // 過去の津波の観測点・バーを地図に出すかどうか。ライブ監視用のshowActiveTsunamiTideStations
  // と同じ考え方で、こちらはisViewingPastTsunamiの間だけ出す。
  // 過去分は参照専用の表示なので、観測点の表示/非表示ボタン(tideStationMarkersVisible)は
  // 関与させない(常にオンとして扱い、ボタン自体は無効化してタップできないようにする
  // ——後述のStationMarkerToggleButton側の対応、及びMapCanvas側のタップ無効化と対)。
  const showHistoricalTsunamiTideStations =
    showTsunamiMapLayers && causingQuakeCard == null && isViewingPastTsunami && selectedTsunamiTideStations.length > 0;

  // 津波タブの予報区一覧(TsunamiAreaRow)に渡す「観測点ごとの最大波」データ。
  // 過去の津波を選んで見ている間はhistorical側(第１報〜解除の期間で計算したもの)、
  // それ以外(ライブ監視中)は従来通りactiveTsunami用の値を使う。
  const tsunamiHeightByStationForDisplay = isViewingPastTsunami ? historicalTsunamiHeightByStation : tsunamiHeightByStation;
  const tsunamiHeightTimeByStationForDisplay = isViewingPastTsunami ? historicalTsunamiHeightTimeByStation : tsunamiHeightTimeByStation;

  // 潮位観測点ピン(発令中の予報区分。潮位計モードでない間に表示しているもの)を
  // 地図上でタップした時、手動で潮位計モードに入って観測点を選んだ時と同じ体験に
  // したいので、選択だけでなく「潮位計モードに切り替えてほしい」という信号も
  // 一緒に送る。mapSelectSignal(震央分布の丸タップ)と同じ「タップのたびに1増える
  // だけの値」パターンを踏襲し、BottomDock側のuseEffectで実際の切り替えを行う。
  const [tideStationSelectSignal, setTideStationSelectSignal] = useState(0);
  function handleSelectTideStationOnMap(code) {
    setSelectedTideStationCode(code);
    setTideStationSelectSignal(n => n + 1);
  }

  return (
    <ThemeContext.Provider value={themeContextValue}>
    <GlassOpaqueContext.Provider value={glassOpaqueContextValue}>
    <QuakeColorSchemeContext.Provider value={quakeColorScheme}>
    <NowcastColorSchemeContext.Provider value={nowcastColorScheme}>
      <GlobalStyles tokens={themeContextValue.tokens}/>
      <Filters/>

      <div style={{ height: "100%", position: "relative", overflow: "hidden", background: themeContextValue.tokens.pageBg }}>

        {/* ── Layer 1: 地図（Liquid Glassが透かす背景） ── */}
        <MapCanvas
          onReady={setMap}
          currentLocationPoint={currentLocationPoint}
          nowcastVisible={activeNav === "weather" && !!nowcastFrame}
          nowcastFrame={nowcastFrame}
          nowcastPreloadFrames={nowcastPreloadFrames}
          nowcastKnownValidtimes={nowcastKnownValidtimes}
          nowcastColorSchemeId={nowcastColorScheme}
          precipVisible={activeNav === "weather" && !!precipFrame}
          precipMode={precipMode}
          precipFrame={precipFrame}
          precipKnownValidtimes={precipKnownValidtimes}
          wdistVisible={activeNav === "weather" && !!wdistFrame}
          wdistMode={wdistMode}
          wdistFrame={wdistFrame}
          wdistKnownValidtimes={wdistKnownValidtimes}
          typhoonVisible={activeNav === "weather" && !!typhoonGeojson}
          typhoonGeojson={typhoonGeojson}
          onSelectTyphoonCenter={handleSelectTyphoonCenter}
          typhoonFlyToRequest={typhoonFlyToRequest}
          warningVisible={activeNav === "alert"}
          warningLevelMap={warningLevelMap}
          selectedWarningArea={selectedWarningArea}
          onSelectWarningArea={handleSelectWarningArea}
          warningAreaFlyToRequest={warningAreaFlyToRequest}
          riskVisible={activeNav === "alert" && !!alertLayerFrame}
          riskMode={alertLayerMode}
          riskFrame={alertLayerFrame}
          riskKnownValidtimes={alertLayerKnownValidtimes}
          riverVisible={activeNav === "alert" && alertLayerMode === "riverLevel" && !!riverStations}
          riverStations={riverStations}
          selectedRiverStation={selectedRiverStation}
          onSelectRiverStation={handleSelectRiverStation}
          stationPoints={showQuakeMapLayers ? (causingQuakeCard ? causingQuakeCard.resolvedPoints || EMPTY_EQDB_LIST : selectedQuakePoints) : EMPTY_EQDB_LIST}
          stationMarkersVisible={showQuakeMapLayers && stationMarkersVisible}
          tideStationPoints={
            showTideGaugeLayer ? tideStationsForMap
            : showActiveTsunamiTideStations ? warnedTideStationsForMap
            : showHistoricalTsunamiTideStations ? historicalTideStationsForMap
            : EMPTY_EQDB_LIST
          }
          onSelectTideStation={handleSelectTideStationOnMap}
          selectedTideStationCode={selectedTideStationCode}
          tsunamiHeightBars={
            showActiveTsunamiTideStations ? tsunamiHeightBars
            : showHistoricalTsunamiTideStations ? historicalTsunamiHeightBars
            : EMPTY_EQDB_LIST
          }
          tideStationBarsMode={showActiveTsunamiTideStations || showHistoricalTsunamiTideStations}
          // 過去の津波の観測点・バーは参照専用の表示なので、タップ(選択・詳細表示)を
          // 無効にする。ライブ監視中(showActiveTsunamiTideStations)・潮位計モードでは
          // 従来通りタップ可能。
          tideStationsInteractive={!showHistoricalTsunamiTideStations}
          hypocenters={showQuakeMapLayers ? (causingQuakeCard ? causingQuakeHypocenters : selectedHypocenters) : EMPTY_EQDB_LIST}
          isWide={isWide}
          quakeTimeStr={causingQuakeCard ? causingQuakeCard.time : selectedQuake?.time}
          maxIntensityKey={causingQuakeCard ? causingQuakeCard.maxIntensity : selectedQuake?.maxIntensity}
          estIntensityEnabled={showQuakeMapLayers && estIntensityEnabled}
          areaFillEnabled={showQuakeMapLayers && areaFillEnabled}
          faultsEnabled={showFaultPlateLayers && faultsEnabled}
          plateBoundariesEnabled={showFaultPlateLayers && plateBoundariesEnabled}
          boundaryLineColorId={boundaryLineColorId}
          epicenterPoints={showQuakeMapLayers ? epicenterPoints : EMPTY_EQDB_LIST}
          onSelectEpicenterPoint={handleSelectEpicenterPoint}
          pointsLoading={showQuakeMapLayers && stationPointsProcessing}
          epicenterLoading={showQuakeMapLayers && epicenterLoading}
          tsunamiAreas={tsunamiAreasForMap}
          tsunamiAreaPickActive={tsunamiAreaPickActive}
          onPickTsunamiArea={handlePickTsunamiArea}
          pickedTsunamiAreas={pickedTsunamiAreas}
          eews={effectiveEews}
          eewEpicenterPickActive={eewEpicenterPickActive}
          onPickEewEpicenter={handlePickEewEpicenter}
          quakeEpicenterPickActive={quakeEpicenterPickActive}
          onPickQuakeEpicenter={handlePickQuakeEpicenter}
          eewDetailOpen={eewDetailOpen}
        />

        {/* 津波テスト配信「地図タップで選択」中のバナー — 画面上部中央に浮かぶ。
            上段: 指示文・選択件数・キャンセル/完了ボタン。
            下段: 「今タップしたらどのグレードで塗るか」を選ぶパレット。予報区ごとに
            違うグレードを割り当てたいので、パレットで切り替えてからタップする方式。
            複数の予報区を選べるようにするため、1回タップしただけではモードを終えず、
            「完了」を押すまで何度でもタップし直せる。「キャンセル」はピック開始時点の
            選択に戻す。 */}
        {tsunamiAreaPickActive && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            left: 0, right: 0,
            display: "flex", justifyContent: "center",
            zIndex: 30, padding: "0 16px",
          }}>
            <Glass radius={22} style={{
              display: "flex", flexDirection: "column", gap: 8,
              padding: "10px 12px",
              animation: "appear 0.3s cubic-bezier(.25,1,.5,1)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: themeContextValue.tokens.text, flex: 1 }}>
                  海岸線をタップして予報区を選択
                  {pickedTsunamiAreas.length > 0 && `(${pickedTsunamiAreas.length}件選択中)`}
                </span>
                <PressableButton
                  type="button"
                  onClick={cancelTsunamiAreaPick}
                  style={{
                    flexShrink: 0, padding: "6px 12px", borderRadius: 999, border: "none", cursor: "pointer",
                    background: `rgba(${themeContextValue.tokens.ink},0.08)`,
                    fontSize: 12, fontWeight: 700, color: themeContextValue.tokens.textSecondary,
                  }}
                >
                  キャンセル
                </PressableButton>
                <PressableButton
                  type="button"
                  onClick={finishTsunamiAreaPick}
                  style={{
                    flexShrink: 0, padding: "6px 14px", borderRadius: 999, border: "none", cursor: "pointer",
                    background: "#0A84FF",
                    fontSize: 12, fontWeight: 700, color: "#fff",
                  }}
                >
                  完了
                </PressableButton>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11, color: themeContextValue.tokens.textSecondary, flexShrink: 0 }}>
                  塗るグレード:
                </span>
                {TEST_TSUNAMI_GRADE_OPTIONS.map(opt => {
                  const active = activePickGrade === opt.value;
                  const color = tsunamiGradeInfo(opt.value).color;
                  return (
                    <PressableButton
                      key={opt.value}
                      type="button"
                      onClick={() => setActivePickGrade(opt.value)}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 5,
                        padding: "5px 10px 5px 8px", borderRadius: 999, cursor: "pointer",
                        border: active ? `1.5px solid ${color}` : "1.5px solid transparent",
                        background: active ? `${color}26` : `rgba(${themeContextValue.tokens.ink},0.05)`,
                        fontSize: 11, fontWeight: 700,
                        color: active ? themeContextValue.tokens.text : themeContextValue.tokens.textSecondary,
                      }}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: 999, background: color, flexShrink: 0 }}/>
                      {opt.label}
                    </PressableButton>
                  );
                })}
              </div>
            </Glass>
          </div>
        )}

        {/* 緊急地震速報テスト配信「地図をタップして震源を指定」中のバナー。
            震源は1点だけなので津波の予報区ピックと違って複数タップの積み上げは不要
            ─ タップした瞬間に確定し、自動的にモードを終える(MapCanvas側のクリック
            ハンドラ→handlePickEewEpicenterでeewEpicenterPickActiveをfalseに戻している)。
            ここでは「今からタップする」ことを案内し、途中でやめられるように
            キャンセルボタンだけ出す。 */}
        {eewEpicenterPickActive && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            left: 0, right: 0,
            display: "flex", justifyContent: "center",
            zIndex: 30, padding: "0 16px",
          }}>
            <Glass radius={22} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 12px",
              animation: "appear 0.3s cubic-bezier(.25,1,.5,1)",
            }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: themeContextValue.tokens.text }}>
                地図をタップして震源を指定
              </span>
              <PressableButton
                type="button"
                onClick={() => handleTestEewAction("cancelEpicenterPick")}
                style={{
                  flexShrink: 0, padding: "6px 12px", borderRadius: 999, border: "none", cursor: "pointer",
                  background: `rgba(${themeContextValue.tokens.ink},0.08)`,
                  fontSize: 12, fontWeight: 700, color: themeContextValue.tokens.textSecondary,
                }}
              >
                キャンセル
              </PressableButton>
            </Glass>
          </div>
        )}

        {/* 震度凡例 — 地震を選択している間だけ、画面右上に縦並びで浮かぶ。
            緊急地震速報の詳細を表示中(eewDetailOpen)は、EEW側に別の凡例
            (震度の予測範囲の凡例)があるため、こちらは隠す。これが無いと、
            地震タブで地震を選択したまま緊急地震速報が開いた時、地震の震度凡例が
            EEWの表示に重なって残ってしまっていた。 */}
        {!eewDetailOpen && activeNav === "quake" && selectedQuake && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <QuakeIntensityLegend maxIntensity={selectedQuake.maxIntensity} legacyIntensityScale={selectedQuake.legacyIntensityScale}/>
          </div>
        )}

        {/* 津波予報凡例 — 津波の予報区を地図に塗っている間だけ、画面右上に浮かぶ(震度凡例と対の構成) */}
        {activeNav === "tsunami" && tsunamiAreasForMap.length > 0 && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <TsunamiGradeLegend areas={tsunamiAreasForMap} tsunamiHeightByStation={tsunamiHeightByStation}/>
          </div>
        )}

        {/* 雨雲レーダー凡例 — レーダーレイヤーを表示している間だけ、画面右上に浮かぶ
            (震度凡例・津波凡例と対の構成)。 */}
        {activeNav === "weather" && nowcastFrame && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <NowcastLegend/>
          </div>
        )}

        {/* 1/3/24時間降水量の凡例 — 雨雲レーダーとは排他なので同時には出ないが、
            同じ位置・同じ構成で出す。 */}
        {activeNav === "weather" && precipMode && precipFrame && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <PrecipLegend mode={precipMode}/>
          </div>
        )}

        {/* 天気分布予報の凡例 — 他とは全て排他なので同時には出ないが、
            同じ位置に出す。 */}
        {activeNav === "weather" && wdistFrame && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <WdistLegend mode={wdistMode}/>
          </div>
        )}

        {/* 警報凡例 — 警報タブで警報・注意報レイヤーを地図に塗っている間だけ、
            画面右上に浮かぶ(震度凡例・津波凡例と対の構成)。キキクル・河川水位
            表示中は警報の塗り分け自体を非表示にしているので、この凡例も出さない
            (代わりにRiskLegend/RiverLegendを出す)。 */}
        {activeNav === "alert" && !alertLayerMode && Object.keys(warningLevelMap).length > 0 && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <WarningLegend warningLevelMap={warningLevelMap}/>
          </div>
        )}

        {/* キキクル(土砂/浸水)凡例 — 警報タブでキキクルレイヤーを表示している間、
            画面右上に浮かぶ(警報凡例・河川水位凡例と排他)。 */}
        {activeNav === "alert" && alertLayerMode && alertLayerMode !== "riverLevel" && alertLayerFrame && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <RiskLegend mode={alertLayerMode}/>
          </div>
        )}

        {/* 河川水位凡例 — 警報タブで河川水位レイヤーを表示している間、
            画面右上に浮かぶ(警報凡例・キキクル凡例と排他)。 */}
        {activeNav === "alert" && alertLayerMode === "riverLevel" && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <RiverLegend/>
          </div>
        )}

        {/* ── Layer 2: Glass UI（透明ガラスが地図に浮かぶ） ── */}

        {/* アラートピル — 一旦非表示 */}
        {/*
        <div style={{
          position: "absolute", top: 20, left: 0, right: 0,
          display: "flex", justifyContent: "center",
          zIndex: 30, pointerEvents: "none",
        }}>
          <div style={{ pointerEvents: "auto" }}>
            <AlertPill alert={ALERT}/>
          </div>
        </div>
        */}

        {/* フローティングのナビ(縦持ちのタブバー/横画面の縦レール)の下端より下は、
            見た目上ナビの外側なのに地図の全画面キャンバスがそのまま裏に伸びている
            ため、何もしないとそこをドラッグ/ピンチしても地図が反応してしまう。
            中身の無い透明divを地図より上の重ね順に置くだけで、この帯の中の
            ポインタ/タッチ操作を地図の手前で止められる(下のcanvasには一切届かない)。
            縦持ち(!isWide)はタブバー自身のbottomオフセットと同じ式、横画面(isWide)
            は縦レールのbottom:16と同じ16pxを高さにして、ナビの下端にぴったり合わせる。 */}
        <div style={{
          position: "absolute",
          left: 0, right: 0, bottom: 0,
          height: isWide
            ? 16
            : isStandalonePwa
              ? "max(0px, calc(env(safe-area-inset-bottom) - 10px))"
              : "calc(env(safe-area-inset-bottom) + 10px)",
          zIndex: 35,
          touchAction: "none",
        }}/>

        {/* ボトムドック — ナビバーと地図レイヤーパネルをひとつのGlassに統合。
            レイヤーを開くと、このガラス自体の高さ・角丸が滑らかに変化し、
            ナビバーの内側からパネルが伸びて生まれてくるように見せる。
            広い画面(isWide)では、SideNavRail(タブ列)とBottomDockの中身を
            1つの共有Glassの中に並べて描画し、継ぎ目の無い1枚のガラスに
            見せる(BottomDock自身はisWideの時、自前のGlassを持たず透明な
            中身だけを返す)。 */}
        <div style={isWide ? {
          position: "fixed",
          left: 12, top: 16, bottom: 16,
          zIndex: 40,
        } : {
          position: "absolute",
          bottom: isStandalonePwa
            ? "calc(env(safe-area-inset-bottom) - 10px)"
            : "calc(env(safe-area-inset-bottom) + 10px)",
          left: 0, right: 0,
          display: "flex", justifyContent: "center", alignItems: "flex-end",
          zIndex: 40, padding: "0 16px",
        }}>
          {isWide ? (
              <div style={{ height: "100%", animation: "appear 0.4s cubic-bezier(.25,1,.5,1) 0.1s both" }}>
                <Glass radius={28} style={{ height: "100%" }}>
                  <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
                    <div style={{ width: WIDE_RAIL_WIDTH, flexShrink: 0, position: "relative" }}>
                      <SideNavRail active={activeNav} onNav={handleNavTap} uiScale={wideUIScale}/>
                    </div>
                    <div style={{ width: 1, alignSelf: "stretch", background: `rgba(${tokens.ink},0.14)` }}/>
                    <BottomDock
                      active={activeNav}
                      onNav={handleNavTap}
                      navCollapseSignal={navCollapseSignal}
                      navDoubleTapSignal={navDoubleTapSignal}
                      layerOpen={layerOpen}
                      layers={layersForPanel}
                      onToggleLayer={toggleLayer}
                      onLayerOpenChange={setLayerOpen}
                      uiScale={wideUIScale}
                      quakes={effectiveQuakes}
                  quakeStatus={quakeStatus}
                  selectedQuakeId={selectedQuakeId}
                  onSelectQuake={selectQuake}
                  tsunamis={effectiveTsunamis}
                  tsunamiStatus={tsunamiStatus}
                  selectedTsunamiId={selectedTsunamiId}
                  onSelectTsunami={setSelectedTsunamiId}
                  isViewingPastTsunami={isViewingPastTsunami}
                  tsunamiHistory={tsunamiHistory}
                  onLoadMoreTsunamiHistory={loadMoreTsunamiHistory}
                  onTsunamiViewModeChange={setTsunamiViewModeTop}
                  onCurrentLocationChange={setCurrentLocationPoint}
                  onNowcastChange={handleNowcastChange}
                  onPrecipChange={handlePrecipChange}
                  onWdistChange={handleWdistChange}
                  onTyphoonChange={handleTyphoonChange}
                  onSelectTyphoon={handleSelectTyphoon}
                  selectedTyphoonInfo={selectedTyphoonInfo}
                  onClearSelectedTyphoon={handleClearSelectedTyphoon}
                  onSelectTyphoonDetail={handleSelectTyphoonCenter}
                  warningLevelMap={warningLevelMap}
                  warningAreaByRegioncode={warningAreaByRegioncode}
                  selectedWarningArea={selectedWarningArea}
                  onSelectWarningAreaFromList={handleSelectWarningAreaFromList}
                  onBackFromWarningArea={handleBackFromWarningArea}
                  onAlertLayerChange={handleAlertLayerChange}
                  onAlertModeChange={handleAlertModeChange}
                  onRiverLayerChange={handleRiverLayerChange}
                  selectedRiverStation={selectedRiverStation}
                  onSelectRiverStation={handleSelectRiverStation}
                  tideStations={tideStationsWithGrade}
                  tideStationsStatus={tideStationsStatus}
                  selectedTideStationCode={selectedTideStationCode}
                  onSelectTideStation={setSelectedTideStationCode}
                  tideStationSelectSignal={tideStationSelectSignal}
                  tsunamiHeightByStation={tsunamiHeightByStationForDisplay}
                  tsunamiHeightTimeByStation={tsunamiHeightTimeByStationForDisplay}
                  tideObsByStation={tideObsByStation}
                  onLoadTideObs={loadTideObs}
                  onCausingQuakeChange={setCausingQuakeCard}
                  stationMarkersVisible={stationMarkersVisible}
                  onToggleStationMarkersVisible={() => setStationMarkersVisible(v => !v)}
                  tideStationMarkersVisible={tideStationMarkersVisible}
                  onToggleTideStationMarkersVisible={() => setTideStationMarkersVisible(v => !v)}
                  stationPoints={selectedQuakePoints}
                  onChangeQuakeColorScheme={handleChangeQuakeColorScheme}
                  onChangeNowcastColorScheme={handleChangeNowcastColorScheme}
                  estIntensityEnabled={estIntensityEnabled}
                  onChangeEstIntensityEnabled={handleChangeEstIntensityEnabled}
                  areaFillEnabled={areaFillEnabled}
                  onChangeAreaFillEnabled={handleChangeAreaFillEnabled}
                  faultsEnabled={faultsEnabled}
                  onChangeFaultsEnabled={handleChangeFaultsEnabled}
                  plateBoundariesEnabled={plateBoundariesEnabled}
                  onChangePlateBoundariesEnabled={handleChangePlateBoundariesEnabled}
                  epicenterCirclesEnabled={epicenterCirclesEnabled}
                  onChangeEpicenterCirclesEnabled={handleChangeEpicenterCirclesEnabled}
                  boundaryLineColorId={boundaryLineColorId}
                  onChangeBoundaryLineColorId={handleChangeBoundaryLineColorId}
                  quakeFetchLimit={quakeFetchLimit}
                  onChangeQuakeFetchLimit={handleChangeQuakeFetchLimit}
                  stationListDisplayMode={stationListDisplayMode}
                  onChangeStationListDisplayMode={handleChangeStationListDisplayMode}
                  experimentalFeaturesEnabled={experimentalFeaturesEnabled}
                  onChangeExperimentalFeaturesEnabled={handleChangeExperimentalFeaturesEnabled}
                  testTsunami={testTsunami}
                  onBroadcastTestTsunami={broadcastTestTsunami}
                  onCancelTestTsunami={cancelTestTsunami}
                  onClearTestTsunami={clearTestTsunami}
                  testEews={testEews}
                  onTestEewAction={handleTestEewAction}
                  eewTestForm={eewTestForm}
                  eewEpicenterPickActive={eewEpicenterPickActive}
                  eews={effectiveEews}
                  eewDetailOpen={eewDetailOpen}
                  eewOpenSignal={eewOpenSignal}
                  onOpenEewDetail={() => { setEewDetailOpen(true); setEewOpenSignal(s => s + 1); }}
                  onCloseEewDetail={() => setEewDetailOpen(false)}
                  testQuake={testQuake}
                  onTestQuakeAction={handleTestQuakeAction}
                  quakeTestForm={quakeTestForm}
                  quakeEpicenterPickActive={quakeEpicenterPickActive}
                  quakeTestAutoPlaying={quakeTestAutoPlaying}
                  tsunamiAreaPickActive={tsunamiAreaPickActive}
                  onStartTsunamiAreaPick={startTsunamiAreaPick}
                  pickedTsunamiAreas={pickedTsunamiAreas}
                  onRemoveTsunamiAreaPick={removeTsunamiAreaPick}
                  onCycleTsunamiAreaGrade={cycleTsunamiAreaGrade}
                  pickedTsunamiHeights={pickedTsunamiHeights}
                  onChangeTsunamiHeightPick={changeTsunamiHeightPick}
                  onRemoveTsunamiHeightPick={removeTsunamiHeightPick}
                  candidateHeightStations={candidateHeightStations}
                  onAddTsunamiHeightPick={addTsunamiHeightPick}
                  stations={stations}
                  searchQuake={searchQuake}
                  onFoundSearchQuake={setSearchQuake}
                  onEpicenterPointsChange={setEpicenterPoints}
                  onEpicenterLoadingChange={setEpicenterLoading}
                  mapSelectSignal={mapSelectSignal}
                />
              </div>
            </Glass>
              </div>
          ) : (
            <BottomDock
              active={activeNav}
              onNav={handleNavTap}
              navCollapseSignal={navCollapseSignal}
              navDoubleTapSignal={navDoubleTapSignal}
              layerOpen={layerOpen}
              layers={layersForPanel}
              onToggleLayer={toggleLayer}
              onLayerOpenChange={setLayerOpen}
              quakes={effectiveQuakes}
              quakeStatus={quakeStatus}
              selectedQuakeId={selectedQuakeId}
              onSelectQuake={selectQuake}
              tsunamis={effectiveTsunamis}
              tsunamiStatus={tsunamiStatus}
              selectedTsunamiId={selectedTsunamiId}
              onSelectTsunami={setSelectedTsunamiId}
              isViewingPastTsunami={isViewingPastTsunami}
              tsunamiHistory={tsunamiHistory}
              onLoadMoreTsunamiHistory={loadMoreTsunamiHistory}
              onTsunamiViewModeChange={setTsunamiViewModeTop}
              onCurrentLocationChange={setCurrentLocationPoint}
                  onNowcastChange={handleNowcastChange}
                  onPrecipChange={handlePrecipChange}
                  onWdistChange={handleWdistChange}
                  onTyphoonChange={handleTyphoonChange}
                  onSelectTyphoon={handleSelectTyphoon}
                  selectedTyphoonInfo={selectedTyphoonInfo}
                  onClearSelectedTyphoon={handleClearSelectedTyphoon}
                  onSelectTyphoonDetail={handleSelectTyphoonCenter}
                  warningLevelMap={warningLevelMap}
                  warningAreaByRegioncode={warningAreaByRegioncode}
                  selectedWarningArea={selectedWarningArea}
                  onSelectWarningAreaFromList={handleSelectWarningAreaFromList}
                  onBackFromWarningArea={handleBackFromWarningArea}
                  onAlertLayerChange={handleAlertLayerChange}
                  onAlertModeChange={handleAlertModeChange}
                  onRiverLayerChange={handleRiverLayerChange}
                  selectedRiverStation={selectedRiverStation}
                  onSelectRiverStation={handleSelectRiverStation}
              tideStations={tideStationsWithGrade}
              tideStationsStatus={tideStationsStatus}
              selectedTideStationCode={selectedTideStationCode}
              onSelectTideStation={setSelectedTideStationCode}
              tideStationSelectSignal={tideStationSelectSignal}
              tsunamiHeightByStation={tsunamiHeightByStationForDisplay}
              tsunamiHeightTimeByStation={tsunamiHeightTimeByStationForDisplay}
              tideObsByStation={tideObsByStation}
              onLoadTideObs={loadTideObs}
              onCausingQuakeChange={setCausingQuakeCard}
              stationMarkersVisible={stationMarkersVisible}
              onToggleStationMarkersVisible={() => setStationMarkersVisible(v => !v)}
              tideStationMarkersVisible={tideStationMarkersVisible}
              onToggleTideStationMarkersVisible={() => setTideStationMarkersVisible(v => !v)}
              stationPoints={selectedQuakePoints}
              onChangeQuakeColorScheme={handleChangeQuakeColorScheme}
                  onChangeNowcastColorScheme={handleChangeNowcastColorScheme}
              estIntensityEnabled={estIntensityEnabled}
              onChangeEstIntensityEnabled={handleChangeEstIntensityEnabled}
              areaFillEnabled={areaFillEnabled}
              onChangeAreaFillEnabled={handleChangeAreaFillEnabled}
              faultsEnabled={faultsEnabled}
              onChangeFaultsEnabled={handleChangeFaultsEnabled}
              plateBoundariesEnabled={plateBoundariesEnabled}
              onChangePlateBoundariesEnabled={handleChangePlateBoundariesEnabled}
              epicenterCirclesEnabled={epicenterCirclesEnabled}
              onChangeEpicenterCirclesEnabled={handleChangeEpicenterCirclesEnabled}
              boundaryLineColorId={boundaryLineColorId}
              onChangeBoundaryLineColorId={handleChangeBoundaryLineColorId}
              quakeFetchLimit={quakeFetchLimit}
              onChangeQuakeFetchLimit={handleChangeQuakeFetchLimit}
              stationListDisplayMode={stationListDisplayMode}
              onChangeStationListDisplayMode={handleChangeStationListDisplayMode}
              experimentalFeaturesEnabled={experimentalFeaturesEnabled}
              onChangeExperimentalFeaturesEnabled={handleChangeExperimentalFeaturesEnabled}
              testTsunami={testTsunami}
              onBroadcastTestTsunami={broadcastTestTsunami}
              onCancelTestTsunami={cancelTestTsunami}
              onClearTestTsunami={clearTestTsunami}
              testEews={testEews}
              onTestEewAction={handleTestEewAction}
              eewTestForm={eewTestForm}
              eewEpicenterPickActive={eewEpicenterPickActive}
              eews={effectiveEews}
              eewDetailOpen={eewDetailOpen}
              eewOpenSignal={eewOpenSignal}
              onOpenEewDetail={() => { setEewDetailOpen(true); setEewOpenSignal(s => s + 1); }}
              onCloseEewDetail={() => setEewDetailOpen(false)}
              testQuake={testQuake}
              onTestQuakeAction={handleTestQuakeAction}
              quakeTestForm={quakeTestForm}
              quakeEpicenterPickActive={quakeEpicenterPickActive}
              quakeTestAutoPlaying={quakeTestAutoPlaying}
              tsunamiAreaPickActive={tsunamiAreaPickActive}
              onStartTsunamiAreaPick={startTsunamiAreaPick}
              pickedTsunamiAreas={pickedTsunamiAreas}
              onRemoveTsunamiAreaPick={removeTsunamiAreaPick}
              onCycleTsunamiAreaGrade={cycleTsunamiAreaGrade}
              pickedTsunamiHeights={pickedTsunamiHeights}
              onChangeTsunamiHeightPick={changeTsunamiHeightPick}
              onRemoveTsunamiHeightPick={removeTsunamiHeightPick}
              candidateHeightStations={candidateHeightStations}
              onAddTsunamiHeightPick={addTsunamiHeightPick}
              stations={stations}
              searchQuake={searchQuake}
              onFoundSearchQuake={setSearchQuake}
              onEpicenterPointsChange={setEpicenterPoints}
              onEpicenterLoadingChange={setEpicenterLoading}
              mapSelectSignal={mapSelectSignal}
            />
          )}
        </div>

      </div>

      {/* 利用規約・プライバシーポリシー・注意事項への同意ゲート。既存のフローティング
          UI(BottomDock等)とは別の全画面オーバーレイで、未同意の間は他の操作を
          一切ブロックする。同意済み(かつ内容に更新が無い)場合は何も描画しない。 */}
      <TermsConsentGate/>
    </NowcastColorSchemeContext.Provider>
    </QuakeColorSchemeContext.Provider>
    </GlassOpaqueContext.Provider>
    </ThemeContext.Provider>
  );
}
