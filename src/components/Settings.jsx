import { Fragment, useContext, useEffect, useState } from "react";
import { APP_VERSION, DEBUG_LOG_MAX, clearDebugLog, useDebugLog } from "../lib/debugLog.js";
import { GlassOpaqueContext, PressableButton } from "../ui/glass.jsx";
import { JMA_NOWCAST_SOURCE_PALETTE, NOWCAST_COLOR_SCHEMES } from "../weather/nowcast.js";
import { INTENSITY_LABEL, INTENSITY_ORDER } from "../quake/intensityScale.jsx";
import { BOUNDARY_LINE_COLORS, QUAKE_COLOR_SCHEMES, QUAKE_FETCH_LIMIT_DEFAULT, QUAKE_FETCH_LIMIT_MAX, QUAKE_FETCH_LIMIT_MIN, QuakeColorSchemeContext, STATION_LIST_DISPLAY_MODES, ThemeContext, clampQuakeFetchLimit, getIntensityStyleFromScheme } from "../settings/prefs.js";
import { QUAKE_STAGE_LABEL, tsunamiGradeInfo } from "../api/p2p.js";
import { EMPTY_EQDB_LIST } from "../api/quakeData.js";
import { Toggle } from "./nav.jsx";

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
export const TEST_TSUNAMI_GRADE_OPTIONS = [
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
export function renderMarkdownLite(text, tokens) {
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



export function SettingsBody({
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
