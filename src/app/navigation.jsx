


/* ─────────────────────────────────────────────────────
   TRUE LIQUID GLASS
   
   Apple iOS 26 の物理モデル:
   - ガラス面 = ほぼ透明（tint なし）
   - 縁 = 光が屈折・集光 → feDisplacementMap で歪み
   - ハイライト = 縁の外側だけに細い白線（rim light）
   - 内部コンテンツは読みやすいよう最低限のblurのみ
   ───────────────────────────────────────────────────── */

export const LAYERS = [
  { id: "quake",        label: "震度分布",     on: false },
  // 実際のon/offは常にApp側のestIntensityEnabled(設定と共有・localStorage永続化)で
  // 上書きされるため、ここでの初期値(false)自体は使われない(layersForPanelを参照)。
  { id: "estIntensity", label: "推計震度分布", on: false },
  { id: "tsunami",      label: "津波予報区",   on: false },
];

// リアルタイムタブは廃止し、地震タブのフローティングバー左端「リアルタイム」に統合した。
// (気象・警報タブは移植後にここへ追加する)
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

      </defs>
    </svg>
  );
}
