import { useContext, useState } from "react";
import { ThemeContext } from "./theme";
import { PressableButton } from "./glass";
import { Toggle } from "./navUi";


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
export const SETTINGS_MENU = [
  { id: "tabSettings", label: "タブ設定" },
  { id: "terms",       label: "利用規約等・注意事項" },
  { id: "advanced",    label: "詳細設定" },
];

// 「タブ設定」配下の一覧。以前のSETTINGS_MENUそのもの。
// pathとしては ["tabSettings", "quake", ...] のように先頭にtabSettingsが付く形になる。
export const TAB_SETTINGS_CATEGORIES = [
  { id: "quake",    label: "地震" },
  { id: "tsunami",  label: "津波" },
  { id: "weather",  label: "気象" },
  // 旧「リアルタイム」カテゴリは、リアルタイムタブ廃止に伴い「地震」配下へ移した
  // (リアルタイム・リプレイ・カメラの動き)。
];

// カテゴリごとの項目一覧。地震・利用規約等の各カテゴリはSettingsBody内で専用に
// 組み立てるためここには含めない。他のカテゴリは現状すべて骨組み(空のプレースホルダー画面)。
export const SETTINGS_ITEMS = {
  weather: [
    { id: "nowcastColorScheme", label: "雨雲レーダー配色" },
    { id: "typhoonForecastInterval", label: "台風予報円の表示間隔" },
  ],
  advanced: [
    { id: "appearance", label: "外観" },
    // 【廃止】APIトークン入力機能を廃止したため、設定メニューからも除外。
    // { id: "realtimeApi", label: "リアルタイムAPI" },
    { id: "experimental", label: "実験的・テスト機能" },
    { id: "logs", label: "ログ" },
  ],
};

// 設定画面共通のヘッダー。「地図レイヤー」のような下線区切りは使わず、
// 太字の大きめタイトルにすることで独自の見た目にしている。
// 戻る操作は地震タブと同じ丸いフローティングボタン(BackToListButton)に
// 統一したので、ヘッダー自体には戻るボタンを持たせていない。
export function SettingsHeader({ title }) {
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
export function SettingsCard({ children }) {
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

export function SettingsCardDivider() {
  const { tokens } = useContext(ThemeContext);
  return <div style={{ height: 0.5, background: tokens.divider, marginLeft: 12 }}/>;
}

// カード内の1行。右端に「>」を出して、掘り下げられることを示す。
export function SettingsMenuRow({ label, onClick }) {
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
// 設定名の右に出す「ⓘ」ボタン。タップすると、説明文の吹き出しを開閉する。
function InfoTipButton({ open, onToggle }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <button
      type="button"
      aria-label="説明を表示"
      aria-expanded={open}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      style={{
        flex: "none", width: 20, height: 20, padding: 0, marginLeft: 6,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: "transparent", border: "none", cursor: "pointer",
        color: open ? tokens.text : tokens.textTertiary,
      }}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="9.5"/>
        <line x1="12" y1="11" x2="12" y2="16.5"/>
        <circle cx="12" cy="7.6" r="0.6" fill="currentColor"/>
      </svg>
    </button>
  );
}

function InfoTipBubble({ children }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <div role="tooltip" style={{
      marginTop: 6, padding: "8px 10px", borderRadius: 8,
      background: tokens.cardBorder, color: tokens.text,
      fontSize: 12, lineHeight: 1.5,
    }}>
      {children}
    </div>
  );
}

// 名前+ⓘ(タップで説明)の見出し部分。
function LabelWithTip({ label, description }) {
  const { tokens } = useContext(ThemeContext);
  const [open, setOpen] = useState(false);
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: tokens.text }}>{label}</span>
        {description && <InfoTipButton open={open} onToggle={() => setOpen(o => !o)}/>}
      </div>
      {description && open && <InfoTipBubble>{description}</InfoTipBubble>}
    </div>
  );
}

export function SettingsToggleRow({ label, description, checked, onChange, disabled = false }) {
  return (
    <div style={{
      width: "100%", display: "flex", alignItems: "center", gap: 10,
      padding: "12px 14px",
    }}>
      <LabelWithTip label={label} description={description}/>
      <Toggle on={checked} onChange={onChange} disabled={disabled}/>
    </div>
  );
}

// 選択肢から1つ選ぶ行(分割ボタン形式)。options: [{ value, label }]
export function SettingsSegmentRow({ label, description, value, options, onChange }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <div style={{ width: "100%", padding: "12px 14px", boxSizing: "border-box" }}>
      <LabelWithTip label={label} description={description}/>
      <div style={{
        display: "flex", marginTop: 8, borderRadius: 8, overflow: "hidden",
        boxShadow: `inset 0 0 0 0.5px ${tokens.cardBorder}`,
      }}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button key={String(o.value)} type="button" onClick={() => onChange(o.value)}
              style={{
                flex: 1, padding: "7px 4px", border: "none", cursor: "pointer",
                fontSize: 13, fontWeight: on ? 700 : 500,
                background: on ? tokens.cardBorder : "transparent", color: tokens.text,
              }}>
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
