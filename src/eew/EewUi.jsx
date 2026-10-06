import { useContext, useEffect, useState } from "react";
import { Glass } from "../ui/glass.jsx";
import { ThemeContext, splitIntensityLabel, useIntensityStyle } from "../settings/prefs.js";
import { formatEewTimeShort } from "../api/p2p.js";
import { AutoFitText, PanelDragHandoffCard } from "../quake/quakeCards.jsx";

/* ─────────────────────────────────────────────────────
   LIVE CLOCK
   ───────────────────────────────────────────────────── */
function Clock() {
  const { tokens } = useContext(ThemeContext);

  const [t, setT] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="mono" style={{ fontSize: 12, color: `rgba(${tokens.ink},0.5)` }}>
      {t.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
    </span>
  );
}


/* ─────────────────────────────────────────────────────
   ALERT PILL
   ───────────────────────────────────────────────────── */
const ALERT_COLOR = {
  watch:     "#FFD60A",
  warning:   "#FF9F0A",
  emergency: "#FF453A",
};

function AlertPill({ alert }) {
  const { tokens } = useContext(ThemeContext);

  // "warning"等の警報色は演出上どのテーマでも同じ鮮やかな色を保つが、
  // 警報なし("none")の通常表示は地の文なので、他のテキストと同様に
  // テーマの文字色に追従させる(固定の白だとライトモードで読めなくなるため)。
  const color = ALERT_COLOR[alert.level] || tokens.textSecondary;
  const hasAlert = alert.level !== "none";

  return (
    <Glass
      radius={999}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 16px",
        animation: "appear 0.4s cubic-bezier(.25,1,.5,1)",
      }}
    >
      {hasAlert && (
        <span style={{
          width: 7, height: 7, borderRadius: "50%",
          background: color, flexShrink: 0, color,
          animation: "pulse 1.5s ease-in-out infinite",
          boxShadow: `0 0 8px ${color}`,
          display: "block",
        }}/>
      )}
      <span style={{ fontSize: 13, fontWeight: 600, color }}>
        {alert.title}
      </span>
      <span style={{ fontSize: 13, color: `rgba(${tokens.ink},0.65)` }}>
        {alert.region}
      </span>
      <div style={{ width: 0.5, height: 13, background: `rgba(${tokens.ink},0.25)`, flexShrink: 0 }}/>
      <Clock/>
    </Glass>
  );
}


/* ─────────────────────────────────────────────────────
   緊急地震速報FABボタン — BackToListButtonと全く同じ丸型Glassの形状・押下演出を
   使った、ビックリマークのアイコンボタン。EEW発表中は画面左上に浮かび、押すと
   緊急地震速報の詳細画面(フローティングカード)へ遷移する。
   ───────────────────────────────────────────────────── */
export function EewFabButton({ onClick }) {
  const [pressed, setPressed] = useState(false);

  return (
    <Glass
      radius={999}
      style={{
        width: 44, height: 44,
        transform: pressed ? "scale(1.16)" : "scale(1)",
        transformOrigin: "center",
        transition: "transform 0.18s cubic-bezier(.22,1,.36,1)",
        animation: "eewFabPulse 1.4s ease-in-out infinite",
      }}
    >
      <button
        onClick={onClick}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerCancel={() => setPressed(false)}
        onPointerLeave={() => setPressed(false)}
        aria-label="緊急地震速報を確認"
        style={{
          position: "relative", zIndex: 1,
          width: "100%", height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#FF453A",
        }}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none"
             stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="14"/>
          <line x1="12" y1="18.4" x2="12" y2="18.5"/>
        </svg>
      </button>
    </Glass>
  );
}


/* ─────────────────────────────────────────────────────
   緊急地震速報(警報)の対象地域が多数にのぼる場合、個別の地域名(細分区域名)を
   ずらずら並べても読みにくいため、2段階で丸めて表示する。
     ・7件を超えたら → 細分区域名ではなく「都道府県」単位(重複排除)
     ・丸めた都道府県が7件を超えたら → さらに「地方」単位(重複排除)
   都道府県は北→南の固定順、地方も同様の固定順で並べ替える(Setの出現順には
   依存しない)。
   EEWのareas[].pref はP2P地震情報のEEW(code:556)なら都道府県名
   (例:"東京都""神奈川県")が入っているが、テスト配信生成分など pref が
   空文字のデータもあるため、その場合は area.name の先頭一致(細分区域名は
   必ず都道府県名で始まる)から都道府県を推定するフォールバックを持つ。
   ───────────────────────────────────────────────────── */
