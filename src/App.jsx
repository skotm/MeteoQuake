import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Filters, Glass, GlassOpaqueContext, LAYERS, PressableButton, detectSuspectedBackdropFilterBreakage, loadGlassOpaqueOverride, saveGlassOpaqueOverride, useIsStandalonePwa, useIsWideLayout, useWideUIScale } from "./ui/glass.jsx";
import { GlobalStyles } from "./ui/globalStyles.jsx";
import { loadGeoData, loadTsunamiAreasData } from "./lib/loaders.js";
import { NowcastColorSchemeContext, loadStoredNowcastColorScheme, saveNowcastColorScheme } from "./weather/nowcast.js";
import { MapCanvas } from "./map/MapCanvas.jsx";
import { QuakeColorSchemeContext, THEME_TOKENS, ThemeContext, clampQuakeFetchLimit, loadStoredAreaFillEnabled, loadStoredBoundaryLineColorId, loadStoredEpicenterCirclesEnabled, loadStoredEstIntensityEnabled, loadStoredExperimentalFeaturesEnabled, loadStoredFaultsEnabled, loadStoredPlateBoundariesEnabled, loadStoredQuakeColorScheme, loadStoredQuakeFetchLimit, loadStoredStationListDisplayMode, loadStoredThemeModePref, saveAreaFillEnabled, saveBoundaryLineColorId, saveEpicenterCirclesEnabled, saveEstIntensityEnabled, saveExperimentalFeaturesEnabled, saveFaultsEnabled, savePlateBoundariesEnabled, saveQuakeColorScheme, saveQuakeFetchLimit, saveStationListDisplayMode, saveThemeModePref, useSystemThemeMode } from "./settings/prefs.js";
import { TSUNAMI_FETCH_LIMIT, TSUNAMI_HISTORY_PAGE_SIZE, dedupeQuakeList, dedupeTsunamiList, fetchJmaTsunamiHistory, fetchRecentTsunamis, fetchTsunamiHistoryPage, mergeQuakeCards, mergeTsunamiSources, tsunamiGradeInfo, tsunamiHeightBandColor } from "./api/p2p.js";
import { fetchRecentQuakes } from "./api/estimatedIntensity.js";
import { EEW_CANCEL_LINGER_MS, EEW_MAX_CONCURRENT, EEW_STALE_MS, connectQuakeWebSocket, connectWolfxEewWebSocket, fetchLatestFreshEew, fetchLatestFreshEewFromWolfx } from "./api/eew.js";
import { EMPTY_EQDB_LIST, loadStations, polygonRoughCentroid, resolveStationPoints, toTideDateStr } from "./api/quakeData.js";
import { buildTestQuakeStageCard, calcTestEewAreasByAttenuation, fetchWarningLevelMap_combined, findNearestTsunamiArea, isTestWarnLevel, loadWarningAreaNameIndex } from "./api/warnings.js";
import { buildEqdbQuakeCard, computeMaxTsunamiHeightCm, daysBetweenDates, fetchTideObsForDateRange, fetchTideObsRange, fetchTideStations } from "./weather/location.jsx";
import { SideNavRail, WIDE_RAIL_WIDTH } from "./components/nav.jsx";
import { BottomDock } from "./components/BottomDock.jsx";
import { NowcastLegend, PrecipLegend, QuakeIntensityLegend, RiskLegend, RiverLegend, TsunamiGradeLegend, WarningLegend, WdistLegend } from "./components/legends.jsx";
import { TEST_TSUNAMI_GRADE_OPTIONS } from "./components/Settings.jsx";
import { TermsConsentGate } from "./components/TermsGate.jsx";

/* ─────────────────────────────────────────────────────
   APP ROOT
   ───────────────────────────────────────────────────── */
