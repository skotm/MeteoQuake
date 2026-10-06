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
export function PinIcon({ size = 18 }) {
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
export function ListViewIcon({ size = 18 }) {
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
export function SearchGlassIcon({ size = 18 }) {
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
export function HistoryClockIcon({ size = 18 }) {
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
export function TideGaugeIcon({ size = 18 }) {
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
