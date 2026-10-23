import { useContext, useEffect } from "react";
import { ESTIMATE_MIN_DISPLAY_CONFIDENCE } from "../epicenterConfidence";
import { EMPTY_EQDB_LIST } from "./eqdb";
import { GlassOpaqueContext } from "./glass";
import { ThemeContext } from "./theme";
import { SETTINGS_ITEMS, SETTINGS_MENU, SettingsCard, SettingsCardDivider, SettingsHeader, SettingsMenuRow, SettingsSegmentRow, SettingsToggleRow, TAB_SETTINGS_CATEGORIES } from "./settingsPrimitives";
import { APP_VERSION } from "./consent";
import { BoundaryLineColorSettings, LicenseFileCard, LogViewerPanel, MarkdownFileCard, QuakeColorSchemeSettings, QuakeFetchLimitSettings, StationListDisplayModeSettings } from "./settingsPanels";
import { EewTestBroadcastPanel, QuakeTestBroadcastPanel, ShakeDetectionTestPanel, TsunamiTestBroadcastPanel } from "./testPanels";
import { DEFAULT_CAMERA_SETTINGS } from "./settingsStorage";
import { NowcastColorSchemeSettings, TyphoonForecastIntervalSettings } from "./weatherSettings";



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
  // realtimeApiToken, onChangeRealtimeApiToken, // 【廃止】APIトークン入力機能廃止に伴いコメントアウト
  replayPlayer,
  realtimeRisingEnabled, onChangeRealtimeRisingEnabled,
  replayJmaColorEnabled, onChangeReplayJmaColorEnabled,
  shakeDetectionEnabled, onChangeShakeDetectionEnabled,
  weakArrayDetectionEnabled, onChangeWeakArrayDetectionEnabled,
  epicenterEstimationEnabled, onChangeEpicenterEstimationEnabled,
  gridDetectionEnabled = false, onChangeGridDetectionEnabled = () => {}, gridCellsVisible = true, onChangeGridCellsVisible = () => {},
  showLowConfidenceEstimates, onChangeShowLowConfidenceEstimates,
  cameraSettings = DEFAULT_CAMERA_SETTINGS, onChangeCameraSettings = () => {},
  testTsunami, onBroadcastTestTsunami, onCancelTestTsunami, onClearTestTsunami,
  testEews = EMPTY_EQDB_LIST, onTestEewAction,
  eewTestForm, eewEpicenterPickActive,
  testQuake, onTestQuakeAction, quakeTestForm, quakeEpicenterPickActive, quakeTestAutoPlaying,
  shakeTests, onShakeTestAction, shakeTestForm, shakeTestEpicenterPickActive,
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

  // 震度配色(地震カテゴリの項目)の中身
  if (category === "quake" && leaf === "colorScheme") {
    return (
      <>
        <SettingsHeader title="震度配色"/>
        <QuakeColorSchemeSettings colorSchemeId={colorSchemeId} onChangeColorScheme={onChangeColorScheme}/>
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
              {gridDetectionEnabled && (
                <SettingsToggleRow
                  label="グリッドの枠を表示"
                  description="検知が起きたセルの枠を、地図上に表示します。検知が起きていない間は表示しません。"
                  checked={gridCellsVisible}
                  onChange={() => onChangeGridCellsVisible(!gridCellsVisible)}
                />
              )}
              <SettingsToggleRow
                label="微弱な揺れの検知(実験的機能)"
                description="震度0未満〜0付近の、ごく弱い揺れ(沖合の無感地震など)を、複数の観測点がP波の伝わる順序で上昇したことから検知します。誤検知が気になる場合は、オフにしてください。"
                checked={weakArrayDetectionEnabled}
                onChange={() => onChangeWeakArrayDetectionEnabled(!weakArrayDetectionEnabled)}
              />
              <SettingsToggleRow
                label="震源推定(実験的機能)"
                description="緊急地震速報が出ない小さな地震でも、地震検知の結果から震央のおおよその位置を推定して地図上に表示します。検知点数が少ないうちは精度が低く、位置が大きくぶれることがあります。(現在、一時的に利用できません)"
                checked={false}
                disabled
                onChange={() => {}}
              />
              {false && epicenterEstimationEnabled && (
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

    return (
      <>
        <SettingsHeader title="リプレイ"/>
        <SettingsCard>
          <div style={{ padding: "14px 16px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: `rgba(${tokens.ink},0.85)`, marginBottom: 6 }}>
              リプレイファイル
            </div>
            <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.55)`, marginBottom: 10, lineHeight: 1.5 }}>
              バックフィルサーバーで生成した過去データのファイル(.bin)を読み込むと、
              地震タブの地図(バー「リアルタイム」)で過去の揺れを再生できます。
            </div>

            {!replayPlayer.loaded ? (
              <label
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "9px 14px", borderRadius: 10,
                  border: `1px solid rgba(${tokens.ink},0.15)`,
                  background: `rgba(${tokens.ink},0.04)`,
                  fontSize: 13, color: `rgba(${tokens.ink},0.85)`, cursor: "pointer",
                }}
              >
                ファイルを選択
                <input type="file" accept=".bin" onChange={handleFileChange} style={{ display: "none" }}/>
              </label>
            ) : (
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>
                    {replayPlayer.fileName}
                  </span>
                  <button
                    onClick={replayPlayer.close}
                    style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: `rgba(${tokens.ink},0.5)`, padding: 0 }}
                  >
                    閉じる
                  </button>
                </div>

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
            )}

            {replayPlayer.error && (
              <div style={{ marginTop: 10, fontSize: 12, color: "#FF453A" }}>{replayPlayer.error}</div>
            )}
          </div>
        </SettingsCard>

        {/* 観測点の色を気象庁震度階級に換算して表示する設定。リプレイ再生時
            (ファイル読み込み後)のみ意味を持つため、その間だけ表示する。 */}
        {replayPlayer.loaded && (
          <SettingsCard>
            <SettingsToggleRow
              label="震度階級で表示"
              description="観測点の色を、強震モニタ本来の連続配色ではなく気象庁の震度階級に換算して表示します。震度1以上は地震情報の観測点マーカーと同じアイコン(設定中の震度配色に対応)、震度0(計測震度-1.0〜0.4)は透明→薄いグレー→グレーの段階で表示し、震度0の中での揺れの強さの違いも見えるようにしています。"
              checked={replayJmaColorEnabled}
              onChange={() => onChangeReplayJmaColorEnabled(!replayJmaColorEnabled)}
            />
          </SettingsCard>
        )}
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