export default function App() {
  const [activeNav, setActiveNav] = useState("quake");
  // WebSocketの受信ハンドラ(古いクロージャのまま生き続ける)から常に最新の
  // activeNavを参照できるようにするためのref。緊急地震速報の自動表示切り替えに使う。
  const activeNavRef = useRef(activeNav);
  useEffect(() => { activeNavRef.current = activeNav; }, [activeNav]);

  // タブバーで、既にアクティブなタブをもう一度タップした時に、フローティングを
  // 開閉トグルさせるための信号。値そのものに意味は無く、変化すること自体を
  // BottomDock側のuseEffectで検知してsnapIndexを切り替える。
  const [navCollapseSignal, setNavCollapseSignal] = useState(0);
  // 既にアクティブなタブをダブルタップした時に、フローティングを「高」まで一気に
  // 開かせるための信号。navCollapseSignalと同様、値の変化自体をBottomDock側で検知する。
  const [navDoubleTapSignal, setNavDoubleTapSignal] = useState(0);
  // SideNavRail・狭幅ナビはどちらも、1回の物理的なタップに対してhandlePointerUp
  // (ポインタを離した時)とhandleClick(単純クリック時)の両方からonNavを呼ぶ作りに
  // なっている(ドラッグでタブを選べるようにするための設計)。そのため、まず
  // 「ごく短時間(80ms未満)内の連続呼び出し」を同一タップ由来の二重発火として無視し、
  // 残った「論理的な1タップ」だけを数える。
  // 通常のタップ操作(開閉トグル)は待たせず即座に実行する。その代わり、フローティングの
  // 開閉アニメーション中(BottomDockのheightトランジションは0.4秒)にもう一度タップされた
  // 場合だけ、それを「動作の途中のタップ」とみなして「高」まで一気に開く。
  // この猶予は実際のトランジション時間(400ms)ちょうどにはせず、80ms分のバッファを
  // 上乗せしている(scheduleSettleが同じ0.4sのトランジションに対して460msの猶予を
  // 持たせているのと同じ考え方)。ちょうど同じ値にしてしまうと、指の反応や
  // イベント発火・再描画にかかるわずかな遅延だけで「連打のつもりが400msをわずかに
  // 超えて届く」ことになり、ダブルタップのはずが単発タップの開閉トグル(=閉じる方向)
  // として誤判定され、開いている途中で閉じてしまう不具合につながっていた。
  const NAV_TRANSITION_MS = 480;
  const navTapStateRef = useRef({ rawTime: 0, logicalTapTime: 0 });
  function handleNavTap(id) {
    if (id !== activeNav) {
      setActiveNav(id);
      return;
    }
    const now = Date.now();
    if (now - navTapStateRef.current.rawTime < 80) {
      navTapStateRef.current.rawTime = now;
      return;
    }
    navTapStateRef.current.rawTime = now;

    const sinceLastLogicalTap = now - navTapStateRef.current.logicalTapTime;
    if (navTapStateRef.current.logicalTapTime && sinceLastLogicalTap < NAV_TRANSITION_MS) {
      // 直前の開閉トグルがまだアニメーション中 → 「高」まで一気に開く
      navTapStateRef.current.logicalTapTime = 0;
      setNavDoubleTapSignal(s => s + 1);
      return;
    }
    navTapStateRef.current.logicalTapTime = now;
    setNavCollapseSignal(s => s + 1);
  }
  const [layers,    setLayers]    = useState(LAYERS);
  const [layerOpen, setLayerOpen] = useState(false);
  const [map,       setMap]       = useState(null);
  const isWide = useIsWideLayout(); // 横画面スマホ・タブレット・PCなどの広い画面かどうか
  const wideUIScale = useWideUIScale(isWide); // 横画面で画面が低い(=スマホ横持ち)場合の縮小率
  const isStandalonePwa = useIsStandalonePwa(); // ホーム画面に追加したPWAとして起動しているか

  // Liquid Glassのぼかしが実効しない(疑いがある)場合の不透明フォールバック。
  // "auto"時はWebGLレンダラー文字列からのヒューリスティック判定に従い、
  // 手動で "on"(常に不透明)/"off"(常にぼかし優先)にも上書きできる
  // (設定タブなどから handleChangeGlassOpaqueOverride を呼んで切り替える)。
  const [glassOpaqueOverride, setGlassOpaqueOverrideState] = useState(loadGlassOpaqueOverride);
  const [suspectedBackdropFilterBroken] = useState(detectSuspectedBackdropFilterBreakage);

  function handleChangeGlassOpaqueOverride(next) {
    // ぼかしが実効しない疑いがある場合、不透明のまま固定する
    // (設定画面のトグルはdisabled表示にしているが、念のためここでも二重に防ぐ)。
    if (suspectedBackdropFilterBroken) return;
    setGlassOpaqueOverrideState(next);
    saveGlassOpaqueOverride(next);
  }

  const glassOpaque =
    suspectedBackdropFilterBroken ? true : // ぼかしが効かない疑いがある場合は常に不透明固定
    glassOpaqueOverride === "on"  ? true  :
    glassOpaqueOverride === "off" ? false :
    false; // "auto" かつ疑いがない場合はぼかしを使う

  const glassOpaqueContextValue = useMemo(() => ({
    opaque: glassOpaque,
    override: glassOpaqueOverride,
    suspectedBroken: suspectedBackdropFilterBroken,
    setOverride: handleChangeGlassOpaqueOverride,
  }), [glassOpaque, glassOpaqueOverride, suspectedBackdropFilterBroken, handleChangeGlassOpaqueOverride]);

  // ライト/ダークモード。設定タブの「詳細設定」→「外観」から切り替える。
  // 初期設定は"system"(デバイスの設定に合わせる)。ユーザーの選択は
  // localStorageに保存し、次回起動時も復元する。
  // "system"のときはuseSystemThemeMode()でデバイスのprefers-color-schemeを
  // ライブ監視し、それをそのまま実際の表示モードとして使う。
  const [themeModePref, setThemeModePrefState] = useState(loadStoredThemeModePref); // "system" | "light" | "dark"
  const systemThemeMode = useSystemThemeMode(); // "dark" | "light"(デバイス設定、リアルタイム反映)
  const themeMode = themeModePref === "system" ? systemThemeMode : themeModePref; // 実際に適用中のモード

  function handleChangeThemeModePref(next) {
    setThemeModePrefState(next);
    saveThemeModePref(next);
  }

  const themeContextValue = useMemo(() => ({
    mode: themeMode,
    tokens: THEME_TOKENS[themeMode],
    modePref: themeModePref,
    setModePref: handleChangeThemeModePref,
  }), [themeMode, themeModePref]);

  // App自身はThemeContext.Providerを作る側なので、自分に対してはuseContextせず
  // 計算済みのthemeContextValueから直接参照する。
  const tokens = themeContextValue.tokens;

  // 震度配色。設定タブの「地震」→「震度配色」から切り替える。
  // 選択したスキームはlocalStorageに保存し、次回起動時も復元する。
  const [quakeColorScheme, setQuakeColorScheme] = useState(loadStoredQuakeColorScheme); // "legacy" | "jma" | "fill"

  function handleChangeQuakeColorScheme(schemeId) {
    setQuakeColorScheme(schemeId);
    saveQuakeColorScheme(schemeId);
  }

  // 雨雲レーダー配色。設定タブの「気象」→「雨雲レーダー配色」から切り替える。
  // 選択したスキームはlocalStorageに保存し、次回起動時も復元する。
  const [nowcastColorScheme, setNowcastColorScheme] = useState(loadStoredNowcastColorScheme); // "jma" | "yahoo"

  function handleChangeNowcastColorScheme(schemeId) {
    setNowcastColorScheme(schemeId);
    saveNowcastColorScheme(schemeId);
  }

  // 推計震度分布の表示ON/OFF。地図レイヤーパネルの「推計震度分布」トグルと
  // 設定タブ「地震」内のトグルの、両方から操作できる単一の状態(localStorageに永続化)。
  const [estIntensityEnabled, setEstIntensityEnabledState] = useState(loadStoredEstIntensityEnabled);

  function handleChangeEstIntensityEnabled(next) {
    setEstIntensityEnabledState(next);
    saveEstIntensityEnabled(next);
  }

  // 細分区域を震度の色で塗りつぶすかどうか。推計震度分布と同じく設定タブで操作し、localStorageに永続化する。
  const [areaFillEnabled, setAreaFillEnabledState] = useState(loadStoredAreaFillEnabled);

  function handleChangeAreaFillEnabled(next) {
    setAreaFillEnabledState(next);
    saveAreaFillEnabled(next);
  }

  // 実験的・テスト機能のON/OFF。設定「詳細設定」内のトグルで操作し、localStorageに永続化する。
  const [experimentalFeaturesEnabled, setExperimentalFeaturesEnabledState] = useState(loadStoredExperimentalFeaturesEnabled);

  function handleChangeExperimentalFeaturesEnabled(next) {
    setExperimentalFeaturesEnabledState(next);
    saveExperimentalFeaturesEnabled(next);
    // OFFに戻したら、テスト配信中のダミー津波情報も片付けておく
    // (OFFなのにテストデータだけ残り続ける事故を防ぐ)。
    if (!next) {
      clearTestTsunami();
      setTsunamiAreaPickActive(false);
      setPickedTsunamiAreas([]);
    }
  }

  // 警報タブ: 気象警報・注意報。regioncode → {level, kinds} のマップ。
  // 警報タブを開いている間だけ10分おきにポーリングする(EEW等の常時監視系と違い、
  // 警報・注意報は数分単位で急変するものではないため)。
  const [warningLevelMap, setWarningLevelMap] = useState({});
  // 直近の取得時刻。タブを行ったり来たりするたびに毎回APIを叩き直さないよう、
  // 直近1分以内に取得済みなら再取得をスキップする(定期ポーリングのタイマーは
  // forceで無視する)。
  const warningLevelMapFetchedAtRef = useRef(0);
  useEffect(() => {
    if (activeNav !== "alert") return;
    let cancelled = false;
    const refresh = (force = false) => {
      if (!force && Date.now() - warningLevelMapFetchedAtRef.current < 60 * 1000) return;
      fetchWarningLevelMap_combined()
        .then((map) => {
          if (cancelled) return;
          warningLevelMapFetchedAtRef.current = Date.now();
          setWarningLevelMap(map);
        })
        .catch((err) => console.error("警報・注意報データの取得に失敗しました:", err));
    };
    refresh();
    const intervalId = setInterval(() => refresh(true), 10 * 60 * 1000);
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [activeNav]);

  // 警報タブ: 市区町村の名称インデックス(1,821件、regioncode→{name, geometry})。
  // 以前はloadWarningAreaMunicipalities()(1,821件全部のcentroidを毎回計算する
  // 重い版、五十音ピッカー専用)を流用していたが、警報タブを開いた瞬間に
  // 発表の有無に関わらず全市区町村分の座標計算が走ってしまい、体感の重さの
  // 原因になっていた。ここでは名称とジオメトリを受け渡すだけの軽量版
  // loadWarningAreaNameIndex()を使い、座標(centroid)は下のuseMemoで
  // 「実際に発表中の数件」だけ遅延計算する。
  const [warningAreaNameIndex, setWarningAreaNameIndex] = useState(null);
  const warningAreaNameIndexLoadedRef = useRef(false);
  useEffect(() => {
    if (activeNav !== "alert" || warningAreaNameIndexLoadedRef.current) return;
    warningAreaNameIndexLoadedRef.current = true;
    loadWarningAreaNameIndex()
      .then(setWarningAreaNameIndex)
      .catch((err) => {
        console.error("警報エリアの名称マスタの読み込みに失敗しました:", err);
        warningAreaNameIndexLoadedRef.current = false; // 失敗時は次回開いた時に再試行できるようにする
      });
  }, [activeNav]);
  // regioncode → {name, lat, lon} の逆引きテーブル。一覧表示・詳細カードの
  // 両方で使う。centroid計算は「現在warningLevelMapに載っている(=発表中の)
  // regioncodeだけ」に絞ることで、全1,821件分の計算を避けている。
  const warningAreaByRegioncode = useMemo(() => {
    const map = {};
    if (!warningAreaNameIndex) return map;
    // 名称は全1,821件分マップしておく(地図タップは発表の有無を問わず全国が
    // 対象になったため、発表なしのエリアでも名前だけは詳細カードで出したい)。
    // centroid計算(polygonRoughCentroid)は依然として重いので、一覧・flyToで
    // 実際に必要になる「発表中」の分だけに絞って計算する。
    for (const regioncode of Object.keys(warningAreaNameIndex)) {
      const entry = warningAreaNameIndex[regioncode];
      if (!entry) continue;
      const centroid = warningLevelMap[regioncode] ? polygonRoughCentroid(entry.geometry) : null;
      map[regioncode] = { name: entry.name, regionname: entry.regionname, lat: centroid?.lat ?? null, lon: centroid?.lon ?? null };
    }
    return map;
  }, [warningLevelMap, warningAreaNameIndex]);

  // 警報タブ: タップ/一覧選択中のエリア(regioncode) | null。
  // タブを離れたら選択解除する(津波タブの選択解除と同じ考え方)。
  const [selectedWarningArea, setSelectedWarningArea] = useState(null);
  useEffect(() => {
    if (activeNav !== "alert") setSelectedWarningArea(null);
  }, [activeNav]);
  // 一覧の項目をタップした時のflyTo先。{lon, lat, nonce} | null
  // (nonceは同じエリアを連続でタップしても再度flyToが発火するようにするため)。
  const [warningAreaFlyToRequest, setWarningAreaFlyToRequest] = useState(null);
  // 地図の塗り分けをタップした時。地図タップは警報レイヤーの全ポリゴン
  // (発表の有無を問わず日本全国)に対して判定される。以前は発表中でない
  // エリアのタップを無視していたが、warningAreaByRegioncodeが名称だけは
  // 全件分持つようになったため、発表なしのエリアもそのまま選択して
  // 詳細カード側で「発表中の警報・注意報はありません」と出す。
  function handleSelectWarningArea(regioncode) {
    setSelectedWarningArea(regioncode);
  }
  // 一覧の項目をタップした時。選択に加えて、代表座標が分かっていればflyToする。
  // useCallbackで参照を安定させ、WarningAreaListPanel(memo化済み)がBottomDockの
  // 再レンダー(ドラッグ中のアニメーション等)のたびに再レンダーされるのを防ぐ。
  const handleSelectWarningAreaFromList = useCallback((regioncode) => {
    setSelectedWarningArea(regioncode);
    const area = warningAreaByRegioncode[regioncode];
    if (area && area.lat != null && area.lon != null) {
      setWarningAreaFlyToRequest({ lon: area.lon, lat: area.lat, nonce: Date.now() });
    }
  }, [warningAreaByRegioncode]);
  // 詳細カードの「戻る」ボタン。
  function handleBackFromWarningArea() {
    setSelectedWarningArea(null);
  }

  // 断層(faults.geojson)の表示ON/OFF。設定タブ「地震」内のトグルで操作し、
  // localStorageに永続化する。ファイルサイズが大きいためデフォルトはOFF。
  const [faultsEnabled, setFaultsEnabledState] = useState(loadStoredFaultsEnabled);

  function handleChangeFaultsEnabled(next) {
    setFaultsEnabledState(next);
    saveFaultsEnabled(next);
  }

  // プレート境界(plate-boundaries.json)の表示ON/OFF。断層と同様。
  const [plateBoundariesEnabled, setPlateBoundariesEnabledState] = useState(loadStoredPlateBoundariesEnabled);

  function handleChangePlateBoundariesEnabled(next) {
    setPlateBoundariesEnabledState(next);
    savePlateBoundariesEnabled(next);
  }

  // 震央分布(地図上の丸)の表示ON/OFF。設定タブ「地震」内のトグルで操作し、
  // localStorageに永続化する。デフォルトはOFF。
  const [epicenterCirclesEnabled, setEpicenterCirclesEnabledState] = useState(loadStoredEpicenterCirclesEnabled);

  function handleChangeEpicenterCirclesEnabled(next) {
    setEpicenterCirclesEnabledState(next);
    saveEpicenterCirclesEnabled(next);
  }

  // 断層・プレート境界の「枠内の色」。設定タブ「地震」内の色選択で操作し、localStorageに永続化する。
  const [boundaryLineColorId, setBoundaryLineColorIdState] = useState(loadStoredBoundaryLineColorId);

  function handleChangeBoundaryLineColorId(next) {
    setBoundaryLineColorIdState(next);
    saveBoundaryLineColorId(next);
  }

  // 震度観測点リスト(各地の震度)の表示方法。"grouped"(階層表示、既定) | "list"(一覧表示)。
  // 設定タブ「地震」内から切り替え、localStorageに永続化する。
  const [stationListDisplayMode, setStationListDisplayModeState] = useState(loadStoredStationListDisplayMode);

  function handleChangeStationListDisplayMode(next) {
    setStationListDisplayModeState(next);
    saveStationListDisplayMode(next);
  }

  // 地震一覧の取得件数(1〜1000、デフォルト100)。設定タブで変更すると一覧を取り直す。
  const [quakeFetchLimit, setQuakeFetchLimitState] = useState(loadStoredQuakeFetchLimit);

  function handleChangeQuakeFetchLimit(next) {
    const clamped = clampQuakeFetchLimit(next);
    setQuakeFetchLimitState(clamped);
    saveQuakeFetchLimit(clamped);
  }

  // 地震情報(P2P地震情報API)
  const [quakes,          setQuakes]          = useState([]);
  const [quakeStatus,     setQuakeStatus]     = useState("loading"); // loading | ready | error
  const [selectedQuakeId, setSelectedQuakeId] = useState(null);
  // WebSocketのイベントハンドラ(古いクロージャのまま生き続ける)から常に最新の
  // selectedQuakeIdを参照できるようにするためのref。
  // 以前はuseEffect(selectedQuakeIdの変化を見て同期)で更新していたが、それだと
  // 「地震を選択した直後(レンダー→コミット→エフェクト実行、が終わる前)に、
  // 同じ地震の続報がWebSocketで届いてidが差し替わる」という、選択とほぼ同時に
  // 起こるケースでrefの反映が間に合わず、続報側の「選択中の地震を後継idへ
  // 引き継ぐ」処理(下のconnectQuakeWebSocket・/history統合の両方)が発火条件を
  // 満たせず素通りしてしまい、選択がズレたまま戻せなくなる不具合があった
  // (戻るボタンが出ない/ツールバーが引っ込まないという形で表面化していた)。
  // → refの更新をuseEffect任せにせず、selectedQuakeIdを変更する箇所すべてで
  //   このselectQuake()を通すことで、state更新と完全に同じタイミング(同期的)
  //   でrefも更新されるようにする。
  const selectedQuakeIdRef = useRef(null);
  const selectQuake = useCallback((id) => {
    console.log("[quake-select-diag][selectQuake]", { from: selectedQuakeIdRef.current, to: id });
    selectedQuakeIdRef.current = id;
    setSelectedQuakeId(id);
  }, []);

  // 津波情報(P2P地震情報API)。地震情報と同じWebSocket接続を共有する(下のuseEffect参照)。
  const [tsunamis,          setTsunamis]          = useState([]);
  const [tsunamiStatus,     setTsunamiStatus]     = useState("loading"); // loading | ready | error
  const [selectedTsunamiId, setSelectedTsunamiId] = useState(null);

  /* ─────────────────────────────────────────────────────
     緊急地震速報(P2P地震情報 EEW, code:556)。地震・津波情報と同じWebSocket接続を
     共有する(下のuseEffect参照)。/historyでの初期取得は行わず、ライブ受信のみ。
     eventIdごとに最新のレコードだけを保持する(続報が来るたびに上書き)。
     ・取消(cancelled)を一度受信したら、以後に遅れて届く非取消の続報では
       上書きしない(取消の表示を覆さないため)。
     ・「最終報」を判定できるフィールドがAPIに無いため、受信のたびに
       receivedLocalAtを更新し、EEW_STALE_MS間続報が無ければ自動的に一覧から外す
       (別のuseEffectでタイマー管理。下方)。
     ───────────────────────────────────────────────────── */
  const [eews, setEews] = useState([]);

  function handleIncomingEew(newEew) {
    setEews(prev => {
      const idx = prev.findIndex(e => e.eventId === newEew.eventId);
      if (idx === -1) {
        const withLocal = { ...newEew, receivedLocalAt: Date.now(), cancelledLocalAt: newEew.cancelled ? Date.now() : null };
        // 新規の(続報ではない)緊急地震速報が来た時、設定タブ以外を見ていれば
        // 自動でEEW詳細画面に切り替える。設定タブだけは対象外
        // (設定変更中に画面が奪われて操作が中断されるのを避けるため)。
        if (activeNavRef.current !== "settings") setEewDetailOpen(true);
        return [withLocal, ...prev].slice(0, EEW_MAX_CONCURRENT);
      }
      const existing = prev[idx];
      // Wolfxを優先する方針: 既にWolfx由来のデータがある場合、P2P地震情報からの
      // 更新では上書きしない(Wolfx自身の更新は常に反映する)。
      if (existing.source === "wolfx" && newEew.source !== "wolfx") return prev;
      if (existing.cancelled && !newEew.cancelled) return prev; // 取消済みは以後の続報で覆さない
      const next = [...prev];
      next[idx] = {
        ...newEew,
        receivedLocalAt: Date.now(),
        cancelledLocalAt: newEew.cancelled ? (existing.cancelledLocalAt || Date.now()) : null,
      };
      return next;
    });
  }

  // 続報・取消が一定時間来ないEEWを定期的に取り除く(タイムアウト方式のライフサイクル管理)。
  useEffect(() => {
    const id = setInterval(() => {
      setEews(prev => {
        const now = Date.now();
        const next = prev.filter(e => {
          if (e.cancelled) return now - (e.cancelledLocalAt || 0) < EEW_CANCEL_LINGER_MS;
          return now - (e.receivedLocalAt || 0) < EEW_STALE_MS;
        });
        return next.length === prev.length ? prev : next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  /* ─────────────────────────────────────────────────────
     実験的機能: 緊急地震速報テスト配信
     実際のeews(WebSocketで更新され続ける)とは別のstateに持たせ、本物のデータ更新に
     巻き込まれて消えてしまわないようにする(津波テスト配信のtestTsunamiと同じ考え方)。
     index.html版の「複数EEW同時発報」「カスタムパラメータでの発報」に相当する機能を
     持たせるため、単一オブジェクトではなく配列(testEews)で複数のテストイベントを
     独立して保持し、それぞれ個別に続報・最終報・取消・削除ができるようにしている。
     ───────────────────────────────────────────────────── */
  const [testEews, setTestEews] = useState([]);

  // カスタムパラメータ(地震タブのカスタムEEWエディタ相当)から1件のテストEEWカードを組み立てる。
  // areas・maxIntensityKeyは呼び出し側で(距離減衰式により)計算済みのものを渡す。
  // idを指定した場合はそのidを使う(発報後も同じイベントを編集し続けるため、
  // フォームのeditingIdと一致させる必要がある)。
  function buildTestEewCard({ id, place, latitude, longitude, depth, magnitude, areas, maxIntensityKey, isWarnLevel, isPlum }) {
    const now = new Date();
    const originTimeStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    const resolvedId = id || `test_${now.getTime()}_${Math.floor(Math.random() * 1000)}`;
    return {
      id: resolvedId, eventId: resolvedId,
      serial: "1",
      cancelled: false,
      isTraining: false,
      originTime: originTimeStr,
      arrivalTime: null,
      isAssumedHypocenter: false,
      place: place || "テスト震源",
      reducedPlace: "テスト",
      latitude, longitude, depth,
      magnitude,
      areas,
      maxIntensityKey,
      isTest: true,
      source: "test",
      isFinal: false,
      isWarnLevel: !!isWarnLevel,
      isPlum: !!isPlum,
      receivedLocalAt: Date.now(),
      cancelledLocalAt: null,
    };
  }

  // カスタムEEWエディタの初期値・「新規」に戻した時の値。
  function defaultEewTestForm() {
    return {
      editingId: null, // nullなら「新規発報」、既存イベントのidが入っていれば「そのイベントへの続報」
      place: "テスト震源(相模湾)",
      latitude: 35.2,
      longitude: 139.3,
      depth: 20,
      magnitude: 5.8,
      isPlum: false,
    };
  }
  const [eewTestForm, setEewTestForm] = useState(defaultEewTestForm);

  // 「地図をタップして震源を指定」モード。ONの間はMapCanvas側のクリックが
  // 震源ピックとして扱われる(津波警報テスト配信のtsunamiAreaPickActiveと同じ考え方)。
  const [eewEpicenterPickActive, setEewEpicenterPickActive] = useState(false);

  /**
   * テスト配信パネルからの操作を一手に受け付ける単一ディスパッチャ。
   * action:
   *   "dispatchForm" 現在のフォーム内容で発報。editingIdがあれば該当イベントへの
   *                  続報(震度・位置などを書き換えつつreportを1つ進める)、
   *                  無ければ新規イベントとして追加する。各地域の予測震度は
   *                  M・深さ・震源からの距離による減衰式でそのつど計算する
   *   "editLoad"     既存イベント(id)の現在値をフォームに読み込み、続報編集モードにする
   *   "resetForm"    フォームを初期値に戻し、続報編集モードを解除する(「新規」ボタン用)
   *   "startEpicenterPick" / "cancelEpicenterPick"  地図タップでの震源指定モードの開始/終了
   *   "update"(続報。パラメータは変えずreportだけ1つ進める) | "finalize"(最終報として発報) |
   *   "cancel"(取消を発報) | "remove"(一覧から削除) | "clearAll"(全部削除)
   */
  function handleTestEewAction(action, payload) {
    if (action === "dispatchForm") {
      const { editingId, ...params } = payload;
      // editingIdが現在のtestEewsに実在するかをここで(setState前に)確定させる。
      // idもここで一度だけ発行し、そのidをそのままフォームのeditingIdへ書き戻すことで、
      // 発報後も「このイベントを編集中」の状態を保つ(index.html版のcurrentSimEventIdと
      // 同じ考え方。以前はdefaultEewTestForm()でeditingIdごと消していたため、続けて
      // 「追加発報」を押すと毎回別イベント扱いになってしまっていた)。
      const idx = editingId ? testEews.findIndex(e => e.id === editingId) : -1;
      const isNew = idx === -1;
      const resultId = isNew ? `test_${Date.now()}_${Math.floor(Math.random() * 1000)}` : testEews[idx].id;
      setEewTestForm(prev => ({ ...prev, editingId: resultId }));

      // 各地域の予測最大震度は細分区域.jsonが要るため、距離減衰式の計算自体は
      // loadGeoData()の解決を待ってから行う(地図表示時に読み込み済みなので、
      // 実際にはほぼ即座に解決する)。
      loadGeoData().then(({ areas: areasGeoJSON }) => {
        const { areas, maxIntensityKey } = calcTestEewAreasByAttenuation(
          areasGeoJSON, params.latitude, params.longitude, params.magnitude, params.depth, params.isPlum
        );
        // 警報/予報はテスト機能限定のルール: 最大震度5弱以上を警報、4以下を予報として
        // 自動判定する。一度警報級になったイベントは、その後の続報で計算上の震度が
        // 下がっても予報には戻さない(気象庁の実運用でも警報は取消されるまで解除されない)。
        const computedIsWarnLevel = isTestWarnLevel(maxIntensityKey);
        if (isNew) {
          setTestEews(prev => [...prev, buildTestEewCard({
            ...params, id: resultId, areas, maxIntensityKey, isWarnLevel: computedIsWarnLevel,
          })]);
        } else {
          setTestEews(prev => {
            const i = prev.findIndex(e => e.id === resultId);
            if (i === -1) return prev;
            const next = [...prev];
            const isWarnLevel = next[i].isWarnLevel === true ? true : computedIsWarnLevel;
            next[i] = {
              ...next[i],
              ...params,
              areas,
              maxIntensityKey,
              isWarnLevel,
              serial: String((parseInt(next[i].serial, 10) || 1) + 1),
              receivedLocalAt: Date.now(),
            };
            return next;
          });
        }
      }).catch(err => {
        console.error("細分区域データの読み込みに失敗しました(震度分布テスト):", err);
      });
      return;
    }
    if (action === "editLoad") {
      const target = testEews.find(e => e.id === payload?.id);
      if (!target) return;
      setEewTestForm({
        editingId: target.id,
        place: target.place,
        latitude: target.latitude,
        longitude: target.longitude,
        depth: target.depth,
        magnitude: target.magnitude,
        isPlum: !!target.isPlum,
      });
      return;
    }
    if (action === "resetForm") {
      setEewTestForm(defaultEewTestForm());
      return;
    }
    if (action === "patchForm") {
      setEewTestForm(prev => ({ ...prev, ...payload }));
      return;
    }
    if (action === "startEpicenterPick") {
      setEewEpicenterPickActive(true);
      return;
    }
    if (action === "cancelEpicenterPick") {
      setEewEpicenterPickActive(false);
      return;
    }
    if (action === "clearAll") {
      setTestEews([]);
      setEewTestForm(defaultEewTestForm());
      return;
    }
    // 以降は既存の特定イベント(id)に対する操作
    const { id } = payload || {};
    setTestEews(prev => {
      if (action === "remove") return prev.filter(e => e.id !== id);
      return prev.map(e => {
        if (e.id !== id) return e;
        if (action === "update") {
          return { ...e, serial: String((parseInt(e.serial, 10) || 1) + 1), receivedLocalAt: Date.now() };
        }
        if (action === "finalize") {
          return { ...e, serial: String((parseInt(e.serial, 10) || 1) + 1), isFinal: true, receivedLocalAt: Date.now() };
        }
        if (action === "cancel") {
          return { ...e, cancelled: true, cancelledLocalAt: Date.now(), receivedLocalAt: Date.now() };
        }
        return e;
      });
    });
    if (action === "remove" && eewTestForm.editingId === id) setEewTestForm(defaultEewTestForm());
  }

  // 地図タップで震源が確定した時のハンドラ(MapCanvasのonPickEewEpicenterから呼ばれる)。
  // 震央地名が判定できなかった場合(ep.jsonの読み込み失敗・データ範囲外など)は、
  // 前回の値を使い回さず、タップした座標そのものを地名欄に表示する。
  function handlePickEewEpicenter(lat, lon, placeName) {
    setEewTestForm(prev => ({
      ...prev,
      latitude: lat,
      longitude: lon,
      place: placeName || `テスト震源(北緯${lat.toFixed(2)}度 東経${lon.toFixed(2)}度)`,
    }));
    setEewEpicenterPickActive(false);
  }

  // テスト配信中は、実際の一覧の先頭にテストデータを合成する。地図・パネルとも、
  // 以降のEEW関連の判定はこちら(effectiveEews)を使う。
  const effectiveEews = testEews.length > 0 ? [...testEews, ...eews] : eews;

  // 緊急地震速報の詳細フローティングカードを表示中かどうか。左上のEewFabButtonを
  // 押すとtrueになり、専用の「戻る」ボタンで閉じるとfalseに戻る。既存のタブ
  // バー(NAV/activeNav)とは独立させ、どのタブを見ている最中でも割り込んで
  // 開けるようにしている。表示中の全EEWが無くなったら自動的に閉じる。
  // FAB/戻るボタン自体と、詳細カードの実際の描画はBottomDock側(戻るボタンと
  // 同じbackButtonBottom基準の高さに出すため)で行う。
  const [eewDetailOpen, setEewDetailOpen] = useState(false);
  useEffect(() => {
    if (eewDetailOpen && effectiveEews.length === 0) setEewDetailOpen(false);
  }, [eewDetailOpen, effectiveEews.length]);
  // FAB(!ボタン)を押すたびに1増える信号。eewDetailOpenは既にtrueのままだと
  // 値が変化せず「開いた瞬間」を検知するuseEffectが反応しないため、既に開いている
  // 状態でFABを押し直した時(例: 手元でパネルを閉じた後、再度確認したい時)にも
  // 確実にパネルの高さを開き直せるよう、別の信号として持たせている。
  const [eewOpenSignal, setEewOpenSignal] = useState(0);

  /* ─────────────────────────────────────────────────────
     実験的機能: 地震情報テスト配信
     設定の「実験的・テスト機能」がONの時だけ使える、UI確認用のダミー地震情報。
     緊急地震速報・津波警報のテスト配信と同じ考え方で、実際のquakes(WebSocketで
     更新され続ける)とは別のstateに持たせ、使う場面(effectiveQuakes)でだけ合成する。
     ①震度速報→②震源に関する情報→③震度に関する情報、と段階を追って配信できる
     ようにし、実際のmergeQuakeCards(dedupeQuakeList)がそのまま使えることを
     確認できるようにする。EEWと違い複数イベントを同時管理する必要は薄いため、
     testEews(配列)ではなく1件のtestQuakeだけを持つ簡易な設計にしている。
     ───────────────────────────────────────────────────── */
  function defaultQuakeTestForm() {
    return {
      place: "テスト震源(相模湾)",
      latitude: 35.2,
      longitude: 139.3,
      depth: 20,
      magnitude: 5.8,
      domesticTsunami: "None", // ③確定報で使う津波判定
    };
  }
  const [quakeTestForm, setQuakeTestForm] = useState(defaultQuakeTestForm);
  const [testQuake, setTestQuake] = useState(null); // mergeQuakeCardsで段階的に更新される1件のテスト地震
  const [quakeEpicenterPickActive, setQuakeEpicenterPickActive] = useState(false);
  const [quakeTestAutoPlaying, setQuakeTestAutoPlaying] = useState(false);
  // 配信中のテスト地震の発生時刻(time)。①〜③を同じ地震の続報として統合するための
  // グループキー。「新規」でクリアするまで、続けて②③を押しても同じ地震として扱われる。
  const testQuakeTimeRef = useRef(null);

  /**
   * 地震情報テスト配信パネルからの操作を受け付けるディスパッチャ。
   * action:
   *   "patchForm"           フォームの値を部分更新する
   *   "broadcastStage"      { stage: "prompt"|"destination"|"detail" } の段階を配信する。
   *                         同じテスト地震(testQuakeTimeRef)への続報として、既存の
   *                         testQuakeとmergeQuakeCardsで統合する。
   *   "autoPlaySequence"    新規のテスト地震を①→②→③の順に数秒間隔で自動配信する
   *   "startEpicenterPick" / "cancelEpicenterPick"  地図タップでの震源指定モードの開始/終了
   *   "resetForm"           フォームを初期値に戻す
   *   "clearAll"            配信中のテスト地震・フォームをすべて片付ける
   */
  function handleTestQuakeAction(action, payload) {
    if (action === "patchForm") {
      setQuakeTestForm(prev => ({ ...prev, ...payload }));
      return;
    }
    if (action === "startEpicenterPick") {
      setQuakeEpicenterPickActive(true);
      return;
    }
    if (action === "cancelEpicenterPick") {
      setQuakeEpicenterPickActive(false);
      return;
    }
    if (action === "resetForm") {
      setQuakeTestForm(defaultQuakeTestForm());
      return;
    }
    if (action === "clearAll") {
      setTestQuake(null);
      testQuakeTimeRef.current = null;
      setQuakeTestAutoPlaying(false);
      setQuakeTestForm(defaultQuakeTestForm());
      return;
    }
    if (action === "broadcastStage") {
      const { stage } = payload;
      if (!testQuakeTimeRef.current) {
        const now = new Date();
        const pad2 = n => String(n).padStart(2, "0");
        testQuakeTimeRef.current = `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
      }
      const time = testQuakeTimeRef.current;
      const now2 = new Date();
      const pad2b = n => String(n).padStart(2, "0");
      const issueTimeStr = `${now2.getFullYear()}/${pad2b(now2.getMonth() + 1)}/${pad2b(now2.getDate())} ${pad2b(now2.getHours())}:${pad2b(now2.getMinutes())}:${pad2b(now2.getSeconds())}`;
      // 各地域の震度分布は細分区域.jsonが要るため、loadGeoData()の解決を待ってから計算する
      // (地図表示時に読み込み済みなので、実際にはほぼ即座に解決する)。
      loadGeoData().then(({ areas: areasGeoJSON }) => {
        const card = buildTestQuakeStageCard(stage, quakeTestForm, time, issueTimeStr, areasGeoJSON);
        setTestQuake(prev => {
          const merged = mergeQuakeCards(prev, card);
          // 段階が進むとtestQuakeのid(test_..._prompt→test_..._destination等)が
          // 変わるため、実際のP2P地震情報のWebSocket受信時と同じ理由で、選択中の
          // まま何もしないと選択が外れて詳細画面が一覧表示に戻ってしまう。
          // 選択中のテスト地震がこの続報の対象そのものであれば、新しいidへ
          // 選択を引き継ぐ。
          if (prev && selectedQuakeIdRef.current === prev.id && merged.id !== prev.id) {
            selectQuake(merged.id);
          }
          return merged;
        });
      }).catch(err => {
        console.error("細分区域データの読み込みに失敗しました(地震情報テスト):", err);
      });
      return;
    }
    if (action === "autoPlaySequence") {
      // 新規のテスト地震として、①→②→③を数秒間隔で自動配信する。
      testQuakeTimeRef.current = null;
      setTestQuake(null);
      setQuakeTestAutoPlaying(true);
      const stages = ["prompt", "destination", "detail"];
      let i = 0;
      const step = () => {
        handleTestQuakeAction("broadcastStage", { stage: stages[i] });
        i += 1;
        if (i < stages.length) {
          setTimeout(step, 3000);
        } else {
          setQuakeTestAutoPlaying(false);
        }
      };
      step();
      return;
    }
  }

  // 地図タップで震源が確定した時のハンドラ(MapCanvasのonPickEewEpicenterから呼ばれる。
  // 「今どちらのテスト配信パネルを開いているか」で行き先を切り替えるのではなく、
  // quakeEpicenterPickActiveがtrueの間だけこちらへ、そうでなければEEW側へ、という
  // 単純な排他制御にしている(両方同時にONにはならない)。
  function handlePickQuakeEpicenter(lat, lon, placeName) {
    setQuakeTestForm(prev => ({
      ...prev,
      latitude: lat,
      longitude: lon,
      place: placeName || `テスト震源(北緯${lat.toFixed(2)}度 東経${lon.toFixed(2)}度)`,
    }));
    setQuakeEpicenterPickActive(false);
  }

  // テスト配信中は、実際の一覧の先頭にテストデータを合成する。地震タブに関する
  // App側の判定(一覧・選択中の地震・地図表示)は、以降すべてこちらを使う。
  const effectiveQuakes = testQuake ? [testQuake, ...quakes] : quakes;

  /* ─────────────────────────────────────────────────────
     実験的機能: 津波警報テスト配信
     設定の「実験的・テスト機能」がONの時だけ使える、UI確認用のダミー津波情報。
     実際のtsunamis(WebSocketで更新され続ける)とは別のstateに持たせ、
     使う場面(effectiveTsunamis)でだけ合成することで、本物のデータ更新に
     巻き込まれて消えてしまわないようにしている。
     ───────────────────────────────────────────────────── */
  const [testTsunami, setTestTsunami] = useState(null); // { ...tsunamiカード, isTest: true } | null

  function broadcastTestTsunami({ areas, heightOverrides }) {
    const now = new Date();
    const pad2 = n => String(n).padStart(2, "0");
    const timeStr = `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    const list = (areas && areas.length > 0) ? areas : [{ name: "テスト予報区", grade: "Warning" }];
    // 実際の津波情報(toTsunamiCard)と同じ考え方で、選んだ予報区の中で最も危険度が
    // 高いgradeを代表(maxGrade)として使う。予報区ごとに異なるグレードを選べるため。
    let maxGrade = null;
    let maxWeight = -1;
    list.forEach(a => {
      const w = tsunamiGradeInfo(a.grade).weight;
      if (w > maxWeight) { maxWeight = w; maxGrade = a.grade; }
    });
    // 観測点コード→高さ(m)の対応表。tsunamiHeightByStationの計算で、実際の
    // 潮位データから求めた値より優先して使われる(App側参照)。
    const heightOverridesMap = {};
    (heightOverrides || []).forEach(h => { heightOverridesMap[h.code] = h.heightM; });
    setTestTsunami({
      id: `test_${now.getTime()}`,
      time: timeStr,
      cancelled: false,
      areas: list.map(a => ({
        name: a.name, grade: a.grade,
        immediate: false, firstHeightCondition: null, firstHeightTime: null, maxHeightDescription: null,
      })),
      maxGrade,
      isTest: true,
      heightOverrides: heightOverridesMap,
    });
  }
  function cancelTestTsunami() {
    setTestTsunami(prev => (prev ? { ...prev, cancelled: true, maxGrade: null } : null));
  }
  function clearTestTsunami() {
    setTestTsunami(null);
  }

  // テスト配信中は、実際の一覧の先頭にテストデータを合成する。以降、津波タブに
  // 関するApp側の判定(現在有効な津波・選択中の津波・地図表示)は、すべてこちらを使う。
  const effectiveTsunamis = testTsunami ? [testTsunami, ...tsunamis] : tsunamis;

  /* ─────────────────────────────────────────────────────
     津波警報テスト配信: 予報区を「地図上の海岸線タップ」で選ぶモード(複数選択・
     予報区ごとに異なるグレードの割り当てが可能)。
     予報区名を手入力する代わりに、地図に表示される津波予報区の海岸線を
     直接タップして選べるようにする。ピックモード中は「今どのグレードで塗るか」を
     activePickGradeで管理し(バナーのパレットで切り替え)、タップした瞬間の
     activePickGradeがその予報区に割り当てられる。
       ・未選択の予報区をタップ → activePickGradeで新規追加
       ・すでにactivePickGradeと同じグレードで選択済みの予報区をタップ → 選択解除
       ・すでに別のグレードで選択済みの予報区をタップ → activePickGradeに塗り替え
     ON中はBottomDock側がフローティングを低くたたんで地図を見せ(BottomDockの
     useEffectでtsunamiAreaPickActiveを監視)、MapCanvas側は全予報区の海岸線を薄く
     表示してタップを受け付け、選択済みの予報区は各自のグレードに応じた実際の
     津波警報と同じ配色で強調表示する(MapCanvas参照。buildTsunamiAreaColorExprを
     そのまま再利用)。
     1回のタップごとに閉じるのではなく、「完了」で確定・「キャンセル」でピック開始時点の
     選択に戻す、という明示的な操作でモードを終える。
     ───────────────────────────────────────────────────── */
  const [tsunamiAreaPickActive, setTsunamiAreaPickActive] = useState(false);
  const [pickedTsunamiAreas, setPickedTsunamiAreas] = useState([]); // [{ name, grade }]
  const [activePickGrade, setActivePickGrade] = useState("Warning"); // 今タップしたら何グレードで塗るか
  const pickedTsunamiAreasSnapshotRef = useRef([]); // キャンセル時に戻す先

  function startTsunamiAreaPick() {
    pickedTsunamiAreasSnapshotRef.current = pickedTsunamiAreas;
    pickedTsunamiHeightsSnapshotRef.current = pickedTsunamiHeights;
    setTsunamiAreaPickActive(true);
  }
  function finishTsunamiAreaPick() {
    setTsunamiAreaPickActive(false);
  }
  function cancelTsunamiAreaPick() {
    setPickedTsunamiAreas(pickedTsunamiAreasSnapshotRef.current);
    setPickedTsunamiHeights(pickedTsunamiHeightsSnapshotRef.current);
    setTsunamiAreaPickActive(false);
  }
  function handlePickTsunamiArea(name) {
    setPickedTsunamiAreas(prev => {
      const idx = prev.findIndex(a => a.name === name);
      if (idx === -1) return [...prev, { name, grade: activePickGrade }]; // 新規選択
      if (prev[idx].grade === activePickGrade) return prev.filter(a => a.name !== name); // 同じグレードの再タップ→解除
      const next = [...prev]; // 別グレードでの再タップ→塗り替え
      next[idx] = { name, grade: activePickGrade };
      return next;
    });
  }
  // テスト配信パネル側の一覧チップの×ボタンから、地図タップ(ピックモード)を
  // 経由せずに直接1件だけ選択解除する。
  function removeTsunamiAreaPick(name) {
    setPickedTsunamiAreas(prev => prev.filter(a => a.name !== name));
  }
  // パネルの一覧チップから、地図に戻らず直接そのグレードを変更する
  // (TEST_TSUNAMI_GRADE_OPTIONSの並び順で次のグレードへ巡回)。
  function cycleTsunamiAreaGrade(name) {
    const order = TEST_TSUNAMI_GRADE_OPTIONS.map(o => o.value);
    setPickedTsunamiAreas(prev => prev.map(a => {
      if (a.name !== name) return a;
      const next = order[(order.indexOf(a.grade) + 1) % order.length];
      return { ...a, grade: next };
    }));
  }

  /* ─────────────────────────────────────────────────────
     津波警報テスト配信: 観測点(潮位計)の「観測された津波の高さ」もテストできるように、
     実在の観測点をタップして高さ(m)を手入力できるようにする。予報区ピックと同じ
     ピックモード・同じ地図タップ操作を共有し(handleSelectTideStationOnMap内で分岐)、
     海岸線をタップすれば予報区、観測点の丸をタップすれば高さ入力、という使い分けに
     なる。ここで設定した値は、実際の潮位データから計算する値の代わりに使われる
     (App側のtsunamiHeightByStation参照)。
     ───────────────────────────────────────────────────── */
  const [pickedTsunamiHeights, setPickedTsunamiHeights] = useState([]); // [{ code, name, heightM }]
  const pickedTsunamiHeightsSnapshotRef = useRef([]); // キャンセル時に戻す先

  const TSUNAMI_HEIGHT_PICK_DEFAULT_M = 1.0;
  function addTsunamiHeightPick(code) {
    if (!code || pickedTsunamiHeights.some(h => h.code === code)) return;
    const st = candidateHeightStations.find(s => s.code === code);
    if (!st) return;
    setPickedTsunamiHeights(prev => [...prev, { code: st.code, name: st.name, heightM: TSUNAMI_HEIGHT_PICK_DEFAULT_M }]);
  }
  function changeTsunamiHeightPick(code, heightM) {
    setPickedTsunamiHeights(prev => prev.map(h => (h.code === code ? { ...h, heightM } : h)));
  }
  function removeTsunamiHeightPick(code) {
    setPickedTsunamiHeights(prev => prev.filter(h => h.code !== code));
  }

  // 津波タブ「過去」モード用。直近一覧(tsunamis)とは別に、/history APIを
  // offsetで遡りながら追加取得した過去の津波情報を保持する(地震タブの
  // searchQuakeと同じ理由でWebSocketの新着・件数上限の影響を受けないようにする)。
  const [tsunamiHistory, setTsunamiHistory] = useState({
    items: [], offset: 0, status: "idle", hasMore: true, debug: "",
  }); // status: idle | loading | ready | error

  async function loadMoreTsunamiHistory() {
    if (tsunamiHistory.status === "loading" || !tsunamiHistory.hasMore) return;
    setTsunamiHistory(prev => ({ ...prev, status: "loading" }));
    const debugParts = [];
    try {
      // 初回は、気象庁の公式一覧(list.json)と、P2P地震情報の津波予報専用API
      // (/v2/jma/tsunami)の先頭2ページ(offset 0, 100)をまとめて取得して統合する。
      if (tsunamiHistory.offset === 0 && tsunamiHistory.items.length === 0) {
        const [jmaItems, p2pPage1, p2pPage2] = await Promise.all([
          fetchJmaTsunamiHistory()
            .then(r => { debugParts.push(`気象庁:${r.length}件`); return r; })
            .catch(err => { console.error("気象庁 津波情報一覧の取得に失敗:", err); debugParts.push(`気象庁:失敗(${err.message})`); return []; }),
          fetchTsunamiHistoryPage(0, TSUNAMI_HISTORY_PAGE_SIZE)
            .then(r => { debugParts.push(`P2P#1:${r.length}件`); return r; })
            .catch(err => { console.error("P2P地震情報 過去の津波情報の取得に失敗:", err); debugParts.push(`P2P#1:失敗(${err.message})`); return []; }),
          fetchTsunamiHistoryPage(TSUNAMI_HISTORY_PAGE_SIZE, TSUNAMI_HISTORY_PAGE_SIZE)
            .then(r => { debugParts.push(`P2P#2:${r.length}件`); return r; })
            .catch(err => { console.error("P2P地震情報 過去の津波情報の取得に失敗:", err); debugParts.push(`P2P#2:失敗(${err.message})`); return []; }),
        ]);
        const p2pItems = [...p2pPage1, ...p2pPage2];
        setTsunamiHistory({
          items: mergeTsunamiSources(jmaItems, p2pItems),
          offset: TSUNAMI_HISTORY_PAGE_SIZE * 2,
          status: "ready",
          hasMore: p2pPage2.length >= TSUNAMI_HISTORY_PAGE_SIZE,
          debug: debugParts.join(" / "),
        });
        return;
      }

      // 2回目以降の「もっと見る」は、P2P地震情報側のoffsetをさらに進めて補う。
      const page = await fetchTsunamiHistoryPage(tsunamiHistory.offset, TSUNAMI_HISTORY_PAGE_SIZE);
      setTsunamiHistory(prev => ({
        items: mergeTsunamiSources(prev.items, page),
        offset: prev.offset + TSUNAMI_HISTORY_PAGE_SIZE,
        status: "ready",
        hasMore: page.length >= TSUNAMI_HISTORY_PAGE_SIZE,
        debug: `P2P追加:${page.length}件`,
      }));
    } catch (err) {
      console.error("過去の津波情報の取得に失敗:", err);
      setTsunamiHistory(prev => ({ ...prev, status: "error", debug: err.message || String(err) }));
    }
  }

  /* ─────────────────────────────────────────────────────
     潮位計(津波タブ「潮位計」モード)
     ・tsunamiViewModeはBottomDock内のローカルstateなので、地図にピンを出すか
       どうかの判断のためだけに、ここへも同じ値を通知してもらう
       (causingQuakeCardと同じ「report up」パターン)。
     ・観測点一覧(tideStations)は初めて潮位計モードを開いた時に1回だけ取得し、
       以降はキャッシュを使い回す。
     ・観測値(tideObsByStation)は地点コードごとにキャッシュし、選び直しても
       同じ日ならAPIを叩き直さない。
     ───────────────────────────────────────────────────── */
  const [tsunamiViewModeTop, setTsunamiViewModeTop] = useState("recent");
  const showTideGaugeLayer = !eewDetailOpen && activeNav === "tsunami" && tsunamiViewModeTop === "tidegauge";

  // 気象タブ「地点」モードでGPS取得できている間だけBottomDock側から伝わってくる、
  // 現在地の緯度経度(地図の青丸表示用)。それ以外は常にnull。
  const [currentLocationPoint, setCurrentLocationPoint] = useState(null);
  // 雨雲レーダーがON中の現在の時刻コマ({basetime, validtime})。BottomDock側から
  // 伝わってくる。OFFの間・未読込の間はnull。
  const [nowcastFrame, setNowcastFrame] = useState(null);
  // 前後の先読み対象コマ(コマ切り替え時に一瞬レーダーが消えないよう、地図側で
  // バックグラウンドにタイルを読み込んでおくために使う)。
  const [nowcastPreloadFrames, setNowcastPreloadFrames] = useState([]);
  // 実況+予測の全validtime一覧(5分おきに更新される)。地図側のキャッシュのうち、
  // もうどのコマにも該当しなくなった(=特に予測コマは更新のたびにほぼ丸ごと
  // 入れ替わる)ものを掃除するために使う。
  const [nowcastKnownValidtimes, setNowcastKnownValidtimes] = useState([]);
  // BottomDock側のonNowcastChangeは{frame, preloadFrames, knownValidtimes} | nullを渡してくる。
  // 3つのstateへ振り分ける。
  const handleNowcastChange = useCallback((payload) => {
    setNowcastFrame(payload ? payload.frame : null);
    setNowcastPreloadFrames(payload ? payload.preloadFrames : []);
    setNowcastKnownValidtimes(payload ? payload.knownValidtimes : []);
  }, []);
  // 1/3/24時間降水量がON中の現在のモード・時刻コマ。BottomDock側から伝わってくる。
  // 雨雲レーダーとは排他なので、オンになるのはどちらか一方だけ。
  const [precipMode, setPrecipMode] = useState(null);
  const [precipFrame, setPrecipFrame] = useState(null);
  // 現在のモードの全validtime一覧(5分おきの一覧更新で変わる)。地図側のキャッシュの
  // うち、もうどのコマにも該当しなくなったレイヤーの掃除に使う(雨雲レーダーの
  // nowcastKnownValidtimesと同じ考え方)。
  const [precipKnownValidtimes, setPrecipKnownValidtimes] = useState([]);
  const handlePrecipChange = useCallback((payload) => {
    setPrecipMode(payload ? payload.mode : null);
    setPrecipFrame(payload ? payload.frame : null);
    setPrecipKnownValidtimes(payload ? payload.knownValidtimes : []);
  }, []);
  // 天気分布予報がON中の現在のモード・時刻コマ。BottomDock側から伝わってくる。
  // 雨雲レーダー・降水量とは排他なので、オンになるのはどれか1つだけ。
  const [wdistMode, setWdistMode] = useState(null);
  const [wdistFrame, setWdistFrame] = useState(null);
  const [wdistKnownValidtimes, setWdistKnownValidtimes] = useState([]);
  const handleWdistChange = useCallback((payload) => {
    setWdistMode(payload ? payload.mode : null);
    setWdistFrame(payload ? payload.frame : null);
    setWdistKnownValidtimes(payload ? payload.knownValidtimes : []);
  }, []);
  // 台風情報がON中の現在のgeojson。BottomDock側から伝わってくる。OFFの間はnull。
  const [typhoonGeojson, setTyphoonGeojson] = useState(null);
  const handleTyphoonChange = useCallback((geojson) => {
    setTyphoonGeojson(geojson);
  }, []);
  // 警報タブのくの字メニューで選択中のキキクル(土砂/浸水)。BottomDock側から
  // {mode, frame, knownValidtimes} | null で伝わってくる(1/3/24時間降水量と
  // 全く同じ形)。MapCanvas側のriskVisible/riskMode/riskFrame/riskKnownValidtimes
  // に振り分ける。
  // 「今どの項目が選ばれているか」(alertLayerMode)は、キキクルの時刻コマの
  // 有無に関係なく常に正しく分かる必要がある(河川水位選択中は時刻コマが
  // そもそも存在しないため)。そのため、キキクルの時刻コマ通知
  // (handleAlertLayerChange)とは別経路(handleAlertModeChange)で管理する。
  const [alertLayerMode, setAlertLayerMode] = useState(null);
  const [alertLayerFrame, setAlertLayerFrame] = useState(null);
  const [alertLayerKnownValidtimes, setAlertLayerKnownValidtimes] = useState([]);
  const handleAlertModeChange = useCallback((mode) => {
    setAlertLayerMode(mode);
  }, []);
  const handleAlertLayerChange = useCallback((payload) => {
    setAlertLayerFrame(payload ? payload.frame : null);
    setAlertLayerKnownValidtimes(payload ? payload.knownValidtimes : []);
  }, []);

  // 警報タブのくの字メニューで選択中の「河川水位」。BottomDock側からGeoJSON
  // FeatureCollection | null で伝わってくる。MapCanvas側のriverVisible/
  // riverStationsに振り分ける。タップ中の観測所(詳細カード用)もここで持つ。
  const [riverStations, setRiverStations] = useState(null);
  const handleRiverLayerChange = useCallback((geojson) => {
    setRiverStations(geojson);
  }, []);
  const [selectedRiverStation, setSelectedRiverStation] = useState(null); // properties | null
  const handleSelectRiverStation = useCallback((properties) => {
    setSelectedRiverStation(properties || null);
  }, []);
  useEffect(() => {
    if (alertLayerMode !== "riverLevel") setSelectedRiverStation(null);
  }, [alertLayerMode]);
  // 台風の中心点/予報円をタップした時のproperties。BottomDock側のTyphoonDetailCardで
  // 表示する(時刻チップ=予報円タップ、台風一覧タップの両方でここに入る)。
  const [selectedTyphoonInfo, setSelectedTyphoonInfo] = useState(null);
  const handleSelectTyphoonCenter = useCallback((properties) => {
    setSelectedTyphoonInfo(properties || null);
  }, []);
  // 台風詳細の選択解除。「戻る」ボタン、およびフローティングを閉じた時にBottomDock側
  // から呼ばれる。
  const handleClearSelectedTyphoon = useCallback(() => {
    setSelectedTyphoonInfo(null);
  }, []);
  // 台風一覧の項目をタップした時、地図をその台風の強風域(無ければ暴風域、それも
  // 無ければ中心のみ)が画面に収まるズーム倍率でflyToするためのリクエスト。
  // {lon, lat, areaRadiusKm, areaLon, areaLat, nonce} | null。nonceは同じ地点を
  // 連続でタップしても毎回flyToが起きるようにするための単純カウンタ。
  const [typhoonFlyToRequest, setTyphoonFlyToRequest] = useState(null);
  const handleSelectTyphoon = useCallback((typhoon) => {
    if (!typhoon) return;
    setSelectedTyphoonInfo(typhoon);
    if (typhoon.lon != null && typhoon.lat != null) {
      setTyphoonFlyToRequest({
        lon: typhoon.lon, lat: typhoon.lat,
        areaRadiusKm: typhoon.areaRadiusKm ?? null,
        areaLon: typhoon.areaLon ?? typhoon.lon,
        areaLat: typhoon.areaLat ?? typhoon.lat,
        nonce: Date.now(),
      });
    }
  }, []);
  // 現在進行形で有効な(解除されていない)津波情報があるかどうか。潮位観測点
  // マスタの取得トリガー・自動表示の判定の両方で使う軽量な判定。
  const hasActiveTsunami = effectiveTsunamis.some(t => !t.cancelled);

  const [tideStations, setTideStations] = useState(EMPTY_EQDB_LIST);
  const [tideStationsStatus, setTideStationsStatus] = useState("idle"); // idle | loading | ready | error
  useEffect(() => {
    // 潮位計モードを開いた時・有効な津波情報がある間に加えて、津波警報テスト配信の
    // 予報区ピックモード中も取得しておく(テスト用の観測点タップ選択で実在の
    // 観測点一覧が必要なため)。
    if ((!showTideGaugeLayer && !hasActiveTsunami && !tsunamiAreaPickActive) || tideStationsStatus !== "idle") return;
    setTideStationsStatus("loading");
    fetchTideStations()
      .then(list => { setTideStations(list); setTideStationsStatus("ready"); })
      .catch(err => { console.error("潮位観測点一覧の取得に失敗:", err); setTideStationsStatus("error"); });
  }, [showTideGaugeLayer, hasActiveTsunami, tsunamiAreaPickActive, tideStationsStatus]);

  const [selectedTideStationCode, setSelectedTideStationCode] = useState(null);
  // 津波タブそのものを離れたら選択を解除する(戻ってきた時に地図のピンと表示が
  // ズレないように)。以前はtidegaugeモードを離れたタイミングで解除していたが、
  // 地図タップでの観測点選択が「潮位計」モードへ切り替えずその場(直近一覧など)で
  // 完結するようになったため、tidegaugeモードの出入りとは切り離す必要がある。
  useEffect(() => {
    if (activeNav !== "tsunami") setSelectedTideStationCode(null);
  }, [activeNav]);

  // 形: { [stationCode]: { date: "YYYYMMDD", days, status: "loading"|"ready"|"error", data } }
  const [tideObsByStation, setTideObsByStation] = useState({});
  // forceがtrueの時は、すでに読み込み済み(status: "ready")でも取得し直す。
  // 津波の観測値表示(観測点詳細)は1回読めば十分だが、地図上の「観測された津波の
  // 高さ」バーは警報等が続く間ずっと最新の最大波を追いたいので、そちらの定期更新
  // からはforce=trueで呼ぶ。
  async function loadTideObs(stationCode, force = false) {
    const dateStr = toTideDateStr(new Date());
    const cur = tideObsByStation[stationCode];
    if (cur && cur.status === "loading") return; // 進行中なら常にスキップ(forceでも二重発火は防ぐ)

    // 現在有効な津波警報・注意報・予報の対象予報区に属する観測点は、最大波の
    // 判定に必要な期間を確実にカバーするため、その現象の第１報の日付〜当日までを
    // 取得する。ただし第１報が当日発表の場合でも、前日分との比較(潮汐の推算誤差
    // チェック等)のため最低2日分(前日+当日)は必ず取得する。
    const isWarnedStation = activeTsunami != null &&
      tideStationsWithGrade.some(st => st.code === stationCode && st.activeGrade);
    const days = isWarnedStation && activeTsunamiEpisodeStartTime
      ? Math.max(2, daysBetweenDates(activeTsunamiEpisodeStartTime, new Date()))
      : 2;

    // 通常時は読み込み済みならスキップ。ただし、以前は非発令(2日分)で読み込んだ
    // 観測点が新たに発令対象になり、必要な日数が増えた場合は、forceでなくても
    // 取得し直す(そうしないと第１報以降の古いデータが欠けたままになるため)。
    if (!force && cur && cur.date === dateStr && cur.status === "ready" && (cur.days || 2) >= days) return;

    setTideObsByStation(prev => ({ ...prev, [stationCode]: { date: dateStr, days, status: "loading", data: null } }));
    try {
      const data = await fetchTideObsRange(stationCode, days);
      setTideObsByStation(prev => ({ ...prev, [stationCode]: { date: dateStr, days, status: "ready", data } }));
    } catch (err) {
      console.error("潮位観測値の取得に失敗:", err);
      setTideObsByStation(prev => ({ ...prev, [stationCode]: { date: dateStr, days, status: "error", data: null } }));
    }
  }

  // 観測点マスタ(緯度経度付き)。points[]との突き合わせに使う。
  const [stations, setStations] = useState(null);

  // 細分区域.json(EEWの地域塗り分けで使っているものと同じデータ)。
  // 震度速報(ScalePrompt)のisArea:trueな点は観測点マスタでは解決できず、
  // 地域名→区域コードのこちらの変換が必要なため、resolveStationPointsに渡す。
  // loadGeoData()はモジュール内でPromiseをキャッシュしているため、地図側で
  // 既に読み込み済みであれば実質即座に解決する。
  const [areasGeoJSON, setAreasGeoJSON] = useState(null);
  useEffect(() => {
    let cancelled = false;
    loadGeoData()
      .then(({ areas }) => { if (!cancelled) setAreasGeoJSON(areas); })
      .catch(err => console.error("細分区域データの取得に失敗:", err));
    return () => { cancelled = true; };
  }, []);

  // 気象庁 震度データベース(eqdb)検索で開いた地震。直近一覧(quakes)には混ぜず、
  // ここだけで別管理する(P2P地震情報のWebSocket更新・件数上限に巻き込まれないようにするため)。
  const [searchQuake, setSearchQuake] = useState(null);

  // 震央分布(地図上の丸)。今どの一覧(P2P一覧/近傍地震検索/データベース検索)を
  // 表示中かに応じて、BottomDock側で計算した点の配列をそのまま受け取る。
  const [epicenterPoints, setEpicenterPoints] = useState([]);
  // 震央分布の丸が、まだ全件分バックグラウンド解決しきっていない間true。
  // 地図側でローディング表示を出すために使う。
  const [epicenterLoading, setEpicenterLoading] = useState(false);

  // 震央分布の丸をタップして選択するたびに1増える信号。BottomDock側では
  // この値が変わるたびに、フローティングの高さを「中」に揃える
  // (一覧内から選んだ時のhandleSelectQuakeForScrollと同じ挙動にするため)。
  const [mapSelectSignal, setMapSelectSignal] = useState(0);

  // 震央分布の丸がタップされた時の選択処理。
  // ・P2P地震一覧由来の点(id=通常の地震ID)は、そのままselectedQuakeIdにする。
  // ・近傍地震検索・データベース検索由来の点(id="eqdb_"始まり)は、
  //   プリフェッチ済みのeqdb詳細(_eqdbDetail)を使って即座に検索結果と同じ形の
  //   quakeカードを組み立て、searchQuakeにセットしてから選択する
  //   (座標を取得済みということは詳細も取得済みなので、再取得は不要)。
  function handleSelectEpicenterPoint(id) {
    if (typeof id === "string" && id.startsWith("eqdb_")) {
      const point = epicenterPoints.find(p => p.id === id);
      if (!point || !point._eqdbDetail) return;
      loadGeoData().then(geo => {
        const card = buildEqdbQuakeCard(point._eqdbDetail, point._eqdbListItem, stations, geo?.areas);
        setSearchQuake(card);
        selectQuake(card.id);
        setMapSelectSignal(n => n + 1);
      });
      return;
    }
    selectQuake(id);
    setMapSelectSignal(n => n + 1);
  }

  const toggleLayer = id => {
    // 「推計震度分布」レイヤーだけは、layers配列ではなく設定と共有のestIntensityEnabled側で管理する
    if (id === "estIntensity") {
      handleChangeEstIntensityEnabled(!estIntensityEnabled);
      return;
    }
    setLayers(prev => prev.map(l => l.id === id ? { ...l, on: !l.on } : l));
  };

  // レイヤーパネルに渡す一覧。「推計震度分布」の見た目上のon/offは、layers配列の
  // 初期値ではなく、常にestIntensityEnabled(設定と共有・永続化されている値)を反映させる。
  const layersForPanel = useMemo(
    () => layers.map(l => l.id === "estIntensity" ? { ...l, on: estIntensityEnabled } : l),
    [layers, estIntensityEnabled]
  );

  // 観測点マスタは全地震で共通なので、起動時に一度だけ取得する
  useEffect(() => {
    let cancelled = false;
    loadStations()
      .then(list => { if (!cancelled) setStations(list); })
      .catch(err => console.error("観測点マスタの取得に失敗:", err));
    return () => { cancelled = true; };
  }, []);

  // 選択中の地震 + 観測点マスタが揃ったら、観測点ごとの震度に緯度経度を割り当てる。
  // 気象庁 震度データベース検索から開いた地震(searchQuake)は quakes には入っていないため、
  // そちらも見つからなかった場合のフォールバックとして探す。
  // (effectiveQuakesを使うことで、地震情報テスト配信中のダミー地震も選択・表示できる)
  const selectedQuake = effectiveQuakes.find(q => q.id === selectedQuakeId)
    || (searchQuake && searchQuake.id === selectedQuakeId ? searchQuake : null);

  // 観測点データが多い地震(震度データベース検索由来ではない、通常の地震一覧からの選択)は、
  // 観測点マスタとの突き合わせ(resolveStationPoints)が重くなり、選択直後に一瞬固まって
  // 見えることがある。selectedQuakeが変わった直後にまずローディング表示を出し、
  // 次のタスクにずらして計算することで、その間に「観測点データを処理中…」を描画させる。
  const [selectedQuakePoints, setSelectedQuakePoints] = useState([]);
  const [stationPointsProcessing, setStationPointsProcessing] = useState(false);
  useEffect(() => {
    if (!selectedQuake) {
      setSelectedQuakePoints([]);
      setStationPointsProcessing(false);
      return;
    }
    // eqdb由来の地震は、観測点の緯度経度を自前で解決済み(resolvedPoints)なのでそのまま使う。
    if (selectedQuake.resolvedPoints) {
      setSelectedQuakePoints(selectedQuake.resolvedPoints);
      setStationPointsProcessing(false);
      return;
    }
    if (!stations) {
      setSelectedQuakePoints([]);
      return;
    }
    setStationPointsProcessing(true);
    const points = selectedQuake.points;
    const timer = setTimeout(() => {
      setSelectedQuakePoints(resolveStationPoints(points, stations, areasGeoJSON));
      setStationPointsProcessing(false);
    }, 0);
    return () => clearTimeout(timer);
  }, [selectedQuake, stations, areasGeoJSON]);

  // 震源(バツ印表示・ズーム用)。複数震源(eqdbのhypocenters)があればその全件、
  // 無ければ従来通り単一のlatitude/longitudeを1件だけの配列にして使う。
  // 緯度経度が無い地震(震源不明)では空配列のまま。
  const selectedHypocenters = useMemo(() => {
    if (!selectedQuake) return [];
    if (Array.isArray(selectedQuake.hypocenters) && selectedQuake.hypocenters.length > 0) {
      return selectedQuake.hypocenters;
    }
    if (selectedQuake.latitude == null || selectedQuake.longitude == null) return [];
    return [{ latitude: selectedQuake.latitude, longitude: selectedQuake.longitude }];
  }, [selectedQuake]);

  // 津波タブの「↪︎津波を引き起こした地震」で見つかった地震(BottomDock内の
  // ローカルなcausingQuakeStateから、表示中の1件だけをここに通知してもらう)。
  // 地震タブのselectedQuakeとは別に持ち、津波タブを見ている間だけ地図に
  // 震源のバツ印・観測点の震度を表示するために使う。
  const [causingQuakeCard, setCausingQuakeCard] = useState(null);
  // 津波タブを離れたら、地図に出している「引き起こした地震」の表示は必ずクリアする。
  // これをやらないと、地震タブに移った時にそちらで選択中の地震ではなく、
  // 津波タブで最後に見ていた地震の震源・観測点が残って表示されてしまう。
  useEffect(() => {
    if (activeNav !== "tsunami") setCausingQuakeCard(null);
  }, [activeNav]);
  const causingQuakeHypocenters = useMemo(() => {
    if (!causingQuakeCard) return [];
    if (Array.isArray(causingQuakeCard.hypocenters) && causingQuakeCard.hypocenters.length > 0) {
      return causingQuakeCard.hypocenters;
    }
    if (causingQuakeCard.latitude == null || causingQuakeCard.longitude == null) return [];
    return [{ latitude: causingQuakeCard.latitude, longitude: causingQuakeCard.longitude }];
  }, [causingQuakeCard]);

  // 地図上の観測点マーカーの表示/非表示。地震タブ・津波タブ(引き起こした地震表示中)の
  // 両方で共有する(パネルの外に浮かぶ丸ボタンから切り替える)。
  const [stationMarkersVisible, setStationMarkersVisible] = useState(true);
  // 地震タブで地震を開くたびに、必ず「表示」状態からスタートする。
  useEffect(() => {
    if (selectedQuakeId != null) setStationMarkersVisible(true);
  }, [selectedQuakeId]);
  // 津波タブで「引き起こした地震」が見つかった時は、逆に「非表示」状態からスタートする
  // (津波タブでは観測点よりも津波の予報区の塗り分けを見たいことが多いため)。
  useEffect(() => {
    if (causingQuakeCard != null) setStationMarkersVisible(false);
  }, [causingQuakeCard]);

  // 起動時に /history で最新一覧を1回だけ取得し、以降はWebSocketで新着分を随時追加する。
  // quakeFetchLimit(設定タブで変更可能)が変わった場合も、この効果全体をやり直して
  // 新しい件数で一覧を取得し直す。
  const [wsStatus, setWsStatus] = useState("connecting"); // connecting | open | closed
  useEffect(() => {
    let cancelled = false;

    fetchRecentQuakes(quakeFetchLimit)
      .then(list => {
        if (cancelled) return;
        setQuakes(prev => {
          // /historyの完了より先にWebSocketで新着が届いていた場合、
          // ここで単純に上書き(setQuakes(list))してしまうと、
          // 「WebSocketで先に届いて選択していた地震」が/historyの
          // レスポンスにまだ反映されていない(配信の遅延)ことがあり、
          // 選択中の地震ごと一覧から消えてしまうことがあった。
          // → prev(それまでの一覧、WebSocket分を含む)とlist(/history)を
          //   idで統合し、どちらか一方にしか無い分もすべて残す。
          const byId = new Map();
          for (const q of list) byId.set(q.id, q);
          for (const q of prev) if (!byId.has(q.id)) byId.set(q.id, q);
          const merged = Array.from(byId.values())
            .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
            .slice(0, quakeFetchLimit);
          const result = dedupeQuakeList(merged);

          // 選択中の地震が、統合後もなお一覧に存在しない場合の後始末。
          // ただし気象庁 震度データベース検索由来(id が "eqdb_" 始まり)の地震は
          // そもそもこの一覧(P2P地震情報)には入らないため、対象外にする。
          // WebSocket受信時(下のconnectQuakeWebSocket側)と同じ理由で、
          // dedupeQuakeList側が「同じ地震のより情報量の多いレコード」を優先して
          // 別idを採用することがある(アプリを開いている間に新着地震を選択した
          // 直後、/historyの取得が完了してより詳細なレコードに差し替わる場合など)。
          // ここでも同様に、消えたレコードのidだけを見て即座に選択解除するのでは
          // なく、まず「同じ発生時刻」の後継レコードを探し、見つかれば
          // そちらに選択を引き継ぐ(見つからない場合だけ選択解除する)。これが
          // 無いと、新着地震を選んだ直後に選択が解除され、詳細画面が一覧表示に
          // 戻ってしまう(ボタンバーは出たまま、戻るボタンは出ない)不具合になる。
          // (以前はtime+placeの一致で判定していたが、震度速報→震源に関する情報の
          // 間でplaceが「震源地不明」→実際の地名に変わるため、時刻のみで判定する)
          const selId = selectedQuakeIdRef.current;
          if (selId != null && !String(selId).startsWith("eqdb_") && !result.some(q => q.id === selId)) {
            const prevSelected = prev.find(q => q.id === selId) || null;
            const successor = prevSelected
              ? result.find(q => q.time === prevSelected.time)
              : null;
            console.log("[quake-select-diag][history-merge] 選択中の地震が一覧から消失", {
              selId,
              prevSelected: prevSelected && { id: prevSelected.id, time: prevSelected.time, place: prevSelected.place },
              successor: successor ? { id: successor.id, time: successor.time, place: successor.place } : null,
              引き継ぎ結果: successor ? `成功(id=${successor.id}へ引き継ぎ)` : "失敗(選択解除)",
            });
            selectQuake(successor ? successor.id : null);
          }

          return result;
        });
        setQuakeStatus("ready");
      })
      .catch(err => {
        console.error("地震情報の取得に失敗:", err);
        if (cancelled) return;
        setQuakeStatus("error");
      });

    fetchRecentTsunamis(TSUNAMI_FETCH_LIMIT)
      .then(list => {
        if (cancelled) return;
        setTsunamis(prev => {
          // 地震情報と同じ理由(WebSocketの新着が/historyより先に届くことがある)で、
          // idで統合してどちらか一方にしか無い分も残す。
          const byId = new Map();
          for (const t of list) byId.set(t.id, t);
          for (const t of prev) if (!byId.has(t.id)) byId.set(t.id, t);
          return dedupeTsunamiList(Array.from(byId.values())).slice(0, TSUNAMI_FETCH_LIMIT);
        });
        setTsunamiStatus("ready");
      })
      .catch(err => {
        console.error("津波情報の取得に失敗:", err);
        if (cancelled) return;
        setTsunamiStatus("error");
      });

    // 緊急地震速報の起動時バックフィル。アプリを開いた時点で既にEEWが発表されて
    // いた場合、WebSocketは「接続後に届いたもの」しか拾えず、次の続報が来るまで
    // 何も表示されないという抜けが起きる。それを防ぐため、/historyを1回だけ見て、
    // 十分新しければ(EEW_HISTORY_FRESHNESS_MS以内)通常のWebSocket受信と同じ経路
    // (handleIncomingEew)に流し込む。以降の続報・取消はWebSocketで通常通り届く。
    // P2P地震情報・Wolfxの両方から同時に取りに行き、どちらが先に届いても
    // handleIncomingEew側のマージロジックがWolfx優先で正しく解決する。
    fetchLatestFreshEew()
      .then(eew => {
        if (cancelled || !eew) return;
        handleIncomingEew(eew);
      })
      .catch(err => {
        console.error("緊急地震速報の起動時取得(P2P地震情報)に失敗:", err);
        // ここで失敗しても、以降のWebSocketライブ受信には影響しない。
      });
    fetchLatestFreshEewFromWolfx()
      .then(eew => {
        if (cancelled || !eew) return;
        handleIncomingEew(eew);
      })
      .catch(err => {
        console.error("緊急地震速報の起動時取得(Wolfx)に失敗:", err);
      });

    const socket = connectQuakeWebSocket(
      (newQuake) => {
        if (cancelled) return;
        console.log("[quake-select-diag][ws-receive] 新着地震をWebSocketで受信", {
          id: newQuake.id, time: newQuake.time, place: newQuake.place,
          pointsCount: Array.isArray(newQuake.points) ? newQuake.points.length : 0,
          現在選択中のid: selectedQuakeIdRef.current,
        });
        setQuakes(prev => {
          // 選択中の地震(あれば)を、差し替え前に控えておく。
          // dedupeQuakeList等で「同じ地震の新しいレコード」に統合された場合、
          // 選択状態をそちらへ引き継ぐために使う。
          const prevSelected = prev.find(q => q.id === selectedQuakeIdRef.current) || null;

          // 同一idの重複配信を除外しつつ、新着を先頭に追加する。
          // 件数は/historyの初期取得と揃えて設定値(quakeFetchLimit)までに抑える。
          const deduped = prev.filter(q => q.id !== newQuake.id);
          const merged = [newQuake, ...deduped].slice(0, quakeFetchLimit);
          // 同じ地震の「震度を持つレコード」と「震源だけの空レコード」が
          // 別々に届くことがあるため、都度まとめて重複排除しておく。
          const result = dedupeQuakeList(merged);

          // 選択中だった地震が、上記の処理で一覧から消えていないか確認する。
          // 消えていて、かつ「同じ発生時刻」の後継レコードが
          // 残っている場合は、そちらに選択状態を引き継ぐ(カード表示が
          // 突然一覧表示に戻ってしまう・戻るボタンだけ残る、といった
          // ズレを防ぐため)。完全に消えた(後継も無い)場合は選択解除する。
          // (M・深さ・placeは電文の段階が進むにつれて修正・確定されることが
          // あるため、一致条件には含めず時刻のみで判定する)
          if (prevSelected && !result.some(q => q.id === prevSelected.id)) {
            const successor = result.find(q => q.time === prevSelected.time);
            console.log("[quake-select-diag][ws-receive] 選択中の地震が一覧から消失", {
              prevSelected: { id: prevSelected.id, time: prevSelected.time, place: prevSelected.place },
              newQuake: { id: newQuake.id, time: newQuake.time, place: newQuake.place },
              successor: successor ? { id: successor.id, time: successor.time, place: successor.place } : null,
              引き継ぎ結果: successor ? `成功(id=${successor.id}へ引き継ぎ)` : "失敗(選択解除)",
            });
            selectQuake(successor ? successor.id : null);
          }

          return result;
        });
        setQuakeStatus("ready");
      },
      (newTsunami) => {
        if (cancelled) return;
        setTsunamis(prev => {
          const deduped = prev.filter(t => t.id !== newTsunami.id);
          return dedupeTsunamiList([newTsunami, ...deduped]).slice(0, TSUNAMI_FETCH_LIMIT);
        });
        setTsunamiStatus("ready");
      },
      (newEew) => {
        if (cancelled) return;
        handleIncomingEew(newEew);
      },
      (status) => { if (!cancelled) setWsStatus(status); }
    );

    return () => { cancelled = true; socket.close(); };
  }, [quakeFetchLimit]);

  // Wolfxの緊急地震速報WebSocket。P2P地震情報とは完全に別のドメイン・接続なので、
  // 専用のuseEffectで独立して繋ぐ(quakeFetchLimitの変更などで無駄に再接続
  // されないよう、依存配列は空にしている)。
  useEffect(() => {
    let cancelled = false;
    const wolfxSocket = connectWolfxEewWebSocket(
      (newEew) => {
        if (cancelled) return;
        handleIncomingEew(newEew);
      },
      () => {} // 接続状態の表示は今のところP2P側(wsStatus)のみを見せているため無視
    );
    return () => { cancelled = true; wolfxSocket.close(); };
  }, []);

  // 断層・プレート境界・観測点マーカー・推計震度分布・震央分布など、地震情報に
  // 関する地図表示は、地震タブ・設定タブを見ている間だけ出す。津波・気象・警報
  // タブを開いている間は表示をクリアする。ここで切り替えているのはMapCanvasに
  // 渡す「実効値」だけで、faultsEnabled等の設定値そのものは変えない
  // (地震タブに戻れば、元の設定のまま再び表示される)。
  // ただし津波タブで「↪︎津波を引き起こした地震」を表示している間だけは例外的に、
  // その地震の震源・観測点を地図に出す(causingQuakeCard参照)。
  // どちらのタブを見ていても、緊急地震速報の詳細画面(eewDetailOpen)を開いている
  // 間はEEW以外の表示を一切出さない(震源・観測点・断層・津波予報区の色分け等、
  // 緊急地震速報の内容に集中してもらうため)。
  const showQuakeMapLayers = !eewDetailOpen && (activeNav === "quake" || activeNav === "settings" || (activeNav === "tsunami" && causingQuakeCard != null));

  // 断層・プレート境界だけは例外。showQuakeMapLayers(震源・観測点・震度塗り分け等)は
  // 緊急地震速報の表示中はすべて隠すが、断層・プレート境界は地理的な背景情報であり、
  // EEWの震源位置を見る上でもむしろ有用なため、EEW表示中でも(元のタブに関わらず)
  // 設定のON/OFF(faultsEnabled/plateBoundariesEnabled)に従って表示できるようにする。
  const showFaultPlateLayers = showQuakeMapLayers || eewDetailOpen;

  // 津波予報区の色分けは、津波タブ・設定タブを見ている間に出す。
  // 実際にどの回の予報区を塗るかはtsunamiForMapDisplay(下)が決める。
  const showTsunamiMapLayers = !eewDetailOpen && (activeNav === "tsunami" || activeNav === "settings");
  const selectedFromRecent = effectiveTsunamis.find(t => t.id === selectedTsunamiId) || null;
  const selectedFromHistory = !selectedFromRecent
    ? (tsunamiHistory.items.find(t => t.id === selectedTsunamiId) || null)
    : null;
  const selectedTsunami = selectedFromRecent || selectedFromHistory;

  // 現在進行形で有効な(解除されていない)、一番新しい津波情報。
  // effectiveTsunamisは新しい順にソート済みなので、先頭の1件だけを見る。以前は
  // find(t => !t.cancelled)としており、一番新しい報が「解除」だった場合に
  // それを読み飛ばして1つ前の(すでに解除済みの)警報を「現在進行形」として
  // 扱ってしまっていた(解除後も地図の塗り分けが古い警報のまま残り続けるバグ)。
  const newestTsunami = effectiveTsunamis[0] || null;
  const activeTsunami = newestTsunami && !newestTsunami.cancelled ? newestTsunami : null;

  // 地図に出す海岸線の色分けは「直近一覧・履歴を問わず、何か選んでいればそれを
  // 最優先」する。選んでいる間は必ずその回の予報区が出る(=他の過去の津波を
  // 開けば、現在発表中の警報ではなくその回自体が表示される)。何も選んでいない
  // (一覧を眺めているだけ)時だけ、現在進行形で有効なactiveTsunamiを自動的に
  // 見せる。
  const tsunamiForMapDisplay = selectedTsunami || activeTsunami;

  // 今見せているのが「現在進行形で有効な津波情報(activeTsunami)」そのものか
  // どうか。潮位観測点ピン・観測された津波の高さバー(下のshowActiveTsunamiTideStations
  // 参照)は、リアルタイム観測データなので、activeTsunami以外(=他の過去の津波を
  // 見ている間)には出さない。
  const isViewingActiveTsunami =
    activeTsunami != null && (!selectedTsunami || selectedTsunami.id === activeTsunami.id);

  // activeTsunamiが属する「一連の現象」の第１報(最初の発表)の時刻。
  // TsunamiTab側の「引き起こした地震」検索(handleFindCausingQuake)と同じ
  // ヒューリスティック(隣り合う発表の間隔が24時間以内なら同じ現象とみなす)を使う。
  // 潮位データの取得範囲・最大波の探索開始時刻の両方の起点として使う
  // (続報のたびにactiveTsunami.timeは新しくなってしまうため、それをそのまま
  // 使うと第１報〜続報までの間の最大波を取りこぼす)。
  //
  // 直近一覧(effectiveTsunamis、最大50件)だけで24時間以内の間隔が一覧の先頭まで
  // 途切れず続いていた場合は、現象がその50件より前から続いている可能性がある
  // (=第１報を取りこぼす)ため、/jma/tsunami の履歴APIをページングして遡って
  // 本当の第１報を探す(レート制限が厳しいAPIのため、遡るページ数には上限を設ける)。
  function walkTsunamiEpisodeBack(sortedAsc, idx) {
    const GAP_LIMIT_MS = 24 * 60 * 60 * 1000; // 24時間以上の空きで別の現象とみなす
    let episodeStart = new Date(sortedAsc[idx].time);
    for (let i = idx; i > 0; i--) {
      const cur = new Date(sortedAsc[i].time);
      const prevTime = new Date(sortedAsc[i - 1].time);
      if (cur.getTime() - prevTime.getTime() > GAP_LIMIT_MS) return { episodeStart, reachedBoundary: true };
      episodeStart = prevTime;
    }
    return { episodeStart, reachedBoundary: false }; // 一覧の先頭に達してもなお空きが見つからなかった
  }

  // walkTsunamiEpisodeBackの逆(先へ辿る)版。過去の津波情報を選んで見ている時、
  // 「一連の現象」の解除時刻を求めるために使う(同じ24時間ギリギリのヒューリスティック)。
  // 解除(cancelled)報が見つかればそこで確定、見つからないまま一覧の末尾(=最新)に
  // 達した場合はreachedBoundary:falseを返す(=まだ解除報を確認できていない=
  // 現象が継続中の可能性がある、という意味)。
  function walkTsunamiEpisodeForward(sortedAsc, idx) {
    const GAP_LIMIT_MS = 24 * 60 * 60 * 1000;
    if (sortedAsc[idx].cancelled) return { episodeEnd: new Date(sortedAsc[idx].time), reachedBoundary: true };
    let cur = sortedAsc[idx];
    for (let i = idx; i < sortedAsc.length - 1; i++) {
      const next = sortedAsc[i + 1];
      if (new Date(next.time).getTime() - new Date(cur.time).getTime() > GAP_LIMIT_MS) {
        return { episodeEnd: null, reachedBoundary: true }; // ここで現象が途切れた=解除報を伴わずに終わった
      }
      cur = next;
      if (cur.cancelled) return { episodeEnd: new Date(cur.time), reachedBoundary: true };
    }
    return { episodeEnd: null, reachedBoundary: false }; // 一覧の末尾に達してもなお解除報が見つからなかった
  }

  const effectiveTsunamisRef = useRef(effectiveTsunamis);
  effectiveTsunamisRef.current = effectiveTsunamis;

  const tsunamiHistoryItemsRef = useRef(tsunamiHistory.items);
  tsunamiHistoryItemsRef.current = tsunamiHistory.items;

  const [activeTsunamiEpisodeStartTime, setActiveTsunamiEpisodeStartTime] = useState(null);
  useEffect(() => {
    if (!activeTsunami) { setActiveTsunamiEpisodeStartTime(null); return; }
    let cancelled = false;

    async function resolve() {
      let pool = dedupeTsunamiList(effectiveTsunamisRef.current);
      let sorted = [...pool].sort((a, b) => new Date(a.time) - new Date(b.time));
      let idx = sorted.findIndex(t => t.id === activeTsunami.id);
      if (idx < 0) { if (!cancelled) setActiveTsunamiEpisodeStartTime(new Date(activeTsunami.time)); return; }

      let { episodeStart, reachedBoundary } = walkTsunamiEpisodeBack(sorted, idx);

      const MAX_HISTORY_PAGES = 5; // 10リクエスト/分の制限があるAPIなので、遡りすぎないよう上限を設ける
      let offset = 0;
      while (!reachedBoundary && !cancelled && offset / TSUNAMI_HISTORY_PAGE_SIZE < MAX_HISTORY_PAGES) {
        let older;
        try {
          older = await fetchTsunamiHistoryPage(offset, TSUNAMI_HISTORY_PAGE_SIZE);
        } catch {
          break; // 取得に失敗したら、それまでに分かっている範囲で確定させる
        }
        if (!older || older.length === 0) break;
        const beforeCount = pool.length;
        pool = dedupeTsunamiList([...pool, ...older]);
        if (pool.length === beforeCount) break; // 追加分が全部重複だった→これ以上遡っても無駄
        sorted = [...pool].sort((a, b) => new Date(a.time) - new Date(b.time));
        idx = sorted.findIndex(t => t.id === activeTsunami.id);
        if (idx < 0) break;
        ({ episodeStart, reachedBoundary } = walkTsunamiEpisodeBack(sorted, idx));
        offset += TSUNAMI_HISTORY_PAGE_SIZE;
      }
      if (!cancelled) setActiveTsunamiEpisodeStartTime(episodeStart);
    }
    resolve();
    return () => { cancelled = true; };
  }, [activeTsunami?.id]);

  // 今見せているのが、activeTsunamiではない「過去の津波情報」かどうか。
  // (選んでいない=activeTsunamiをそのまま自動表示している間はfalse)
  const isViewingPastTsunami =
    selectedTsunami != null && (!activeTsunami || selectedTsunami.id !== activeTsunami.id);

  // 過去の津波情報を選んで見ている間、その「一連の現象」の開始(第１報)〜
  // 終了(解除報)の日時。潮位データの取得範囲(=第１報〜解除まで)と、その中での
  // 最大波の探索に使う。解除報が見つからない場合はend:null(=解除されないまま
  // 一覧が途切れている。まれなケースだが、その場合は「開始から一覧にある最後の
  // 報の時刻まで」を範囲とみなす)。
  const [selectedTsunamiEpisodeRange, setSelectedTsunamiEpisodeRange] = useState(null); // {start, end} | null
  useEffect(() => {
    if (!isViewingPastTsunami || !selectedTsunami) { setSelectedTsunamiEpisodeRange(null); return; }
    let cancelled = false;

    async function resolve() {
      let pool = dedupeTsunamiList([...effectiveTsunamisRef.current, ...tsunamiHistoryItemsRef.current]);
      let sorted = [...pool].sort((a, b) => new Date(a.time) - new Date(b.time));
      let idx = sorted.findIndex(t => t.id === selectedTsunami.id);
      if (idx < 0) {
        if (!cancelled) {
          const t = new Date(selectedTsunami.time);
          setSelectedTsunamiEpisodeRange({ start: t, end: selectedTsunami.cancelled ? t : t });
        }
        return;
      }

      let { episodeStart, reachedBoundary: startBoundary } = walkTsunamiEpisodeBack(sorted, idx);
      let { episodeEnd, reachedBoundary: endBoundary } = walkTsunamiEpisodeForward(sorted, idx);

      const MAX_HISTORY_PAGES = 5; // 10リクエスト/分の制限があるAPIなので、遡りすぎないよう上限を設ける
      let offset = 0;
      while ((!startBoundary || !endBoundary) && !cancelled && offset / TSUNAMI_HISTORY_PAGE_SIZE < MAX_HISTORY_PAGES) {
        let older;
        try {
          older = await fetchTsunamiHistoryPage(offset, TSUNAMI_HISTORY_PAGE_SIZE);
        } catch {
          break; // 取得に失敗したら、それまでに分かっている範囲で確定させる
        }
        if (!older || older.length === 0) break;
        const beforeCount = pool.length;
        pool = dedupeTsunamiList([...pool, ...older]);
        if (pool.length === beforeCount) break; // 追加分が全部重複だった→これ以上遡っても無駄
        sorted = [...pool].sort((a, b) => new Date(a.time) - new Date(b.time));
        idx = sorted.findIndex(t => t.id === selectedTsunami.id);
        if (idx < 0) break;
        if (!startBoundary) ({ episodeStart, reachedBoundary: startBoundary } = walkTsunamiEpisodeBack(sorted, idx));
        if (!endBoundary) ({ episodeEnd, reachedBoundary: endBoundary } = walkTsunamiEpisodeForward(sorted, idx));
        offset += TSUNAMI_HISTORY_PAGE_SIZE;
      }
      // 解除報がどうしても見つからない場合は、一覧にある最後(=一連の現象の中で
      // 一番新しい)報の時刻を終了時刻の代わりに使う(潮位データを取りこぼさないため、
      // 少し余裕を持たせた範囲になる)。
      if (!episodeEnd) {
        idx = sorted.findIndex(t => t.id === selectedTsunami.id);
        if (idx < 0) {
          episodeEnd = episodeStart; // 見失った場合は開始時刻をそのまま終了時刻とする
        } else {
          let lastIdx = idx;
          for (let i = idx; i < sorted.length - 1; i++) {
            if (new Date(sorted[i + 1].time).getTime() - new Date(sorted[i].time).getTime() > 24 * 60 * 60 * 1000) break;
            lastIdx = i + 1;
          }
          episodeEnd = new Date(sorted[lastIdx].time);
        }
      }
      if (!cancelled) setSelectedTsunamiEpisodeRange({ start: episodeStart, end: episodeEnd });
    }
    resolve();
    return () => { cancelled = true; };
  }, [isViewingPastTsunami, selectedTsunami?.id]);

  const tsunamiAreasForMap =
    !showTsunamiMapLayers || !tsunamiForMapDisplay || tsunamiForMapDisplay.cancelled
      ? EMPTY_EQDB_LIST
      : tsunamiForMapDisplay.areas;

  // 潮位観測点ごとに「一番近い津波予報区」を、都道府県名などのあいまいな情報ではなく、
  // 地図の海岸線描画に実際使っているtsunami-areas.json(座標データ)との距離計算で
  // 幾何学的に求める。観測点は動かないため、1回計算できればあとは使い回せる。
  const [tsunamiAreasGeoData, setTsunamiAreasGeoData] = useState(null);
  useEffect(() => {
    if (tideStations.length === 0 || tsunamiAreasGeoData) return;
    loadTsunamiAreasData()
      .then(setTsunamiAreasGeoData)
      .catch(err => console.error("津波予報区データ(座標)の取得に失敗:", err));
  }, [tideStations.length, tsunamiAreasGeoData]);

  const tideStationsWithArea = useMemo(() => {
    if (!tsunamiAreasGeoData || tideStations.length === 0) return tideStations;
    return tideStations.map(st => {
      const nearest = findNearestTsunamiArea(st.lat, st.lon, tsunamiAreasGeoData);
      return nearest ? { ...st, tsunamiAreaName: nearest.name, tsunamiAreaCode: nearest.code } : st;
    });
  }, [tideStations, tsunamiAreasGeoData]);

  // 津波警報テスト配信で「予報区」として選んでいる(まだ配信前の作業中の)ものに
  // 実際に属する観測点の候補一覧。地図タップではなく、この一覧からプルダウンで
  // 選べるようにすることで、配信後に必ずactiveGradeが付く(=バーがちゃんと出る)
  // 組み合わせだけを選ばせられる。
  const candidateHeightStations = useMemo(() => {
    const areaNames = new Set(pickedTsunamiAreas.map(a => a.name));
    if (areaNames.size === 0) return EMPTY_EQDB_LIST;
    return tideStationsWithArea.filter(st => st.tsunamiAreaName && areaNames.has(st.tsunamiAreaName));
  }, [pickedTsunamiAreas, tideStationsWithArea]);

  // 予報区の選択を後から変えて、既に高さを設定していた観測点が対象外になった場合は
  // 一覧からも取り除く(配信しても反映されない設定が残り続けるのを防ぐ)。
  useEffect(() => {
    setPickedTsunamiHeights(prev => {
      const validCodes = new Set(candidateHeightStations.map(st => st.code));
      const next = prev.filter(h => validCodes.has(h.code));
      return next.length === prev.length ? prev : next;
    });
  }, [candidateHeightStations]);

  // 潮位観測点に、現在有効な津波情報の警報グレードを対応付ける。上で求めた
  // 「一番近い予報区の正式名称」と、津波情報側のareas[].nameを完全一致で照合するため、
  // 都道府県名だけで大まかに合わせていた以前の方式より正確なはず。
  const tideStationsWithGrade = useMemo(() => {
    if (!activeTsunami || activeTsunami.cancelled || !Array.isArray(activeTsunami.areas) || activeTsunami.areas.length === 0) {
      return tideStationsWithArea;
    }
    return tideStationsWithArea.map(st => {
      if (!st.tsunamiAreaName) return st;
      const match = activeTsunami.areas.find(a => a.name === st.tsunamiAreaName);
      return match ? { ...st, activeGrade: match.grade } : st;
    });
  }, [tideStationsWithArea, activeTsunami]);

  // 過去の(activeTsunamiではない)津波情報を選んで見ている間、その回の対象予報区に
  // 属する観測点一覧。tideStationsWithGradeはactiveTsunami(ライブ監視)専用なので、
  // 過去分はここで別途、selectedTsunami.areasと照合して求める。
  const selectedTsunamiTideStations = useMemo(() => {
    if (!isViewingPastTsunami || !selectedTsunami || !Array.isArray(selectedTsunami.areas) || selectedTsunami.areas.length === 0) {
      return EMPTY_EQDB_LIST;
    }
    const result = [];
    for (const st of tideStationsWithArea) {
      if (!st.tsunamiAreaName) continue;
      const match = selectedTsunami.areas.find(a => a.name === st.tsunamiAreaName);
      if (match) result.push({ ...st, activeGrade: match.grade });
    }
    return result;
  }, [isViewingPastTsunami, selectedTsunami, tideStationsWithArea]);

  // 潮位観測点(発令中の予報区分)の表示/非表示。地震タブの観測点表示ボタンと
  // 同じ考え方で、パネルの外に浮かぶ丸ボタンから切り替える。
  const [tideStationMarkersVisible, setTideStationMarkersVisible] = useState(true);
  // 新しく津波情報が有効になるたびに、必ず「表示」状態からスタートする
  // (前回OFFにしたまま覚えておくと、次の警報で見落とす恐れがあるため)。
  useEffect(() => {
    if (activeTsunami != null) setTideStationMarkersVisible(true);
  }, [activeTsunami?.id]);

  // 潮位観測点ピンの自動表示: 有効な津波情報がある間・かつ「引き起こした地震」を
  // 見ていない間だけ(その間は震度観測点の表示に専念させたいため、地震タブ同様
  // stationMarkersVisibleがfalseから始まる=causingQuakeCardのuseEffect参照)。
  // それに加えて、今見ている津波情報がactiveTsunami自身である間だけに限定する
  // (isViewingActiveTsunami)。これが無いと、他の過去の津波を開いている間も
  // activeTsunami分の観測点ピンが残ってしまう。
  // 潮位計モード(手動で観測点一覧を見ている間)は、そちらの全件表示が優先されるため
  // ここでは判定しない(下のtideStationPoints算出側でshowTideGaugeLayerを優先している)。
  const showActiveTsunamiTideStations =
    showTsunamiMapLayers && causingQuakeCard == null && isViewingActiveTsunami && tideStationMarkersVisible;

  /* ─────────────────────────────────────────────────────
     観測された津波の高さ(地図上のバー表示)。
     気象庁の電文(有料)は使わず、既に取得している潮位観測データ(潮位偏差=
     実測潮位−天文潮位。TideStationDetailで表示しているものと同じ値)から、
     警報等の発表時刻以降で絶対値が最大になった値を「観測された津波の高さ」として
     使う(computeMaxTsunamiHeightCm参照。気象庁の考え方に沿った近似値)。
     ・対象は発令中の予報区の観測点のみ(全国の観測点を取りに行くと重くなるため)。
     ・同時リクエスト数を絞ったワーカープールで順に取得する(fetchTideStations等と
       同じ考え方)。
     ・警報等が続く間は最大波が更新され得るので、数分おきに再取得する。
     ・±0.2m未満は「微弱」として扱い、バー自体を表示しない
       (気象庁も同程度の小さい値は数値を出さない運用のため)。
     ───────────────────────────────────────────────────── */
  const warnedStationCodesKey = useMemo(
    () => tideStationsWithGrade.filter(s => s.activeGrade).map(s => s.code).sort().join(","),
    [tideStationsWithGrade]
  );
  useEffect(() => {
    if (!activeTsunami || !warnedStationCodesKey) return;
    const overrides = activeTsunami.heightOverrides || null;
    // テスト配信で手入力の高さを設定済みの観測点は、実データが無くても表示できるので
    // 取得をスキップする(無駄なリクエストを増やさないため)。
    const codes = warnedStationCodesKey.split(",").filter(code => !(overrides && overrides[code] != null));
    if (codes.length === 0) return;
    let cancelled = false;
    const CONCURRENCY = 4; // 同時に投げる数を絞って、重くならないようにする

    async function runPool(force) {
      let nextIndex = 0;
      async function worker() {
        while (!cancelled) {
          const i = nextIndex++;
          if (i >= codes.length) return;
          await loadTideObs(codes[i], force);
        }
      }
      const workers = [];
      for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
      await Promise.all(workers);
    }

    runPool(false); // 初回は「未取得の分だけ」取得する

    // 警報等が続いている間、最大波が更新されていないか3分おきに取得し直す。
    const REFRESH_MS = 3 * 60 * 1000;
    const intervalId = setInterval(() => { if (!cancelled) runPool(true); }, REFRESH_MS);

    return () => { cancelled = true; clearInterval(intervalId); };
  }, [warnedStationCodesKey, activeTsunami != null]);

  // 観測点コードごとの、観測された津波の高さ(メートル、符号付き)。
  // ±0.2m未満は「微弱」としてnull扱いにする(バーを出さない)。
  const TSUNAMI_HEIGHT_NEGLIGIBLE_M = 0.2;
  const tsunamiHeightByStation = useMemo(() => {
    if (!activeTsunami) return {};
    const startMs = new Date(activeTsunami.time).getTime(); // テスト配信の手入力値用の近似時刻
    // 実データの最大波探索は、続報のたびに更新されるactiveTsunami.timeではなく、
    // 一連の現象の第１報の時刻を起点にする(そうしないと第１報〜続報までの間の
    // 最大波を取りこぼすため)。
    const episodeStartMs = activeTsunamiEpisodeStartTime ? activeTsunamiEpisodeStartTime.getTime() : startMs;
    if (!Number.isFinite(startMs)) return {};
    const overrides = activeTsunami.heightOverrides || null; // テスト配信用の手入力値(App側参照)
    const result = {};
    tideStationsWithGrade.forEach(st => {
      if (!st.activeGrade) return;
      if (overrides && overrides[st.code] != null) {
        const m = overrides[st.code];
        if (Math.abs(m) >= TSUNAMI_HEIGHT_NEGLIGIBLE_M) result[st.code] = m; // 手入力値も微弱ルールは同様に適用
        return;
      }
      const obs = tideObsByStation[st.code];
      if (!obs || obs.status !== "ready" || !obs.data) return;
      const max = computeMaxTsunamiHeightCm(obs.data, episodeStartMs);
      if (max == null) return;
      const m = max.cm / 100;
      if (Math.abs(m) < TSUNAMI_HEIGHT_NEGLIGIBLE_M) return; // 微弱
      result[st.code] = m;
    });
    return result;
  }, [activeTsunami, activeTsunamiEpisodeStartTime, tideStationsWithGrade, tideObsByStation]);

  // 観測点コードごとの、最大波を観測した時刻(エポックms)。テスト配信の手入力値には
  // 実際の観測時刻が無いため、代わりに配信時刻(activeTsunami.time)を使う
  // (近似だが、テスト用途としては十分)。
  const tsunamiHeightTimeByStation = useMemo(() => {
    if (!activeTsunami) return {};
    const startMs = new Date(activeTsunami.time).getTime();
    if (!Number.isFinite(startMs)) return {};
    const episodeStartMs = activeTsunamiEpisodeStartTime ? activeTsunamiEpisodeStartTime.getTime() : startMs;
    const overrides = activeTsunami.heightOverrides || null;
    const result = {};
    tideStationsWithGrade.forEach(st => {
      if (!st.activeGrade || tsunamiHeightByStation[st.code] == null) return;
      if (overrides && overrides[st.code] != null) {
        result[st.code] = startMs; // テスト配信: 配信時刻を代わりに使う
        return;
      }
      const obs = tideObsByStation[st.code];
      if (!obs || obs.status !== "ready" || !obs.data) return;
      const max = computeMaxTsunamiHeightCm(obs.data, episodeStartMs);
      if (max?.timeMs != null) result[st.code] = max.timeMs;
    });
    return result;
  }, [activeTsunami, activeTsunamiEpisodeStartTime, tideStationsWithGrade, tideObsByStation, tsunamiHeightByStation]);

  /* ─────────────────────────────────────────────────────
     過去の津波情報を選んで見ている間の潮位データ・最大波。
     activeTsunami用(tideObsByStation)は「当日を含む直近日」しか取得しないため、
     過去の任意の期間には使えない。ここでは、対象観測点それぞれについて
     「一連の現象」の第１報の日〜解除の日までを個別に取得し(historicalTideObsByStation、
     `${tsunamiId}::${code}`をキーにしてactiveTsunami用のキャッシュとは独立させる)、
     その範囲内で潮位偏差が正の値(山)の最大のものを最大波として計算する。
     ───────────────────────────────────────────────────── */
  // 形: { "tsunamiId::stationCode": { status: "loading"|"ready"|"error", data } }
  const [historicalTideObsByStation, setHistoricalTideObsByStation] = useState({});
  const historicalTideObsRequestedRef = useRef(new Set()); // 取得を開始済みのキー(重複フェッチ防止)
  useEffect(() => {
    if (!isViewingPastTsunami || !selectedTsunami || !selectedTsunamiEpisodeRange || selectedTsunamiTideStations.length === 0) return;
    let cancelled = false;
    const { start, end } = selectedTsunamiEpisodeRange;
    const endDate = end || new Date(); // 稀に解除が確認できなかった場合は現在時刻まで
    const tsunamiId = selectedTsunami.id;

    // 気象庁の潮位観測値(tide_obs)は直近1週間程度分しか提供されておらず、
    // それより古い日付を指定するとエラーになる。対象期間の終端(=取得対象の
    // うち最も新しい日)がすでに1週間以上前なら、取得を試みるだけ無駄なので
    // APIを叩かずに「取得不可」として扱う。
    const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const isTooOldToFetch = Date.now() - endDate.getTime() > ONE_WEEK_MS;

    async function run() {
      for (const st of selectedTsunamiTideStations) {
        if (cancelled) return;
        const key = `${tsunamiId}::${st.code}`;
        if (historicalTideObsRequestedRef.current.has(key)) continue; // 取得済み・取得中ならスキップ
        historicalTideObsRequestedRef.current.add(key);
        if (isTooOldToFetch) {
          // 1週間以上前のデータは気象庁側に無くエラーになるだけなので、
          // リクエストを送らずに直接「取得失敗」扱いにする。
          setHistoricalTideObsByStation(prev => ({ ...prev, [key]: { status: "error", data: null } }));
          continue;
        }
        setHistoricalTideObsByStation(prev => ({ ...prev, [key]: { status: "loading", data: null } }));
        try {
          const data = await fetchTideObsForDateRange(st.code, start, endDate);
          if (cancelled) return;
          setHistoricalTideObsByStation(prev => ({ ...prev, [key]: { status: "ready", data } }));
        } catch (err) {
          console.error(`過去の津波の潮位観測値の取得に失敗(${st.code}):`, err);
          if (cancelled) return;
          setHistoricalTideObsByStation(prev => ({ ...prev, [key]: { status: "error", data: null } }));
        }
      }
    }
    run();
    return () => { cancelled = true; };
  }, [isViewingPastTsunami, selectedTsunami, selectedTsunamiEpisodeRange, selectedTsunamiTideStations]);

  // 観測点コードごとの、過去の津波で観測された最大波(メートル、正の値のみ)。
  const historicalTsunamiHeightByStation = useMemo(() => {
    if (!isViewingPastTsunami || !selectedTsunami || !selectedTsunamiEpisodeRange) return {};
    const startMs = selectedTsunamiEpisodeRange.start.getTime();
    const result = {};
    selectedTsunamiTideStations.forEach(st => {
      const entry = historicalTideObsByStation[`${selectedTsunami.id}::${st.code}`];
      if (!entry || entry.status !== "ready" || !entry.data) return;
      const max = computeMaxTsunamiHeightCm(entry.data, startMs);
      if (max == null) return;
      const m = max.cm / 100;
      if (m < TSUNAMI_HEIGHT_NEGLIGIBLE_M) return; // 微弱
      result[st.code] = m;
    });
    return result;
  }, [isViewingPastTsunami, selectedTsunami, selectedTsunamiEpisodeRange, selectedTsunamiTideStations, historicalTideObsByStation]);

  // 観測点コードごとの、過去の津波で最大波を観測した時刻(エポックms)。
  const historicalTsunamiHeightTimeByStation = useMemo(() => {
    if (!isViewingPastTsunami || !selectedTsunami || !selectedTsunamiEpisodeRange) return {};
    const startMs = selectedTsunamiEpisodeRange.start.getTime();
    const result = {};
    selectedTsunamiTideStations.forEach(st => {
      if (historicalTsunamiHeightByStation[st.code] == null) return;
      const entry = historicalTideObsByStation[`${selectedTsunami.id}::${st.code}`];
      if (!entry || entry.status !== "ready" || !entry.data) return;
      const max = computeMaxTsunamiHeightCm(entry.data, startMs);
      if (max?.timeMs != null) result[st.code] = max.timeMs;
    });
    return result;
  }, [isViewingPastTsunami, selectedTsunami, selectedTsunamiEpisodeRange, selectedTsunamiTideStations, historicalTideObsByStation, historicalTsunamiHeightByStation]);

  // 地図に表示する観測点一覧。丸の色(dotColor)は、予報区の公式グレードではなく
  // 実際に観測された津波の高さ(tsunamiHeightByStation)から決める
  // (tsunamiHeightBandColor参照。未観測・微弱の間は薄グレー)。
  const tideStationsForMap = useMemo(() => {
    return tideStationsWithGrade.map(st => ({
      ...st,
      dotColor: tsunamiHeightBandColor(tsunamiHeightByStation[st.code]),
    }));
  }, [tideStationsWithGrade, tsunamiHeightByStation]);

  // 発令中の予報区の観測点一覧(地図の自動表示用)。選択中の観測点は、続報の
  // 反映タイミング等で一瞬対象予報区から外れても一覧に残すようにする。そうしないと
  // 選択中の丸が地図から消えてしまい、「タップしても強調されない」ように見えるため。
  const warnedTideStationsForMap = useMemo(() => {
    const warned = tideStationsForMap.filter(s => s.activeGrade);
    if (selectedTideStationCode != null && !warned.some(s => s.code === selectedTideStationCode)) {
      const selected = tideStationsForMap.find(s => s.code === selectedTideStationCode);
      if (selected) return [...warned, selected];
    }
    return warned;
  }, [tideStationsForMap, selectedTideStationCode]);

  // 地図に描く「観測された津波の高さ」バー。高さ(m)を0〜1に正規化した値(heightT)に
  // しておき、実際のピクセル上のバーの長さはMapCanvas側で決める(ズームで見た目の
  // 長さが変わらないよう、アイコンのピクセルサイズとして描画するため)。色は観測点の
  // 丸と同じtsunamiHeightBandColorを使い、2つのレイヤーの色がズレないようにする。
  const TSUNAMI_HEIGHT_BAR_MAX_M = 10;
  const tsunamiHeightBars = useMemo(() => {
    return tideStationsWithGrade
      .filter(st => st.activeGrade && tsunamiHeightByStation[st.code] != null)
      .map(st => {
        const heightM = tsunamiHeightByStation[st.code];
        const clamped = Math.min(Math.abs(heightM), TSUNAMI_HEIGHT_BAR_MAX_M);
        const heightT = (clamped - TSUNAMI_HEIGHT_NEGLIGIBLE_M) / (TSUNAMI_HEIGHT_BAR_MAX_M - TSUNAMI_HEIGHT_NEGLIGIBLE_M);
        return {
          code: st.code,
          name: st.name,
          heightM,
          heightT,
          color: tsunamiHeightBandColor(heightM),
          lng: st.lon,
          lat: st.lat,
        };
      });
  }, [tideStationsWithGrade, tsunamiHeightByStation]);

  // 過去の津波を選んで見ている間に地図に出す観測点(丸)・バー。ライブ監視用の
  // tideStationsForMap/tsunamiHeightBarsと全く同じ組み立て方を、対象データだけ
  // selectedTsunamiTideStations/historicalTsunamiHeightByStationに差し替えて使う。
  // 潮位データが取得できていない(未取得・取得中・失敗)観測点は表示しない
  // ——ライブ監視と違い、過去分は「観測点はあるが値はまだ来ていない」という
  // 状態が長く続くことは無い(取得済みか失敗かのどちらか)ため、取得できたものだけに絞る。
  const historicalTideStationsForMap = useMemo(() => {
    return selectedTsunamiTideStations
      .filter(st => {
        const entry = historicalTideObsByStation[`${selectedTsunami?.id}::${st.code}`];
        return entry?.status === "ready";
      })
      .map(st => ({
        ...st,
        dotColor: tsunamiHeightBandColor(historicalTsunamiHeightByStation[st.code]),
      }));
  }, [selectedTsunamiTideStations, historicalTsunamiHeightByStation, historicalTideObsByStation, selectedTsunami]);

  const historicalTsunamiHeightBars = useMemo(() => {
    return selectedTsunamiTideStations
      .filter(st => historicalTsunamiHeightByStation[st.code] != null)
      .map(st => {
        const heightM = historicalTsunamiHeightByStation[st.code];
        const clamped = Math.min(heightM, TSUNAMI_HEIGHT_BAR_MAX_M);
        const heightT = (clamped - TSUNAMI_HEIGHT_NEGLIGIBLE_M) / (TSUNAMI_HEIGHT_BAR_MAX_M - TSUNAMI_HEIGHT_NEGLIGIBLE_M);
        return {
          code: st.code,
          name: st.name,
          heightM,
          heightT,
          color: tsunamiHeightBandColor(heightM),
          lng: st.lon,
          lat: st.lat,
        };
      });
  }, [selectedTsunamiTideStations, historicalTsunamiHeightByStation]);

  // 過去の津波の観測点・バーを地図に出すかどうか。ライブ監視用のshowActiveTsunamiTideStations
  // と同じ考え方で、こちらはisViewingPastTsunamiの間だけ出す。
  // 過去分は参照専用の表示なので、観測点の表示/非表示ボタン(tideStationMarkersVisible)は
  // 関与させない(常にオンとして扱い、ボタン自体は無効化してタップできないようにする
  // ——後述のStationMarkerToggleButton側の対応、及びMapCanvas側のタップ無効化と対)。
  const showHistoricalTsunamiTideStations =
    showTsunamiMapLayers && causingQuakeCard == null && isViewingPastTsunami && selectedTsunamiTideStations.length > 0;

  // 津波タブの予報区一覧(TsunamiAreaRow)に渡す「観測点ごとの最大波」データ。
  // 過去の津波を選んで見ている間はhistorical側(第１報〜解除の期間で計算したもの)、
  // それ以外(ライブ監視中)は従来通りactiveTsunami用の値を使う。
  const tsunamiHeightByStationForDisplay = isViewingPastTsunami ? historicalTsunamiHeightByStation : tsunamiHeightByStation;
  const tsunamiHeightTimeByStationForDisplay = isViewingPastTsunami ? historicalTsunamiHeightTimeByStation : tsunamiHeightTimeByStation;

  // 潮位観測点ピン(発令中の予報区分。潮位計モードでない間に表示しているもの)を
  // 地図上でタップした時、手動で潮位計モードに入って観測点を選んだ時と同じ体験に
  // したいので、選択だけでなく「潮位計モードに切り替えてほしい」という信号も
  // 一緒に送る。mapSelectSignal(震央分布の丸タップ)と同じ「タップのたびに1増える
  // だけの値」パターンを踏襲し、BottomDock側のuseEffectで実際の切り替えを行う。
  const [tideStationSelectSignal, setTideStationSelectSignal] = useState(0);
  function handleSelectTideStationOnMap(code) {
    setSelectedTideStationCode(code);
    setTideStationSelectSignal(n => n + 1);
  }

  return (
    <ThemeContext.Provider value={themeContextValue}>
    <GlassOpaqueContext.Provider value={glassOpaqueContextValue}>
    <QuakeColorSchemeContext.Provider value={quakeColorScheme}>
    <NowcastColorSchemeContext.Provider value={nowcastColorScheme}>
      <GlobalStyles tokens={themeContextValue.tokens}/>
      <Filters/>

      <div style={{ height: "100%", position: "relative", overflow: "hidden", background: themeContextValue.tokens.pageBg }}>

        {/* ── Layer 1: 地図（Liquid Glassが透かす背景） ── */}
        <MapCanvas
          onReady={setMap}
          currentLocationPoint={currentLocationPoint}
          nowcastVisible={activeNav === "weather" && !!nowcastFrame}
          nowcastFrame={nowcastFrame}
          nowcastPreloadFrames={nowcastPreloadFrames}
          nowcastKnownValidtimes={nowcastKnownValidtimes}
          nowcastColorSchemeId={nowcastColorScheme}
          precipVisible={activeNav === "weather" && !!precipFrame}
          precipMode={precipMode}
          precipFrame={precipFrame}
          precipKnownValidtimes={precipKnownValidtimes}
          wdistVisible={activeNav === "weather" && !!wdistFrame}
          wdistMode={wdistMode}
          wdistFrame={wdistFrame}
          wdistKnownValidtimes={wdistKnownValidtimes}
          typhoonVisible={activeNav === "weather" && !!typhoonGeojson}
          typhoonGeojson={typhoonGeojson}
          onSelectTyphoonCenter={handleSelectTyphoonCenter}
          typhoonFlyToRequest={typhoonFlyToRequest}
          warningVisible={activeNav === "alert"}
          warningLevelMap={warningLevelMap}
          selectedWarningArea={selectedWarningArea}
          onSelectWarningArea={handleSelectWarningArea}
          warningAreaFlyToRequest={warningAreaFlyToRequest}
          riskVisible={activeNav === "alert" && !!alertLayerFrame}
          riskMode={alertLayerMode}
          riskFrame={alertLayerFrame}
          riskKnownValidtimes={alertLayerKnownValidtimes}
          riverVisible={activeNav === "alert" && alertLayerMode === "riverLevel" && !!riverStations}
          riverStations={riverStations}
          selectedRiverStation={selectedRiverStation}
          onSelectRiverStation={handleSelectRiverStation}
          stationPoints={showQuakeMapLayers ? (causingQuakeCard ? causingQuakeCard.resolvedPoints || EMPTY_EQDB_LIST : selectedQuakePoints) : EMPTY_EQDB_LIST}
          stationMarkersVisible={showQuakeMapLayers && stationMarkersVisible}
          tideStationPoints={
            showTideGaugeLayer ? tideStationsForMap
            : showActiveTsunamiTideStations ? warnedTideStationsForMap
            : showHistoricalTsunamiTideStations ? historicalTideStationsForMap
            : EMPTY_EQDB_LIST
          }
          onSelectTideStation={handleSelectTideStationOnMap}
          selectedTideStationCode={selectedTideStationCode}
          tsunamiHeightBars={
            showActiveTsunamiTideStations ? tsunamiHeightBars
            : showHistoricalTsunamiTideStations ? historicalTsunamiHeightBars
            : EMPTY_EQDB_LIST
          }
          tideStationBarsMode={showActiveTsunamiTideStations || showHistoricalTsunamiTideStations}
          // 過去の津波の観測点・バーは参照専用の表示なので、タップ(選択・詳細表示)を
          // 無効にする。ライブ監視中(showActiveTsunamiTideStations)・潮位計モードでは
          // 従来通りタップ可能。
          tideStationsInteractive={!showHistoricalTsunamiTideStations}
          hypocenters={showQuakeMapLayers ? (causingQuakeCard ? causingQuakeHypocenters : selectedHypocenters) : EMPTY_EQDB_LIST}
          isWide={isWide}
          quakeTimeStr={causingQuakeCard ? causingQuakeCard.time : selectedQuake?.time}
          maxIntensityKey={causingQuakeCard ? causingQuakeCard.maxIntensity : selectedQuake?.maxIntensity}
          estIntensityEnabled={showQuakeMapLayers && estIntensityEnabled}
          areaFillEnabled={showQuakeMapLayers && areaFillEnabled}
          faultsEnabled={showFaultPlateLayers && faultsEnabled}
          plateBoundariesEnabled={showFaultPlateLayers && plateBoundariesEnabled}
          boundaryLineColorId={boundaryLineColorId}
          epicenterPoints={showQuakeMapLayers ? epicenterPoints : EMPTY_EQDB_LIST}
          onSelectEpicenterPoint={handleSelectEpicenterPoint}
          pointsLoading={showQuakeMapLayers && stationPointsProcessing}
          epicenterLoading={showQuakeMapLayers && epicenterLoading}
          tsunamiAreas={tsunamiAreasForMap}
          tsunamiAreaPickActive={tsunamiAreaPickActive}
          onPickTsunamiArea={handlePickTsunamiArea}
          pickedTsunamiAreas={pickedTsunamiAreas}
          eews={effectiveEews}
          eewEpicenterPickActive={eewEpicenterPickActive}
          onPickEewEpicenter={handlePickEewEpicenter}
          quakeEpicenterPickActive={quakeEpicenterPickActive}
          onPickQuakeEpicenter={handlePickQuakeEpicenter}
          eewDetailOpen={eewDetailOpen}
        />

        {/* 津波テスト配信「地図タップで選択」中のバナー — 画面上部中央に浮かぶ。
            上段: 指示文・選択件数・キャンセル/完了ボタン。
            下段: 「今タップしたらどのグレードで塗るか」を選ぶパレット。予報区ごとに
            違うグレードを割り当てたいので、パレットで切り替えてからタップする方式。
            複数の予報区を選べるようにするため、1回タップしただけではモードを終えず、
            「完了」を押すまで何度でもタップし直せる。「キャンセル」はピック開始時点の
            選択に戻す。 */}
        {tsunamiAreaPickActive && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            left: 0, right: 0,
            display: "flex", justifyContent: "center",
            zIndex: 30, padding: "0 16px",
          }}>
            <Glass radius={22} style={{
              display: "flex", flexDirection: "column", gap: 8,
              padding: "10px 12px",
              animation: "appear 0.3s cubic-bezier(.25,1,.5,1)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: themeContextValue.tokens.text, flex: 1 }}>
                  海岸線をタップして予報区を選択
                  {pickedTsunamiAreas.length > 0 && `(${pickedTsunamiAreas.length}件選択中)`}
                </span>
                <PressableButton
                  type="button"
                  onClick={cancelTsunamiAreaPick}
                  style={{
                    flexShrink: 0, padding: "6px 12px", borderRadius: 999, border: "none", cursor: "pointer",
                    background: `rgba(${themeContextValue.tokens.ink},0.08)`,
                    fontSize: 12, fontWeight: 700, color: themeContextValue.tokens.textSecondary,
                  }}
                >
                  キャンセル
                </PressableButton>
                <PressableButton
                  type="button"
                  onClick={finishTsunamiAreaPick}
                  style={{
                    flexShrink: 0, padding: "6px 14px", borderRadius: 999, border: "none", cursor: "pointer",
                    background: "#0A84FF",
                    fontSize: 12, fontWeight: 700, color: "#fff",
                  }}
                >
                  完了
                </PressableButton>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11, color: themeContextValue.tokens.textSecondary, flexShrink: 0 }}>
                  塗るグレード:
                </span>
                {TEST_TSUNAMI_GRADE_OPTIONS.map(opt => {
                  const active = activePickGrade === opt.value;
                  const color = tsunamiGradeInfo(opt.value).color;
                  return (
                    <PressableButton
                      key={opt.value}
                      type="button"
                      onClick={() => setActivePickGrade(opt.value)}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 5,
                        padding: "5px 10px 5px 8px", borderRadius: 999, cursor: "pointer",
                        border: active ? `1.5px solid ${color}` : "1.5px solid transparent",
                        background: active ? `${color}26` : `rgba(${themeContextValue.tokens.ink},0.05)`,
                        fontSize: 11, fontWeight: 700,
                        color: active ? themeContextValue.tokens.text : themeContextValue.tokens.textSecondary,
                      }}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: 999, background: color, flexShrink: 0 }}/>
                      {opt.label}
                    </PressableButton>
                  );
                })}
              </div>
            </Glass>
          </div>
        )}

        {/* 緊急地震速報テスト配信「地図をタップして震源を指定」中のバナー。
            震源は1点だけなので津波の予報区ピックと違って複数タップの積み上げは不要
            ─ タップした瞬間に確定し、自動的にモードを終える(MapCanvas側のクリック
            ハンドラ→handlePickEewEpicenterでeewEpicenterPickActiveをfalseに戻している)。
            ここでは「今からタップする」ことを案内し、途中でやめられるように
            キャンセルボタンだけ出す。 */}
        {eewEpicenterPickActive && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            left: 0, right: 0,
            display: "flex", justifyContent: "center",
            zIndex: 30, padding: "0 16px",
          }}>
            <Glass radius={22} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 12px",
              animation: "appear 0.3s cubic-bezier(.25,1,.5,1)",
            }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: themeContextValue.tokens.text }}>
                地図をタップして震源を指定
              </span>
              <PressableButton
                type="button"
                onClick={() => handleTestEewAction("cancelEpicenterPick")}
                style={{
                  flexShrink: 0, padding: "6px 12px", borderRadius: 999, border: "none", cursor: "pointer",
                  background: `rgba(${themeContextValue.tokens.ink},0.08)`,
                  fontSize: 12, fontWeight: 700, color: themeContextValue.tokens.textSecondary,
                }}
              >
                キャンセル
              </PressableButton>
            </Glass>
          </div>
        )}

        {/* 震度凡例 — 地震を選択している間だけ、画面右上に縦並びで浮かぶ。
            緊急地震速報の詳細を表示中(eewDetailOpen)は、EEW側に別の凡例
            (震度の予測範囲の凡例)があるため、こちらは隠す。これが無いと、
            地震タブで地震を選択したまま緊急地震速報が開いた時、地震の震度凡例が
            EEWの表示に重なって残ってしまっていた。 */}
        {!eewDetailOpen && activeNav === "quake" && selectedQuake && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <QuakeIntensityLegend maxIntensity={selectedQuake.maxIntensity} legacyIntensityScale={selectedQuake.legacyIntensityScale}/>
          </div>
        )}

        {/* 津波予報凡例 — 津波の予報区を地図に塗っている間だけ、画面右上に浮かぶ(震度凡例と対の構成) */}
        {activeNav === "tsunami" && tsunamiAreasForMap.length > 0 && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <TsunamiGradeLegend areas={tsunamiAreasForMap} tsunamiHeightByStation={tsunamiHeightByStation}/>
          </div>
        )}

        {/* 雨雲レーダー凡例 — レーダーレイヤーを表示している間だけ、画面右上に浮かぶ
            (震度凡例・津波凡例と対の構成)。 */}
        {activeNav === "weather" && nowcastFrame && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <NowcastLegend/>
          </div>
        )}

        {/* 1/3/24時間降水量の凡例 — 雨雲レーダーとは排他なので同時には出ないが、
            同じ位置・同じ構成で出す。 */}
        {activeNav === "weather" && precipMode && precipFrame && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <PrecipLegend mode={precipMode}/>
          </div>
        )}

        {/* 天気分布予報の凡例 — 他とは全て排他なので同時には出ないが、
            同じ位置に出す。 */}
        {activeNav === "weather" && wdistFrame && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <WdistLegend mode={wdistMode}/>
          </div>
        )}

        {/* 警報凡例 — 警報タブで警報・注意報レイヤーを地図に塗っている間だけ、
            画面右上に浮かぶ(震度凡例・津波凡例と対の構成)。キキクル・河川水位
            表示中は警報の塗り分け自体を非表示にしているので、この凡例も出さない
            (代わりにRiskLegend/RiverLegendを出す)。 */}
        {activeNav === "alert" && !alertLayerMode && Object.keys(warningLevelMap).length > 0 && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <WarningLegend warningLevelMap={warningLevelMap}/>
          </div>
        )}

        {/* キキクル(土砂/浸水)凡例 — 警報タブでキキクルレイヤーを表示している間、
            画面右上に浮かぶ(警報凡例・河川水位凡例と排他)。 */}
        {activeNav === "alert" && alertLayerMode && alertLayerMode !== "riverLevel" && alertLayerFrame && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <RiskLegend mode={alertLayerMode}/>
          </div>
        )}

        {/* 河川水位凡例 — 警報タブで河川水位レイヤーを表示している間、
            画面右上に浮かぶ(警報凡例・キキクル凡例と排他)。 */}
        {activeNav === "alert" && alertLayerMode === "riverLevel" && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <RiverLegend/>
          </div>
        )}

        {/* ── Layer 2: Glass UI（透明ガラスが地図に浮かぶ） ── */}

        {/* アラートピル — 一旦非表示 */}
        {/*
        <div style={{
          position: "absolute", top: 20, left: 0, right: 0,
          display: "flex", justifyContent: "center",
          zIndex: 30, pointerEvents: "none",
        }}>
          <div style={{ pointerEvents: "auto" }}>
            <AlertPill alert={ALERT}/>
          </div>
        </div>
        */}

        {/* フローティングのナビ(縦持ちのタブバー/横画面の縦レール)の下端より下は、
            見た目上ナビの外側なのに地図の全画面キャンバスがそのまま裏に伸びている
            ため、何もしないとそこをドラッグ/ピンチしても地図が反応してしまう。
            中身の無い透明divを地図より上の重ね順に置くだけで、この帯の中の
            ポインタ/タッチ操作を地図の手前で止められる(下のcanvasには一切届かない)。
            縦持ち(!isWide)はタブバー自身のbottomオフセットと同じ式、横画面(isWide)
            は縦レールのbottom:16と同じ16pxを高さにして、ナビの下端にぴったり合わせる。 */}
        <div style={{
          position: "absolute",
          left: 0, right: 0, bottom: 0,
          height: isWide
            ? 16
            : isStandalonePwa
              ? "max(0px, calc(env(safe-area-inset-bottom) - 10px))"
              : "calc(env(safe-area-inset-bottom) + 10px)",
          zIndex: 35,
          touchAction: "none",
        }}/>

        {/* ボトムドック — ナビバーと地図レイヤーパネルをひとつのGlassに統合。
            レイヤーを開くと、このガラス自体の高さ・角丸が滑らかに変化し、
            ナビバーの内側からパネルが伸びて生まれてくるように見せる。
            広い画面(isWide)では、SideNavRail(タブ列)とBottomDockの中身を
            1つの共有Glassの中に並べて描画し、継ぎ目の無い1枚のガラスに
            見せる(BottomDock自身はisWideの時、自前のGlassを持たず透明な
            中身だけを返す)。 */}
        <div style={isWide ? {
          position: "fixed",
          left: 12, top: 16, bottom: 16,
          zIndex: 40,
        } : {
          position: "absolute",
          bottom: isStandalonePwa
            ? "calc(env(safe-area-inset-bottom) - 10px)"
            : "calc(env(safe-area-inset-bottom) + 10px)",
          left: 0, right: 0,
          display: "flex", justifyContent: "center", alignItems: "flex-end",
          zIndex: 40, padding: "0 16px",
        }}>
          {isWide ? (
              <div style={{ height: "100%", animation: "appear 0.4s cubic-bezier(.25,1,.5,1) 0.1s both" }}>
                <Glass radius={28} style={{ height: "100%" }}>
                  <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
                    <div style={{ width: WIDE_RAIL_WIDTH, flexShrink: 0, position: "relative" }}>
                      <SideNavRail active={activeNav} onNav={handleNavTap} uiScale={wideUIScale}/>
                    </div>
                    <div style={{ width: 1, alignSelf: "stretch", background: `rgba(${tokens.ink},0.14)` }}/>
                    <BottomDock
                      active={activeNav}
                      onNav={handleNavTap}
                      navCollapseSignal={navCollapseSignal}
                      navDoubleTapSignal={navDoubleTapSignal}
                      layerOpen={layerOpen}
                      layers={layersForPanel}
                      onToggleLayer={toggleLayer}
                      onLayerOpenChange={setLayerOpen}
                      uiScale={wideUIScale}
                      quakes={effectiveQuakes}
                  quakeStatus={quakeStatus}
                  selectedQuakeId={selectedQuakeId}
                  onSelectQuake={selectQuake}
                  tsunamis={effectiveTsunamis}
                  tsunamiStatus={tsunamiStatus}
                  selectedTsunamiId={selectedTsunamiId}
                  onSelectTsunami={setSelectedTsunamiId}
                  isViewingPastTsunami={isViewingPastTsunami}
                  tsunamiHistory={tsunamiHistory}
                  onLoadMoreTsunamiHistory={loadMoreTsunamiHistory}
                  onTsunamiViewModeChange={setTsunamiViewModeTop}
                  onCurrentLocationChange={setCurrentLocationPoint}
                  onNowcastChange={handleNowcastChange}
                  onPrecipChange={handlePrecipChange}
                  onWdistChange={handleWdistChange}
                  onTyphoonChange={handleTyphoonChange}
                  onSelectTyphoon={handleSelectTyphoon}
                  selectedTyphoonInfo={selectedTyphoonInfo}
                  onClearSelectedTyphoon={handleClearSelectedTyphoon}
                  onSelectTyphoonDetail={handleSelectTyphoonCenter}
                  warningLevelMap={warningLevelMap}
                  warningAreaByRegioncode={warningAreaByRegioncode}
                  selectedWarningArea={selectedWarningArea}
                  onSelectWarningAreaFromList={handleSelectWarningAreaFromList}
                  onBackFromWarningArea={handleBackFromWarningArea}
                  onAlertLayerChange={handleAlertLayerChange}
                  onAlertModeChange={handleAlertModeChange}
                  onRiverLayerChange={handleRiverLayerChange}
                  selectedRiverStation={selectedRiverStation}
                  onSelectRiverStation={handleSelectRiverStation}
                  tideStations={tideStationsWithGrade}
                  tideStationsStatus={tideStationsStatus}
                  selectedTideStationCode={selectedTideStationCode}
                  onSelectTideStation={setSelectedTideStationCode}
                  tideStationSelectSignal={tideStationSelectSignal}
                  tsunamiHeightByStation={tsunamiHeightByStationForDisplay}
                  tsunamiHeightTimeByStation={tsunamiHeightTimeByStationForDisplay}
                  tideObsByStation={tideObsByStation}
                  onLoadTideObs={loadTideObs}
                  onCausingQuakeChange={setCausingQuakeCard}
                  stationMarkersVisible={stationMarkersVisible}
                  onToggleStationMarkersVisible={() => setStationMarkersVisible(v => !v)}
                  tideStationMarkersVisible={tideStationMarkersVisible}
                  onToggleTideStationMarkersVisible={() => setTideStationMarkersVisible(v => !v)}
                  stationPoints={selectedQuakePoints}
                  onChangeQuakeColorScheme={handleChangeQuakeColorScheme}
                  onChangeNowcastColorScheme={handleChangeNowcastColorScheme}
                  estIntensityEnabled={estIntensityEnabled}
                  onChangeEstIntensityEnabled={handleChangeEstIntensityEnabled}
                  areaFillEnabled={areaFillEnabled}
                  onChangeAreaFillEnabled={handleChangeAreaFillEnabled}
                  faultsEnabled={faultsEnabled}
                  onChangeFaultsEnabled={handleChangeFaultsEnabled}
                  plateBoundariesEnabled={plateBoundariesEnabled}
                  onChangePlateBoundariesEnabled={handleChangePlateBoundariesEnabled}
                  epicenterCirclesEnabled={epicenterCirclesEnabled}
                  onChangeEpicenterCirclesEnabled={handleChangeEpicenterCirclesEnabled}
                  boundaryLineColorId={boundaryLineColorId}
                  onChangeBoundaryLineColorId={handleChangeBoundaryLineColorId}
                  quakeFetchLimit={quakeFetchLimit}
                  onChangeQuakeFetchLimit={handleChangeQuakeFetchLimit}
                  stationListDisplayMode={stationListDisplayMode}
                  onChangeStationListDisplayMode={handleChangeStationListDisplayMode}
                  experimentalFeaturesEnabled={experimentalFeaturesEnabled}
                  onChangeExperimentalFeaturesEnabled={handleChangeExperimentalFeaturesEnabled}
                  testTsunami={testTsunami}
                  onBroadcastTestTsunami={broadcastTestTsunami}
                  onCancelTestTsunami={cancelTestTsunami}
                  onClearTestTsunami={clearTestTsunami}
                  testEews={testEews}
                  onTestEewAction={handleTestEewAction}
                  eewTestForm={eewTestForm}
                  eewEpicenterPickActive={eewEpicenterPickActive}
                  eews={effectiveEews}
                  eewDetailOpen={eewDetailOpen}
                  eewOpenSignal={eewOpenSignal}
                  onOpenEewDetail={() => { setEewDetailOpen(true); setEewOpenSignal(s => s + 1); }}
                  onCloseEewDetail={() => setEewDetailOpen(false)}
                  testQuake={testQuake}
                  onTestQuakeAction={handleTestQuakeAction}
                  quakeTestForm={quakeTestForm}
                  quakeEpicenterPickActive={quakeEpicenterPickActive}
                  quakeTestAutoPlaying={quakeTestAutoPlaying}
                  tsunamiAreaPickActive={tsunamiAreaPickActive}
                  onStartTsunamiAreaPick={startTsunamiAreaPick}
                  pickedTsunamiAreas={pickedTsunamiAreas}
                  onRemoveTsunamiAreaPick={removeTsunamiAreaPick}
                  onCycleTsunamiAreaGrade={cycleTsunamiAreaGrade}
                  pickedTsunamiHeights={pickedTsunamiHeights}
                  onChangeTsunamiHeightPick={changeTsunamiHeightPick}
                  onRemoveTsunamiHeightPick={removeTsunamiHeightPick}
                  candidateHeightStations={candidateHeightStations}
                  onAddTsunamiHeightPick={addTsunamiHeightPick}
                  stations={stations}
                  searchQuake={searchQuake}
                  onFoundSearchQuake={setSearchQuake}
                  onEpicenterPointsChange={setEpicenterPoints}
                  onEpicenterLoadingChange={setEpicenterLoading}
                  mapSelectSignal={mapSelectSignal}
                />
              </div>
            </Glass>
              </div>
          ) : (
            <BottomDock
              active={activeNav}
              onNav={handleNavTap}
              navCollapseSignal={navCollapseSignal}
              navDoubleTapSignal={navDoubleTapSignal}
              layerOpen={layerOpen}
              layers={layersForPanel}
              onToggleLayer={toggleLayer}
              onLayerOpenChange={setLayerOpen}
              quakes={effectiveQuakes}
              quakeStatus={quakeStatus}
              selectedQuakeId={selectedQuakeId}
              onSelectQuake={selectQuake}
              tsunamis={effectiveTsunamis}
              tsunamiStatus={tsunamiStatus}
              selectedTsunamiId={selectedTsunamiId}
              onSelectTsunami={setSelectedTsunamiId}
              isViewingPastTsunami={isViewingPastTsunami}
              tsunamiHistory={tsunamiHistory}
              onLoadMoreTsunamiHistory={loadMoreTsunamiHistory}
              onTsunamiViewModeChange={setTsunamiViewModeTop}
              onCurrentLocationChange={setCurrentLocationPoint}
                  onNowcastChange={handleNowcastChange}
                  onPrecipChange={handlePrecipChange}
                  onWdistChange={handleWdistChange}
                  onTyphoonChange={handleTyphoonChange}
                  onSelectTyphoon={handleSelectTyphoon}
                  selectedTyphoonInfo={selectedTyphoonInfo}
                  onClearSelectedTyphoon={handleClearSelectedTyphoon}
                  onSelectTyphoonDetail={handleSelectTyphoonCenter}
                  warningLevelMap={warningLevelMap}
                  warningAreaByRegioncode={warningAreaByRegioncode}
                  selectedWarningArea={selectedWarningArea}
                  onSelectWarningAreaFromList={handleSelectWarningAreaFromList}
                  onBackFromWarningArea={handleBackFromWarningArea}
                  onAlertLayerChange={handleAlertLayerChange}
                  onAlertModeChange={handleAlertModeChange}
                  onRiverLayerChange={handleRiverLayerChange}
                  selectedRiverStation={selectedRiverStation}
                  onSelectRiverStation={handleSelectRiverStation}
              tideStations={tideStationsWithGrade}
              tideStationsStatus={tideStationsStatus}
              selectedTideStationCode={selectedTideStationCode}
              onSelectTideStation={setSelectedTideStationCode}
              tideStationSelectSignal={tideStationSelectSignal}
              tsunamiHeightByStation={tsunamiHeightByStationForDisplay}
              tsunamiHeightTimeByStation={tsunamiHeightTimeByStationForDisplay}
              tideObsByStation={tideObsByStation}
              onLoadTideObs={loadTideObs}
              onCausingQuakeChange={setCausingQuakeCard}
              stationMarkersVisible={stationMarkersVisible}
              onToggleStationMarkersVisible={() => setStationMarkersVisible(v => !v)}
              tideStationMarkersVisible={tideStationMarkersVisible}
              onToggleTideStationMarkersVisible={() => setTideStationMarkersVisible(v => !v)}
              stationPoints={selectedQuakePoints}
              onChangeQuakeColorScheme={handleChangeQuakeColorScheme}
                  onChangeNowcastColorScheme={handleChangeNowcastColorScheme}
              estIntensityEnabled={estIntensityEnabled}
              onChangeEstIntensityEnabled={handleChangeEstIntensityEnabled}
              areaFillEnabled={areaFillEnabled}
              onChangeAreaFillEnabled={handleChangeAreaFillEnabled}
              faultsEnabled={faultsEnabled}
              onChangeFaultsEnabled={handleChangeFaultsEnabled}
              plateBoundariesEnabled={plateBoundariesEnabled}
              onChangePlateBoundariesEnabled={handleChangePlateBoundariesEnabled}
              epicenterCirclesEnabled={epicenterCirclesEnabled}
              onChangeEpicenterCirclesEnabled={handleChangeEpicenterCirclesEnabled}
              boundaryLineColorId={boundaryLineColorId}
              onChangeBoundaryLineColorId={handleChangeBoundaryLineColorId}
              quakeFetchLimit={quakeFetchLimit}
              onChangeQuakeFetchLimit={handleChangeQuakeFetchLimit}
              stationListDisplayMode={stationListDisplayMode}
              onChangeStationListDisplayMode={handleChangeStationListDisplayMode}
              experimentalFeaturesEnabled={experimentalFeaturesEnabled}
              onChangeExperimentalFeaturesEnabled={handleChangeExperimentalFeaturesEnabled}
              testTsunami={testTsunami}
              onBroadcastTestTsunami={broadcastTestTsunami}
              onCancelTestTsunami={cancelTestTsunami}
              onClearTestTsunami={clearTestTsunami}
              testEews={testEews}
              onTestEewAction={handleTestEewAction}
              eewTestForm={eewTestForm}
              eewEpicenterPickActive={eewEpicenterPickActive}
              eews={effectiveEews}
              eewDetailOpen={eewDetailOpen}
              eewOpenSignal={eewOpenSignal}
              onOpenEewDetail={() => { setEewDetailOpen(true); setEewOpenSignal(s => s + 1); }}
              onCloseEewDetail={() => setEewDetailOpen(false)}
              testQuake={testQuake}
              onTestQuakeAction={handleTestQuakeAction}
              quakeTestForm={quakeTestForm}
              quakeEpicenterPickActive={quakeEpicenterPickActive}
              quakeTestAutoPlaying={quakeTestAutoPlaying}
              tsunamiAreaPickActive={tsunamiAreaPickActive}
              onStartTsunamiAreaPick={startTsunamiAreaPick}
              pickedTsunamiAreas={pickedTsunamiAreas}
              onRemoveTsunamiAreaPick={removeTsunamiAreaPick}
              onCycleTsunamiAreaGrade={cycleTsunamiAreaGrade}
              pickedTsunamiHeights={pickedTsunamiHeights}
              onChangeTsunamiHeightPick={changeTsunamiHeightPick}
              onRemoveTsunamiHeightPick={removeTsunamiHeightPick}
              candidateHeightStations={candidateHeightStations}
              onAddTsunamiHeightPick={addTsunamiHeightPick}
              stations={stations}
              searchQuake={searchQuake}
              onFoundSearchQuake={setSearchQuake}
              onEpicenterPointsChange={setEpicenterPoints}
              onEpicenterLoadingChange={setEpicenterLoading}
              mapSelectSignal={mapSelectSignal}
            />
          )}
        </div>

      </div>

      {/* 利用規約・プライバシーポリシー・注意事項への同意ゲート。既存のフローティング
          UI(BottomDock等)とは別の全画面オーバーレイで、未同意の間は他の操作を
          一切ブロックする。同意済み(かつ内容に更新が無い)場合は何も描画しない。 */}
      <TermsConsentGate/>
    </NowcastColorSchemeContext.Provider>
    </QuakeColorSchemeContext.Provider>
    </GlassOpaqueContext.Provider>
    </ThemeContext.Provider>
  );
}
