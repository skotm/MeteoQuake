import { useContext } from "react";
import { Glass, PressableButton } from "../ui/glass.jsx";
import { ThemeContext } from "../settings/prefs.js";

/* ─────────────────────────────────────────────────────
   TYPHOON LIST PANEL — 気象タブで「台風情報」ONの間、WeatherLocationPanelの
   代わりに表示する「現在活動中の台風」一覧。地震一覧・警報一覧と同じ
   パネル枠に、名前(弱化していればグレー)・中心気圧・最大風速を並べる。
   タップすると地図がその台風の中心へflyToする(参考実装のupdateRanking()の
   台風分岐を踏襲)。
   ───────────────────────────────────────────────────── */
// 台風の詳細カード。時刻チップ(予報円)をタップした時と、台風一覧の項目を
// タップした時の両方で使う。infoにforecastTimeが入っていれば「その予報時点」の
// 情報、入っていなければ「現在」の情報として見出しを出し分ける。
// フィールド名(name/category/weakened/pressure/maxWind/maxGust/scale/intensity/
// speed/courseText/speedKmh/timeLabel)はfetchTyphoonData側で両パターンとも
// 揃えてあるので、カードの中身は共通にできる。
// デザインは、ユーザーが参考として共有した「大きな数字+英字サブラベル」風の
// 台風情報表示を下敷きにしつつ、フローティングパネルの限られた高さに収まるよう
// 余白は最小限に詰めている。
// 「大きさ」バッジの色。大型=黄、超大型=赤。それ以外(該当なし)はnull。
function getTyphoonScaleBadgeColor(scale) {
  if (scale === "超大型") return { bg: "#C0392B", fg: "#fff" };
  if (scale === "大型") return { bg: "#E3B62B", fg: "#2B2200" };
  return null;
}

// 「強さ」バッジの色。強い=黄、非常に強い=赤、猛烈な=紫。それ以外はnull。
function getTyphoonIntensityBadgeColor(intensity) {
  if (intensity === "猛烈な") return { bg: "#8E44AD", fg: "#fff" };
  if (intensity === "非常に強い") return { bg: "#C0392B", fg: "#fff" };
  if (intensity === "強い") return { bg: "#E3B62B", fg: "#2B2200" };
  return null;
}


