import { Fragment, useContext, useEffect } from "react";
import { MAPLIBRE_VERSION, TURF_VERSION } from "./mapDataLoaders";
import { ESTIMATE_MIN_DISPLAY_CONFIDENCE } from "../engines/epicenterConfidence";
import { EMPTY_EQDB_LIST } from "./eqdb";
import { GlassOpaqueContext } from "./glass";
import { ThemeContext } from "./theme";
import { SETTINGS_ITEMS, SETTINGS_MENU, SettingsCard, SettingsCardDivider, SettingsCheckRow, SettingsHeader, SettingsMenuRow, SettingsSegmentRow, SettingsToggleRow, TAB_SETTINGS_CATEGORIES } from "./settingsPrimitives";
import { APP_VERSION } from "./consent";
import { BoundaryLineColorSettings, LicenseFileCard, LogViewerPanel, MapColorSettings, MarkdownFileCard, QuakeColorSchemeSettings, QuakeFetchLimitSettings } from "./settingsPanels";
import { EewTestBroadcastPanel, QuakeTestBroadcastPanel, ShakeDetectionTestPanel, TsunamiTestBroadcastPanel } from "./testPanels";
import { DEFAULT_CAMERA_SETTINGS, CITY_FILL_ZOOM_MIN, CITY_FILL_ZOOM_MAX, CITY_FILL_ZOOM_DEFAULT, clampCityFillZoom } from "./settingsStorage";
import { AmedasRangeSettings, MaxZoomSettings, NowcastColorSchemeSettings, TyphoonForecastIntervalSettings } from "./weatherSettings";



// 設定 → 利用規約等・注意事項 → ライセンス に全文を掲載する、第三者のライセンス(MIT License)。
// 全文は public/licenses/ のテキストを取得して表示する(LicenseFileCard)。追加する時は、
// ここに1件足し、public/licenses/ に全文のテキストを置く。
//   sub  : 設定画面の階層(path)に入る識別子  label: 項目の表示名  file: 全文のファイル
const THIRD_PARTY_MIT_LICENSES = [
  { sub: "mit-eqmonitor", label: "EQMonitor — MIT License 2022 YumNumm", file: "licenses/MIT-EQMonitor.txt" },
  { sub: "mit-kyoshin-monitor-observation-points", label: "kyoshin-monitor-observation-points — MIT License 2025 ingen084", file: "licenses/MIT-KyoshinMonitorObservationPoints.txt" },
  { sub: "mit-kyoshin-eew-viewer-ingen", label: "KyoshinEewViewerIngen — MIT License 2019 ingen084", file: "licenses/MIT-KyoshinEewViewerIngen.txt" },
  { sub: "mit-snet-viewer", label: "S-net_Viewer — MIT License 2022 Ichihai1415", file: "licenses/MIT-SnetViewer.txt" },
];

// ライブラリ(アプリの中で実際に動くソフトウェア)のライセンス。Reactなどは配布物に同梱され、
// MapLibre GL JS・Turf.jsはCDNから実行時に読み込まれる(mapDataLoaders.js)。
// 全文は public/licenses/ にあり、MapLibreの全文はそのバージョンの公式LICENSE.txt。
const LIBRARY_LICENSES = [
  { sub: "lib-react", label: "React / React DOM — MIT License", file: "licenses/MIT-React.txt" },
  { sub: "lib-maplibre", label: `MapLibre GL JS ${MAPLIBRE_VERSION} — BSD 3-Clause License`, file: "licenses/BSD3-MapLibreGL.txt" },
  { sub: "lib-turf", label: `Turf.js ${TURF_VERSION} — MIT License`, file: "licenses/MIT-Turf.txt" },
  { sub: "lib-workbox", label: "Workbox — MIT License", file: "licenses/MIT-Workbox.txt" },
];