// 北→南の固定順(JIS都道府県コード順=ほぼ地理的な北→南)。
export const PREF_ORDER = [
  "北海道",
  "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県",
  "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
  "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県",
  "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県",
  "沖縄県",
];

const PREF_TO_REGION = {
  "北海道": "北海道",
  "青森県": "東北", "岩手県": "東北", "宮城県": "東北", "秋田県": "東北", "山形県": "東北", "福島県": "東北",
  "茨城県": "関東", "栃木県": "関東", "群馬県": "関東", "埼玉県": "関東", "千葉県": "関東", "東京都": "関東", "神奈川県": "関東",
  "新潟県": "北陸", "富山県": "北陸", "石川県": "北陸", "福井県": "北陸",
  "山梨県": "中部", "長野県": "中部", "岐阜県": "中部",
  "静岡県": "東海", "愛知県": "東海", "三重県": "東海",
  "滋賀県": "近畿", "京都府": "近畿", "大阪府": "近畿", "兵庫県": "近畿", "奈良県": "近畿", "和歌山県": "近畿",
  "鳥取県": "中国", "島根県": "中国", "岡山県": "中国", "広島県": "中国", "山口県": "中国",
  "徳島県": "四国", "香川県": "四国", "愛媛県": "四国", "高知県": "四国",
  "福岡県": "九州", "佐賀県": "九州", "長崎県": "九州", "熊本県": "九州", "大分県": "九州", "宮崎県": "九州", "鹿児島県": "九州",
  "沖縄県": "沖縄",
};

const EEW_REGION_ORDER = ["北海道", "東北", "関東", "北陸", "中部", "東海", "近畿", "中国", "四国", "九州", "沖縄"];

const EEW_AREA_GROUPING_THRESHOLD = 7;
 // 対象地域の件数がこれを超えたら都道府県表示に丸める
const EEW_PREF_GROUPING_THRESHOLD = 7;
 // 丸めた都道府県の件数がこれを超えたらさらに地方表示に丸める

// 北海道の細分区域名(石狩地方北部、渡島地方東部、日高地方西部…)は、他の道府県と
// 違って先頭に都道府県名「北海道」が付かない特殊な表記のため、上のPREF_ORDER前方
// 一致だけでは拾えない。支庁地方名の一覧で個別に判定する。
const HOKKAIDO_SUBAREA_NAME_PREFIXES = [
  "石狩", "渡島", "檜山", "後志", "空知", "上川", "留萌", "宗谷", "網走",
  "北見", "紋別", "胆振", "日高", "十勝", "釧路", "根室",
];


// area.pref が空/未知の場合に、area.name(細分区域名)の先頭一致から都道府県名を
// 推定する。細分区域名は「◯◯県△△」のように都道府県名で始まる表記なので、
// PREF_ORDERを順に前方一致でチェックすれば一意に決まる(prefix同士の衝突は無い)。
// 北海道だけは表記が異なるため、支庁地方名リストで別途判定する。
export function derivePrefFromEewAreaName(name) {
  if (!name) return null;
  for (const pref of PREF_ORDER) {
    if (name.startsWith(pref)) return pref;
  }
  if (HOKKAIDO_SUBAREA_NAME_PREFIXES.some(p => name.startsWith(p))) return "北海道";
  return null;
}


// EEWの対象地域一覧(areas[])を、カード表示用の1本のテキストに整形する。
function formatEewAreasSummary(areas) {
  if (!Array.isArray(areas) || areas.length === 0) return "";
  if (areas.length <= EEW_AREA_GROUPING_THRESHOLD) {
    return areas.map(a => a.name).join("、");
  }

  // 第1段階: 都道府県に丸める(pref優先、無ければ地域名から推定。
  // それでも分からなければ元の地域名のままフォールバックで残す)。
  const prefsSeen = new Set();
  const unresolvedNames = new Set();
  for (const a of areas) {
    const pref = (a.pref && PREF_TO_REGION[a.pref]) ? a.pref : derivePrefFromEewAreaName(a.name);
    if (pref) prefsSeen.add(pref);
    else unresolvedNames.add(a.name);
  }
  const orderedPrefs = PREF_ORDER.filter(p => prefsSeen.has(p));

  if (orderedPrefs.length <= EEW_PREF_GROUPING_THRESHOLD) {
    return [...orderedPrefs, ...unresolvedNames].join("、");
  }

  // 第2段階: 都道府県数も7件を超えていたら、さらに地方に丸める。
  const regionsSeen = new Set();
  for (const pref of orderedPrefs) {
    const region = PREF_TO_REGION[pref];
    if (region) regionsSeen.add(region);
  }
  const orderedRegions = EEW_REGION_ORDER.filter(r => regionsSeen.has(r));
  return [...orderedRegions, ...unresolvedNames].join("、");
}


