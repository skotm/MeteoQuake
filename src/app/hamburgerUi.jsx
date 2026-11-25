import { useContext } from "react";
import { createPortal } from "react-dom";
import { ThemeContext } from "./theme";
import { NAV_ICONS } from "./navUi";
import { HAM_BAR_TOP, HAM_BTN_SIZE } from "./hamburgerLayout";

/* ハンバーガー式のタブ配置で使う部品。
   ・HamburgerExpandButton: フローティングのカードの右上(すぐ上)に出す「全画面」ボタン。
   ・HamburgerLayer: 全画面の時の背景・上部のボタン行・左ドロワー(タブ一覧)・切り替えの知らせ。 */

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
const ICON_MENU = <svg viewBox="0 0 24 24" width="24" height="24" {...stroke}><path d="M4 7h16M4 12h16M4 17h16"/></svg>;
const ICON_EXPAND = <svg viewBox="0 0 24 24" width="22" height="22" {...stroke}><path d="M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6"/></svg>;
const ICON_SHRINK = <svg viewBox="0 0 24 24" width="22" height="22" {...stroke}><path d="M14 10h6V4M10 14H4v6M20 4l-6 6M4 20l6-6"/></svg>;

function roundBtnStyle(tokens, extra) {
  return {
    width: HAM_BTN_SIZE, height: HAM_BTN_SIZE, borderRadius: HAM_BTN_SIZE / 2, border: 0, padding: 0,
    display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
    color: tokens.text, background: tokens.glassOpaqueBg,
    boxShadow: `inset 0 0 0 0.5px ${tokens.rimLight}, 0 2px 10px rgba(0,0,0,0.18)`,
    WebkitTapHighlightColor: "transparent", ...extra,
  };
}

// カードの右上(上端のすぐ上)に出す「全画面」ボタン。タブボタンを右上に出す設定(cornerTabs)と同じ置き方。
export function HamburgerExpandButton({ onClick }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <div style={{ position: "absolute", left: 16, right: 16, bottom: "100%", display: "flex", justifyContent: "center", pointerEvents: "none", zIndex: 10, animation: "appearFade 0.4s ease-out 0.1s backwards" }}>
      <div style={{ width: "100%", maxWidth: 480, minWidth: 240, display: "flex", justifyContent: "flex-end" }}>
        <button type="button" aria-label="全画面で表示" onClick={onClick}
          style={roundBtnStyle(tokens, { pointerEvents: "auto", marginBottom: 8, width: 44, height: 44, borderRadius: 22 })}>
          {ICON_EXPAND}
        </button>
      </div>
    </div>
  );
}

export function HamburgerLayer({ fullscreen, menuOpen, activeId, navItems, onOpenMenu, onCloseMenu, onSelect, onShrink, notice }) {
  const { tokens } = useContext(ThemeContext);
  const activeLabel = navItems.find((n) => n.id === activeId)?.label ?? "";
  const bar = { position: "fixed", top: HAM_BAR_TOP, zIndex: 41 };
  return createPortal(
    <>
      {fullscreen && (
        <>
          {/* 地図を隠す背景(ドック本体=z40の下)。 */}
          <div aria-hidden="true" style={{ position: "fixed", inset: 0, zIndex: 39, background: tokens.pageBg }}/>
          <button type="button" aria-label="メニューを開く" aria-expanded={menuOpen} onClick={onOpenMenu}
            style={roundBtnStyle(tokens, { ...bar, left: 16 })}>{ICON_MENU}</button>
          <div style={{ ...bar, left: 80, right: 80, height: HAM_BTN_SIZE, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 800, color: tokens.text, pointerEvents: "none" }}>
            {activeLabel}
          </div>
          <button type="button" aria-label="フローティングに戻す" onClick={onShrink}
            style={roundBtnStyle(tokens, { ...bar, right: 16 })}>{ICON_SHRINK}</button>
        </>
      )}
      {fullscreen && menuOpen && (
        <>
          <div onClick={onCloseMenu} aria-hidden="true" style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(20,40,80,0.35)" }}/>
          <nav aria-label="タブ" style={{
            position: "fixed", left: 0, top: 0, bottom: 0, width: 290, maxWidth: "82vw", zIndex: 61, boxSizing: "border-box",
            padding: `calc(env(safe-area-inset-top, 0px) + 48px) 14px calc(env(safe-area-inset-bottom, 0px) + 24px)`,
            borderRadius: "0 28px 28px 0", background: tokens.glassOpaqueBg, color: tokens.text,
            boxShadow: "0 0 30px rgba(20,40,80,0.35)", display: "flex", flexDirection: "column", gap: 4,
            animation: "appearFade 0.25s ease-out",
          }}>
            <div style={{ fontSize: 22, fontWeight: 800, padding: "0 18px 14px" }}>MeteoQuake</div>
            {navItems.map((n) => {
              const on = n.id === activeId;
              return (
                <button key={n.id} type="button" aria-current={on ? "page" : undefined} onClick={() => onSelect(n.id)}
                  style={{
                    height: 56, border: 0, borderRadius: 16, padding: "0 18px", display: "flex", alignItems: "center", gap: 14,
                    fontSize: 18, fontWeight: on ? 800 : 600, color: "inherit", cursor: "pointer", textAlign: "left",
                    background: on ? `rgba(${tokens.ink},0.09)` : "transparent", WebkitTapHighlightColor: "transparent",
                  }}>
                  <span style={{ display: "flex", width: 26, height: 26, alignItems: "center", justifyContent: "center" }}>{NAV_ICONS[n.id]}</span>
                  {n.label}
                </button>
              );
            })}
          </nav>
        </>
      )}
      {notice && (
        <div role="status" style={{
          position: "fixed", left: 16, right: 16, top: HAM_BAR_TOP, zIndex: 70, minHeight: HAM_BTN_SIZE, boxSizing: "border-box",
          borderRadius: HAM_BTN_SIZE / 2, padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center",
          background: "#0B0B0C", color: "#fff", fontSize: 13, fontWeight: 700, lineHeight: 1.3, boxShadow: "0 2px 12px rgba(0,0,0,0.3)", animation: "appearFade 0.25s ease-out",
        }}>{notice}</div>
      )}
    </>,
    document.body
  );
}
