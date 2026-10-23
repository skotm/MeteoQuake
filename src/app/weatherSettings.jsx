import { useContext } from "react";
import { PressableButton } from "./glass";
import { ThemeContext } from "./theme";
import { SettingsCard, SettingsCardDivider } from "./settingsPrimitives";
import { JMA_NOWCAST_SOURCE_PALETTE, NOWCAST_COLOR_SCHEMES } from "./weather/nowcast";

// 雨雲レーダー配色の一覧選択画面(震度配色ピッカーと全く同じ見た目・作り)。
export function NowcastColorSchemeSettings({ colorSchemeId, onChangeColorScheme }) {
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


export function TyphoonForecastIntervalSettings({ intervalHours, onChangeIntervalHours }) {
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
