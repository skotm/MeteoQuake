import { useContext, useState } from "react";
import { Glass, PressableButton } from "../ui/glass.jsx";
import { ThemeContext } from "../settings/prefs.js";

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


const WEATHER_MENU_BUTTON_SIZE = 44;
      // 閉じている時のトグルボタン(円)のサイズ
const WEATHER_MENU_BUTTON_SIZE_OPEN = 34;
 // 開いている時は少し小さく
const WEATHER_MENU_TOGGLE_RECT_HEIGHT = 22;
 // 開いている時のトグルボタンの長方形の高さ(雨雲レーダー等の項目より細長い)
const WEATHER_MENU_ITEM_HEIGHT = 32;
      // 各項目の長方形ボタンの高さ
const WEATHER_MENU_ITEM_GAP = 6;
          // 項目同士の間隔
const WEATHER_MENU_ITEMS_PAD = 8;
         // 項目ブロックの上下左右の余白
const WEATHER_MENU_PAGE_NAV_HEIGHT = 26;
  // ページ送り(左右のくの字)の行の高さ
const WEATHER_MENU_WIDTH = 172;


export function WeatherMenuFloating({
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
  { id: "heavyrainKikkuru", label: "大雨キキクル" },
  { id: "riverLevel", label: "河川水位" },
];


export function AlertMenuFloating({ open, onToggle, growUp = true, itemStates = {}, onToggleItem }) {
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