export function TyphoonDetailCard({ info, typhoons = [], onSelectTyphoonDetail }) {
  const { tokens } = useContext(ThemeContext);
  const isForecast = info.forecastTime != null;
  const timeLabel = info.timeLabel || (isForecast ? `${info.forecastTime} 予報` : "現在");

  // 予報タイムライン: 「現在」+ この台風の予報点(間引き後、時系列順)。
  // infoが予報時点を見ている時は、同じ台風のtyphoons側の現在情報(=id一致)を
  // 探して先頭に足す。infoが「現在」そのものの時は、info自身が既にforecastsを
  // 持っているのでそれをそのまま使う。
  const parentTyphoon = info.forecastTime != null
    ? typhoons.find(t => t.id === info.id)
    : info;
  const timelineForecasts = parentTyphoon?.forecasts || [];
  const timelineItems = parentTyphoon ? [parentTyphoon, ...timelineForecasts] : [];

  const primaryStats = [
    { label: "中心気圧", value: (info.pressure && info.pressure !== "不明") ? info.pressure : "―", unit: "hPa" },
    { label: "最大風速", value: (info.maxWind && info.maxWind !== "不明") ? info.maxWind : "―", unit: "m/s" },
  ];
  const secondaryStats = [
    { label: "最大瞬間風速", value: (info.maxGust && info.maxGust !== "不明") ? info.maxGust : "―", unit: "m/s" },
    { label: "移動速度", value: info.speedKmh != null ? info.speedKmh : "―", unit: info.speedKmh != null ? "km/h" : "" },
    { label: "移動方向", value: (info.courseText && info.courseText !== "-") ? info.courseText : "ほぼ停滞", unit: "" },
  ];
  if (isForecast && info.radiusKm) {
    secondaryStats.push({ label: "予報円の半径", value: info.radiusKm, unit: "km" });
  }

  const scaleBadgeColor = getTyphoonScaleBadgeColor(info.scale);
  const intensityBadgeColor = getTyphoonIntensityBadgeColor(info.intensity);

  return (
    <div style={{ margin: "0 14px 2px" }}>
      {/* 見出し: 名称の下に「バッジ(左)+発表時刻(右)」を1行にまとめる */}
      <div style={{ padding: "0 4px 4px" }}>
        <div style={{
          fontSize: 17, fontWeight: 800, color: tokens.text, lineHeight: 1.15,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {info.name}
        </div>
        {/* バッジの有無(0〜2個)に関わらず、この行の高さは常に一定にする。
            そうしないと、選ぶ台風/予報時点によってバッジの数が変わるたびに
            下のガラスパネルの位置が上下に押し出されてしまうため。 */}
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 4, minHeight: 18 }}>
          {scaleBadgeColor && (
            <span style={{
              fontSize: 11, fontWeight: 800, padding: "2px 8px", borderRadius: 7,
              background: scaleBadgeColor.bg, color: scaleBadgeColor.fg,
            }}>
              {info.scale}
            </span>
          )}
          {intensityBadgeColor && (
            <span style={{
              fontSize: 11, fontWeight: 800, padding: "2px 8px", borderRadius: 7,
              background: intensityBadgeColor.bg, color: intensityBadgeColor.fg,
            }}>
              {info.intensity}
            </span>
          )}
          <span style={{ flex: 1, minWidth: 4 }}/>
          <span style={{ fontSize: 11, fontWeight: 500, color: `rgba(${tokens.ink},0.5)`, whiteSpace: "nowrap" }}>
            {timeLabel}
          </span>
        </div>
      </div>

      {/* バッジより下の詳細情報(中心気圧〜移動方向まで)を、まとめて1枚のガラスで囲む */}
      <Glass radius={16} style={{ padding: "6px 12px 4px" }}>
        {/* 中心気圧・最大風速 — ひときわ大きい数字で強調する */}
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 8,
          paddingBottom: 3, marginBottom: 3,
          borderBottom: `0.5px solid rgba(${tokens.ink},0.12)`,
        }}>
          {primaryStats.map(stat => (
            <div key={stat.label} style={{ textAlign: "center" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: `rgba(${tokens.ink},0.6)` }}>{stat.label}</div>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 3 }}>
                <span className="mono" style={{ fontSize: 28, fontWeight: 800, color: tokens.text, lineHeight: 1.15 }}>
                  {stat.value}
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: `rgba(${tokens.ink},0.5)` }}>{stat.unit}</span>
              </div>
            </div>
          ))}
        </div>

        {/* その他の項目 — 常に1行(最大4列)に収め、項目同士の間に縦の仕切り線を入れる。
            ただし上の横の仕切り線とは接続しない(セル自体の上端には線を引かず、
            隣同士を区切る縦線だけを立てる)ようにしている。 */}
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${secondaryStats.length}, 1fr)`, columnGap: 6 }}>
          {secondaryStats.map((stat, i) => (
            <div
              key={stat.label}
              style={{
                textAlign: "center",
                borderLeft: i > 0 ? `0.5px solid rgba(${tokens.ink},0.12)` : "none",
                paddingLeft: i > 0 ? 6 : 0,
              }}
            >
              <div style={{ fontSize: 9.5, fontWeight: 700, color: `rgba(${tokens.ink},0.55)`, whiteSpace: "nowrap" }}>
                {stat.label}
              </div>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 2 }}>
                <span className="mono" style={{ fontSize: 15, fontWeight: 700, color: tokens.text, whiteSpace: "nowrap" }}>
                  {stat.value}
                </span>
                {stat.unit && (
                  <span style={{ fontSize: 9.5, fontWeight: 600, color: `rgba(${tokens.ink},0.5)` }}>{stat.unit}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </Glass>

      {/* 予報タイムライン — 「現在」+ この台風の予報点を時系列で並べる。
          タップすると、上の詳細カードの中身がその時刻の予報に切り替わる。
          タイムライン自体は選択中の時刻に関わらず同じ並び("現在"は常に先頭)を
          保つので、行き来しながら見比べられる。 */}
      {timelineItems.length > 1 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ padding: "6px 4px 4px", fontSize: 11.5, fontWeight: 600, color: `rgba(${tokens.ink},0.55)` }}>
            予報の推移
          </div>
          <Glass radius={16} style={{ padding: "2px 4px" }}>
            {timelineItems.map((item, i) => {
              const itemIsForecast = item.forecastTime != null;
              const itemLabel = itemIsForecast ? item.forecastTime : "現在";
              const isSelected = isForecast
                ? (itemIsForecast && item.forecastTime === info.forecastTime)
                : !itemIsForecast;
              const itemScaleColor = getTyphoonScaleBadgeColor(item.scale);
              const itemIntensityColor = getTyphoonIntensityBadgeColor(item.intensity);
              return (
                <div key={itemIsForecast ? `${item.id}-${item.forecastTime}` : `${item.id}-current`}>
                  {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.1)`, marginLeft: 14 }}/>}
                  <PressableButton
                    onClick={() => onSelectTyphoonDetail?.({ ...item, forecasts: timelineForecasts })}
                    style={{
                      width: "100%", display: "flex", alignItems: "center",
                      padding: "9px 14px", gap: 8, textAlign: "left",
                      background: isSelected ? `rgba(${tokens.ink},0.07)` : "transparent",
                      borderRadius: 12,
                    }}
                  >
                    <span style={{
                      fontSize: 13, fontWeight: isSelected ? 800 : 600, flexShrink: 0,
                      color: isSelected ? tokens.text : `rgba(${tokens.ink},0.75)`,
                    }}>
                      {itemLabel}
                    </span>
                    {/* 勢力(強さ)・サイズ(大きさ)の情報がある予報点だけ、小さめのバッジを添える */}
                    {(itemScaleColor || itemIntensityColor) && (
                      <span style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                        {itemScaleColor && (
                          <span style={{
                            fontSize: 9.5, fontWeight: 800, padding: "1px 6px", borderRadius: 6,
                            background: itemScaleColor.bg, color: itemScaleColor.fg, whiteSpace: "nowrap",
                          }}>
                            {item.scale}
                          </span>
                        )}
                        {itemIntensityColor && (
                          <span style={{
                            fontSize: 9.5, fontWeight: 800, padding: "1px 6px", borderRadius: 6,
                            background: itemIntensityColor.bg, color: itemIntensityColor.fg, whiteSpace: "nowrap",
                          }}>
                            {item.intensity}
                          </span>
                        )}
                      </span>
                    )}
                    <span style={{ flex: 1 }}/>
                    <span className="mono" style={{ fontSize: 12.5, color: `rgba(${tokens.ink},0.55)`, whiteSpace: "nowrap" }}>
                      {item.pressure}hPa / {item.maxWind}m/s
                    </span>
                  </PressableButton>
                </div>
              );
            })}
          </Glass>
        </div>
      )}
    </div>
  );
}


