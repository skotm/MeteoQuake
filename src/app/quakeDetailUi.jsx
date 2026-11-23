import { useRef, useState, useLayoutEffect, useContext, useMemo, useEffect } from "react";
import { ThemeContext } from "./theme";
import { QUAKE_COLOR_SCHEMES, QuakeColorSchemeContext, getIntensityStyleFromScheme, getLongPeriodStyleFromScheme, splitIntensityLabel, useIntensityStyle, useLongPeriodStyle } from "./colorSchemes";
import { QUAKE_STAGE_LABEL, buildQuakeMessage, formatQuakeTimeShort } from "./quakeCards";
import { INTENSITY_ORDER } from "./stationIcons";
import { Glass, PressableButton } from "./glass";
import { useIsStandalonePwa } from "./layoutHooks";
import { IntensityNumWithSuffix } from "./intensityLabel";
import { findJmaMechanism, findUsgsCmtForQuake } from "./cmt";
import { loadStoredCmtSourcePref, saveCmtSourcePref } from "./settingsStorage";
import { prefOfAreaName } from "../longPeriod";


/* ─────────────────────────────────────────────────────
   AUTO FIT TEXT
   与えられたコンテナ幅に収まるよう、フォントサイズを自動的に縮小して1行で表示する。
   QuakeDetailCardの震源地名(短い地名〜長い地名まで幅が大きく変わる)向け。
   ResizeObserverでコンテナ幅の変化(画面回転・レイアウト変更)にも追従する。
   ───────────────────────────────────────────────────── */