/* ─────────────────────────────────────────────────────
   緊急地震速報の詳細フローティングカード。
   地震タブの選択中カード(QuakeDetailCard)と同じ「最大震度バッジ＋震源地／M・
   深さ／発生時刻」のレイアウトを踏襲しつつ、Glassで包んで地図上に浮かべ、
   ヘッダーに第◯報・PLUM法バッジ・警戒文言、下段に対象地域を足したもの。
   複数のEEWが同時に発表された場合は縦に積んで表示する(EEW_MAX_CONCURRENTで
   件数を制限しているため、実用上は積みすぎて見づらくなることはない)。
   取消(cancelled)を受信した場合は「取消」表示に切り替わり、一定時間後に
   一覧から消える(App側のEEW_CANCEL_LINGER_MSタイマーで管理)。
   ───────────────────────────────────────────────────── */
export function EewDetailFloatingCard({ eew, onHandoffToPanelDrag }) {
  const { tokens } = useContext(ThemeContext);
  const style = useIntensityStyle(eew.maxIntensityKey);
  const { num, suffix } = splitIntensityLabel(style.label);
  const isWarnLevel = eew.isWarnLevel !== false; // 警報級かどうか(Wolfxの予報はfalse)
  // 警報=赤、予報=amber、取消=グレー、と重要度で色分けする。
  const accent = eew.cancelled ? tokens.textSecondary : (isWarnLevel ? "#FF453A" : "#FF9F0A");

  return (
    <div>
      {/* 見出し — 「緊急地震速報(警報)」チップと「#報番号」チップを、色付きの
          Glass(すりガラス)で囲う。tintColorはGlass内部のブラー層自体の背景を
          直接置き換えるため、ライト/ダークモードやフローティング不透明設定に
          関わらず常に同じ濃さの色になる(以前はstyle.backgroundで指定していたため、
          tokens.glassTint/glassOpaqueBgと二重に重なって、モードや不透明設定ごとに
          色の見え方がバラついていた)。
          テスト配信バッジは、この見出しブロックの左上に重ねて絶対配置する
          (このdivだけをposition:relativeにすることで、カード全体やスクロール
          位置には影響させず、見出しブロックとの相対位置だけで決まるようにする)。 */}
      <PanelDragHandoffCard onHandoffToPanelDrag={onHandoffToPanelDrag}>
        <div style={{ position: "relative", margin: "4px 16px 10px" }}>
          {eew.isTest && (
            <span style={{
              position: "absolute", top: -6, left: 8, zIndex: 1,
              fontSize: 9.5, fontWeight: 800, color: "#fff",
              background: "#FF453A", borderRadius: 4, padding: "2px 6px",
            }}>
              テスト配信
            </span>
          )}
          <div style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
          <Glass
            radius={14}
            tintColor={eew.cancelled ? null : accent}
            style={{
              flex: 1, minWidth: 0,
              padding: "10px 14px",
              display: "flex", alignItems: "center",
              background: eew.cancelled ? `rgba(${tokens.ink},0.08)` : undefined,
            }}
          >
            <span style={{
              fontSize: 16, fontWeight: 800, lineHeight: 1.25,
              color: tokens.text,
            }}>
              緊急地震速報{eew.cancelled ? "(取消)" : (isWarnLevel ? "(警報)" : "(予報)")}{!eew.cancelled && eew.isPlum ? "・PLUM法" : ""}
            </span>
          </Glass>
          {!eew.cancelled && (
            <Glass
              radius={14}
              style={{
                flexShrink: 0,
                padding: "10px 14px",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <span style={{ fontSize: 16, fontWeight: 800, color: tokens.text, whiteSpace: "nowrap" }}>
                # {eew.serial ?? "-"}{eew.isFinal ? "(最終)" : ""}
              </span>
            </Glass>
          )}
          </div>
        </div>
      </PanelDragHandoffCard>

      {eew.cancelled ? (
        <div style={{ margin: "2px 16px 10px", fontSize: 13, color: tokens.textSecondary, lineHeight: 1.7 }}>
          この緊急地震速報は取り消されました。
        </div>
      ) : (
        <>
          {/* ここから先は地震タブのQuakeDetailCardと全く同じ構造・スタイル(囲みなし) */}
          <div
            style={{
              margin: "2px 14px 4px",
              borderRadius: 16,
              padding: "8px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 3,
              background: `linear-gradient(135deg, ${style.bg}2E, ${style.bg}14)`,
              boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.12)`,
              animation: "appear 0.35s cubic-bezier(.25,1,.5,1)",
            }}
          >
            {/* 震源地 — カード上部に全幅で表示 */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0, lineHeight: 1.1 }}>
              <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.55)`, flexShrink: 0, lineHeight: 1.1 }}>{eew.isPlum ? "検知観測点" : "震源地"}</span>
              <AutoFitText
                text={eew.place}
                maxFontSize={25}
                minFontSize={13}
                style={{ fontWeight: 800, color: tokens.text, lineHeight: 1.1 }}
              />
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.6)`, whiteSpace: "nowrap", lineHeight: 1.1 }}>
                  最大予測震度
                </span>
                <div
                  style={{
                    width: 58, height: 58,
                    borderRadius: 13,
                    background: style.bg, color: style.fg,
                    position: "relative",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  {suffix ? (
                    <>
                      <span className="mono" style={{ fontSize: 29, fontWeight: 800, lineHeight: 1 }}>{num}</span>
                      <span style={{
                        fontSize: 14, fontWeight: 700, lineHeight: 1,
                        marginLeft: 2, alignSelf: "flex-end", marginBottom: 12,
                      }}>{suffix}</span>
                    </>
                  ) : (
                    <span className="mono" style={{ fontSize: 29, fontWeight: 800, lineHeight: 1 }}>{num}</span>
                  )}
                </div>
              </div>

              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                {/* PLUM法(観測点の揺れの実測から震源を仮定する方式)の場合は、
                    M・深さの行そのものを「PLUM法による仮定震源要素」というラベルに
                    差し替えて同じ位置に表示する(通常方式のときだけM・深さを表示)。 */}
                {eew.isPlum ? (
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6, lineHeight: 1.1, marginBottom: 14 }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.1 }}>
                      PLUM法による仮定震源要素
                    </span>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "baseline", gap: 12, lineHeight: 1.1 }}>
                    <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.1 }}>
                      M<span className="mono" style={{ fontSize: 25, fontWeight: 800, color: tokens.text, marginLeft: 3, lineHeight: 1.1 }}>
                        {eew.magnitude != null ? eew.magnitude.toFixed(1) : "-"}
                      </span>
                    </span>
                    <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.1 }}>
                      深さ<span className="mono" style={{ fontSize: 25, fontWeight: 800, color: tokens.text, marginLeft: 3, lineHeight: 1.1 }}>
                        {eew.depth != null ? (eew.depth === 0 ? "ごく浅い" : eew.depth) : "-"}
                      </span>
                      {eew.depth != null && eew.depth !== 0 && (
                        <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.6)`, marginLeft: 2, lineHeight: 1.1 }}>km</span>
                      )}
                    </span>
                  </div>
                )}

                <div style={{ display: "flex", alignItems: "baseline", gap: 6, lineHeight: 1.1 }}>
                  <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, flexShrink: 0, lineHeight: 1.1 }}>発生時刻</span>
                  <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: `rgba(${tokens.ink},0.85)`, lineHeight: 1.1 }}>
                    {formatEewTimeShort(eew.originTime)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* 対象地域 — QuakeMessageCardと全く同じ「電文カード」風の下段パネル(囲みなし) */}
          {eew.areas && eew.areas.length > 0 && (
            <div style={{ margin: "2px 14px 8px" }}>
              <div style={{
                borderRadius: 12,
                padding: "10px 12px",
                display: "flex", flexDirection: "column", gap: 8,
                background: `rgba(${tokens.ink},0.04)`,
                boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
              }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#FFD60A" }}>
                    【対象地域】
                  </span>
                  <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.85)`, lineHeight: 1.5 }}>
                    {formatEewAreasSummary(eew.areas)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {eew.isPlum && (
            <div style={{ margin: "0 16px 8px", fontSize: 11, color: tokens.textSecondary, lineHeight: 1.6 }}>
              ※観測点の揺れの実測から予測しています(到達時刻は未提供)。
            </div>
          )}
        </>
      )}
    </div>
  );
}
