import { useContext, useState, useEffect, Fragment } from "react";
import { MAP_COLOR_DEFAULTS, MAP_COLOR_ITEMS, ThemeContext, mapLineToCss } from "./theme";
import { SettingsCard, SettingsCardDivider } from "./settingsPrimitives";
import { QUAKE_FETCH_LIMIT_DEFAULT, QUAKE_FETCH_LIMIT_MAX, QUAKE_FETCH_LIMIT_MIN, STATION_LIST_DISPLAY_MODES, clampQuakeFetchLimit } from "./settingsStorage";
import { PressableButton } from "./glass";
import { QUAKE_COLOR_SCHEMES, QuakeColorSchemeContext, getIntensityStyleFromScheme } from "./colorSchemes";
import { BOUNDARY_LINE_COLORS, INTENSITY_ORDER } from "./stationIcons";
import { DEBUG_LOG_MAX, clearDebugLog, useDebugLog } from "./debugLog";



// 地震一覧の取得件数の設定画面。スライダー(左右に動かして数値を決める) + よく使う件数のプリセットチップ。
// 以前は数値入力欄だったが、タップした瞬間にiOS側でページ全体がズームされてしまうため、
// テキスト入力を使わずスライダーだけで完結するようにしている。
export function QuakeFetchLimitSettings({ value, onChange }) {
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
export function QuakeColorSchemeSettings({ colorSchemeId, onChangeColorScheme }) {
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

// 震度観測点リストの表示方法(階層表示/一覧表示)の選択画面。震度配色ピッカーと同じ見た目のリスト。
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

export function StationListDisplayModeSettings({ value, onChange }) {
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

export function LogViewerPanel() {
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
export function LicenseFileCard() {
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
function renderMarkdownLite(text, tokens) {
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

/* ─────────────────────────────────────────────────────
   利用規約・注意事項・プライバシーポリシー(public/配下のMarkdown文書)の
   取得結果を、アプリを開いている間だけメモリ上(モジュール変数)にキャッシュする。
   - 地図データのloadGeoData等と違い、Cache API/localStorageには一切保存しない。
     ページを閉じる・再読み込みするとこのモジュール変数ごと自動的に消える
     ため、「アプリを閉じたらキャッシュを破棄する」を、何もしないことで
     実現している(=次回起動時は必ず最新のファイルを取得し直すので、
     文書が更新されていても気づける)。
   - ConsentGateでのタブ切り替えや、設定画面を開き直した際に、同じ文書へ
     何度もネットワーク取得しに行かないようにするのが目的。
   ───────────────────────────────────────────────────── */
const markdownFileCache = new Map(); // fileName -> Promise<string>
export function loadMarkdownFile(fileName) {
  if (!markdownFileCache.has(fileName)) {
    const promise = fetch(`${import.meta.env.BASE_URL}${fileName}`)
      .then(res => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.text();
      })
      .catch(err => {
        // 失敗した場合はキャッシュに残さず、次にloadMarkdownFileが呼ばれた
        // 時点(コンポーネントの再マウント等)で再取得を試みられるようにする。
        markdownFileCache.delete(fileName);
        throw err;
      });
    markdownFileCache.set(fileName, promise);
  }
  return markdownFileCache.get(fileName);
}

// public/配下のMarkdownファイル(利用規約・注意事項・プライバシーポリシー等)を
// 実行時に取得し、renderMarkdownLiteで整形して表示するカード。LicenseFileCardと
// 同じ理由(ビルドし直さずファイル編集だけで内容を更新できるように)で、
// ビルド時埋め込みではなく実行時fetchにしている。
// 前提: Viteの public/ ディレクトリに対象のMarkdownファイルが置かれていること
// (LicenseFileCardと同様、BASE_URL配下に配置する必要がある)。
export function MarkdownFileCard({ fileName }) {
  const { tokens } = useContext(ThemeContext);
  const [state, setState] = useState({ status: "loading", text: "" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", text: "" });
    loadMarkdownFile(fileName)
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
export function BoundaryLineColorSettings({ boundaryLineColorId, onChangeBoundaryLineColorId }) {
  const { tokens } = useContext(ThemeContext);

  const entries = Object.entries(BOUNDARY_LINE_COLORS);
  return (
    <div style={{ padding: "10px 14px 12px" }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: tokens.textSecondary, marginBottom: 9 }}>
        線の色(プレート境界・断層)
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


// 色のスウォッチ(丸)。見た目は自前の丸にし、透明な<input type="color">を重ねて
// タップした時にOS標準のカラーピッカーを開く(iOS Safariでも動く)。
// MapColorSettingsの内側で定義すると、色を選ぶたびの再描画で<input>が作り直されて
// ピッカーが閉じてしまうため、モジュール直下に置いている。
function MapColorSwatch({ value, onPick, label }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <div style={{
      position: "relative", width: 32, height: 32, borderRadius: 16, flexShrink: 0,
      background: value, boxShadow: `0 0 0 1px rgba(${tokens.ink},0.25)`, overflow: "hidden",
    }}>
      <input
        type="color" value={value} aria-label={label}
        onChange={e => onPick(e.target.value)}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer", border: "none", padding: 0 }}
      />
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   地図の色(海・陸・都道府県の境界線・国境線)の設定。
   ライト/ダークで別々に保存する。編集対象のモードは上のトグルで切り替えられ(初期値は
   今のモード)、変更はその場で地図に反映される(今のモードの色を編集している場合)。
   線は半透明が既定なので、色と「濃さ(不透明度)」を別々に調整できる。
   「初期設定に戻す」は、ライト・ダーク両方の全項目を一括で戻す(誤タップ防止に2回押し)。
   ───────────────────────────────────────────────────── */
export function MapColorSettings({ overrides, onChange, onResetItem, onResetAll }) {
  const { tokens, mode } = useContext(ThemeContext);
  const [editMode, setEditMode] = useState(mode);
  const [confirmingReset, setConfirmingReset] = useState(false);

  // 「もう一度押すと戻ります」状態は数秒で自動的に解除する。
  useEffect(() => {
    if (!confirmingReset) return;
    const id = setTimeout(() => setConfirmingReset(false), 4000);
    return () => clearTimeout(id);
  }, [confirmingReset]);

  const defaults = MAP_COLOR_DEFAULTS[editMode];
  const custom = (overrides && overrides[editMode]) || {};
  const valueOf = key => (custom[key] != null ? custom[key] : defaults[key]);
  const anyCustomized = ["light", "dark"].some(m => overrides && overrides[m] && Object.keys(overrides[m]).length > 0);

  // プレビュー: 海の上に、日本・海外の陸を並べ、それぞれの境界線を引いた小さな図。
  const sea = valueOf("mapBg");
  const prefFill = valueOf("mapPrefFill");
  const worldFill = valueOf("mapWorldFill");
  const prefLine = mapLineToCss(valueOf("mapPrefLine"));
  const worldLine = mapLineToCss(valueOf("mapWorldLine"));

  const labelStyle = { fontSize: 13, fontWeight: 600, color: tokens.text };
  const smallBtn = (enabled) => ({
    padding: "4px 10px", borderRadius: 999, border: `1px solid rgba(${tokens.ink},0.2)`,
    background: "transparent", color: tokens.textSecondary, fontSize: 11, fontWeight: 600,
    cursor: enabled ? "pointer" : "default", opacity: enabled ? 1 : 0.35, flexShrink: 0,
  });

  return (
    <>
      <div style={{ display: "flex", gap: 4, padding: 4, margin: "0 14px 10px", borderRadius: 12, background: `rgba(${tokens.ink},0.07)` }}>
        {[["light", "ライト"], ["dark", "ダーク"]].map(([m, label]) => {
          const selected = editMode === m;
          return (
            <PressableButton
              key={m}
              type="button"
              onClick={() => setEditMode(m)}
              style={{
                flex: 1, padding: "7px 0", borderRadius: 9, border: "none", cursor: "pointer",
                background: selected ? `rgba(${tokens.ink},0.14)` : "transparent",
                color: selected ? tokens.text : tokens.textSecondary,
                fontSize: 13, fontWeight: selected ? 700 : 600,
              }}
            >
              {label}{m === mode ? "(表示中)" : ""}
            </PressableButton>
          );
        })}
      </div>

      <div style={{ margin: "0 14px 10px", height: 64, borderRadius: 12, background: sea, position: "relative", overflow: "hidden", boxShadow: `0 0 0 1px rgba(${tokens.ink},0.12)` }}>
        <div style={{ position: "absolute", left: "-6%", top: "-18%", width: "46%", height: "140%", background: worldFill, border: `1px solid ${worldLine}`, borderRadius: "0 40% 30% 0" }}/>
        <div style={{ position: "absolute", left: "52%", top: "12%", width: "36%", height: "76%", background: prefFill, border: `1px solid ${prefLine}`, borderRadius: "30% 50% 40% 30%" }}/>
        <div style={{ position: "absolute", left: "70%", top: "34%", width: "16%", height: "34%", background: prefFill, border: `1px solid ${prefLine}`, borderRadius: "40%" }}/>
      </div>

      <SettingsCard>
        {MAP_COLOR_ITEMS.map((item, i) => {
          const value = valueOf(item.key);
          const isLine = item.type === "line";
          const color = isLine ? value.color : value;
          const customized = custom[item.key] != null;
          return (
            <Fragment key={item.key}>
              {i > 0 && <SettingsCardDivider/>}
              <div style={{ padding: "10px 14px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <MapColorSwatch
                    value={color}
                    label={item.label}
                    onPick={hex => onChange(editMode, item.key, isLine ? { color: hex, opacity: value.opacity } : hex)}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={labelStyle}>{item.label}</div>
                    <div style={{ fontSize: 11, color: tokens.textSecondary, marginTop: 2 }}>{color.toUpperCase()}</div>
                  </div>
                  <PressableButton
                    type="button"
                    disabled={!customized}
                    onClick={() => onResetItem(editMode, item.key)}
                    style={smallBtn(customized)}
                  >
                    戻す
                  </PressableButton>
                </div>
                {isLine && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, paddingLeft: 44 }}>
                    <span style={{ fontSize: 11, color: tokens.textSecondary, flexShrink: 0 }}>濃さ</span>
                    <input
                      type="range" min={0} max={100} step={1}
                      value={Math.round(value.opacity * 100)}
                      onChange={e => onChange(editMode, item.key, { color: value.color, opacity: Number(e.target.value) / 100 })}
                      style={{ flex: 1, minWidth: 0, accentColor: tokens.accentText }}
                    />
                    <span style={{ fontSize: 11, color: tokens.textSecondary, width: 34, textAlign: "right", flexShrink: 0 }}>
                      {Math.round(value.opacity * 100)}%
                    </span>
                  </div>
                )}
              </div>
            </Fragment>
          );
        })}
      </SettingsCard>

      <SettingsCard>
        <PressableButton
          type="button"
          disabled={!anyCustomized}
          onClick={() => {
            if (confirmingReset) { setConfirmingReset(false); onResetAll(); }
            else setConfirmingReset(true);
          }}
          style={{
            width: "100%", padding: "13px 14px", border: "none", background: "transparent",
            cursor: anyCustomized ? "pointer" : "default", textAlign: "center",
            fontSize: 14, fontWeight: 600,
            color: confirmingReset ? "#FF453A" : (anyCustomized ? tokens.text : tokens.textSecondary),
            opacity: anyCustomized ? 1 : 0.5,
          }}
        >
          {confirmingReset ? "もう一度押すと、ライト・ダークとも初期設定に戻します" : "地図の色を初期設定に戻す"}
        </PressableButton>
      </SettingsCard>

      <div style={{ margin: "0 14px 16px", fontSize: 11, color: tokens.textSecondary, lineHeight: 1.6 }}>
        色はライトとダークで別々に保存されます。地図の色を大きく変えると、震度の塗りつぶしや
        観測点の表示が見づらくなることがあります。その場合は「初期設定に戻す」で元に戻せます。
      </div>
    </>
  );
}
