import { createContext, forwardRef, useContext, useState } from "react";
import { ThemeContext } from "./theme";


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

const GLASS_OPAQUE_OVERRIDE_KEY = "glassOpaqueFallback"; // "auto" | "on" | "off"

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
