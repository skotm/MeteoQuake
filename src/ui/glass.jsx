import { createContext, forwardRef, useContext, useEffect, useState } from "react";
import { ThemeContext } from "../settings/prefs.js";

/* ─────────────────────────────────────────────────────
   RESPONSIVE LAYOUT
   スマホ縦持ちでは「下部タブバー + 下からドラッグして開くボトムシート」、
   横画面スマホ・タブレット・PCなど横幅が十分ある場合は「左端の縦タブバー
   (レール) + 常に画面右側に居るパネル」に切り替える。
   ここではその判定(=isWideLayout)だけを提供する。実際のレイアウト分岐は
   BottomDock側で行う。
   ───────────────────────────────────────────────────── */
const WIDE_LAYOUT_MIN_WIDTH = 720;
 // これ未満は常にスマホ縦持ち相当の下部タブバーを使う

export function useIsWideLayout() {
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
export function useIsStandalonePwa() {
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
export function useWideUIScale(isWide) {
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


export const LAYERS = [
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


export const NAV = [
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
export function Filters() {
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
export function detectSuspectedBackdropFilterBreakage() {
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


const GLASS_OPAQUE_OVERRIDE_KEY = "glassOpaqueFallback";
 // "auto" | "on" | "off"

export function loadGlassOpaqueOverride() {
  try {
    const v = localStorage.getItem(GLASS_OPAQUE_OVERRIDE_KEY);
    return v === "on" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}


export function saveGlassOpaqueOverride(v) {
  try { localStorage.setItem(GLASS_OPAQUE_OVERRIDE_KEY, v); } catch {}
}


// Glassコンポーネント群、および設定画面の「フローティング関連」トグルが
// 共有するcontext。Appのトップレベルで判定結果(自動判定 or 手動オーバーライド)
// と、オーバーライドを変更するための関数をまとめて配信する。
// - opaque: 実際に不透明表示にするかどうか(Glassコンポーネントが参照)
// - override: "auto" | "on" | "off"(ユーザーの手動選択。設定画面のトグルに対応)
// - suspectedBroken: 自動判定の結果(ぼかしが実効しない疑いがあるか)
// - setOverride: overrideを変更する関数
export const GlassOpaqueContext = createContext({
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
export const Glass = forwardRef(function Glass({
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
export const PressableButton = forwardRef(function PressableButton({ style, onClick, children, ...rest }, ref) {
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