export function SettingsBody({
  path, onNavigate, colorSchemeId, onChangeColorScheme,
  nowcastColorSchemeId, onChangeNowcastColorScheme,
  typhoonForecastIntervalHours, onChangeTyphoonForecastIntervalHours,
  maxZoom, onChangeMaxZoom,
  amedasSliderHours, onChangeAmedasSliderHours, amedasChartHours, onChangeAmedasChartHours,
  estIntensityEnabled, onChangeEstIntensityEnabled,
  areaFillEnabled, onChangeAreaFillEnabled,
  cityFillZoom = 7.5, onChangeCityFillZoom = () => {},
  faultsEnabled, onChangeFaultsEnabled,
  plateBoundariesEnabled, onChangePlateBoundariesEnabled,
  epicenterCirclesEnabled, onChangeEpicenterCirclesEnabled,
  boundaryLineColorId, onChangeBoundaryLineColorId,
  mapColorOverrides, onChangeMapColor = () => {}, onResetMapColor = () => {}, onResetAllMapColors = () => {},
  quakeFetchLimit, onChangeQuakeFetchLimit,
  stationListDisplayMode, onChangeStationListDisplayMode,
  experimentalFeaturesEnabled, onChangeExperimentalFeaturesEnabled,
  // realtimeApiToken, onChangeRealtimeApiToken, // 【廃止】APIトークン入力機能廃止に伴いコメントアウト
  replayPlayer,
  realtimeRisingEnabled, onChangeRealtimeRisingEnabled,
  replayJmaColorEnabled, onChangeReplayJmaColorEnabled,
  replayPastQuakesEnabled, onChangeReplayPastQuakesEnabled,
  shakeDetectionEnabled, onChangeShakeDetectionEnabled,
  weakArrayDetectionEnabled, onChangeWeakArrayDetectionEnabled,
  shakeEventCardsEnabled, onChangeShakeEventCardsEnabled,
  longPeriodEnabled, onChangeLongPeriodEnabled,
  quakeSource = "p2p", onChangeQuakeSource = () => {},
  displayInsets, onOpenDisplayAreaEditor,
  tabPlacement, onChangeTabPlacement,
  epicenterEstimationEnabled, onChangeEpicenterEstimationEnabled,
  gridDetectionEnabled = false, onChangeGridDetectionEnabled = () => {}, gridCellsVisible = true, onChangeGridCellsVisible = () => {}, detectedOutlineEnabled = false, onChangeDetectedOutlineEnabled = () => {}, cmtFetchSources = { jma: true, usgs: true }, onChangeCmtFetchSources = () => {},
  showLowConfidenceEstimates, onChangeShowLowConfidenceEstimates,
  cameraSettings = DEFAULT_CAMERA_SETTINGS, onChangeCameraSettings = () => {},
  testTsunami, onBroadcastTestTsunami, onCancelTestTsunami, onClearTestTsunami,
  wolfxTsunamiSampleKey = null, onSelectWolfxTsunamiSample,
  testEews = EMPTY_EQDB_LIST, onTestEewAction,
  eewTestForm, eewEpicenterPickActive,
  testQuakes, onTestQuakeAction, quakeTestForm, quakeEpicenterPickActive, quakeTestAutoPlaying,
  shakeTests, onShakeTestAction, shakeTestForm, shakeTestEpicenterPickActive, shakeTestEewLink,
  epicenterEstimates,
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
      (path[path.length - 1] === "tsunamiTestBroadcast" || path[path.length - 1] === "eewTestBroadcast" || path[path.length - 1] === "quakeTestBroadcast" || path[path.length - 1] === "shakeDetectionTest") &&
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

  // 震度配色(表示設定の項目)の中身
  if (category === "display" && leaf === "colorScheme") {
    return (
      <>
        <SettingsHeader title="震度配色"/>
        <QuakeColorSchemeSettings colorSchemeId={colorSchemeId} onChangeColorScheme={onChangeColorScheme}/>
      </>
    );
  }

  // 地図塗りつぶし(表示設定の項目)の中身。
  // 「細分区域を震度で塗りつぶす」「推計震度分布を表示」の2つのON/OFFをまとめる。
  if (category === "display" && leaf === "mapFill") {
    return (
      <>
        <SettingsHeader title="地図塗りつぶし"/>
        <SettingsCard>
          <SettingsToggleRow
            label="細分区域を震度で塗りつぶす"
            description="観測点の震度をもとに、細分区域単位(拡大すると市区町村単位)で地図を塗り分けます。"
            checked={areaFillEnabled}
            onChange={() => onChangeAreaFillEnabled(!areaFillEnabled)}
          />
          <SettingsCardDivider/>
          <div style={{ padding: "12px 16px 14px", opacity: areaFillEnabled ? 1 : 0.4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 15, fontWeight: 500, color: `rgba(${tokens.ink},0.9)` }}>市区町村塗りに切り替えるズーム</span>
              <span style={{ fontSize: 14, fontVariantNumeric: "tabular-nums", color: `rgba(${tokens.ink},0.6)` }}>{cityFillZoom.toFixed(1)}</span>
            </div>
            {cityFillZoom !== CITY_FILL_ZOOM_DEFAULT && (
              <button
                type="button"
                disabled={!areaFillEnabled}
                onClick={() => onChangeCityFillZoom(CITY_FILL_ZOOM_DEFAULT)}
                style={{ marginTop: 6, padding: "4px 10px", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 12, fontFamily: "inherit",
                  color: `rgba(${tokens.ink},0.7)`, background: `rgba(${tokens.ink},0.08)` }}
              >初期値({CITY_FILL_ZOOM_DEFAULT.toFixed(1)})に戻す</button>
            )}
            <input
              type="range"
              min={CITY_FILL_ZOOM_MIN}
              max={CITY_FILL_ZOOM_MAX}
              step={0.1}
              value={cityFillZoom}
              disabled={!areaFillEnabled}
              onChange={(e) => onChangeCityFillZoom(clampCityFillZoom(e.target.value))}
              style={{ width: "100%", marginTop: 8 }}
            />
            <div style={{ fontSize: 12, lineHeight: 1.6, color: `rgba(${tokens.ink},0.45)`, marginTop: 4 }}>
              地図をこのズーム以上に拡大すると、細分区域の塗りが市区町村ごとの塗りに、短いフェードで切り替わります(観測点のない市区町村は塗りません)。旧震度階級の地震は、常に細分区域単位です。
            </div>
          </div>
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

  // 断層・プレート境界(表示設定の項目)の中身。
  // いずれもファイルサイズが大きいデータのため、初期設定は両方OFF。
  // 縁取り(halo)はライト/ダーク共通の固定色だが、枠内の色はここで選べる。
  // ヘッダー・カードを1つにまとめてコンパクトにし、パネルの高さ「中高」
  // (MIDHIGH_FIXED)だけでスクロールなしに全項目が収まるようにしている。
  if (category === "display" && leaf === "boundaries") {
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

  // 地震情報の取得元(地震カテゴリの項目)の中身。緊急地震速報の取得元は、この設定とは別。
  if (category === "quake" && leaf === "quakeSource") {
    return (
      <>
        <SettingsHeader title="地震情報の取得元"/>
        <SettingsCard>
          <SettingsCheckRow
            label="P2P地震情報"
            description="標準の取得元です。起動時に一覧を取得し、新着はWebSocketで受け取ります。"
            checked={quakeSource === "p2p"}
            onChange={() => onChangeQuakeSource("p2p")}
          />
          <SettingsCardDivider/>
          <SettingsCheckRow
            label="Wolfx Open API"
            description="地震情報を、Wolfxから取得します。長周期地震動階級の表示と同じ通信を使うため、通信を1本にまとめられます。一覧は直近100件までです(取得件数の設定は使いません)。"
            checked={quakeSource === "wolfx"}
            onChange={() => onChangeQuakeSource("wolfx")}
          />
        </SettingsCard>
        <div style={{ padding: "0 16px 8px", fontSize: 11.5, lineHeight: 1.6, color: "#8E8E93" }}>
          緊急地震速報と津波情報は、この設定に関わらず従来どおりです。
        </div>
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

  // 発震機構解(CMT解)の取得先(地震カテゴリの項目)の中身。タップでチェックを付け外しする。
  // どちらもオンが既定。オフにした取得先には通信しない。
  if (category === "quake" && leaf === "cmtFetchSources") {
    return (
      <>
        <SettingsHeader title="発震機構解(CMT解)の取得先"/>
        <SettingsCard>
          <SettingsCheckRow
            label="気象庁(JMA)"
            description="気象庁のCMT解・初動解・遠地地震CMTを取得します。"
            checked={cmtFetchSources.jma}
            onChange={() => onChangeCmtFetchSources({ ...cmtFetchSources, jma: !cmtFetchSources.jma })}
          />
          <SettingsCardDivider/>
          <SettingsCheckRow
            label="USGS"
            description="USGSのモーメントテンソル解を取得します。両方にチェックがある場合、両方に解がある地震では、詳細画面で表示する方を切り替えられます。"
            checked={cmtFetchSources.usgs}
            onChange={() => onChangeCmtFetchSources({ ...cmtFetchSources, usgs: !cmtFetchSources.usgs })}
          />
        </SettingsCard>
        {!cmtFetchSources.jma && !cmtFetchSources.usgs && (
          <div style={{ padding: "0 16px 8px", fontSize: 11.5, color: "#FF9F0A", lineHeight: 1.6 }}>
            どちらのチェックも外れている間は、発震機構解を取得せず、地震の詳細に発震機構解のボタンも出しません。
          </div>
        )}
      </>
    );
  }

  // 雨雲レーダー配色(表示設定の項目)の中身
  if (category === "display" && leaf === "nowcastColorScheme") {
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

  // 台風予報円の表示間隔(表示設定の項目)の中身
  if (category === "display" && leaf === "typhoonForecastInterval") {
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

  // 地図の最大ズームレベル
  if (category === "display" && leaf === "maxZoom") {
    return (
      <>
        <SettingsHeader title="最大ズームレベル"/>
        <MaxZoomSettings value={maxZoom} onChange={onChangeMaxZoom}/>
      </>
    );
  }

  // アメダスの取得時間の範囲
  if (category === "display" && leaf === "amedasRange") {
    return (
      <>
        <SettingsHeader title="アメダスの取得時間"/>
        <AmedasRangeSettings
          sliderHours={amedasSliderHours} onChangeSliderHours={onChangeAmedasSliderHours}
          chartHours={amedasChartHours} onChangeChartHours={onChangeAmedasChartHours}
        />
      </>
    );
  }

  // 表示設定(トップ階層のカテゴリ)。地図・地震・気象の「見た目」に関する設定への入口を
  // まとめている。各項目の画面の中身は、以前の置き場所(地震・気象・詳細設定)から
  // そのまま移したもの(保存する値も同じ)。
  if (category === "display" && !leaf) {
    const captionStyle = { margin: "16px 14px 6px", fontSize: 12.5, fontWeight: 700, color: `rgba(${tokens.ink},0.7)` };
    return (
      <>
        <SettingsHeader title="表示設定"/>
        <SettingsCard>
          <SettingsMenuRow label="外観" onClick={() => onNavigate([...path, "appearance"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="最大ズームレベル" onClick={() => onNavigate([...path, "maxZoom"])}/>
        </SettingsCard>

        <div style={captionStyle}>地図</div>
        <SettingsCard>
          <SettingsMenuRow label="地図の色" onClick={() => onNavigate([...path, "mapColors"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="断層・プレート境界" onClick={() => onNavigate([...path, "boundaries"])}/>
        </SettingsCard>

        <div style={captionStyle}>地震</div>
        <SettingsCard>
          <SettingsMenuRow label="震度配色" onClick={() => onNavigate([...path, "colorScheme"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="地図塗りつぶし" onClick={() => onNavigate([...path, "mapFill"])}/>
          <SettingsCardDivider/>
          <SettingsToggleRow
            label="震央分布を表示"
            description="近傍/データベース検索の地震一覧を開いた時、地図上に震央の丸を表示します。震度が大きい地震ほど上に重なって表示されます。"
            checked={epicenterCirclesEnabled}
            onChange={() => onChangeEpicenterCirclesEnabled(!epicenterCirclesEnabled)}
          />
          <SettingsCardDivider/>
          <SettingsCardDivider/>
          <SettingsToggleRow
            label="長周期地震動階級を表示"
            description="気象庁が発表した長周期地震動階級を、地震の一覧(震度バッジの右上)と詳細に表示します。データはWolfx Open APIから取得します。観測情報は地震の約10分後に発表されるため、少し遅れて表示されます(初期設定はオン)。"
            checked={longPeriodEnabled}
            onChange={() => onChangeLongPeriodEnabled(!longPeriodEnabled)}
          />
        </SettingsCard>

        <div style={captionStyle}>気象</div>
        <SettingsCard>
          <SettingsMenuRow label="雨雲レーダー配色" onClick={() => onNavigate([...path, "nowcastColorScheme"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="台風予報円の表示間隔" onClick={() => onNavigate([...path, "typhoonForecastInterval"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="アメダスの取得時間" onClick={() => onNavigate([...path, "amedasRange"])}/>
        </SettingsCard>
      </>
    );
  }

  // 地震カテゴリのトップ(取得件数・リアルタイム・リプレイ・カメラの動きへの入口)。
  // 震度配色・地図塗りつぶし・断層・プレート境界・震央分布・各地の震度の表示方法は、
  // 「表示設定」(トップ階層)に移した。
  // 他のカテゴリと違い項目を専用に組み立てているため、汎用のitems一覧ループとは別扱いにする。
  if (category === "quake" && !leaf) {
    return (
      <>
        <SettingsHeader title="地震"/>
        <SettingsCard>
          <SettingsMenuRow label="地震情報の取得元" onClick={() => onNavigate([...path, "quakeSource"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="取得件数" onClick={() => onNavigate([...path, "fetchLimit"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="発震機構解(CMT解)の取得先" onClick={() => onNavigate([...path, "cmtFetchSources"])}/>
        </SettingsCard>
        {/* 地震タブのフローティングバー左端「リアルタイム」まわりの設定(旧リアルタイムタブ・詳細設定から移動) */}
        <SettingsCard>
          <SettingsMenuRow label="リアルタイム" onClick={() => onNavigate([...path, "realtime"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="リプレイ" onClick={() => onNavigate([...path, "replay"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="カメラの動き" onClick={() => onNavigate([...path, "camera"])}/>
        </SettingsCard>
      </>
    );
  }

  // リアルタイムカテゴリのトップ(強震モニタ/S-netの表示レイヤー設定への入口)。
  // 地震カテゴリと同じく、項目を専用に組み立てているため汎用のitems一覧ループとは別扱いにする。
  if (category === "quake" && leaf === "realtime") {
    return (
      <>
        <SettingsHeader title="リアルタイム"/>
        <SettingsCard>
          <SettingsToggleRow
            label="地震検知"
            description="観測点の震度データから揺れを自動検知し、地図上への表示と、地震タブのバー「リアルタイム」への一覧表示を行います。"
            checked={shakeDetectionEnabled}
            onChange={() => onChangeShakeDetectionEnabled(!shakeDetectionEnabled)}
          />
          {shakeDetectionEnabled && (
            <>
              <SettingsSegmentRow
                label="検知方式(実験的機能)"
                description="揺れの検知方式を選びます。「個別観測点検知」は従来の方式です。「グリッド検知」は、地図を緯度経度のセルに分けてセルごとに検知する方式で、同じ時期に離れた場所で起きた地震を別々に検知しやすくなります。グリッド検知では、震源推定もグリッド検知の結果に対してのみ行います。"
                value={gridDetectionEnabled ? "grid" : "station"}
                options={[{ value: "station", label: "個別観測点検知" }, { value: "grid", label: "グリッド検知" }]}
                onChange={(v) => onChangeGridDetectionEnabled(v === "grid")}
              />
              {!gridDetectionEnabled && (
                <SettingsToggleRow
                  label="検知観測点を黒縁で強調"
                  description="個別観測点検知で、揺れを検知した観測点を、太い黒の縁取りで強調します。オフにすると、縁取りは付けず、他の観測点と同じ表示になります。"
                  checked={detectedOutlineEnabled}
                  onChange={() => onChangeDetectedOutlineEnabled(!detectedOutlineEnabled)}
                />
              )}
              {gridDetectionEnabled && (
                <SettingsToggleRow
                  label="グリッドの枠を表示"
                  description="検知が起きたセルの枠を、地図上に表示します。検知が起きていない間は表示しません。"
                  checked={gridCellsVisible}
                  onChange={() => onChangeGridCellsVisible(!gridCellsVisible)}
                />
              )}
              <SettingsToggleRow
                label="揺れ検出情報をフローティングに表示"
                description="揺れ検知で検出した地震の情報を、画面下のフローティングにカードとして表示します。オフにしても、地図上の検知表示や検知そのものは止まりません(初期設定はオン)。"
                checked={shakeEventCardsEnabled}
                onChange={() => onChangeShakeEventCardsEnabled(!shakeEventCardsEnabled)}
              />
              <SettingsToggleRow
                label="微弱な揺れの検知(実験的機能)"
                description="震度0未満〜0付近の、ごく弱い揺れ(沖合の無感地震など)を、複数の観測点がP波の伝わる順序で上昇したことから検知します。誤検知が気になる場合は、オフにしてください。"
                checked={weakArrayDetectionEnabled}
                onChange={() => onChangeWeakArrayDetectionEnabled(!weakArrayDetectionEnabled)}
              />
              <SettingsToggleRow
                label="震源推定(実験的機能)"
                description="緊急地震速報が出ない小さな地震でも、地震検知の結果から震央のおおよその位置を推定して地図上に表示します。検知点数が少ないうちは精度が低く、位置が大きくぶれることがあります。"
                checked={epicenterEstimationEnabled}
                onChange={() => onChangeEpicenterEstimationEnabled(!epicenterEstimationEnabled)}
              />
              {epicenterEstimationEnabled && (
                <SettingsToggleRow
                  label="信頼度の低い推定を表示"
                  description={`震源推定の信頼度(推定Mの右に表示される0.00〜1.00の数値)が${ESTIMATE_MIN_DISPLAY_CONFIDENCE.toFixed(2)}未満の推定も表示します。オフの間は、${ESTIMATE_MIN_DISPLAY_CONFIDENCE.toFixed(2)}未満の推定を表示しません。`}
                  checked={showLowConfidenceEstimates}
                  onChange={() => onChangeShowLowConfidenceEstimates(!showLowConfidenceEstimates)}
                />
              )}
            </>
          )}
          <SettingsToggleRow
            label="震度上昇中を表示"
            description="強震モニタの観測点のうち、前回の更新時点より震度が上昇した観測点を黄色、それ以外を震度-3相当の青色で表示します。"
            checked={realtimeRisingEnabled}
            onChange={() => onChangeRealtimeRisingEnabled(!realtimeRisingEnabled)}
          />
        </SettingsCard>
      </>
    );
  }

  // 【廃止】APIトークン入力機能を廃止したため、この設定画面自体をコメント
  // アウトしている(設定メニュー側の項目も併せてコメントアウト済み)。
  // 復元する場合は、このブロックと設定メニュー項目・状態管理・propsの
  // バケツリレー箇所を全てコメント解除すること。
  /*
  // リアルタイムタブ(強震モニタ/S-net)配信APIのアクセストークン設定。
  // 「外観」と同じ実装パターン(SettingsCard内にコントロールを1つ置く形)。
  if (category === "advanced" && leaf === "realtimeApi") {
    return (
      <>
        <SettingsHeader title="リアルタイムAPI"/>
        <SettingsCard>
          <div style={{ padding: "14px 16px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: `rgba(${tokens.ink},0.85)`, marginBottom: 6 }}>
              アクセストークン
            </div>
            <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.55)`, marginBottom: 10, lineHeight: 1.5 }}>
              強震モニタ・S-netのリアルタイム震度配信サーバーへの接続に使うトークンです。
              このアプリは公開配信されるため、ここに入力したトークンは秘匿情報として扱われません(無差別アクセスを防ぐための簡易フィルタです)。
            </div>
            <input
              type="text"
              value={realtimeApiToken}
              onChange={(e) => onChangeRealtimeApiToken(e.target.value)}
              placeholder="トークンを入力"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "10px 12px",
                fontSize: 14,
                borderRadius: 10,
                border: `1px solid rgba(${tokens.ink},0.15)`,
                background: `rgba(${tokens.ink},0.04)`,
                color: `rgba(${tokens.ink},0.9)`,
                outline: "none",
              }}
            />
          </div>
        </SettingsCard>
      </>
    );
  }
  */

  // リプレイファイル(バックフィルサーバーで生成した過去データ)の読み込み・
  // 再生コントロール。「リアルタイムAPI」と同じ実装パターン。
  if (category === "quake" && leaf === "replay") {
    const handleFileChange = (e) => {
      const file = e.target.files?.[0];
      if (file) replayPlayer.loadFile(file);
      e.target.value = "";
    };

    const handleEewFileChange = (e) => {
      const files = [...(e.target.files ?? [])];
      if (files.length > 0) replayPlayer.loadEewFiles(files);
      e.target.value = "";
    };
    const pickerLabelStyle = {
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "9px 14px", borderRadius: 10,
      border: `1px solid rgba(${tokens.ink},0.15)`,
      background: `rgba(${tokens.ink},0.04)`,
      fontSize: 13, color: `rgba(${tokens.ink},0.85)`, cursor: "pointer",
    };
    const titleStyle = { fontSize: 13, fontWeight: 600, color: `rgba(${tokens.ink},0.85)`, marginBottom: 6 };
    const descStyle = { fontSize: 12, color: `rgba(${tokens.ink},0.55)`, marginBottom: 10, lineHeight: 1.5 };
    const fileRowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
    const fileNameStyle = { fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 };
    const linkButtonStyle = { background: "none", border: "none", cursor: "pointer", fontSize: 13, color: `rgba(${tokens.ink},0.5)`, padding: 0, flex: "none" };
    const eewEntries = replayPlayer.eews;

    return (
      <>
        <SettingsHeader title="リプレイ"/>
        <SettingsCard>
          <div style={{ padding: "14px 16px" }}>
            <div style={titleStyle}>リプレイファイル(震度)</div>
            <div style={descStyle}>
              バックフィルサーバーで生成した過去データのファイル(.bin)を読み込むと、
              地震タブの地図(バー「リアルタイム」)で過去の揺れを再生できます。
            </div>
            {!replayPlayer.hasBin ? (
              <label style={pickerLabelStyle}>
                ファイルを選択
                <input type="file" accept=".bin" onChange={handleFileChange} style={{ display: "none" }}/>
              </label>
            ) : (
              <div style={fileRowStyle}>
                <span style={fileNameStyle}>{replayPlayer.fileName}</span>
                <button onClick={replayPlayer.closeBin} style={linkButtonStyle}>閉じる</button>
              </div>
            )}
          </div>
        </SettingsCard>

        <SettingsCard>
          <div style={{ padding: "14px 16px" }}>
            <div style={titleStyle}>緊急地震速報(EEW)ファイル</div>
            <div style={descStyle}>
              JmaEewParserで作成したEEWのファイル(.eew.json)を読み込むと、再生時刻に合わせて緊急地震速報が表示されます。
              複数のファイルを読み込めます。震度のファイルと一緒に読み込むと、その再生時間内の地震のEEWが、それぞれの時刻に表示されます(時間外のものは表示されません)。EEWだけでも再生できます。EEWを読み込んでいる間は、リアルタイムの緊急地震速報は表示しません。
            </div>
            {eewEntries.map((entry) => {
              const eew = entry.data;
              const eewFinal = eew.reports[eew.reports.length - 1];
              return (
                <div key={entry.id} style={{ marginBottom: 12 }}>
                  <div style={fileRowStyle}>
                    <span style={fileNameStyle}>{entry.fileName}</span>
                    <button onClick={() => replayPlayer.removeEew(entry.id)} style={linkButtonStyle}>外す</button>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.5 }}>
                    {eew.hypocenterName || "震源地不明"}{eewFinal.hypocenter.magnitude != null ? ` M${eewFinal.hypocenter.magnitude}` : ""}{eewFinal.isCancel ? "(キャンセル報で終了)" : ""}
                    {" ・ "}{eew.reports.length}報(第{eewFinal.serial}報まで)
                    {" ・ "}{new Date(eew.originTimeMs).toLocaleString("ja-JP", { hour12: false, timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}頃
                  </div>
                  {entry.note && (
                    <div style={{ marginTop: 6, fontSize: 12, color: "#FF9F0A", lineHeight: 1.5 }}>{entry.note}</div>
                  )}
                  {eew.warnings.length > 0 && (
                    <div style={{ marginTop: 6, fontSize: 12, color: "#FF9F0A", lineHeight: 1.5 }}>
                      ファイル作成時の注意: {eew.warnings.join(" / ")}
                    </div>
                  )}
                </div>
              );
            })}
            {eewEntries.length > 0 && !replayPlayer.hasBin && (
              <div style={{ marginBottom: 12, fontSize: 12, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.5 }}>
                震度のファイルが無いため、EEWだけを再生します(観測点の揺れは表示されません)。
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <label style={pickerLabelStyle}>
                {eewEntries.length === 0 ? "ファイルを選択(複数可)" : "EEWを追加"}
                <input type="file" multiple accept=".json,application/json" onChange={handleEewFileChange} style={{ display: "none" }}/>
              </label>
              {eewEntries.length > 1 && (
                <button onClick={replayPlayer.clearEew} style={linkButtonStyle}>すべて外す</button>
              )}
            </div>
          </div>
        </SettingsCard>

        {replayPlayer.loaded && (
          <SettingsCard>
            <div style={{ padding: "14px 16px" }}>
              <div style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", color: `rgba(${tokens.ink},0.55)`, marginBottom: 8 }}>
                {replayPlayer.frames[replayPlayer.currentIndex]
                  ? replayPlayer.frames[replayPlayer.currentIndex].dataTime.toLocaleString("ja-JP", { hour12: false })
                  : "--"}
                {"  ("}{replayPlayer.currentIndex + 1}/{replayPlayer.frames.length}{")"}
              </div>

              <input
                type="range"
                min={0}
                max={Math.max(0, replayPlayer.frames.length - 1)}
                value={replayPlayer.currentIndex}
                onChange={(e) => replayPlayer.seek(Number(e.target.value))}
                style={{ width: "100%", marginBottom: 10 }}
              />

              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  onClick={replayPlayer.isPlaying ? replayPlayer.pause : replayPlayer.play}
                  style={{
                    background: `rgba(${tokens.ink},0.08)`, border: "none", borderRadius: 8,
                    padding: "6px 14px", fontSize: 13, cursor: "pointer", color: `rgba(${tokens.ink},0.85)`,
                  }}
                >
                  {replayPlayer.isPlaying ? "⏸ 一時停止" : "▶ 再生"}
                </button>
                <select
                  value={replayPlayer.speed}
                  onChange={(e) => replayPlayer.setSpeed(Number(e.target.value))}
                  style={{
                    background: `rgba(${tokens.ink},0.08)`, border: "none", borderRadius: 8,
                    padding: "6px 8px", fontSize: 13, color: `rgba(${tokens.ink},0.85)`,
                    // PCブラウザのネイティブポップアップの配色をモードに合わせる
                    // (無いとダークモードで文字が背景に埋もれて読めない)。
                    colorScheme: themeMode === "dark" ? "dark" : "light",
                  }}
                >
                  <option value={1}>1倍速</option>
                  <option value={2}>2倍速</option>
                  <option value={4}>4倍速</option>
                </select>
              </div>
            </div>
          </SettingsCard>
        )}

        {replayPlayer.error && (
          <div style={{ padding: "0 16px 8px", fontSize: 12, color: "#FF453A", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{replayPlayer.error}</div>
        )}

        {/* 観測点の色を気象庁震度階級に換算して表示する設定。震度ファイル(.bin)を
            読み込んだ時のみ意味を持つため、その間だけ表示する。 */}
        {replayPlayer.hasBin && (
          <SettingsCard>
            <SettingsToggleRow
              label="震度階級で表示"
              description="観測点の色を、強震モニタ本来の連続配色ではなく気象庁の震度階級に換算して表示します。震度1以上は地震情報の観測点マーカーと同じアイコン(設定中の震度配色に対応)、震度0(計測震度-1.0〜0.4)は透明→薄いグレー→グレーの段階で表示し、震度0の中での揺れの強さの違いも見えるようにしています。計測震度-1.0未満の観測点は表示しません。"
              checked={replayJmaColorEnabled}
              onChange={() => onChangeReplayJmaColorEnabled(!replayJmaColorEnabled)}
            />
          </SettingsCard>
        )}
        {replayPlayer.hasBin && (
          <SettingsCard>
            <SettingsToggleRow
              label="リプレイ時刻の地震情報を再現"
              description="地震タブの一覧を、リプレイ時刻にMeteoQuakeを開いていた場合の並びにします。リプレイ開始の7日前〜終了の地震を取得し(P2P地震情報、無ければ気象庁 震度データベース)、リプレイ時間内の地震は、震度に関わらず発生の3分30秒後に詳細の地震情報だけを出します。"
              checked={replayPastQuakesEnabled}
              onChange={() => onChangeReplayPastQuakesEnabled(!replayPastQuakesEnabled)}
            />
          </SettingsCard>
        )}
      </>
    );
  }

  // 外観(表示設定の項目)の中身。
  // 「デバイスの設定に合わせる」が初期設定(ON)で、端末のライト/ダーク設定に
  // 自動追従する。OFFにした場合のみ、ライト/ダークを手動で選べる。
  // ここではUIチューム(背景・カード・文字色など)の基礎トークンだけを
  // 切り替えており、地図の基本配色や震度配色スキームは対象外
  // (別途テーマ対応が必要)。
  if (category === "display" && leaf === "appearance") {
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
        <SettingsCard>
          <SettingsToggleRow
            label="タブボタンをフローティングの右上に配置"
            description="地震・津波・気象・警報・設定のタブを、スライド式のナビの代わりに、フローティングの外側(右上)にアイコンボタンとして表示します(横画面は縦並び、縦画面は横並び)。オフのときは従来のスライド式です(初期設定はオフ)。"
            checked={tabPlacement === "corner"}
            onChange={() => onChangeTabPlacement(tabPlacement === "corner" ? "slide" : "corner")}
          />
        </SettingsCard>
        <SettingsCard>
          <div style={{ padding: "12px 16px" }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>表示領域</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.6, opacity: 0.7, marginBottom: 10 }}>
              デバイスの画面内にアプリを表示する領域を、ピンチ操作で変えられます(初期設定は全画面)。
              {displayInsets && (displayInsets.top || displayInsets.right || displayInsets.bottom || displayInsets.left)
                ? ` 現在の余白: 上${displayInsets.top} 下${displayInsets.bottom} 左${displayInsets.left} 右${displayInsets.right}`
                : " 現在: 全画面"}
            </div>
            <button
              onClick={onOpenDisplayAreaEditor}
              style={{ font: "inherit", fontSize: 14, fontWeight: 600, padding: "9px 16px", borderRadius: 10, border: "none", background: "#0A84FF", color: "#fff", cursor: "pointer" }}
            >表示領域を調整</button>
          </div>
        </SettingsCard>
      </>
    );
  }

  // 地図の色(表示設定の項目)。海・陸・都道府県の境界線・国境線の色を、ライト/ダーク別に変える。
  if (category === "display" && leaf === "mapColors") {
    return (
      <>
        <SettingsHeader title="地図の色"/>
        <MapColorSettings
          overrides={mapColorOverrides}
          onChange={onChangeMapColor}
          onResetItem={onResetMapColor}
          onResetAll={onResetAllMapColors}
        />
      </>
    );
  }

  // カメラの動き(詳細設定の項目)。緊急地震速報・揺れ検知での地図の自動ズームの設定。
  if (category === "quake" && leaf === "camera") {
    const cs = cameraSettings;
    return (
      <>
        <SettingsHeader title="カメラの動き"/>
        <SettingsCard>
          <SettingsToggleRow
            label="緊急地震速報で震源へ移動"
            description="緊急地震速報の第一報(アプリを開いた時点で既に発表されていた速報を含む)で、震源が画面に収まるように地図を動かします。続報では動かしません(初期設定はオン)。"
            checked={cs.eewFocus}
            onChange={() => onChangeCameraSettings({ eewFocus: !cs.eewFocus })}
          />
        </SettingsCard>
        <SettingsCard>
          <SettingsToggleRow
            label="揺れ検知で観測点に合わせて移動"
            description="揺れを検知したら、検知した観測点が画面に収まるように地図を動かします。観測点が増えて画面の端からはみ出しそうになったら、ズームを調整します(初期設定はオン)。"
            checked={cs.shakeFollow}
            onChange={() => onChangeCameraSettings({ shakeFollow: !cs.shakeFollow })}
          />
          <SettingsCardDivider/>
          <SettingsToggleRow
            label="操作後に自動ズームを再開"
            description="地図を自分で動かしても、2秒間操作がなければ、揺れ検知の自動ズームを再開します。オフの時は、動かした後その揺れ検知では自動で動かしません(初期設定はオン)。"
            checked={cs.autoResume}
            onChange={() => onChangeCameraSettings({ autoResume: !cs.autoResume })}
            disabled={!cs.shakeFollow}
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
            <SettingsCardDivider/>
            <SettingsMenuRow
              label="地震検知テスト"
              onClick={() => onNavigate([...path, "shakeDetectionTest"])}
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
          wolfxSampleKey={wolfxTsunamiSampleKey}
          onSelectWolfxSample={onSelectWolfxTsunamiSample}
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
          testQuakes={testQuakes}
          onAction={onTestQuakeAction}
          quakeTestForm={quakeTestForm}
          quakeEpicenterPickActive={quakeEpicenterPickActive}
          quakeTestAutoPlaying={quakeTestAutoPlaying}
        />
      </>
    );
  }

  // 実験的機能: 地震検知テスト。
  if (category === "advanced" && leaf === "experimental" && sub === "shakeDetectionTest") {
    if (!experimentalFeaturesEnabled) return null;
    return (
      <>
        <SettingsHeader title="地震検知テスト"/>
        <ShakeDetectionTestPanel
          shakeTests={shakeTests}
          onAction={onShakeTestAction}
          shakeTestForm={shakeTestForm}
          shakeTestEpicenterPickActive={shakeTestEpicenterPickActive}
          shakeTestEewLink={shakeTestEewLink}
          epicenterEstimates={epicenterEstimates}
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
              UIデザインの参考
            </div>
            EQMonitor(YumNumm氏)
          </div>
          <SettingsCardDivider/>
          <div style={{ padding: "14px 14px", fontSize: 12, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.8, textAlign: "left" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: tokens.text, marginBottom: 4 }}>
              プログラムの参考
            </div>
            KyoshinEewViewerIngen(ingen084氏) / S-net_Viewer(Ichihai1415氏)
          </div>
          <SettingsCardDivider/>
          <div style={{ padding: "14px 14px", fontSize: 12, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.8, textAlign: "left" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: tokens.text, marginBottom: 4 }}>
              観測点データ
            </div>
            kyoshin-monitor-observation-points(ingen084氏)
          </div>
          <SettingsCardDivider/>
          <div style={{ padding: "14px 14px", fontSize: 12, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.8, textAlign: "left" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: tokens.text, marginBottom: 4 }}>
              オープンソースソフトウェア
            </div>
            React / React DOM / MapLibre GL JS / Turf.js / Workbox
            <div style={{ marginTop: 4 }}>
              ライセンスの全文は下の項目から確認できます。フォントの配信には Fontsource のパッケージを利用しています(フォントのライセンスは下の「フォント」を参照)。
            </div>
          </div>
          <SettingsCardDivider/>
          <div style={{ padding: "14px 14px", fontSize: 12, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.8, textAlign: "left" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: tokens.text, marginBottom: 4 }}>
              フォント
            </div>
            Noto Sans JP(日本語) / Inter(数字・英字)
            <div style={{ marginTop: 4 }}>
              どちらも SIL Open Font License 1.1 で配布されているフォントを、アプリに同梱して使用しています。
              ライセンスの全文は下の項目から確認できます。
            </div>
          </div>
        </SettingsCard>
        <SettingsCard>
          <SettingsMenuRow label="MIT License 2026 skotm" onClick={() => onNavigate([...path, "mit"])}/>
          {THIRD_PARTY_MIT_LICENSES.map(lic => (
            <Fragment key={lic.sub}>
              <SettingsCardDivider/>
              <SettingsMenuRow label={lic.label} onClick={() => onNavigate([...path, lic.sub])}/>
            </Fragment>
          ))}
        </SettingsCard>
        <SettingsCard>
          {LIBRARY_LICENSES.map((lic, i) => (
            <Fragment key={lic.sub}>
              {i > 0 && <SettingsCardDivider/>}
              <SettingsMenuRow label={lic.label} onClick={() => onNavigate([...path, lic.sub])}/>
            </Fragment>
          ))}
        </SettingsCard>
        <SettingsCard>
          <SettingsMenuRow label="Noto Sans JP — SIL Open Font License 1.1" onClick={() => onNavigate([...path, "ofl-noto-sans-jp"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="Inter — SIL Open Font License 1.1" onClick={() => onNavigate([...path, "ofl-inter"])}/>
        </SettingsCard>
      </>
    );
  }

  // 第三者のライセンス全文(THIRD_PARTY_MIT_LICENSES・LIBRARY_LICENSESの各項目)。
  if (category === "terms" && leaf === "license" && sub) {
    const lic = THIRD_PARTY_MIT_LICENSES.find(l => l.sub === sub) || LIBRARY_LICENSES.find(l => l.sub === sub);
    if (lic) {
      return (
        <>
          <SettingsHeader title={lic.label}/>
          <LicenseFileCard fileName={lic.file}/>
        </>
      );
    }
  }

  // フォントのライセンス全文(MITライセンスと同じく、ライセンス項目のさらに下の階層)。
  // 全文は public/licenses/ のテキストを取得して表示する(Service Workerが事前キャッシュ)。
  if (category === "terms" && leaf === "license" && sub === "ofl-noto-sans-jp") {
    return (
      <>
        <SettingsHeader title="Noto Sans JP — SIL Open Font License 1.1"/>
        <LicenseFileCard fileName="licenses/OFL-NotoSansJP.txt"/>
      </>
    );
  }
  if (category === "terms" && leaf === "license" && sub === "ofl-inter") {
    return (
      <>
        <SettingsHeader title="Inter — SIL Open Font License 1.1"/>
        <LicenseFileCard fileName="licenses/OFL-Inter.txt"/>
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
