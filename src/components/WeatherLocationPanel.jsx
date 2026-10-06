import { useContext, useState } from "react";
import { Glass, PressableButton, useIsStandalonePwa } from "../ui/glass.jsx";
import { PREF_ORDER } from "../eew/EewUi.jsx";
import { ThemeContext } from "../settings/prefs.js";
import { KANA_ROWS } from "../api/warnings.js";
import { WeatherIcon, formatForecastDayLabel, formatTimeSeriesDateChanged, formatTimeSeriesHour, windDirectionToDegrees } from "../weather/location.jsx";
import { PinIcon } from "./icons.jsx";

/* ─────────────────────────────────────────────────────
   WEATHER LOCATION PANEL — 気象タブ「地点(ピン)」モードの中身。フローティング
   の小さなカードではなく、既存の「現在開発中です」プレースホルダーが出ていた
   パネル枠(設定メニュー・地図レイヤー一覧と同じ場所)に、現在地(GPS)または
   登録地点(1件)の天気予報を表示する。
   ───────────────────────────────────────────────────── */
export function WeatherLocationPanel({
  geoState, onConsentLocation, onResetLocationConsent,
  activeWeatherPoint, forecastState, timeSeriesState, registeredWeatherPoint, currentMunicipalityName,
  weatherSourceMode, onChangeWeatherSourceMode,
  kanaPickerOpen, onOpenKanaPicker, onCloseKanaPicker,
  kanaPickerStep, onChangeKanaPickerStep,
  kanaPickerPref, onChangeKanaPickerPref,
  kanaPickerRow, onChangeKanaPickerRow, kanaPickerCol, onChangeKanaPickerCol,
  kanaGroupedMunicipalities, municipalityListReady, municipalityListError, onSelectMunicipality,
}) {
  const { tokens } = useContext(ThemeContext);
  const isStandalonePwa = useIsStandalonePwa();
  const [rangeMode, setRangeMode] = useState("3day"); // "3day" | "week"
  // 天気アイコンの縁取りはWeatherIconコンポーネント側(canvas焼き込み)で
  // 処理するため、ここでは何もしない。旧: SVGフィルタ(weather-icon-outline-
  // dark/-light)を<img>に直接filterで適用していたが、Safari/iOSで一部が
  // 透けて見える不具合があったため撤去した。
  // 地点登録(五十音ピッカー)を開いている間は、それ専用の画面をフルで表示する。
  if (kanaPickerOpen) {
    return (
      <KanaMunicipalityPicker
        step={kanaPickerStep} onChangeStep={onChangeKanaPickerStep}
        pref={kanaPickerPref} onChangePref={onChangeKanaPickerPref}
        row={kanaPickerRow} onChangeRow={onChangeKanaPickerRow}
        col={kanaPickerCol} onChangeCol={onChangeKanaPickerCol}
        grouped={kanaGroupedMunicipalities}
        dataReady={municipalityListReady}
        loadError={municipalityListError}
        onSelect={onSelectMunicipality}
        onClose={onCloseKanaPicker}
      />
    );
  }

  // 上部のヘッダー行 — 現在地/登録地点の表示名と、切り替えボタンを同じ行に置く。
  // 切り替えボタンは以前は横幅いっぱいの2分割セグメントだったが、幅を短く
  // (中身の文字幅に合わせた自動幅)している。
  const headerLabel = weatherSourceMode === "registered"
    ? (registeredWeatherPoint?.name || "登録地点")
    : (currentMunicipalityName || "現在地");
  const modeToggle = (
    <div style={{
      display: "flex", padding: 2, borderRadius: 8,
      background: `rgba(${tokens.ink},0.07)`, flexShrink: 0,
    }}>
      {[{ id: "gps", label: "現在地" }, { id: "registered", label: "登録地点" }].map(opt => (
        <PressableButton
          key={opt.id}
          onClick={() => onChangeWeatherSourceMode(opt.id)}
          style={{
            fontSize: 11.5, fontWeight: 600, padding: "4px 9px", borderRadius: 6, textAlign: "center",
            whiteSpace: "nowrap",
            color: weatherSourceMode === opt.id ? tokens.text : `rgba(${tokens.ink},0.55)`,
            background: weatherSourceMode === opt.id ? (tokens.cardBg || `rgba(${tokens.ink},0.16)`) : "transparent",
          }}
        >
          {opt.label}
        </PressableButton>
      ))}
    </div>
  );
  const headerRow = (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
      padding: "14px 18px 4px",
    }}>
      <span style={{
        fontSize: 13, fontWeight: 600, color: `rgba(${tokens.ink},0.6)`,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {headerLabel}
      </span>
      {modeToggle}
    </div>
  );

  // モードごとの案内・エラー画面(activeWeatherPointがまだ無い場合)。
  let body = null;

  if (weatherSourceMode === "registered" && !registeredWeatherPoint) {
    body = (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "36px 18px" }}>
        <span style={{ fontSize: 14, color: `rgba(${tokens.ink},0.6)`, textAlign: "center" }}>
          地点が登録されていません
        </span>
        <PressableButton
          onClick={onOpenKanaPicker}
          style={{
            fontSize: 13.5, fontWeight: 600, color: "#fff",
            padding: "9px 18px", borderRadius: 999, background: "#0A84FF",
          }}
        >
          地点を登録
        </PressableButton>
      </div>
    );
  } else if (weatherSourceMode === "gps" && geoState.status === "awaiting-consent") {
    // ブラウザに位置情報を要求する前に、何のために・どう使うのかをアプリ内で
    // 説明する画面。ここで「現在地を使う」を選んで初めてgeolocationを呼び出す
    // (=続けてブラウザ自体の許可ダイアログが出る)。誤解を避けるため、送信先や
    // 用途を明記する。
    body = (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "30px 22px" }}>
        <PinIcon size={26}/>
        <span style={{ fontSize: 14.5, fontWeight: 700, color: `rgba(${tokens.ink},0.9)`, textAlign: "center" }}>
          現在地の天気を表示しますか?
        </span>
        <span style={{ fontSize: 12.5, color: `rgba(${tokens.ink},0.6)`, textAlign: "center", lineHeight: 1.7 }}>
          位置情報は天気予報を調べる目的にのみ使用します。開発者のサーバーに送信・保存されることはありません。
          「現在地を使う」を選ぶと、続けてお使いのブラウザの位置情報の確認が表示されます。
          以前ブラウザ側で拒否した場合は、ブラウザのサイト設定から改めて許可してください。
        </span>
        <PressableButton
          onClick={onConsentLocation}
          style={{
            fontSize: 13.5, fontWeight: 600, color: "#fff", textAlign: "center",
            padding: "10px 0", borderRadius: 999, background: "#0A84FF", width: "100%", maxWidth: 240,
          }}
        >
          現在地を使う
        </PressableButton>
      </div>
    );
  } else if (weatherSourceMode === "gps" && geoState.status === "loading") {
    body = (
      <div style={{ padding: "36px 18px", textAlign: "center", fontSize: 14, color: `rgba(${tokens.ink},0.6)` }}>
        現在地を取得中…
      </div>
    );
  } else if (weatherSourceMode === "gps" && geoState.status === "error") {
    body = (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "30px 18px" }}>
        <span style={{ fontSize: 14, color: `rgba(${tokens.ink},0.6)`, textAlign: "center", lineHeight: 1.6 }}>
          現在地を取得できませんでした。ブラウザで位置情報の利用がブロックされているか、取得に失敗しました。
        </span>
        <PressableButton
          onClick={onResetLocationConsent}
          style={{
            fontSize: 13.5, fontWeight: 600, color: `rgba(${tokens.ink},0.7)`,
            padding: "9px 18px", borderRadius: 999, background: `rgba(${tokens.ink},0.08)`,
          }}
        >
          もう一度試す
        </PressableButton>
      </div>
    );
  } else if (weatherSourceMode === "gps" && geoState.status === "unsupported") {
    body = (
      <div style={{ padding: "36px 18px", textAlign: "center", fontSize: 14, color: `rgba(${tokens.ink},0.6)`, lineHeight: 1.6 }}>
        この端末・ブラウザでは現在地を利用できません。上の「登録地点」から地点を登録してください。
      </div>
    );
  } else if (!activeWeatherPoint) {
    body = (
      <div style={{ padding: "36px 18px", textAlign: "center", fontSize: 14, color: `rgba(${tokens.ink},0.6)` }}>
        現在地を取得中…
      </div>
    );
  } else if (forecastState.status === "loading" || forecastState.status === "idle") {
    body = (
      <div style={{ padding: "36px 18px", textAlign: "center", fontSize: 14, color: `rgba(${tokens.ink},0.6)` }}>
        天気予報を取得中…
      </div>
    );
  } else if (forecastState.status === "error") {
    body = (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "30px 18px" }}>
        <span style={{ fontSize: 14, color: `rgba(${tokens.ink},0.6)`, textAlign: "center", lineHeight: 1.6 }}>
          天気予報を取得できませんでした
        </span>
        {weatherSourceMode === "registered" && (
          // 登録地点の予報がどうしても取得できない場合(離島など)でも、
          // ここで行き詰まらず別の地点を登録し直せるようにする。
          <PressableButton
            onClick={onOpenKanaPicker}
            style={{
              fontSize: 13.5, fontWeight: 600, color: "#fff",
              padding: "9px 18px", borderRadius: 999, background: "#0A84FF",
            }}
          >
            別の地点を登録
          </PressableButton>
        )}
      </div>
    );
  } else {
    const f = forecastState.data;
    const daily = f.daily || [];
    const visibleDays = rangeMode === "week" ? daily.slice(0, 7) : daily.slice(0, 3);
    body = (
      <div style={{ padding: "6px 18px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
        {weatherSourceMode === "registered" && (
          <PressableButton
            onClick={onOpenKanaPicker}
            style={{ fontSize: 12, fontWeight: 600, color: `rgba(${tokens.ink},0.55)`, alignSelf: "flex-end" }}
          >
            地点を変更
          </PressableButton>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {f.weatherCode != null && (
            <div style={{
              width: 68, height: 68, borderRadius: 16, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              marginLeft: 6,
            }}>
              <WeatherIcon code={f.weatherCode} size={68} alt=""/>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginLeft: 16 }}>
            <span style={{ fontSize: 19, fontWeight: 700, color: `rgba(${tokens.ink},0.92)` }}>{f.telop || "-"}</span>
            <span style={{ fontSize: 14, color: `rgba(${tokens.ink},0.7)` }}>
              {f.tempMax != null ? `${f.tempMax}°` : "--°"} / {f.tempMin != null ? `${f.tempMin}°` : "--°"}
              {f.pop != null ? `　降水確率 ${f.pop}%` : ""}
            </span>
          </div>
        </div>

        {timeSeriesState.status === "ready" && timeSeriesState.data?.entries?.length > 0 && (
          <>
            <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.12)`, margin: "2px 0" }}/>
            <span style={{ fontSize: 12, fontWeight: 600, color: `rgba(${tokens.ink},0.55)` }}>
              地域時系列予報
            </span>
            <div style={{ display: "flex", overflowX: "auto", gap: 2, marginLeft: -18, marginRight: -18, paddingLeft: 18, paddingRight: 18 }}>
              {timeSeriesState.data.entries.map((e, i) => {
                const prevDate = i > 0 ? timeSeriesState.data.entries[i - 1].dateTime : null;
                const dateChanged = formatTimeSeriesDateChanged(e.dateTime, prevDate);
                return (
                  <div
                    key={e.dateTime || i}
                    style={{
                      display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                      flexShrink: 0, width: 62, padding: "6px 0",
                      borderLeft: dateChanged && i > 0 ? `0.5px solid rgba(${tokens.ink},0.15)` : "none",
                    }}
                  >
                    <span style={{ fontSize: 9.5, color: `rgba(${tokens.ink},0.45)`, height: 12 }}>
                      {dateChanged ? formatForecastDayLabel(e.dateTime, 1).replace(/\(.\)$/, "") : ""}
                    </span>
                    <span style={{ fontSize: 11.5, color: `rgba(${tokens.ink},0.7)` }}>
                      {formatTimeSeriesHour(e.dateTime)}
                    </span>
                    {e.weatherCode != null ? (
                      <div style={{
                        width: 34, height: 34, borderRadius: 9, flexShrink: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        <WeatherIcon code={e.weatherCode} size={34} alt={e.weather || ""}/>
                      </div>
                    ) : (
                      <div style={{ width: 34, height: 34 }}/>
                    )}
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: `rgba(${tokens.ink},0.9)` }}>
                      {e.temperature != null ? `${e.temperature}°` : "--°"}
                    </span>
                    {e.wind && (
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, marginTop: 1 }}>
                        <span
                          aria-hidden="true"
                          style={{
                            fontSize: 17, color: `rgba(${tokens.ink},0.85)`, lineHeight: 1,
                            display: "inline-block", fontWeight: 700,
                            transform: `rotate(${windDirectionToDegrees(e.wind.direction) + 180}deg)`,
                          }}
                        >
                          ↑
                        </span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.8)`, whiteSpace: "nowrap" }}>
                          {e.wind.direction}{e.wind.speed != null ? ` ${e.wind.speed}m` : ""}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {daily.length > 0 && (
          <>
            <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.12)`, margin: "2px 0" }}/>

            {/* 3日間/週間の切り替え。iOS設定アプリ等でよく見る、2択の丸みを帯びた
                セグメントコントロール。 */}
            <div style={{
              display: "flex", padding: 2, borderRadius: 9,
              background: `rgba(${tokens.ink},0.07)`, alignSelf: "flex-start",
            }}>
              {[{ id: "3day", label: "3日間" }, { id: "week", label: "週間" }].map(opt => (
                <PressableButton
                  key={opt.id}
                  onClick={() => setRangeMode(opt.id)}
                  style={{
                    fontSize: 12.5, fontWeight: 600, padding: "5px 14px", borderRadius: 7,
                    color: rangeMode === opt.id ? tokens.text : `rgba(${tokens.ink},0.55)`,
                    background: rangeMode === opt.id ? (tokens.cardBg || `rgba(${tokens.ink},0.16)`) : "transparent",
                  }}
                >
                  {opt.label}
                </PressableButton>
              ))}
            </div>

            <div style={{ display: "flex", flexDirection: "column" }}>
              {visibleDays.map((d, i) => (
                <div key={d.date || i}>
                  {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.1)` }}/>}
                  <div style={{ display: "flex", alignItems: "center", padding: "9px 2px", gap: 10 }}>
                    <span style={{ fontSize: 13.5, color: `rgba(${tokens.ink},0.8)`, width: 56, flexShrink: 0 }}>
                      {formatForecastDayLabel(d.date, i)}
                    </span>
                    {d.weatherCode != null ? (
                      <div style={{
                        width: 36, height: 36, borderRadius: 9, flexShrink: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        <WeatherIcon code={d.weatherCode} size={36} alt=""/>
                      </div>
                    ) : (
                      <div style={{ width: 36, height: 36 }}/>
                    )}
                    <span style={{ fontSize: 12.5, color: `rgba(${tokens.ink},0.55)`, width: 44, flexShrink: 0 }}>
                      {d.pop != null ? `${d.pop}%` : ""}
                    </span>
                    <span style={{ fontSize: 13.5, color: `rgba(${tokens.ink},0.9)`, marginLeft: "auto", textAlign: "right" }}>
                      {d.tempMax != null ? `${d.tempMax}°` : "--°"}
                      {" / "}
                      <span style={{ color: `rgba(${tokens.ink},0.55)` }}>
                        {d.tempMin != null ? `${d.tempMin}°` : "--°"}
                      </span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {f.officeCode && (
          <a
            href={`https://www.jma.go.jp/bosai/forecast/#area_type=offices&area_code=${f.officeCode}`}
            {...(isStandalonePwa ? {} : { target: "_blank", rel: "noopener noreferrer" })}
            style={{
              display: "block", textAlign: "center", padding: "10px 0 0",
              fontSize: 12, fontWeight: 600, color: tokens.accentText || "#0A84FF",
              textDecoration: "none",
            }}
          >
            気象庁の該当ページを開く ↗
          </a>
        )}
        {f.officeCode && (
          <a
            href={`https://www.jma.go.jp/bosai/wdist/timeseries.html#area_type=offices&area_code=${f.officeCode}`}
            {...(isStandalonePwa ? {} : { target: "_blank", rel: "noopener noreferrer" })}
            style={{
              display: "block", textAlign: "center", padding: "2px 0 0",
              fontSize: 12, fontWeight: 600, color: tokens.accentText || "#0A84FF",
              textDecoration: "none",
            }}
          >
            地域時系列予報を見る ↗
          </a>
        )}
      </div>
    );
  }

  return (
    <div>
      {headerRow}
      {body}
    </div>
  );
}


/* ─────────────────────────────────────────────────────
   KANA MUNICIPALITY PICKER — 地点登録の絞り込み選択。
   都道府県(北→南の固定順)→「あかさたなはまやらわ」(行)→選んだ行の段
   (例:あいうえお)→該当する市区町村の一覧、の4ステップで絞り込む。
   テキスト入力は行わない。
   ───────────────────────────────────────────────────── */
function KanaMunicipalityPicker({
  step, onChangeStep, pref, onChangePref, row, onChangeRow, col, onChangeCol,
  grouped, dataReady, loadError, onSelect, onClose,
}) {
  const { tokens } = useContext(ThemeContext);

  const header = (title, onBack) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px 10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {onBack && (
          <PressableButton
            onClick={onBack}
            style={{ fontSize: 15, fontWeight: 600, color: `rgba(${tokens.ink},0.55)`, padding: "2px 4px" }}
          >
            ←
          </PressableButton>
        )}
        <span style={{ fontSize: 14, fontWeight: 600, color: `rgba(${tokens.ink},0.9)` }}>{title}</span>
      </div>
      <PressableButton onClick={onClose} style={{ fontSize: 12.5, fontWeight: 600, color: `rgba(${tokens.ink},0.55)` }}>
        閉じる
      </PressableButton>
    </div>
  );

  // 市区町村一覧そのものの読み込み中/失敗は、どのステップにいても共通で出す
  // (都道府県だけ選んで次に進めない状態を避けるため)。
  if (!dataReady) {
    return (
      <div>
        {header("地点を登録", null)}
        <div style={{ padding: "36px 18px", textAlign: "center", fontSize: 14, color: `rgba(${tokens.ink},0.6)` }}>
          {loadError ? "市区町村一覧の取得に失敗しました" : "読み込み中…"}
        </div>
      </div>
    );
  }

  if (step === "prefectures") {
    return (
      <div style={{ paddingBottom: 8 }}>
        {header("地点を登録", null)}
        <div style={{ display: "flex", flexDirection: "column", maxHeight: 420, overflowY: "auto", padding: "0 18px" }}>
          {PREF_ORDER.map((p, i) => (
            <div key={p}>
              {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.1)` }}/>}
              <PressableButton
                onClick={() => { onChangePref(p); onChangeStep("rows"); }}
                style={{ textAlign: "left", fontSize: 14, color: `rgba(${tokens.ink},0.85)`, padding: "10px 2px", width: "100%" }}
              >
                {p}
              </PressableButton>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (step === "rows") {
    return (
      <div style={{ paddingBottom: 14 }}>
        {header(pref || "地点を登録", () => onChangeStep("prefectures"))}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8,
          padding: "4px 18px 8px",
        }}>
          {KANA_ROWS.map(r => (
            <PressableButton
              key={r.key}
              onClick={() => { onChangeRow(r.key); onChangeStep("columns"); }}
              style={{
                fontSize: 16, fontWeight: 600, color: tokens.text,
                padding: "14px 0", borderRadius: 12, textAlign: "center",
                background: `rgba(${tokens.ink},0.06)`,
              }}
            >
              {r.key}
            </PressableButton>
          ))}
        </div>
      </div>
    );
  }

  const rowDef = KANA_ROWS.find(r => r.key === row) || KANA_ROWS[0];

  if (step === "columns") {
    return (
      <div style={{ paddingBottom: 14 }}>
        {header(`「${row}」から選ぶ`, () => onChangeStep("rows"))}
        <div style={{
          display: "grid", gridTemplateColumns: `repeat(${rowDef.columns.length}, 1fr)`, gap: 8,
          padding: "4px 18px 8px",
        }}>
          {rowDef.columns.map(c => {
            const count = grouped?.[row]?.[c]?.length || 0;
            return (
              <PressableButton
                key={c}
                disabled={count === 0}
                onClick={() => { onChangeCol(c); onChangeStep("list"); }}
                style={{
                  fontSize: 16, fontWeight: 600, color: count === 0 ? `rgba(${tokens.ink},0.28)` : tokens.text,
                  padding: "14px 0", borderRadius: 12, textAlign: "center",
                  background: `rgba(${tokens.ink},0.06)`,
                }}
              >
                {c}
              </PressableButton>
            );
          })}
        </div>
      </div>
    );
  }

  // step === "list"
  const list = grouped?.[row]?.[col] || [];
  return (
    <div style={{ paddingBottom: 8 }}>
      {header(`「${col}」から選ぶ`, () => onChangeStep("columns"))}
      <div style={{ display: "flex", flexDirection: "column", maxHeight: 320, overflowY: "auto", padding: "0 18px" }}>
        {list.map((m, i) => (
          <div key={m.regioncode}>
            {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.1)` }}/>}
            <PressableButton
              onClick={() => onSelect(m)}
              style={{ textAlign: "left", fontSize: 14, color: `rgba(${tokens.ink},0.85)`, padding: "10px 2px", width: "100%" }}
            >
              {m.regionname}
            </PressableButton>
          </div>
        ))}
        {list.length === 0 && (
          <div style={{ fontSize: 13, color: `rgba(${tokens.ink},0.5)`, padding: "16px 2px" }}>
            該当する市区町村がありません
          </div>
        )}
      </div>
    </div>
  );
}

export function BackToListButton({ onClick, label = "地震一覧に戻る" }) {
  const { tokens } = useContext(ThemeContext);
  // ナビ行のガラスハイライトと同じ、"押し込むとガラスが少し膨らむ"演出。
  const [pressed, setPressed] = useState(false);

  return (
    <Glass
      radius={999}
      style={{
        width: 44, height: 44,
        transform: pressed ? "scale(1.16)" : "scale(1)",
        transformOrigin: "center",
        transition: "transform 0.18s cubic-bezier(.22,1,.36,1)",
      }}
    >
      <button
        onClick={onClick}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerCancel={() => setPressed(false)}
        onPointerLeave={() => setPressed(false)}
        aria-label={label}
        style={{
          position: "relative", zIndex: 1,
          width: "100%", height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: tokens.text,
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
             stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 6 9 12 15 18"/>
        </svg>
      </button>
    </Glass>
  );
}
