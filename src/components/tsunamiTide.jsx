import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Glass, PressableButton, useIsStandalonePwa } from "../ui/glass.jsx";
import { ThemeContext, getIntensityStyleFromScheme } from "../settings/prefs.js";
import { QUAKE_STAGE_LABEL, TSUNAMI_GRADE_FALLBACK, formatQuakeTimeShort, formatTsunamiMaxWaveTime, formatTsunamiTimeShort, tsunamiGradeInfo, tsunamiHeightBandColor } from "../api/p2p.js";
import { EMPTY_EQDB_LIST } from "../api/quakeData.js";
import { PanelDragHandoffCard, QuakeDetailCard, StationPointsList } from "../quake/quakeCards.jsx";
import { HistoryClockIcon, TideGaugeIcon } from "./icons.jsx";

/* ─────────────────────────────────────────────────────
   QUAKE LIST ROW
   地震一覧の1行分。「直近の一覧」と「検索結果一覧」の両方から共通で使う。
   ───────────────────────────────────────────────────── */
export function QuakeListRow({ quake: q, showDivider, colorScheme, onSelect, loading = false }) {
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
export function TsunamiTabBody({
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