export function TyphoonListPanel({ typhoons = [], loadError = false, onSelectTyphoon }) {
  const { tokens } = useContext(ThemeContext);

  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center",
        padding: "8px 18px 11px",
        borderBottom: `0.5px solid rgba(${tokens.ink},0.15)`,
      }}>
        <span style={{ fontSize: 14, fontWeight: 600, flex: 1, color: `rgba(${tokens.ink},0.9)` }}>
          現在の台風情報
        </span>
      </div>

      {loadError ? (
        <div style={{ padding: "24px 18px", fontSize: 13, color: `rgba(${tokens.ink},0.5)`, textAlign: "center" }}>
          台風情報の取得に失敗しました。しばらくしてから再度お試しください。
        </div>
      ) : typhoons.length === 0 ? (
        <div style={{ padding: "24px 18px", fontSize: 13, color: `rgba(${tokens.ink},0.5)`, textAlign: "center" }}>
          現在、発生中の台風はありません。
        </div>
      ) : (
        typhoons.map((t, i) => (
          <div key={t.id}>
            {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.1)`, marginLeft: 18 }}/>}
            <PressableButton
              onClick={() => onSelectTyphoon?.(t)}
              style={{
                width: "100%", display: "flex", alignItems: "center",
                padding: "11px 18px", gap: 10, textAlign: "left",
              }}
            >
              <span style={{
                fontSize: 14, fontWeight: 600, flex: 1,
                color: t.weakened ? "#9AA0A6" : "#0A84FF",
              }}>
                {t.name}
              </span>
              <span style={{ fontSize: 13, color: `rgba(${tokens.ink},0.7)`, whiteSpace: "nowrap" }}>
                {t.pressure}hPa / {t.maxWind}m/s
              </span>
            </PressableButton>
          </div>
        ))
      )}
    </div>
  );
}