export function AutoFitText({ text, maxFontSize, minFontSize = 13, className, style }) {
  const containerRef = useRef(null);
  const textRef = useRef(null);
  const [fontSize, setFontSize] = useState(maxFontSize);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const textEl = textRef.current;
    if (!container || !textEl) return;

    function fit() {
      const containerWidth = container.clientWidth;
      if (containerWidth <= 0) return;

      // 最大サイズから1pxずつ縮めて、テキストの実測幅(scrollWidth)が
      // コンテナ幅に収まるところを探す。文字数が少なければ最大サイズのまま。
      let size = maxFontSize;
      textEl.style.fontSize = `${size}px`;
      while (size > minFontSize && textEl.scrollWidth > containerWidth) {
        size -= 1;
        textEl.style.fontSize = `${size}px`;
      }
      setFontSize(size);
    }

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(container);
    return () => ro.disconnect();
  }, [text, maxFontSize, minFontSize]);

  return (
    <div ref={containerRef} style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
      <span
        ref={textRef}
        className={className}
        style={{ ...style, fontSize, whiteSpace: "nowrap", display: "inline-block" }}
      >
        {text}
      </span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   PANEL DRAG HANDOFF CARD
   フローティングパネル最上部のカード(地震カード・津波カード)を掴んで縦方向に
   ドラッグした時、リスト内スクロールではなく、パネル本体の高さ調整
   (ハンドルのドラッグ)として扱うためのラッパー。QuakeListToolbarの
   onHandoffToPanelDrag(縦方向優位の動きをパネルドラッグへ引き渡す)と同じ考え方。
   カード内のボタン等のタップ操作はそのまま素通しするため、判定前は何もしない。
   ───────────────────────────────────────────────────── */
export function PanelDragHandoffCard({ onHandoffToPanelDrag, children }) {
  const pointerId = useRef(null);
  const startX    = useRef(0);
  const startY    = useRef(0);
  const decided   = useRef(false);

  function handlePointerDown(e) {
    if (pointerId.current != null) return; // 複数指の同時操作は無視
    pointerId.current = e.pointerId;
    startX.current = e.clientX;
    startY.current = e.clientY;
    decided.current = false;
    // マウス(PC)ではポインタを捕捉しない。捕捉すると、押した位置のボタンではなくこのラッパーに
    // pointerupが届き、clickもラッパー側で発生するため、カード内のボタン(「津波を引き起こした地震」
    // など)が押せなくなる。タッチは元々押した要素に暗黙に捕捉されるため、従来どおり。
    if (e.pointerType !== "mouse") {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    }
  }
  function handlePointerMove(e) {
    if (pointerId.current !== e.pointerId || decided.current) return;
    const dx = e.clientX - startX.current;
    const dy = e.clientY - startY.current;
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return; // まだ判定するには小さすぎる(タップの可能性)
    decided.current = true;
    if (Math.abs(dy) >= Math.abs(dx)) {
      // 縦方向優位の動き = パネルの高さ調整として引き渡す(ハンドルを掴んだ時と同じ)
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
      pointerId.current = null;
      onHandoffToPanelDrag?.(e);
    }
    // 横方向優位の動きは、このラッパーとしては何もしない(カード内の通常操作に任せる)
  }
  function handlePointerUp(e) {
    if (pointerId.current !== e.pointerId) return;
    pointerId.current = null;
  }

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{ touchAction: "none" }} // QuakeListToolbarと同じ(縦横ともブラウザ標準ジェスチャーを完全に無効化し、途中でpointercancelされるのを防ぐ)
    >
      {children}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   LONG PERIOD BADGE — 長周期地震動階級の「通知バッジ」
   アプリの通知のように、震度バッジの右上に小さな赤い丸+階級の数字を重ねる。
   親(震度バッジ)はposition: relativeであること。階級が無い/0なら何も描かない。
   ───────────────────────────────────────────────────── */
export function LongPeriodBadge({ grade, size = 16, offset = -6 }) {
  const lp = useLongPeriodStyle(grade);
  if (!(grade >= 1) || !lp) return null;
  return (
    <span
      aria-label={`長周期地震動階級${grade}`}
      style={{
        position: "absolute", top: offset, right: offset, zIndex: 2,
        minWidth: size, height: size, boxSizing: "border-box", padding: "0 3px",
        borderRadius: size / 2,
        background: lp.bg, color: lp.fg,
        boxShadow: "0 0 0 1.5px rgba(255,255,255,0.9), 0 1px 3px rgba(0,0,0,0.3)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: Math.round(size * 0.62), fontWeight: 800, lineHeight: 1,
        pointerEvents: "none",
      }}
    >
      {grade}
    </span>
  );
}

const LONG_PERIOD_PHRASE = { 1: "やや大きな揺れ", 2: "大きな揺れ", 3: "非常に大きな揺れ", 4: "極めて大きな揺れ" };

/* ─────────────────────────────────────────────────────
   LONG PERIOD CARD — 長周期地震動階級(市区町村ごと)
   階級の高い順に、その階級を観測した市区町村を並べる。
   市区町村の階級は、観測点(コード先頭5桁が市区町村)の最大階級。観測点のある市区町村のみ。
   ───────────────────────────────────────────────────── */
// 観測点名の末尾などに付く「＊」(気象庁以外の震度観測点)は表示しない。
function stripStationMark(t) { return typeof t === "string" ? t.replace(/[*＊]/g, "").trim() : t; }

// 地図に出す内容の切り替え: 「各地の震度」(観測点・推計震度分布) ⇄ 「長周期地震動階級」(細分区域の塗り)
export function LongPeriodMapToggle({ mapView, onChange }) {
  const { tokens } = useContext(ThemeContext);
  const [pressed, setPressed] = useState(null);
  // 角を少しだけ丸めた長方形。押している間は色を濃くする。
  const seg = (id, active, label, onClick) => (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={() => setPressed(id)}
      onPointerUp={() => setPressed(null)}
      onPointerLeave={() => setPressed(null)}
      onPointerCancel={() => setPressed(null)}
      style={{
        flex: 1, padding: "4px 10px", border: "none", cursor: "pointer", borderRadius: 9,
        fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
        color: active ? tokens.text : `rgba(${tokens.ink},0.55)`,
        background: pressed === id ? `rgba(${tokens.ink},0.26)` : (active ? `rgba(${tokens.ink},0.16)` : "transparent"),
        transition: "background 0.08s",
      }}
    >{label}</button>
  );
  return (
    <div style={{ margin: "4px 14px 2px", display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, flexShrink: 0 }}>地図の表示</span>
      <div style={{ flex: 1, display: "flex", padding: 2, borderRadius: 11, background: `rgba(${tokens.ink},0.08)` }}>
        {seg("a", !mapView, "各地の震度", () => onChange(false))}
        {seg("b", mapView, "長周期地震動階級", () => onChange(true))}
      </div>
    </div>
  );
}

// 長周期地震動階級の地域一覧。「各地の震度」と同じく、階級 → 都道府県 → 市区町村の順にその場で開閉する。
export function LongPeriodCard({ quake }) {
  const { tokens } = useContext(ThemeContext);
  const schemeId = useContext(QuakeColorSchemeContext);
  const scheme = QUAKE_COLOR_SCHEMES[schemeId] || QUAKE_COLOR_SCHEMES.fill;
  const info = quake.longPeriodInfo;
  const [openGroups, setOpenGroups] = useState(() => new Set());
  const [openPrefs, setOpenPrefs] = useState(() => new Set());
  useEffect(() => { setOpenGroups(new Set()); setOpenPrefs(new Set()); }, [info]);

  // 階級ごと(大きい順)に、都道府県→名前の一覧にまとめる。都道府県が分からない行は「pref=null」にまとめ、その階層は出さない。
  const groups = useMemo(() => {
    if (!info) return [];
    const rows = info.cities.length > 0 ? info.cities : (info.areas || []);
    const m = new Map();
    for (const c of rows) {
      const pref = c.pref ?? prefOfAreaName(c.name) ?? null;
      if (!m.has(c.lg)) m.set(c.lg, new Map());
      const pm = m.get(c.lg);
      if (!pm.has(pref)) pm.set(pref, []);
      pm.get(pref).push(pref && c.name.startsWith(pref) ? c.name.slice(pref.length) || c.name : c.name);
    }
    return [...m.entries()].sort((a, b) => b[0] - a[0]).map(([lg, pm]) => [lg, [...pm.entries()]]);
  }, [info]);
  if (!info || !(info.maxLg >= 1)) return null;

  const toggle = (setter, key) => setter(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const chevron = (open, size = 14) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
         stroke={`rgba(${tokens.ink},0.35)`} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
         style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s ease", flexShrink: 0 }}>
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );

  return (
    <div style={{ margin: "2px 14px 8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 2px" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: tokens.text }}>長周期地震動階級</span>
        <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.6)` }}>
          最大 {info.maxLg}（{LONG_PERIOD_PHRASE[info.maxLg]}）
        </span>
      </div>
      <div style={{
        borderRadius: 12, overflow: "hidden",
        background: `rgba(${tokens.ink},0.04)`, boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
      }}>
        {groups.map(([lg, prefList], gi) => {
          const st = getLongPeriodStyleFromScheme(scheme, lg);
          const open = openGroups.has(lg);
          const known = prefList.filter(([p]) => p).map(([p]) => p);
          const summary = known.length > 0 ? known.join("、") : prefList.flatMap(([, names]) => names).join("、");
          return (
            <div key={lg}>
              {gi > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)` }}/>}
              <PressableButton
                onClick={() => toggle(setOpenGroups, lg)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 10,
                  padding: "9px 12px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left",
                }}
              >
                <span style={{
                  flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
                  background: st?.bg, color: st?.fg,
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800,
                }}>{lg}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: tokens.text }}>階級{lg}</div>
                  {!open && (
                    <div style={{ fontSize: 13, color: `rgba(${tokens.ink},0.65)`, marginTop: 3, lineHeight: 1.6 }}>{summary}</div>
                  )}
                </div>
                {chevron(open)}
              </PressableButton>
              {open && (
                <div style={{ padding: "0 12px 8px 12px" }}>
                  {prefList.map(([pref, names]) => {
                    if (!pref) {
                      return (
                        <div key="__none" style={{ borderLeft: `3px solid ${st?.bg}`, padding: "6px 10px", fontSize: 14, lineHeight: 1.7, color: `rgba(${tokens.ink},0.88)` }}>
                          {names.join("、")}
                        </div>
                      );
                    }
                    const pk = `${lg}|${pref}`;
                    const pOpen = openPrefs.has(pk);
                    return (
                      <div key={pk} style={{ borderLeft: `3px solid ${st?.bg}`, marginTop: 4 }}>
                        <PressableButton
                          onClick={() => toggle(setOpenPrefs, pk)}
                          style={{
                            width: "100%", display: "flex", alignItems: "center", gap: 8,
                            padding: "9px 10px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left",
                          }}
                        >
                          <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: tokens.text }}>{pref}</span>
                          {chevron(pOpen, 13)}
                        </PressableButton>
                        {pOpen && (
                          <div style={{ padding: "0 10px 8px 10px", fontSize: 14, lineHeight: 1.7, color: `rgba(${tokens.ink},0.88)` }}>
                            {names.join("、")}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   QUAKE DETAIL CARD
   地震リスト/地図で選択した地震の詳細を表示するカード。
   左に「最大震度」バッジ、右にM/深さ・震源地・発生時刻を積む構成。
   ───────────────────────────────────────────────────── */
export function QuakeDetailCard({ quake }) {
  const { tokens } = useContext(ThemeContext);

  const style = useIntensityStyle(quake.maxIntensity || "1");
  const { num, suffix } = splitIntensityLabel(style.label);

  return (
    <div
      style={{
        margin: "2px 14px 4px",
        borderRadius: 16,
        padding: "7px 16px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        position: "relative",
        background: `linear-gradient(135deg, ${style.bg}2E, ${style.bg}14)`,
        boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.12)`,
        animation: "appear 0.35s cubic-bezier(.25,1,.5,1)",
      }}
    >
      {/* 最大震度バッジ — 遠地地震は震度が観測されないため「遠地」表示にする */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.6)`, whiteSpace: "nowrap", lineHeight: 1.1 }}>
          {quake.isForeign ? "遠地地震" : "最大震度"}
        </span>
        <div
          style={{
            width: 64, height: 64,
            borderRadius: 14,
            background: style.bg, color: style.fg,
            position: "relative",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <LongPeriodBadge grade={quake.longPeriod} size={22} offset={-8}/>
          {/* テスト配信バッジ — 津波警報テスト配信(TsunamiDetailCard)と全く同じ見た目を
              そのまま流用する。最大震度アイコンの角に乗せることで、一目でテストデータだと
              分かるようにする。 */}
          {quake.isTest && (
            <span style={{
              position: "absolute", top: -8, left: -8,
              fontSize: 9.5, fontWeight: 800, color: "#fff",
              background: "#FF453A", borderRadius: 4, padding: "2px 6px",
              whiteSpace: "nowrap",
            }}>
              テスト配信
            </span>
          )}
          {quake.isForeign ? (
            <span style={{ fontSize: 14, fontWeight: 800, lineHeight: 1.2 }}>不明</span>
          ) : quake.maxIntensity === "?" ? (
            <span style={{ fontSize: 13, fontWeight: 800, lineHeight: 1.15, textAlign: "center" }}>調査中</span>
          ) : quake.maxIntensity === "5u" ? (
            // 震度5弱以上未入電 — 観測点の震度計は検知したが、確定した震度が
            // まだ入電されていない状態。「少なくとも5弱」を示す"5弱+"と、
            // その理由となる"未入電"を2段で表示する。
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", lineHeight: 1.1 }}>
              <span className="mono" style={{ fontSize: 22, fontWeight: 800 }}>5弱+</span>
              <span style={{ fontSize: 10, fontWeight: 700, marginTop: 2 }}>未入電</span>
            </div>
          ) : suffix ? (
            // 弱/強付き(5弱・5強・6弱・6強) — 数字と弱/強を近づけ、正方形の中央にまとめて配置する。
            // 弱/強の下端は数字の下端(ベースライン)に揃える(intensityLabel.jsx)。
            <IntensityNumWithSuffix num={num} suffix={suffix} numSize={32} suffixSize={15} />
          ) : (
            // 数字のみ(1〜4,7) — 弱/強が無い分、正方形の大きさを変えずに数字だけ少し大きく
            <span className="mono" style={{ fontSize: 32, fontWeight: 800, lineHeight: 1 }}>{num}</span>
          )}
        </div>
      </div>

      {/* 震源地 / M・深さ / 発生時刻 — 中央寄せで大きめに表示する */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0, lineHeight: 1.1 }}>
          {/* 発表段階バッジ。震度速報・震源に関する情報の間だけ「震源地」ラベルの
              代わりに表示し、確定報(DetailScale)が届いたら通常の「震源地」に戻る。
              ラベルの位置にそのまま差し替えるだけなので、他の行・列の並びは変わらない。 */}
          {QUAKE_STAGE_LABEL[quake.stage] ? (
            <span style={{
              flexShrink: 0, fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
              background: `rgba(${tokens.ink},0.14)`, color: `rgba(${tokens.ink},0.75)`,
              whiteSpace: "nowrap", lineHeight: 1.5,
            }}>
              {QUAKE_STAGE_LABEL[quake.stage]}
            </span>
          ) : (
            <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.55)`, flexShrink: 0, lineHeight: 1.1 }}>震源地</span>
          )}
          <AutoFitText
            text={quake.place}
            maxFontSize={30}
            minFontSize={13}
            style={{ fontWeight: 800, color: tokens.text, lineHeight: 1.1 }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 12, lineHeight: 1.1 }}>
          <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.1 }}>
            M<span className="mono" style={{ fontSize: 21, fontWeight: 800, color: tokens.text, marginLeft: 3, lineHeight: 1.1 }}>
              {quake.magnitude != null ? quake.magnitude.toFixed(1) : "-"}
            </span>
          </span>
          <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.1 }}>
            深さ<span className="mono" style={{ fontSize: 21, fontWeight: 800, color: tokens.text, marginLeft: 3, lineHeight: 1.1 }}>
              {quake.depth != null ? (quake.depth === 0 ? "ごく浅い" : quake.depth) : "-"}
            </span>
            {quake.depth != null && quake.depth !== 0 && (
              <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.6)`, marginLeft: 2, lineHeight: 1.1 }}>km</span>
            )}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 6, lineHeight: 1.1 }}>
          <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, flexShrink: 0, lineHeight: 1.1 }}>発生時刻</span>
          <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: `rgba(${tokens.ink},0.85)`, lineHeight: 1.1 }}>
            {formatQuakeTimeShort(quake.time)}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   QUAKE MESSAGE CARD — 電文(津波情報・付加文)
   選択中の地震について、津波の心配の有無や気象庁の付加コメントを表示する。
   ───────────────────────────────────────────────────── */
