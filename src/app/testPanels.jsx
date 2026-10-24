import { useContext, Fragment } from "react";
import { ThemeContext } from "./theme";
import { PressableButton } from "./glass";
import { SettingsCard, SettingsCardDivider } from "./settingsPrimitives";
import { INTENSITY_LABEL } from "./stationIcons";
import { QUAKE_STAGE_LABEL } from "./quakeCards";
import { haversineKm } from "./geo";
import { tsunamiGradeInfo } from "./tsunamiData";


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

export function EewTestBroadcastPanel({ testEews, onAction, eewTestForm, eewEpicenterPickActive }) {
  const { tokens, mode } = useContext(ThemeContext);
  const f = eewTestForm;
  const isEditing = !!f.editingId;

  // colorScheme: <select>のネイティブなドロップダウン一覧(PCのブラウザは
  // OS/ブラウザ側の描画になり、backgroundやcolorのCSSがポップアップの中まで
  // 完全には反映されない)に、閉じた状態のボタンと同じ配色系統を使わせるため
  // の指定。これが無いと常にライト前提の配色になり、ダークモード時に白文字が
  // 白背景のポップアップに重なって読めなくなる。
  const inputStyle = {
    width: "100%", padding: "8px 10px", borderRadius: 8, border: "none",
    background: `rgba(${tokens.ink},0.08)`, color: tokens.text,
    fontSize: 13, fontWeight: 600, boxSizing: "border-box",
    colorScheme: mode === "dark" ? "dark" : "light",
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

export function QuakeTestBroadcastPanel({ testQuake, onAction, quakeTestForm, quakeEpicenterPickActive, quakeTestAutoPlaying }) {
  const { tokens, mode } = useContext(ThemeContext);
  const f = quakeTestForm;

  // colorScheme: PCブラウザのネイティブ<select>ポップアップの配色をアプリの
  // モードに合わせる(無いとダークモードで白文字が白背景に埋もれて読めない)。
  const inputStyle = {
    width: "100%", padding: "8px 10px", borderRadius: 8, border: "none",
    background: `rgba(${tokens.ink},0.08)`, color: tokens.text,
    fontSize: 13, fontWeight: 600, boxSizing: "border-box",
    colorScheme: mode === "dark" ? "dark" : "light",
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

/* ─────────────────────────────────────────────────────
   SHAKE DETECTION TEST PANEL — 実験的機能の1つ。
   揺れ検知エンジン(shakeDetection.ts)の動作確認用に、震源(地図タップ)・
   深さ・Mを指定して仮想的な揺れを発生させる。QuakeTestBroadcastPanelと
   同じUIパターン(震源ピック・SettingsCardでの入力欄)を踏襲している。
   ───────────────────────────────────────────────────── */
export function ShakeDetectionTestPanel({ shakeTests = [], onAction, shakeTestForm, shakeTestEpicenterPickActive, epicenterEstimates }) {
  const { tokens, mode } = useContext(ThemeContext);
  const f = shakeTestForm;
  const running = shakeTests.length > 0;

  // 震源推定(epicenterEstimation.ts)の現在の推定結果のうち、各シミュレーション
  // (実際の震源)に最も近いものを、そのシミュレーションとの比較対象として
  // 選ぶ。複数のシミュレーションが同時実行されている場合でも、それぞれの
  // 「実際の震源」に地理的に最も近い推定を対応付けることで、どの検知
  // イベントがどのシミュレーションに対応するかを個別に判定する(11節の
  // イベント統合対策により、近接する複数のシミュレーションが1つの検知
  // イベントに統合されている場合は、同じ推定が複数のシミュレーションの
  // 比較対象として選ばれることもある。これは統合が正しく機能している
  // 証拠でもあるため、意図通りの挙動)。
  function pickBestEstimateFor(form) {
    if (!epicenterEstimates) return null;
    let best = null;
    let bestDistanceKm = Infinity;
    for (const est of epicenterEstimates.values()) {
      if (!est) continue;
      const d = haversineKm(form.latitude, form.longitude, est.lat, est.lon);
      if (d < bestDistanceKm) { bestDistanceKm = d; best = est; }
    }
    return best;
  }

  // colorScheme: PCブラウザのネイティブ<select>ポップアップの配色をアプリの
  // モードに合わせる(無いとダークモードで白文字が白背景に埋もれて読めない)。
  const inputStyle = {
    width: "100%", padding: "8px 10px", borderRadius: 8, border: "none",
    background: `rgba(${tokens.ink},0.08)`, color: tokens.text,
    fontSize: 13, fontWeight: 600, boxSizing: "border-box",
    colorScheme: mode === "dark" ? "dark" : "light",
  };
  const labelStyle = {
    display: "block", fontSize: 11, fontWeight: 600,
    color: `rgba(${tokens.ink},0.5)`, marginBottom: 4,
  };
  function patchForm(patch) {
    onAction?.("patchForm", patch);
  }

  return (
    <>
      <div style={{ margin: "-4px 14px 10px", fontSize: 11, color: `rgba(${tokens.ink},0.45)`, lineHeight: 1.7 }}>
        実際の地震ではない、揺れ検知エンジンの動作確認用のシミュレーションです。
        震源・M・深さから観測点ごとのP波/S波到達時刻とピーク震度を計算し、
        実際のリアルタイム震度データと同じ形で観測点に反映します
        (地盤増幅・断層破壊伝播・指向性は簡略化のため考慮していません)。
      </div>

      <div style={{ margin: "18px 14px 6px" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: `rgba(${tokens.ink},0.7)` }}>
          震源
        </span>
      </div>
      <SettingsCard>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label style={labelStyle}>震源</label>
            <PressableButton
              type="button"
              onClick={() => onAction?.(shakeTestEpicenterPickActive ? "cancelEpicenterPick" : "startEpicenterPick")}
              style={{
                width: "100%", padding: "10px 12px", borderRadius: 8, border: "none", cursor: "pointer",
                textAlign: "left",
                background: shakeTestEpicenterPickActive ? "rgba(255,69,58,0.18)" : `rgba(${tokens.ink},0.08)`,
                color: shakeTestEpicenterPickActive ? "#FF453A" : tokens.text,
              }}
            >
              {shakeTestEpicenterPickActive ? (
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
        </div>
      </SettingsCard>

      <SettingsCard>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <PressableButton
            type="button"
            onClick={() => onAction?.("start")}
            disabled={f.latitude == null || f.longitude == null}
            style={{
              width: "100%", padding: "10px 14px", borderRadius: 10, border: "none",
              cursor: (f.latitude == null || f.longitude == null) ? "default" : "pointer",
              background: "rgba(48,209,88,0.16)", color: "#30D158",
              fontSize: 13, fontWeight: 700, textAlign: "center",
              opacity: (f.latitude == null || f.longitude == null) ? 0.5 : 1,
            }}
          >
            地震を発生させる
          </PressableButton>
          <div style={{ fontSize: 11, color: `rgba(${tokens.ink},0.45)`, lineHeight: 1.6 }}>
            発生させると、震源に近い観測点から順にP波→S波が到達し、震度が立ち上がって
            から徐々に収まっていきます。全観測点の揺れが収まると自動的に終了します。
            実行中でも新たに発生させると、複数の地震を同時にシミュレーションできます
            (観測点の震度が重複する場合は、より高い方が採用されます)。
          </div>
        </div>
      </SettingsCard>

      {running && (
        <>
          <div style={{ margin: "18px 14px 6px" }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: `rgba(${tokens.ink},0.7)` }}>
              実行中のシミュレーション({shakeTests.length}件)
            </span>
          </div>
          <SettingsCard>
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              {shakeTests.map(t => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: tokens.text, lineHeight: 1.5, minWidth: 0 }}>
                    {t.form.place}・M{t.form.magnitude.toFixed(1)}・深さ{t.form.depth}km
                  </div>
                  <PressableButton
                    type="button"
                    onClick={() => onAction?.("stop", { id: t.id })}
                    style={{
                      flexShrink: 0, padding: "6px 10px", borderRadius: 8, border: "none", cursor: "pointer",
                      background: "rgba(255,69,58,0.16)", color: "#FF453A",
                      fontSize: 11, fontWeight: 700, whiteSpace: "nowrap",
                    }}
                  >
                    停止
                  </PressableButton>
                </div>
              ))}
              {shakeTests.length > 1 && (
                <PressableButton
                  type="button"
                  onClick={() => onAction?.("stop")}
                  style={{
                    width: "100%", padding: "8px 12px", borderRadius: 8, border: "none", cursor: "pointer",
                    background: `rgba(${tokens.ink},0.08)`, color: tokens.text,
                    fontSize: 12, fontWeight: 700, textAlign: "center",
                  }}
                >
                  すべて停止
                </PressableButton>
              )}
            </div>
          </SettingsCard>
        </>
      )}

      {running && (
        <>
          <div style={{ margin: "18px 14px 6px" }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: `rgba(${tokens.ink},0.7)` }}>
              実際の震源 と 検知した震源(推定)の比較
            </span>
          </div>
          {shakeTests.map(t => {
            const compareTarget = t.form;
            const bestEstimate = pickBestEstimateFor(compareTarget);
            const distanceErrorKm = bestEstimate
              ? haversineKm(compareTarget.latitude, compareTarget.longitude, bestEstimate.lat, bestEstimate.lon)
              : null;
            const depthErrorKm = bestEstimate
              ? bestEstimate.depthKm - compareTarget.depth
              : null;
            const magnitudeError = (bestEstimate && bestEstimate.magnitude != null)
              ? bestEstimate.magnitude - compareTarget.magnitude
              : null;
            return (
              <SettingsCard key={t.id}>
                <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                  {shakeTests.length > 1 && (
                    <div style={{ fontSize: 12, fontWeight: 700, color: `rgba(${tokens.ink},0.85)` }}>
                      {compareTarget.place}・M{compareTarget.magnitude.toFixed(1)}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                        <span style={{
                          display: "inline-block", width: 10, height: 10, transform: "rotate(45deg)",
                          background: "#FFFFFF", border: "1.5px solid #111111", boxSizing: "border-box",
                        }} />
                        <span style={{ fontSize: 11, fontWeight: 700, color: `rgba(${tokens.ink},0.55)` }}>実際の震源</span>
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>
                        北緯{compareTarget.latitude?.toFixed?.(2)}° ・ 東経{compareTarget.longitude?.toFixed?.(2)}°
                      </div>
                      <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.6)`, marginTop: 2 }}>
                        深さ{compareTarget.depth}km
                      </div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                        <span style={{
                          display: "inline-block", width: 10, height: 10, borderRadius: "50%",
                          background: "#FFFFFF", border: "1.5px solid #111111", boxSizing: "border-box",
                        }} />
                        <span style={{ fontSize: 11, fontWeight: 700, color: `rgba(${tokens.ink},0.55)` }}>検知した震源(推定)</span>
                      </div>
                      {bestEstimate ? (
                        <>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>
                            北緯{bestEstimate.lat.toFixed(2)}° ・ 東経{bestEstimate.lon.toFixed(2)}°
                          </div>
                          <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.6)`, marginTop: 2 }}>
                            深さ{Math.round(bestEstimate.depthKm)}km ・ 検知点数{bestEstimate.pointCount}
                            {bestEstimate.magnitude != null && <> ・ M{bestEstimate.magnitude.toFixed(1)}(推定)</>}
                          </div>
                          <div style={{
                            display: "inline-block", marginTop: 4, padding: "1px 6px", borderRadius: 4,
                            fontSize: 10, fontWeight: 700,
                            background: bestEstimate.confirmed ? "rgba(52,199,89,0.15)" : "rgba(255,149,0,0.15)",
                            color: bestEstimate.confirmed ? "#248A3D" : "#B25000",
                          }}>
                            {bestEstimate.confirmed ? "収束済み" : "推定中(位置が変動する可能性あり)"}
                          </div>
                        </>
                      ) : (
                        <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.45)`, marginTop: 2 }}>
                          まだ検知なし(「震源推定」設定がOFFの場合は表示されません)
                        </div>
                      )}
                    </div>
                  </div>
                  {bestEstimate && (
                    <div style={{
                      marginTop: 2, paddingTop: 10, borderTop: `1px solid rgba(${tokens.ink},0.08)`,
                      fontSize: 12, color: `rgba(${tokens.ink},0.65)`,
                    }}>
                      誤差: 水平方向 約{distanceErrorKm.toFixed(1)}km ・ 深さ方向 {depthErrorKm >= 0 ? "+" : ""}{depthErrorKm.toFixed(0)}km
                      {magnitudeError != null && <> ・ M {magnitudeError >= 0 ? "+" : ""}{magnitudeError.toFixed(1)}</>}
                    </div>
                  )}
                </div>
              </SettingsCard>
            );
          })}
        </>
      )}
    </>
  );
}

export function TsunamiTestBroadcastPanel({
  testTsunami, onBroadcast, onCancel, onClear,
  tsunamiAreaPickActive, onStartAreaPick, pickedAreas = [], onRemoveAreaPick, onCycleAreaGrade,
  pickedHeights = [], onChangeHeightPick, onRemoveHeightPick,
  candidateHeightStations = [], onAddHeightPick,
}) {
  const { tokens, mode } = useContext(ThemeContext);
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
                      // PCブラウザのネイティブポップアップの配色をモードに合わせる
                      // (無いとダークモードで白文字が白背景に埋もれて読めない)。
                      colorScheme: mode === "dark" ? "dark" : "light",
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
                // PCブラウザのネイティブポップアップの配色をモードに合わせる
                // (無いとダークモードで文字が背景に埋もれて読めない)。
                colorScheme: mode === "dark" ? "dark" : "light",
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