export function QuakeMessageCard({ quake, part = "all" }) {
  const { tokens } = useContext(ThemeContext);

  const lines = buildQuakeMessage(quake, part);
  if (lines.length === 0) return null;

  return (
    <div style={{ margin: "2px 14px 8px" }}>
      <div style={{
        borderRadius: 12,
        padding: "10px 12px",
        display: "flex", flexDirection: "column", gap: 8,
        background: `rgba(${tokens.ink},0.04)`,
        boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
      }}>
        {/* 見出しは本文の頭に同じ行でつなげて出す(縦に1行積まない)ことで、
            文字を大きくしてもカードの高さがほとんど増えないようにしている。 */}
        {lines.map((line, i) => (
          <div key={i} style={{ lineHeight: 1.45 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: line.color, marginRight: 4 }}>
              【{line.label}】
            </span>
            <span style={{
              fontSize: 14, lineHeight: 1.45,
              fontWeight: line.alert ? 600 : 400,
              color: line.alert ? line.color : `rgba(${tokens.ink},0.9)`,
            }}>
              {line.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   STATION POINTS LIST — 各地の震度
   選択中の地震について、観測点ごとの震度を表示する。表示方法は設定で選べる:
     - "list"    : 震度が大きい順にフラットな一覧で表示(従来の見た目)。
                   件数が多い地震(数百観測点になることもある)を考慮し、
                   既定では上位のみ表示し「すべて表示」で展開できる。
     - "grouped" : 震度階級ごとの一覧(既定)。各行は「バッジ+震度ラベル+
                   都道府県名(まとめて表示)+ >」の要約行で、タップすると
                   その震度の地域一覧(都道府県ごとに開閉できる詳細画面)へ遷移する。
   観測点マスタに見つからず地図に表示されていない件数(unmappedCount)は、
   要約画面の最下部にまとめて表示する(詳細画面では表示しない)。
   ───────────────────────────────────────────────────── */
// 各地の震度は階層表示(震度→都道府県→市区町村)のみ。displayModeは互換のため受け取るだけで使わない。
export function StationPointsList({ points, displayMode: _unusedDisplayMode, openKey, onOpenKeyChange, showHeader = false, onSelectStation }) {
  const { tokens } = useContext(ThemeContext);

  const [expanded, setExpanded] = useState(false); // 一覧表示(list)用の「すべて表示」
  // 階層表示(grouped)用: 詳細画面を開いている震度キー。
  // フローティングの外にある丸い「戻る」ボタンでもこの詳細画面を閉じられるように、
  // 親(BottomDock)側にstateを持ち上げてpropsで受け取る形にしている
  // (✕ボタン自体はこれまで通りこのコンポーネント内に残す)。
  const [openPrefs, setOpenPrefs] = useState(() => new Set()); // 詳細画面内で開いている都道府県
  const [openGroups, setOpenGroups] = useState(() => new Set()); // その場で開いている震度グループ
  const schemeId = useContext(QuakeColorSchemeContext);
  const scheme = QUAKE_COLOR_SCHEMES[schemeId] || QUAKE_COLOR_SCHEMES.fill;

  // scale(10刻みのJMAコード)が大きい順 = 震度が大きい順
  const sorted = useMemo(() => {
    return [...points].sort((a, b) => INTENSITY_ORDER.indexOf(b.intensityKey) - INTENSITY_ORDER.indexOf(a.intensityKey));
  }, [points]);

  // 震度キーごとにグループ化する(sortedは既に震度降順なので、Mapの挿入順=震度降順のまま保たれる)
  const groups = useMemo(() => {
    const map = new Map();
    for (const p of sorted) {
      if (!map.has(p.intensityKey)) map.set(p.intensityKey, []);
      map.get(p.intensityKey).push(p);
    }
    return [...map.entries()];
  }, [sorted]);

  // 選択中の地震が変わるたび(=points自体が変わるたび)、詳細画面は閉じておく
  useEffect(() => {
    onOpenKeyChange(null);
    setOpenPrefs(new Set());
    setOpenGroups(new Set());
  }, [points]);

  if (sorted.length === 0) return null;

  // 観測点マスタに見つからず、緯度経度が引けなかった(=地図上には表示されていない)観測点の数。
  // 地図上で「無いことに気づけない」状態を防ぐため、要約画面の最下部に件数を明示しておく。
  // 震度速報(isArea:true)の点は、そもそも個別の緯度経度を持たず区域塗り分けで
  // 表示される(観測点マスタに無いのとは違う)ため、この「地図に出せない件数」には含めない。
  const unmappedCount = sorted.filter(p => !p.isArea && (p.latitude == null || p.longitude == null)).length;

  const VISIBLE_COUNT = 10;
  const visible = expanded ? sorted : sorted.slice(0, VISIBLE_COUNT);
  const hasMore = sorted.length > VISIBLE_COUNT;

  function toggleGroup(key) {
    setOpenGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function togglePref(pref) {
    setOpenPrefs(prev => {
      const next = new Set(prev);
      if (next.has(pref)) next.delete(pref); else next.add(pref);
      return next;
    });
  }

  // 階層表示(grouped)は別画面へ遷移せず、その場で開閉する(震度 → 都道府県 → 市区町村)。
  // 震度ごとの都道府県・市区町村のまとめ(出現順を維持)。
  function buildByPref(groupPoints) {
    const byPref = [];
    const prefIndexOf = new Map();
    for (const p of groupPoints) {
      if (!prefIndexOf.has(p.pref)) {
        prefIndexOf.set(p.pref, byPref.length);
        byPref.push({ pref: p.pref, cities: [], cityIndexOf: new Map() });
      }
      const prefEntry = byPref[prefIndexOf.get(p.pref)];
      const cityKey = p.city || `__nocity_${p.addr}`; // 市区町村が無い観測点は地点名単位でそのまま1件ずつ扱う
      if (!prefEntry.cityIndexOf.has(cityKey)) {
        prefEntry.cityIndexOf.set(cityKey, prefEntry.cities.length);
        prefEntry.cities.push({ city: p.city, addrs: [] });
      }
      prefEntry.cities[prefEntry.cityIndexOf.get(cityKey)].addrs.push({ text: stripStationMark(p.addr), point: p });
    }
    return byPref;
  }
  const chevron = (open, size = 14) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
         stroke={`rgba(${tokens.ink},0.35)`} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
         style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s ease", flexShrink: 0 }}>
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );

  return (
    <div style={{ margin: "2px 14px 8px" }}>
      {showHeader ? (
        <div style={{
          padding: "6px 2px",
          fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.5)`,
        }}>
          各地の震度
        </div>
      ) : <div style={{ height: 4 }}/>}

      <div style={{
        borderRadius: 12,
        overflow: "hidden",
        background: `rgba(${tokens.ink},0.04)`,
        boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
      }}>
        {true ? (
          groups.map(([key, groupPoints], gi) => {
            const style = getIntensityStyleFromScheme(scheme, key);
            const prefs = [...new Set(groupPoints.map(p => p.pref))];
            const groupOpen = openGroups.has(key);
            return (
              <div key={key}>
                {gi > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)` }}/>}
                <PressableButton
                  onClick={() => toggleGroup(key)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 10,
                    padding: "9px 12px", background: "transparent", border: "none",
                    cursor: "pointer", textAlign: "left",
                  }}
                >
                  <span style={{
                    flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
                    background: style.bg, color: style.fg,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: key === "5u" ? 9 : 11, fontWeight: 800,
                  }}>
                    {key === "5u" ? "未入電" : style.label}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: tokens.text }}>
                      震度{style.label}
                    </div>
                    {!groupOpen && (
                      <div style={{ fontSize: 13, color: `rgba(${tokens.ink},0.65)`, marginTop: 3, lineHeight: 1.6 }}>
                        {prefs.map((pref, pi) => (
                          <span key={pref} style={{ whiteSpace: "nowrap" }}>
                            {pref}{pi < prefs.length - 1 ? "、" : ""}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {chevron(groupOpen)}
                </PressableButton>
                {groupOpen && (
                  <div style={{ padding: "0 12px 8px 12px" }}>
                    {buildByPref(groupPoints).map(entry => {
                      const pk = `${key}|${entry.pref}`;
                      const prefOpen = openPrefs.has(pk);
                      return (
                        <div key={pk} style={{ borderLeft: `3px solid ${style.bg}`, marginTop: 4 }}>
                          <PressableButton
                            onClick={() => togglePref(pk)}
                            style={{
                              width: "100%", display: "flex", alignItems: "center", gap: 8,
                              padding: "9px 10px", background: "transparent", border: "none",
                              cursor: "pointer", textAlign: "left",
                            }}
                          >
                            <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: tokens.text }}>{entry.pref}</span>
                            {chevron(prefOpen, 13)}
                          </PressableButton>
                          {prefOpen && (
                            <div style={{ padding: "0 10px 8px 10px" }}>
                              {entry.cities.map((c, ci) => (
                                <div key={ci} style={{ marginTop: ci > 0 ? 6 : 0, fontSize: 14, lineHeight: 1.7 }}>
                                  {c.city && <span style={{ fontWeight: 700, color: tokens.text }}>{c.city} </span>}
                                  <span style={{ color: `rgba(${tokens.ink},0.88)` }}>
                                    {c.addrs.map((a, ai) => {
                                      const canFocus = !!onSelectStation && !a.point.isArea && a.point.latitude != null && a.point.longitude != null;
                                      return (
                                        <span key={ai}>
                                          {ai > 0 && " "}
                                          {canFocus ? (
                                            // タッチすると、その観測点へ地図をズームして名前のチップを出す
                                            <span
                                              role="button" tabIndex={0}
                                              onClick={() => onSelectStation(a.point)}
                                              style={{
                                                cursor: "pointer", borderRadius: 4, padding: "0 1px",
                                                textDecoration: "underline", textDecorationStyle: "dotted",
                                                textDecorationColor: `rgba(${tokens.ink},0.35)`, textUnderlineOffset: 3,
                                              }}
                                            >{a.text}</span>
                                          ) : a.text}
                                        </span>
                                      );
                                    })}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          visible.map((p, i) => {
            const style = getIntensityStyleFromScheme(scheme, p.intensityKey);
            return (
              <div key={`${p.pref}-${p.addr}-${i}`}>
                {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)`, marginLeft: 12 }}/>}
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px" }}>
                  <span style={{
                    flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
                    background: style.bg, color: style.fg,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: p.intensityKey === "5u" ? 9 : 11, fontWeight: 800,
                  }}>
                    {p.intensityKey === "5u" ? "未入電" : style.label}
                  </span>
                  <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.4)`, flexShrink: 0 }}>
                    {p.pref}
                  </span>
                  <span style={{
                    flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: tokens.text,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {stripStationMark(p.addr)}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {false && hasMore && (
        <PressableButton
          onClick={() => setExpanded(v => !v)}
          style={{
            width: "100%", textAlign: "center", padding: "8px 0",
            fontSize: 12, fontWeight: 600, color: `rgba(${tokens.ink},0.55)`,
          }}
        >
          {expanded ? "閉じる" : `すべて表示 (${sorted.length}件)`}
        </PressableButton>
      )}

      {unmappedCount > 0 && (
        <div style={{ padding: "8px 2px 2px", fontSize: 11, fontWeight: 500, color: `rgba(${tokens.ink},0.35)` }}>
          うち{unmappedCount}件は観測点マスタに無く、地図には非表示です
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   QUAKE MECH DETAIL PANEL — 「この地震の詳細」画面
   
   気象庁(精査版・速報値のCMT解/初動解/遠地地震CMT)とUSGSの発震機構解を並行して取得して
   表示する。気象庁の中では、CMT解 > 初動解、同じ種別なら精査版 > 速報値の順に1つ採用する。
   気象庁とUSGSの両方に解がある場合は、画面上のトグルで表示する方を選べる(選択は保存される)。
   片方にしか無い場合は、ある方を表示する。どちらにも無い場合はその旨を案内する(エラーではない)。
   ───────────────────────────────────────────────────── */
export function QuakeMechDetailPanel({ quake, cmtSources = { jma: true, usgs: true } }) {
  const { tokens } = useContext(ThemeContext);
  // ホーム画面に追加したPWA(スタンドアロン表示)かどうか。
  // iOSのスタンドアロンPWAには「新しいタブ」という概念が無いため、
  // target="_blank"のリンクを踏むとOSがSafari側にまるごと処理を渡してしまい、
  // 「戻る」で復帰した時にPWA側のWebViewがメモリから破棄されていて
  // アプリ全体がリロードされてしまうことがある(=開いていた画面が消える不具合)。
  // スタンドアロン時だけtarget="_blank"を外し、同じWebView内で遷移させることで、
  // これを避ける。
  const isStandalonePwa = useIsStandalonePwa();
  // 情報源ごとの取得状態。status: "loading" | "found" | "not_found" | "error" | "disabled"(設定で取得先から外している)
  const [jma, setJma] = useState({ status: cmtSources.jma ? "loading" : "disabled", detail: null });
  const [usgs, setUsgs] = useState({ status: cmtSources.usgs ? "loading" : "disabled", detail: null });
  // 両方に解がある時にどちらを表示するか("jma" | "usgs")。保存して次回以降も使う。
  const [sourcePref, setSourcePref] = useState(loadStoredCmtSourcePref);
  // 震源球画像のURLが取れても、実際には読み込みに失敗する(ページ構成の想定違いで
  // 誤ったURLを組み立ててしまった等)ことがあるため、<img>のonErrorで検知して
  // 壊れた画像アイコンの代わりに案内文を出す。URLごとに記録するので、情報源を
  // 切り替えても他方の画像の判定には影響しない。
  const [failedImgUrl, setFailedImgUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setJma({ status: cmtSources.jma ? "loading" : "disabled", detail: null });
    setUsgs({ status: cmtSources.usgs ? "loading" : "disabled", detail: null });
    setFailedImgUrl(null);

    // 気象庁とUSGSは互いに独立に取得する(片方が遅い・失敗しても、もう片方は表示できる)。
    // 設定で取得先から外している方には、通信しない。
    if (cmtSources.jma) (async () => {
      try {
        // 気象庁の5系統(精査版CMT・速報値・初動・遠地CMT)から、優先順位が最も高い解を1つ得る。
        const d = await findJmaMechanism(quake);
        if (cancelled) return;
        setJma(d ? { status: "found", detail: d } : { status: "not_found", detail: null });
      } catch (err) {
        console.error("発震機構解(気象庁)の取得に失敗:", err);
        if (!cancelled) setJma({ status: "error", detail: null });
      }
    })();

    if (cmtSources.usgs) (async () => {
      try {
        const d = await findUsgsCmtForQuake(quake);
        if (cancelled) return;
        setUsgs(d ? { status: "found", detail: d } : { status: "not_found", detail: null });
      } catch (err) {
        console.error("発震機構解(USGS)の取得に失敗:", err);
        if (!cancelled) setUsgs({ status: "error", detail: null });
      }
    })();

    return () => { cancelled = true; };
  }, [quake.id, cmtSources.jma, cmtSources.usgs]);

  const SOURCE_LABEL = { jma: "気象庁", usgs: "USGS" };
  const bothFound = jma.status === "found" && usgs.status === "found";
  // 表示する情報源: 両方あれば選択に従い、片方だけならある方。
  const shownSource = bothFound
    ? sourcePref
    : jma.status === "found" ? "jma"
    : usgs.status === "found" ? "usgs"
    : null;
  const detail = shownSource === "jma" ? jma.detail : shownSource === "usgs" ? usgs.detail : null;
  const pending = jma.status === "loading" || usgs.status === "loading";
  const noSource = jma.status === "disabled" && usgs.status === "disabled";
  const status = detail ? "found"
    : noSource ? "disabled"
    : pending ? "loading"
    : (jma.status === "error" || usgs.status === "error") ? "error"
    : "not_found";
  // 震源球画像の読み込みに失敗した時は、自前で描いた震源球(USGSのみ)に切り替える。
  const primaryImgFailed = !!detail && failedImgUrl != null && failedImgUrl === detail.beachballImageUrl;
  const beachballSrc = !detail ? null
    : (primaryImgFailed && detail.beachballFallbackUrl) ? detail.beachballFallbackUrl
    : detail.beachballImageUrl;
  const imgLoadFailed = primaryImgFailed && !detail?.beachballFallbackUrl;
  const beachballDrawn = !!detail && !!detail.beachballFallbackUrl && beachballSrc === detail.beachballFallbackUrl;
  // 片方だけ解があり、もう片方は確認済みで「無い」場合の補足表示用
  const otherSource = shownSource === "jma" ? "usgs" : "jma";
  const otherState = shownSource === "jma" ? usgs : jma;
  const singleSourceNote = detail && !bothFound && otherState.status === "not_found"
    ? `${SOURCE_LABEL[shownSource]}の解のみ掲載されています(${SOURCE_LABEL[otherSource]}には該当する解がありません)`
    : null;

  function handleChangeSourcePref(next) {
    setSourcePref(next);
    saveCmtSourcePref(next);
  }

  const rowLabelStyle = { fontSize: 11, color: tokens.textSecondary };
  const rowValueStyle = { fontSize: 13, fontWeight: 700, color: tokens.text };

  function DataRow({ label, value }) {
    if (value == null || value === "") return null;
    return (
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "6px 0" }}>
        <span style={rowLabelStyle}>{label}</span>
        <span style={rowValueStyle}>{value}</span>
      </div>
    );
  }

  // 深さ・M(またはMw)のように、単独の行だと空きスペースが目立つ2項目を
  // 1行に横並びで表示する(左右それぞれで見出し/値のペア)。
  // 片方だけ値が無い場合は、そちら側だけ非表示にする。
  function DataRowPair({ left, right }) {
    const leftHas = left.value != null && left.value !== "";
    const rightHas = right.value != null && right.value !== "";
    if (!leftHas && !rightHas) return null;
    return (
      <div style={{ display: "flex", gap: 10, padding: "6px 0" }}>
        {leftHas && (
          <div style={{ flex: 1, display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ ...rowLabelStyle, flexShrink: 0 }}>{left.label}</span>
            <span style={{ ...rowValueStyle, flex: 1, textAlign: "center" }}>{left.value}</span>
          </div>
        )}
        {rightHas && (
          <div style={{ flex: 1, display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ ...rowLabelStyle, flexShrink: 0 }}>{right.label}</span>
            <span style={{ ...rowValueStyle, flex: 1, textAlign: "center" }}>{right.value}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <QuakeDetailCard quake={quake}/>
      <div style={{ padding: "2px 14px 16px" }}>
      {status === "loading" && (
        <Glass radius={14} style={{ padding: "24px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 12, color: tokens.textSecondary }}>{[cmtSources.jma && "気象庁", cmtSources.usgs && "USGS"].filter(Boolean).join("・")}のデータを確認しています…</div>
        </Glass>
      )}

      {status === "disabled" && (
        <Glass radius={14} style={{ padding: "24px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 12, color: tokens.textSecondary, lineHeight: 1.6 }}>
            発震機構解の取得先が選ばれていません。<br/>
            設定の「地震」→「発震機構解(CMT解)の取得先」で、気象庁またはUSGSを選んでください。
          </div>
        </Glass>
      )}

      {status === "not_found" && (
        <Glass radius={14} style={{ padding: "24px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 12, color: tokens.textSecondary, lineHeight: 1.6 }}>
            この地震の発震機構解は見つかりませんでした。<br/>
            まだ解析中か、解析対象外の可能性があります。
          </div>
        </Glass>
      )}

      {status === "error" && (
        <Glass radius={14} style={{ padding: "24px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 12, color: "rgba(255,140,140,0.9)", lineHeight: 1.6 }}>
            発震機構解の取得に失敗しました。時間をおいて再度お試しください。
          </div>
        </Glass>
      )}

      {status === "found" && detail && (
        <>
          {/* 気象庁とUSGSの両方に解がある時だけ、表示する方を選べる。 */}
          {bothFound && (
            <Glass radius={14} style={{ padding: 4, marginBottom: 10 }}>
              <div style={{ display: "flex", gap: 4 }}>
                {["jma", "usgs"].map(src => {
                  const selectedSrc = shownSource === src;
                  return (
                    <PressableButton
                      key={src}
                      type="button"
                      onClick={() => handleChangeSourcePref(src)}
                      style={{
                        flex: 1, padding: "8px 0", borderRadius: 10, border: "none", cursor: "pointer",
                        background: selectedSrc ? `rgba(${tokens.ink},0.14)` : "transparent",
                        color: selectedSrc ? tokens.text : tokens.textSecondary,
                        fontSize: 13, fontWeight: selectedSrc ? 700 : 600,
                      }}
                    >
                      {SOURCE_LABEL[src]}
                    </PressableButton>
                  );
                })}
              </div>
            </Glass>
          )}
          {/* 表示中の解の種別(例: CMT解(国内)・精査版 / 初動解・速報値 / USGS モーメントテンソル解)と、
              速報値・「参考」(精度が低く節面が無い解)の注意書き。 */}
          <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text, padding: "0 4px 2px" }}>
            {detail.sourceLabel}
          </div>
          {detail.grade === "prelim" && (
            <div style={{ fontSize: 11, color: tokens.textSecondary, lineHeight: 1.5, padding: "0 4px 8px" }}>
              自動解析の速報値です。後日の精査で変更されることがあります。
            </div>
          )}
          {detail.reference && (
            <div style={{ fontSize: 11, color: tokens.textSecondary, lineHeight: 1.5, padding: "0 4px 8px" }}>
              精度が低い参考の解のため、断層面解は求められていません(震源球は押し引きの分布のみ)。
            </div>
          )}
          {singleSourceNote && (
            <div style={{ fontSize: 11, color: tokens.textSecondary, lineHeight: 1.5, padding: "0 4px 8px" }}>
              {singleSourceNote}
            </div>
          )}

          {/* 使用観測点数・精度(左)と震源球の図(右)を横並びにする。
              左側は中身の幅だけ確保し(space-betweenで間延びさせない)、
              余った分は震源球の画像を大きく見せる方に回す。
              「震源球(下半球等積投影)」のキャプションは画像の下ではなく、
              左側の解の精度の下に矢印つきで置くことで、画像により幅を割ける。 */}
          <Glass radius={14} style={{ padding: 16, marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, minWidth: 0 }}>
              <div style={{ flexShrink: 1, minWidth: 0 }}>
                {(detail.metrics || []).map(m => (
                  <DataRow key={m.label} label={m.label} value={m.value} />
                ))}
                {beachballSrc && !imgLoadFailed && (
                  <div style={{ fontSize: 10, color: tokens.textSecondary, marginTop: 6, lineHeight: 1.5 }}>
                    震源球(下半球等積投影{beachballDrawn ? "・断層面解1から描画" : ""})→
                  </div>
                )}
              </div>
              {beachballSrc && (
                <div style={{ flex: "0 1 150px", minWidth: 0, maxWidth: 150, textAlign: "center" }}>
                  {!imgLoadFailed ? (
                    <img
                      src={beachballSrc}
                      alt="震源球(発震機構解)"
                      style={{ display: "block", width: "100%", maxWidth: "100%", height: "auto", borderRadius: 8, background: "#fff" }}
                      onError={() => setFailedImgUrl(detail.beachballImageUrl)}
                    />
                  ) : (
                    <div style={{ fontSize: 10, color: tokens.textSecondary, lineHeight: 1.5 }}>
                      画像を読み込めませんでした
                    </div>
                  )}
                </div>
              )}
            </div>
          </Glass>

          <Glass radius={14} style={{ padding: "6px 16px", marginBottom: 10 }}>
            <DataRow label="発生時刻" value={detail.hypo.time} />
            <DataRow label="震源位置" value={detail.hypo.lat && detail.hypo.lon ? `${detail.hypo.lat} ${detail.hypo.lon}` : null} />
            <DataRowPair
              left={{ label: "深さ", value: detail.hypo.depth }}
              right={{ label: "M", value: detail.hypo.magnitude }}
            />
          </Glass>

          {/* 初動解にはセントロイド・Mwが無いので、値が無い時はカードごと隠す。 */}
          {(detail.centroid.time || detail.centroid.mw) && (
          <Glass radius={14} style={{ padding: "6px 16px", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text, padding: "8px 0 2px" }}>
              セントロイド・モーメントマグニチュード
            </div>
            <DataRow label="セントロイド時刻" value={detail.centroid.time} />
            <DataRow label="位置" value={detail.centroid.lat && detail.centroid.lon ? `${detail.centroid.lat} ${detail.centroid.lon}` : null} />
            <DataRowPair
              left={{ label: "深さ", value: detail.centroid.depth }}
              right={{ label: "Mw", value: detail.centroid.mw }}
            />
          </Glass>
          )}

          {/* 断層面解1・2は片方ずつだと余白が目立つため、真ん中に区切り線を入れて
              横に2つ並べる。 */}
          {detail.plane1.strike != null && (
          <Glass radius={14} style={{ padding: "6px 16px", marginBottom: 10 }}>
            <div style={{ display: "flex", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text, padding: "8px 0 2px" }}>
                  断層面解1
                </div>
                <DataRow label="走向" value={detail.plane1.strike} />
                <DataRow label="傾斜" value={detail.plane1.dip} />
                <DataRow label="すべり角" value={detail.plane1.rake} />
              </div>
              <div style={{ width: 1, alignSelf: "stretch", background: tokens.divider, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text, padding: "8px 0 2px" }}>
                  断層面解2
                </div>
                <DataRow label="走向" value={detail.plane2.strike} />
                <DataRow label="傾斜" value={detail.plane2.dip} />
                <DataRow label="すべり角" value={detail.plane2.rake} />
              </div>
            </div>
          </Glass>
          )}

          {detail.axes.p.azimuth != null && (
          <Glass radius={14} style={{ padding: "6px 16px", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text, padding: "8px 0 2px" }}>
              P軸・T軸・N軸(方位 / 傾斜)
            </div>
            <DataRow label="P軸" value={detail.axes.p.azimuth && detail.axes.p.plunge ? `${detail.axes.p.azimuth}° / ${detail.axes.p.plunge}°` : null} />
            <DataRow label="T軸" value={detail.axes.t.azimuth && detail.axes.t.plunge ? `${detail.axes.t.azimuth}° / ${detail.axes.t.plunge}°` : null} />
            <DataRow label="N軸" value={detail.axes.n.azimuth && detail.axes.n.plunge ? `${detail.axes.n.azimuth}° / ${detail.axes.n.plunge}°` : null} />
          </Glass>
          )}

          <a
            href={detail.sourceUrl}
            {...(isStandalonePwa ? {} : { target: "_blank", rel: "noopener noreferrer" })}
            style={{
              display: "block", textAlign: "center", padding: "10px 0",
              fontSize: 12, fontWeight: 600, color: tokens.accentText || "#0A84FF",
              textDecoration: "none",
            }}
          >
            {SOURCE_LABEL[shownSource]}の該当ページを開く ↗
          </a>
        </>
      )}

      {/* CMT解についての注意書きは最下部に置く */}
      <Glass radius={14} style={{ padding: "14px 16px", marginTop: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: tokens.text, marginBottom: 2 }}>
          発震機構解(CMT解)
        </div>
        <div style={{ fontSize: 11, color: tokens.textSecondary, lineHeight: 1.5 }}>
          気象庁とUSGSの解析結果です。気象庁は、モーメントテンソル(CMT)解を日本周辺の
          Mw5.0以上と海外の大きな地震、初動解を主に内陸の地震について解析しており、
          自動解析の速報値と精査版の両方を参照しています(CMT解があれば初動解より優先し、
          精査版があれば速報値より優先します)。USGSは日本周辺のM4.5以上を収録しています。
          気象庁とUSGSの両方に解がある場合は上のボタンで切り替えられます。対象の地震でも
          掲載されていない場合があります。
        </div>
      </Glass>
      </div>
    </>
  );
}
