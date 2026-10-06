import { useContext, useEffect, useRef, useState } from "react";
import { Glass } from "../ui/glass.jsx";
import { loadEpicenterNamesData, loadFaultsData, loadGeoData, loadMapLibre, loadPlateBoundariesData, loadTsunamiAreasData } from "../lib/loaders.js";
import { NOWCAST_BOUNDS, nowcastProtocolUrl, precipProtocolUrl, wdistProtocolUrl } from "../weather/nowcast.js";
import { registerNowcastProtocol, registerPrecipProtocol, registerWdistProtocol } from "../weather/typhoon.js";
import { registerRiskProtocol, riskProtocolUrl } from "../weather/risk.js";
import { TSUNAMI_ICON_BORDER, buildMapStyle, tsunamiBarWidthForZoom, tsunamiStationIconId } from "./mapStyle.js";
import { EEW_FILL_LEGEND_ORDER, INTENSITY_LABEL, STATION_ICON_BASE_RADIUS, STATION_ICON_KEYS, registerAreaIcons, registerStationIcons } from "../quake/intensityScale.jsx";
import { BOUNDARY_LINE_COLORS, QUAKE_COLOR_SCHEMES, QuakeColorSchemeContext, ThemeContext, getBoundaryHaloColor } from "../settings/prefs.js";
import { buildTsunamiAreaColorExpr } from "../api/p2p.js";
import { EST_INTENSITY_MIN_INTENSITY_KEYS, QUAKE_INTENSITY_RANK, buildEpicenterCircleColorExpr, buildEpicenterCircleStrokeColorExpr, buildEstIntensityFillColorExpr, buildEstIntensityFillFeatures, buildEstIntensityGridFromImage, buildEstIntensityLineCoords, fetchEstimatedIntensityMatch, loadImageElement, meshCodeToBounds, offsetMeshCode } from "../api/estimatedIntensity.js";
import { EEW_P_WAVE_SPEED_KM_S, EEW_S_WAVE_SPEED_KM_S, eewCirclePolygon, eewWaveSurfaceRadiusKm } from "../api/eew.js";
import { aggregateByArea } from "../api/quakeData.js";
import { buildWarningAreaColorExpr, buildWarningAreasGeoJson, findNearestTsunamiAreaWithDistance, loadWarningAreasFullGeoJson } from "../api/warnings.js";
import { findAreaCodesByName, findEpicenterNameByPoint } from "../weather/location.jsx";

/* ─────────────────────────────────────────────────────
   MAP CANVAS — MapLibre GL JS(描画エンジン) + ローカルGeoJSON(データ)
   世界(world.json)・都道府県(prefectures.json)をベクターとして描画する。
   外部タイル・外部スタイルサーバーには依存しない。
   ───────────────────────────────────────────────────── */
export function MapCanvas({
  onReady, stationPoints, hypocenters, isWide,
  quakeTimeStr, maxIntensityKey, estIntensityEnabled, areaFillEnabled,
  faultsEnabled, plateBoundariesEnabled, boundaryLineColorId,
  epicenterPoints = [], onSelectEpicenterPoint,
  pointsLoading = false, epicenterLoading = false,
  tsunamiAreas = [],
  stationMarkersVisible = true,
  tideStationPoints = [], onSelectTideStation, selectedTideStationCode,
  tsunamiHeightBars = [], tideStationBarsMode = false,
  tideStationsInteractive = true,
  tsunamiAreaPickActive = false, onPickTsunamiArea, pickedTsunamiAreas = [],
  eews = [],
  eewEpicenterPickActive = false, onPickEewEpicenter,
  quakeEpicenterPickActive = false, onPickQuakeEpicenter,
  eewDetailOpen = false,
  currentLocationPoint = null, // { lat, lon } | null。気象タブ「地点」モード中のGPS現在地(iOS風の青丸)
  nowcastVisible = false,      // 雨雲レーダーレイヤーを表示するか
  nowcastFrame = null,         // { basetime, validtime } | null。表示中の時刻コマ
  nowcastPreloadFrames = [],   // 前後の先読み対象コマ({basetime,validtime}の配列)。
                                // タイルをバックグラウンドで読み込んでおき、切り替え時に一瞬消えるのを防ぐ
  nowcastKnownValidtimes = [], // 実況+予測の現在の全validtime一覧。この一覧に無くなった
                                // (=特に予測コマで一覧更新のたびに起きる)キャッシュ済みレイヤーの掃除に使う
  nowcastColorSchemeId = "jma", // 雨雲レーダーの配色スキームID
  precipVisible = false,        // 1/3/24時間降水量レイヤーを表示するか
  precipMode = null,            // "precip1h" | "precip3h" | "precip24h" | null
  precipFrame = null,           // { basetime, validtime, member } | null。表示中の時刻コマ
  precipKnownValidtimes = [],   // 現在のモードの全validtime一覧。この一覧に無くなった
                                 // (5分おきの一覧更新でありうる)キャッシュ済みレイヤーの掃除に使う
  wdistVisible = false,         // 天気分布予報レイヤーを表示するか
  wdistMode = null,             // "weather" | "temperature" | null
  wdistFrame = null,            // { basetime, validtime, member } | null。表示中の時刻コマ
  wdistKnownValidtimes = [],    // 現在のモードの全validtime一覧。キャッシュ済みレイヤーの掃除に使う
  typhoonVisible = false,       // 台風情報レイヤーを表示するか
  typhoonGeojson = null,        // fetchTyphoonData()が返すgeojson({type:"FeatureCollection"})| null
  onSelectTyphoonCenter,        // 台風の中心点/予報円をタップした時にpropertiesを渡すコールバック
  typhoonFlyToRequest = null,   // {lon, lat, nonce} | null。台風一覧の項目をタップした時のflyTo先
  warningVisible = false,       // 警報タブ: 警報・注意報レイヤーを表示するか(警報タブがアクティブな間だけtrue)
  warningLevelMap = {},         // 警報タブ: regioncode → {level, kinds} のマップ(App側でポーリング取得)
  selectedWarningArea = null,   // 警報タブ: タップ/一覧選択中のregioncode | null。選択中のエリアを地図上で強調する
  onSelectWarningArea,          // 警報タブ: 地図の塗り分けをタップした時に呼ぶコールバック(regioncodeを渡す)
  warningAreaFlyToRequest = null, // 警報タブ: {lon, lat, nonce} | null。一覧の項目をタップした時のflyTo先
  riskVisible = false,          // 警報タブ: キキクル(土砂/浸水)レイヤーを表示するか
  riskMode = null,              // "doshaKikkuru" | "inundKikkuru" | null
  riskFrame = null,             // { basetime, validtime } | null。表示中の時刻コマ
  riskKnownValidtimes = [],     // 現在のモードの全validtime一覧。この一覧に無くなったキャッシュ済みレイヤーの掃除に使う
  riverVisible = false,         // 警報タブ: 河川水位観測所レイヤーを表示するか
  riverStations = null,         // GeoJSON FeatureCollection(river.go.jpのstg概観)| null
  selectedRiverStation = null,  // タップ中の観測所のproperties | null。地図上で強調表示に使う
  onSelectRiverStation,         // 河川水位観測所のピンをタップした時に呼ぶコールバック(propertiesを渡す)
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [errorMsg, setErrorMsg] = useState("");
  // 現在選択中の震度配色スキーム。観測点マーカー・震度分布の塗り分けの両方で使う。
  const colorSchemeId = useContext(QuakeColorSchemeContext);
  const colorScheme = QUAKE_COLOR_SCHEMES[colorSchemeId] || QUAKE_COLOR_SCHEMES.fill;
  // 震央分布(circleレイヤー)は map.on("load") 内(初回マウント時のみ実行)で
  // 作るため、生成時点の最新配色をrefで参照できるようにしておく
  // (切り替え時の反映は別のuseEffectでsetPaintPropertyする。下方)。
  const colorSchemeRef = useRef(colorScheme);
  colorSchemeRef.current = colorScheme;

  // 震央分布の丸をホバー/タッチした時に出す簡易ツールチップ。
  // { x, y, title, text } | null。x,yは地図コンテナ基準のスクリーン座標
  // (MapLibreのe.pointがそのままその座標系なので、変換不要で使える)。
  const [epicenterTooltip, setEpicenterTooltip] = useState(null);

  // 地図に塗られている緊急地震速報の予想震度のうち、最も低いものと最も高いもの。
  // {minKey, maxKey} | null(何も塗られていない時)。右上の凡例表示に使う。
  const [eewFillRange, setEewFillRange] = useState(null);

  // 震央分布の丸をタップした時に呼ぶ選択コールバック。
  // map.on("load")内の登録は初回マウント時の1回きりなので、refで最新の
  // 関数を参照できるようにしておく。
  const onSelectEpicenterPointRef = useRef(onSelectEpicenterPoint);
  onSelectEpicenterPointRef.current = onSelectEpicenterPoint;
  const onSelectTideStationRef = useRef(onSelectTideStation);
  onSelectTideStationRef.current = onSelectTideStation;
  // 警報タブ: 警報・注意報レイヤーをタップした時のコールバック。他のタップ系
  // コールバックと同様、map.on("load")内の登録は初回マウント時の1回きりなので
  // refで最新の関数を参照できるようにしておく。
  const onSelectWarningAreaRef = useRef(onSelectWarningArea);
  onSelectWarningAreaRef.current = onSelectWarningArea;
  const onSelectRiverStationRef = useRef(onSelectRiverStation);
  onSelectRiverStationRef.current = onSelectRiverStation;
  const tideStationsInteractiveRef = useRef(tideStationsInteractive);
  tideStationsInteractiveRef.current = tideStationsInteractive;
  // 台風の中心点/予報円をタップした時のコールバック。map.on("load")内の登録は
  // 初回マウント時の1回きりなので、他のピック系コールバックと同様にrefで最新を参照する。
  const onSelectTyphoonCenterRef = useRef(onSelectTyphoonCenter);
  onSelectTyphoonCenterRef.current = onSelectTyphoonCenter;
  // 予報円の横に出す時刻ラベル(maplibregl.Marker)。map.on("load")の外(typhoonGeojsonが
  // 変わるたびに動くuseEffect)で作り直すため、現在出しているマーカーの配列をrefで保持する。
  const typhoonForecastMarkersRef = useRef([]);

  // 津波予報区の「地図タップで選択」モード用。map.on("load")内の登録は初回のみなので、
  // 最新のモードON/OFF・コールバック・読み込み済みデータをrefで参照できるようにする。
  const tsunamiAreaPickActiveRef = useRef(tsunamiAreaPickActive);
  tsunamiAreaPickActiveRef.current = tsunamiAreaPickActive;
  const onPickTsunamiAreaRef = useRef(onPickTsunamiArea);
  onPickTsunamiAreaRef.current = onPickTsunamiArea;
  const eewEpicenterPickActiveRef = useRef(eewEpicenterPickActive);
  eewEpicenterPickActiveRef.current = eewEpicenterPickActive;
  const onPickEewEpicenterRef = useRef(onPickEewEpicenter);
  onPickEewEpicenterRef.current = onPickEewEpicenter;
  // 地震情報テスト配信の「地図をタップして震源を指定」モード用。EEWのピックモードと
  // 同じ考え方・同じep.jsonの震央地名検索を共有し、activeな方だけ反応させる(両方
  // 同時にONにはならない)。
  const quakeEpicenterPickActiveRef = useRef(quakeEpicenterPickActive);
  quakeEpicenterPickActiveRef.current = quakeEpicenterPickActive;
  const onPickQuakeEpicenterRef = useRef(onPickQuakeEpicenter);
  onPickQuakeEpicenterRef.current = onPickQuakeEpicenter;
  // 震央地名データは、緊急地震速報テスト配信のピックモードが最初にONになった時だけ
  // 遅延読み込みする(実験的機能なので、使わないユーザーには一切通信させない)。
  const epicenterNamesGeoDataRef = useRef(null);
  const epicenterNamesLoadedRef = useRef(false);
  const tsunamiAreasGeoDataRef = useRef(null);
  // 地図の基本配色(海・陸・都道府県境界線)。ライト/ダークモードで切り替える。
  const { tokens: themeTokens, mode } = useContext(ThemeContext);
  const tokens = themeTokens; // 下方で自動変換されたtokens.*参照のためのエイリアス
  // マップ生成(下のuseEffect本体)は[]依存で一度きりしか走らないため、
  // 生成時点の最新トークンをrefで参照する。切り替え時の反映は
  // 別のuseEffectでsetPaintPropertyして行う(下方)。
  const themeTokensRef = useRef(themeTokens);
  themeTokensRef.current = themeTokens;
  // 震央分布の縁取り色(震度1・気象庁配色のみライトモードで黒にする)の判定に、
  // 生成時点のライト/ダーク状態も同様にrefで参照できるようにしておく。
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // 断層・プレート境界の「枠内の色」の現在値をrefでも持っておき、
  // map.on("load")内(初回マウント時のみ実行)で最新の選択値を読めるようにする。
  const boundaryLineColorIdRef = useRef(boundaryLineColorId);
  boundaryLineColorIdRef.current = boundaryLineColorId;

  useEffect(() => {
    let cancelled = false;

    Promise.all([loadMapLibre(), loadGeoData()])
      .then(([maplibregl, geo]) => {
        if (cancelled || !containerRef.current) return;
        registerNowcastProtocol(maplibregl);
        registerPrecipProtocol(maplibregl);
        registerWdistProtocol(maplibregl);
        registerRiskProtocol(maplibregl);

        let map;
        try {
          map = new maplibregl.Map({
            container: containerRef.current,
            style: buildMapStyle(geo, themeTokensRef.current),
            center: [138.0, 38.0], // 日本全体が収まる中心付近
            zoom: 4.5,
            pitch: 0,
            attributionControl: false,
            // ナビゲーション操作はLiquid Glassの自前ボタンで行うため
            // 標準コントロールはあえて追加しない

            // preserveDrawingBuffer: true
            // MapLibreのWebGL canvasはデフォルトだと描画直後にdrawing bufferを
            // 破棄してよいことになっている(次フレームでどうせ描き直すため)。
            // 通常表示ではこれで問題ないが、backdrop-filterはブラウザの
            // コンポジタが「今画面に出ている見た目」をその都度スナップショット
            // して読みに行く処理であり、Windows Chromium(ANGLE/D3D11経由)の
            // GPUコンポジットのタイミングによっては、そのスナップショットの
            // 瞬間にはすでにbufferがクリア済み=空、ということが起こり得る。
            // これが「backdrop-filterのガラスパネルの中だけWebGL地図が
            // 全く映らず完全に透ける」症状の典型的な原因のひとつ。
            // preserveDrawingBufferをtrueにすると毎フレームのbufferが
            // 保持されるため、コンポジタがいつ読みに来ても地図が残っている
            // 状態になる(引き換えに描画コストがわずかに上がる)。
            preserveDrawingBuffer: true,
          });
        } catch (constructErr) {
          console.error("MapLibre Map construction failed:", constructErr);
          if (!cancelled) {
            setStatus("error");
            setErrorMsg("地図の初期化に失敗: " + (constructErr.message || String(constructErr)));
          }
          return;
        }

        map.on("load", () => {
          if (cancelled) return;

          // 震源(バツ印)アイコンを生成してMapLibreへ登録しておく。
          // 白フチ付きの赤いバツ印にするため、まず太めの白でストロークしてから
          // その上に少し細い赤をストロークすることで、白い縁取りを再現する。
          const crossSize = 36;
          const crossCanvas = document.createElement("canvas");
          crossCanvas.width = crossSize; crossCanvas.height = crossSize;
          const cc = crossCanvas.getContext("2d");
          const crossPad = 10;
          const drawCrossPath = () => {
            cc.beginPath();
            cc.moveTo(crossPad, crossPad); cc.lineTo(crossSize - crossPad, crossSize - crossPad);
            cc.moveTo(crossSize - crossPad, crossPad); cc.lineTo(crossPad, crossSize - crossPad);
          };
          cc.lineCap = "round";
          cc.lineJoin = "round";
          cc.strokeStyle = "#ffffff";
          cc.lineWidth = 10;
          drawCrossPath();
          cc.stroke();
          cc.strokeStyle = "#FF453A";
          cc.lineWidth = 6;
          drawCrossPath();
          cc.stroke();
          map.addImage("hypocenter-cross", cc.getImageData(0, 0, crossSize, crossSize));

          // PLUM法震源(円)アイコン。index.html版の.eew-marker-plum(白フチ付き赤リング)
          // と同じ考え方で、バツ印と同じキャンバスサイズ・白→赤の二重ストロークにして
          // 見た目のトーンを揃える。PLUM法は到達時刻を伴わないためバツ印ではなく円で示す。
          const circleCanvas = document.createElement("canvas");
          circleCanvas.width = crossSize; circleCanvas.height = crossSize;
          const rc = circleCanvas.getContext("2d");
          const circleCenter = crossSize / 2;
          const circleRadius = 10;
          rc.lineCap = "round";
          rc.beginPath();
          rc.arc(circleCenter, circleCenter, circleRadius, 0, Math.PI * 2);
          rc.strokeStyle = "#ffffff";
          rc.lineWidth = 8;
          rc.stroke();
          rc.beginPath();
          rc.arc(circleCenter, circleCenter, circleRadius, 0, Math.PI * 2);
          rc.strokeStyle = "#FF453A";
          rc.lineWidth = 5;
          rc.stroke();
          map.addImage("hypocenter-plum-circle", rc.getImageData(0, 0, crossSize, crossSize));

          // 観測点(震度)マーカー用のアイコン(丸+白フチ+数字)を、
          // 現在の配色スキームに合わせて生成・登録しておく。
          registerStationIcons(map, colorScheme);
          // 震度速報・震源に関する情報(細分区域単位)専用の角丸正方形アイコン。
          registerAreaIcons(map, colorScheme);

          // 観測点マーカー本体。circleではなくsymbolレイヤーにすることで、
          // registerStationIconsで焼いたbitmap(白フチ+数字入り)をそのまま使う。
          // ズームに応じた大きさは、段階切り替えだとカクつくため連続補間(interpolate)にし、
          // 見やすさ重視で全体的に一回り大きめのサイズにしている。
          // 推計震度分布(250mメッシュをベクター化したもの)の塗り・境界線レイヤー。
          // 初期状態は空のFeatureCollectionで登録しておき、実際のデータは専用の
          // useEffect内でsetData()により差し替える(選択中の地震・トグルが変わるたび)。
          // station-points-symbolより前にaddLayerすることで、観測点マーカーより
          // 必ず下に来るようにしている。
          map.addSource("est-intensity-fill", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
            // MapLibreはGeoJSONソースを内部的にタイル分割して描画するため、単純化
            // (簡略化)されると、隣接タイル同士で境界の頂点位置がわずかにずれて、
            // 継ぎ目(細い線)として見えてしまうことがある。矩形はもともと単純な形状で
            // 単純化の恩恵もほぼ無いため、toleranceを0にして単純化自体を無効化する。
            tolerance: 0,
          });
          map.addLayer({
            id: "est-intensity-fill-layer",
            type: "fill",
            source: "est-intensity-fill",
            paint: {
              "fill-color": buildEstIntensityFillColorExpr(colorScheme),
              "fill-opacity": 0.75,
              // 隣接する矩形ポリゴン同士の境目(内部タイル分割の継ぎ目を含む)に
              // GPU描画特有の細い隙間(線)が出るのを防ぐため、アンチエイリアスを無効化する。
              "fill-antialias": false,
            },
          });
          map.addSource("est-intensity-line", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "est-intensity-line-layer",
            type: "line",
            source: "est-intensity-line",
            paint: {
              // 外周(色が付いた範囲と地図の背景との境目)は暗い地図に対して見やすいよう白、
              // 震度階級同士の境目(4と5-の間など)は両側とも明るい色なので黒のままにする。
              "line-color": ["match", ["get", "edgeType"], "outer", `rgba(${tokens.ink},0.8)`, "rgba(0,0,0,0.45)"],
              "line-width": 1,
            },
          });

          map.addSource("station-points", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "station-points-symbol",
            type: "symbol",
            source: "station-points",
            layout: {
              // ズーム6未満は円が小さく数字が潰れるため、数字なしアイコンに切り替える。
              "icon-image": [
                "step", ["zoom"],
                ["concat", "station-icon-", ["get", "intensityKey"], "-dot"],
                6, ["concat", "station-icon-", ["get", "intensityKey"], "-num"],
              ],
              "icon-size": [
                "interpolate", ["linear"], ["zoom"],
                4, 5 / STATION_ICON_BASE_RADIUS,
                7, 10 / STATION_ICON_BASE_RADIUS,
                9, 14 / STATION_ICON_BASE_RADIUS,
                11, 20 / STATION_ICON_BASE_RADIUS,
                14, 30 / STATION_ICON_BASE_RADIUS,
              ],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              // 震度が大きいほど後(=前面)に描画されるよう、sort-keyに震度の並び順を使う。
              "symbol-sort-key": ["get", "sortOrder"],
            },
          });

          // 震度速報・震源に関する情報(細分区域単位、isArea:true)専用のマーカー。
          // 通常の観測点マーカー(station-points、円形アイコン)とは別のソース・
          // レイヤーにして、角丸正方形アイコン(area-icon-*)を使う。
          // 1つの地震のpointsは常に「全部isArea:true」か「全部isArea:false」の
          // どちらかで、両方が混ざることは無いため、重なり順は特に気にしなくてよい。
          map.addSource("area-points", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "area-points-symbol",
            type: "symbol",
            source: "area-points",
            layout: {
              "icon-image": [
                "step", ["zoom"],
                ["concat", "area-icon-", ["get", "intensityKey"], "-dot"],
                4, ["concat", "area-icon-", ["get", "intensityKey"], "-num"],
              ],
              "icon-size": [
                "interpolate", ["linear"], ["zoom"],
                4, 6.5 / STATION_ICON_BASE_RADIUS,
                7, 13 / STATION_ICON_BASE_RADIUS,
                9, 18 / STATION_ICON_BASE_RADIUS,
                11, 26 / STATION_ICON_BASE_RADIUS,
                14, 38 / STATION_ICON_BASE_RADIUS,
              ],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              "symbol-sort-key": ["get", "sortOrder"],
            },
          });

          // プレート境界(plate-boundaries.json)・断層(faults.geojson)レイヤー。
          // いずれも数MB規模のファイルのため、初期状態では空のFeatureCollectionだけ
          // 登録しておき、実データは対応するトグルが最初にONにされた時点で
          // 遅延読み込みする(下方の専用useEffectでsetDataにより差し替える)。
          // トグルOFF時はvisibility:noneで非表示にするだけでレイヤー自体は
          // 削除しない(再ON時に読み込み直さずに済むようにするため)。
          // beforeIdに"station-points-symbol"を指定し、観測点マーカーより
          // 必ず下に来るようにする。
          //
          // 配色はプレート境界・断層とも、種別ごとの派手な色分けはせず、
          // 「縁取り(halo)は共通の固定グレー」「枠内の色(core)はユーザーが
          // 設定で選べる」という組み合わせにする。
          // ・縁取り(halo)はライト/ダーク共通の固定色(BOUNDARY_HALO_COLOR)。
          //   どちらのテーマでも海・陸に対して十分なコントラストが出る
          //   中間グレーを採用している。
          // ・枠内の色(core)は設定(BOUNDARY_LINE_COLORS)から選んだ色を使う。
          // ・どちらも、あえて半透明(rgba)にせず不透明の実色にしている。
          //   半透明にすると、線同士が交差・分岐する箇所(断層の枝分かれ・
          //   プレート境界同士の交点など)でアルファが重なって不自然に濃く
          //   見えてしまうため、それを避けるため。
          // 「線の先端を丸く」という見た目のため、太めのハローレイヤーを下に敷き、
          // その上に細めの中の線を重ねる「ケースドライン」の手法を使う
          // (halo→mainの順にaddLayerすることで、両方ともstation-points-symbolの
          // 直下・halo→mainの順で正しく積み重なる)。
          const boundaryLineLayout = { visibility: "none", "line-cap": "round", "line-join": "round" };
          const boundaryHaloWidth = ["interpolate", ["linear"], ["zoom"], 4, 2.2, 8, 3.6, 12, 5.2];
          const boundaryLineWidth = ["interpolate", ["linear"], ["zoom"], 4, 1.0, 8, 1.6, 12, 2.2];
          const initHalo = getBoundaryHaloColor(boundaryLineColorIdRef.current);
          const initCore = (BOUNDARY_LINE_COLORS[boundaryLineColorIdRef.current] || BOUNDARY_LINE_COLORS.gray).color;

          map.addSource("plate-boundaries", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "plate-boundaries-halo-layer",
            type: "line",
            source: "plate-boundaries",
            layout: boundaryLineLayout,
            paint: { "line-color": initHalo, "line-width": boundaryHaloWidth },
          }, "station-points-symbol");
          map.addLayer({
            id: "plate-boundaries-layer",
            type: "line",
            source: "plate-boundaries",
            layout: boundaryLineLayout,
            paint: { "line-color": initCore, "line-width": boundaryLineWidth },
          }, "station-points-symbol");

          map.addSource("faults", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "faults-halo-layer",
            type: "line",
            source: "faults",
            layout: boundaryLineLayout,
            paint: { "line-color": initHalo, "line-width": boundaryHaloWidth },
          }, "station-points-symbol");
          map.addLayer({
            id: "faults-layer",
            type: "line",
            source: "faults",
            layout: boundaryLineLayout,
            paint: { "line-color": initCore, "line-width": boundaryLineWidth },
          }, "station-points-symbol");

          // 津波予報区(海岸線)。津波情報の詳細を開いた時だけ、対象の予報区を
          // grade(危険度)の色で塗る。データ自体は遅延読み込みのため、
          // ここでは空のソースだけ用意しておく(下方のuseEffect参照)。
          map.addSource("tsunami-areas", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "tsunami-areas-layer",
            type: "line",
            source: "tsunami-areas",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "rgba(0,0,0,0)",
              "line-width": 4.5,
            },
          }, "station-points-symbol");

          // 津波テスト配信「地図タップで選択」機能用: 現在選んでいる予報区(複数可)を、
          // 実際の津波警報と同じグレード配色で太く強調するレイヤー。同じソース
          // (tsunami-areas)を使い回し、line-colorのmatch式(buildTsunamiAreaColorExpr)
          // で対象の予報区名だけに色を付け、それ以外は透明にする。filterでの絞り込みは
          // 行わず、色そのもので表示/非表示を切り替える(複数選択に対応するため)。
          map.addLayer({
            id: "tsunami-areas-pick-highlight-layer",
            type: "line",
            source: "tsunami-areas",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "rgba(0,0,0,0)",
              "line-width": 6,
            },
          }, "station-points-symbol");

          // 警報タブ: 気象警報・注意報レイヤー(市区町村単位の塗り分け)。
          // データ自体は警報タブを開いた時だけ遅延読み込みするため、ここでは
          // 空のソースだけ用意する(下方の専用useEffect参照)。
          map.addSource("warning-areas", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "warning-areas-fill-layer",
            type: "fill",
            source: "warning-areas",
            layout: { visibility: "none" },
            paint: {
              // 色そのものはベタ(不透明)で持たせ、不透明度はfill-opacityで別掛けする。
              // 移植元ツールと完全に同じ配色・不透明度(0.55)にする。
              "fill-color": buildWarningAreaColorExpr(),
              "fill-opacity": 0.55,
            },
          }, "station-points-symbol");
          map.addLayer({
            id: "warning-areas-line-layer",
            type: "line",
            source: "warning-areas",
            layout: { visibility: "none" },
            paint: {
              // 移植元ツールと同じく、境界線は警報レベルで色分けせず、
              // 市区町村境界を示すだけの固定の線にする。ライトモードは警報の
              // 塗り分け(黄〜赤)の上で白だと見えづらいので黒、ダークモードは
              // 従来通り薄い白にする(下方のテーマ切り替えeffectでも同期する)。
              "line-color": mode === "light" ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.25)",
              "line-width": 0.6,
              "line-opacity": 1,
            },
          }, "station-points-symbol");

          // タップ/一覧選択中の警報エリアを強調する専用レイヤー。同じソース
          // (warning-areas)を使い回し、setFilterで選択中のregioncodeだけに
          // 絞り込む(下方の専用useEffect参照)。太い白線で塗り分けの上から囲う。
          map.addLayer({
            id: "warning-areas-highlight-layer",
            type: "line",
            source: "warning-areas",
            layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
            filter: ["==", ["get", "regioncode"], "__none__"],
            paint: {
              "line-color": "#ffffff",
              "line-width": 3,
            },
          }, "station-points-symbol");

          // 河川水位観測所(国管理・主要河川)。stg_ovlvl(危険度、10刻み)で
          // 6段階に色分けした丸ポイント。警報の塗り分け・キキクルより上、
          // 選択中の市区町村ハイライトより下に置く(下方のuseEffectでデータ・
          // 表示状態を管理)。
          map.addSource("river-stations", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "river-stations-layer",
            type: "circle",
            source: "river-stations",
            layout: { visibility: "none" },
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 3, 10, 6, 14, 9],
              "circle-color": [
                "step", ["coalesce", ["get", "stg_ovlvl"], -1],
                "#c8c8cb", // 欠測(stg_ovlvlが無い)
                0, "#66ccff",   // 通常
                10, "#35a86b",  // 水防団待機
                20, "#f2e700",  // 氾濫注意
                40, "#ff2800",  // 避難判断
                80, "#aa00aa",  // 氾濫危険
                90, "#140014",  // 氾濫発生
              ],
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 1.2,
            },
          }, "station-points-symbol");
          // タップ中の観測所を強調する専用レイヤー(選択中の1件だけをsetFilterで絞る)。
          map.addLayer({
            id: "river-stations-highlight-layer",
            type: "circle",
            source: "river-stations",
            layout: { visibility: "none" },
            filter: ["==", ["get", "obs_fcd"], "__none__"],
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 6, 10, 10, 14, 14],
              "circle-color": "rgba(0,0,0,0)",
              "circle-stroke-color": "#0A84FF",
              "circle-stroke-width": 3,
            },
          }, "station-points-symbol");

          // 震央分布(P2P地震一覧・近傍地震検索・データベース検索の結果を、
          // 震度配色の丸として地図上に重ねて表示する)。
          // 独自のcanvasレイヤーではなくMapLibre標準のcircleレイヤーにすることで、
          // map.on('click'/'mousemove', layerId, ...)によるタップ選択・
          // ホバー/タッチ時のツールチップ表示がそのまま使える。
          // beforeIdを指定していないため、ここまでに作った他のレイヤー
          // (観測点・断層・プレート境界など)より上に、かつこの後に作る
          // hypocenter-point-symbol(選択中の地震の×印)より下に積み重なる。
          map.addSource("epicenter-points", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "epicenter-points-layer",
            type: "circle",
            source: "epicenter-points",
            paint: {
              // 参考にしたLeaflet版(circleMarker)と同じ考え方で、マグニチュードに
              // 応じた固定ピクセル半径にする(ズームで拡大縮小しない)。
              "circle-radius": ["max", ["*", ["coalesce", ["get", "mag"], 4], 2.2], 5],
              "circle-color": buildEpicenterCircleColorExpr(colorSchemeRef.current),
              "circle-opacity": 0.45,
              "circle-stroke-color": buildEpicenterCircleStrokeColorExpr(colorSchemeRef.current, modeRef.current),
              "circle-stroke-width": 1.4,
              "circle-stroke-opacity": 0.95,
            },
          });

          // 震源マーカー用のソース・レイヤー。観測点レイヤーより後にaddLayerすることで、
          // MapLibreのレイヤー順だけで「震源は常に観測点より上」を保証する。
          map.addSource("hypocenter-point", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "hypocenter-point-symbol",
            type: "symbol",
            source: "hypocenter-point",
            layout: {
              "icon-image": "hypocenter-cross",
              // crossSize(36px)を焼いたが、見た目の大きさは元の28px相当のまま保つための比率
              "icon-size": 28 / 36,
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            },
          });

          // 観測点の丸+観測された津波の高さ(推定)バーをまとめて表示するレイヤー
          // (tideStationBarsModeがtrueの間だけ使う。App側のcombinedTideStations参照。
          // データが空の間は何も描かれない)。tsunamiStationIconId参照のとおり、
          // 丸とバーを1枚のアイコンにまとめているのは、レイヤーをまたいだ重なり順を
          // MapLibreで制御できないため(同じレイヤー内でのみsymbol-sort-keyが効く)。
          map.addSource("tsunami-height-bars", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "tsunami-height-bars-layer",
            type: "symbol",
            source: "tsunami-height-bars",
            layout: {
              "icon-image": ["get", "iconId"],
              "icon-anchor": "bottom",
              "icon-size": 1, // 固定(ズームに応じた拡大縮小をしない)
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              // 観測点の丸(アイコン画像内では一番下)の中心を、実際の座標にきちんと
              // 合わせるためのズレ補正(render関数側で計算)。無いと、バーの分だけ
              // 画像全体が高くなる影響で、丸が実際の位置より北へズレて見えてしまう。
              "icon-offset": ["get", "offset"],
              // 観測点の丸のレイヤー(常に配列順=描画順)と重なり方を揃えるための
              // 明示的な並び順(symbolレイヤーは指定しないと重なり順が保証されないため)。
              "symbol-sort-key": ["get", "sortKey"],
            },
          });

          // 潮位観測点のピン。津波タブの「潮位計」モード、または現在進行形の津波情報が
          // ある間(発令中の予報区の観測点のみ)にデータが入る
          // (tideStationPointsが空の間は何も描かれない)。
          map.addSource("tide-station-points", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "tide-station-points-layer",
            type: "circle",
            source: "tide-station-points",
            paint: {
              "circle-radius": [
                "interpolate", ["linear"], ["zoom"],
                4,  ["case", ["get", "selected"], 7, 4.5],
                8,  ["case", ["get", "selected"], 8, 5.5],
                12, ["case", ["get", "selected"], 11, 7],
                16, ["case", ["get", "selected"], 15, 9.5],
              ],
              "circle-color": [
                "case",
                ["get", "selected"], "#FF9F0A",
                ["get", "dotColor"],
              ],
              "circle-stroke-width": ["case", ["get", "selected"], 2.5, 1.5],
              "circle-stroke-color": "#ffffff",
              // tideStationBarsModeがtrueの間(observedTsunamiHeightバーを表示するモード)は、
              // 丸とバーの重なり順を正しく揃えるため、代わりにtsunami-height-bars-layer
              // (1枚のアイコンに丸+バーをまとめて描く)を使う。このレイヤーはその間、
              // タップ判定(ヒットテスト)のためだけに透明のまま残しておく
              // (circle-opacityを0にしても、クリック判定自体は引き続き機能する)。
              "circle-opacity": 1,
              "circle-stroke-opacity": 1,
            },
          });
          map.on("mouseenter", "tide-station-points-layer", () => {
            if (!tideStationsInteractiveRef.current) return;
            map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", "tide-station-points-layer", () => {
            map.getCanvas().style.cursor = "";
          });
          map.on("click", "tide-station-points-layer", (e) => {
            if (!tideStationsInteractiveRef.current) return; // 過去の津波の参照専用表示ではタップを無効にする
            if (!e.features || !e.features.length) return;
            onSelectTideStationRef.current?.(e.features[0].properties.code);
          });
          // 観測点の丸+バーをまとめて描くレイヤー(tideStationBarsModeの間、実際に
          // 見えているのはこちら)。バーの部分をタップしても、丸をタップした時と
          // 同じく観測点を選択できるようにする(アイコン全体が当たり判定になるため、
          // 丸だけでなくバーの範囲もタップ可能)。
          map.on("click", "tsunami-height-bars-layer", (e) => {
            if (!tideStationsInteractiveRef.current) return; // 過去の津波の参照専用表示ではタップを無効にする
            if (!e.features || !e.features.length) return;
            onSelectTideStationRef.current?.(e.features[0].properties.code);
          });
          map.on("mouseenter", "tsunami-height-bars-layer", () => {
            if (!tideStationsInteractiveRef.current) return;
            map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", "tsunami-height-bars-layer", () => {
            map.getCanvas().style.cursor = "";
          });

          // 震央分布の丸のタップ選択・ホバー/タッチ時のツールチップ表示。
          map.on("mouseenter", "epicenter-points-layer", () => {
            map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", "epicenter-points-layer", () => {
            map.getCanvas().style.cursor = "";
            setEpicenterTooltip(null);
          });
          map.on("mousemove", "epicenter-points-layer", (e) => {
            if (!e.features || !e.features.length) return;
            const p = e.features[0].properties || {};
            const magNum = Number(p.mag);
            const magText = Number.isFinite(magNum) && magNum > 0 ? `M${magNum.toFixed(1)}` : "M不明";
            const depthNum = Number(p.depth);
            const depthText = depthNum === 0 ? "ごく浅い" : (Number.isFinite(depthNum) && depthNum > 0 ? `${depthNum}km` : "深さ不明");
            setEpicenterTooltip({
              x: e.point.x,
              y: e.point.y,
              title: p.place || "震源地不明",
              text: `${p.time || ""}　${magText}　深さ${depthText}`,
            });
          });
          map.on("click", "epicenter-points-layer", (e) => {
            if (!e.features || !e.features.length) return;
            setEpicenterTooltip(null);
            onSelectEpicenterPointRef.current?.(e.features[0].properties.id);
          });

          // 警報タブ: 塗り分けられた市区町村をタップした時、regioncodeを親(App)に
          // 伝える。名称・警報種別は親側でwarningLevelMap/エリア名マスタから
          // 引くため、ここではregioncodeだけ渡せば十分。
          map.on("click", "warning-areas-fill-layer", (e) => {
            if (!e.features || !e.features.length) return;
            onSelectWarningAreaRef.current?.(e.features[0].properties.regioncode);
          });
          map.on("mouseenter", "warning-areas-fill-layer", () => map.getCanvas().style.cursor = "pointer");
          map.on("mouseleave", "warning-areas-fill-layer", () => map.getCanvas().style.cursor = "");

          // 警報タブ: 河川水位観測所のピンをタップした時、properties一式を
          // そのまま親(App)に渡す。
          map.on("click", "river-stations-layer", (e) => {
            if (!e.features || !e.features.length) return;
            onSelectRiverStationRef.current?.(e.features[0].properties);
          });
          map.on("mouseenter", "river-stations-layer", () => map.getCanvas().style.cursor = "pointer");
          map.on("mouseleave", "river-stations-layer", () => map.getCanvas().style.cursor = "");

          // 津波テスト配信「地図タップで選択」モード中だけ有効になる、地図全体を対象と
          // したクリック(レイヤー指定なし)。タップ地点から一番近い予報区(海岸線)の
          // 頂点を探し、近すぎず遠すぎない(60km以内)場合だけ選択として採用する。
          // 海上や地図の対象外の場所を誤ってタップした場合は何も起きない。
          map.on("click", (e) => {
            if (!tsunamiAreaPickActiveRef.current) return;
            const geo = tsunamiAreasGeoDataRef.current;
            if (!geo) return;
            const nearest = findNearestTsunamiAreaWithDistance(e.lngLat.lat, e.lngLat.lng, geo);
            if (!nearest || nearest.distanceKm > 60) return;
            onPickTsunamiAreaRef.current?.(nearest.name);
          });

          // 緊急地震速報テスト配信「地図をタップして震源を指定」モード中だけ有効になる、
          // 地図全体を対象としたクリック。タップ地点の緯度経度をそのまま震源座標にし、
          // ep.json(遅延読み込み済みなら同期的に、まだなら取得してから)で
          // その地点を含む区域名を調べ、緯度・経度・震源地名をまとめて返す。
          map.on("click", (e) => {
            if (!eewEpicenterPickActiveRef.current) return;
            const { lat, lng } = e.lngLat;
            const geo = epicenterNamesGeoDataRef.current;
            if (geo) {
              const name = findEpicenterNameByPoint(geo, lat, lng);
              onPickEewEpicenterRef.current?.(lat, lng, name);
            } else {
              // 初回タップ時にまだ読み込めていない場合は、取得を待ってから確定する。
              loadEpicenterNamesData().then((loaded) => {
                epicenterNamesGeoDataRef.current = loaded;
                const name = findEpicenterNameByPoint(loaded, lat, lng);
                onPickEewEpicenterRef.current?.(lat, lng, name);
              }).catch((err) => {
                console.error("震央地名データの読み込みに失敗しました:", err);
                onPickEewEpicenterRef.current?.(lat, lng, null);
              });
            }
          });

          // 地震情報テスト配信「地図をタップして震源を指定」モード用。EEWの震源ピックと
          // 全く同じ処理(ep.jsonでの震央地名検索)を、行き先(onPickQuakeEpicenter)だけ
          // 変えて共有する。
          map.on("click", (e) => {
            if (!quakeEpicenterPickActiveRef.current) return;
            const { lat, lng } = e.lngLat;
            const geo = epicenterNamesGeoDataRef.current;
            if (geo) {
              const name = findEpicenterNameByPoint(geo, lat, lng);
              onPickQuakeEpicenterRef.current?.(lat, lng, name);
            } else {
              loadEpicenterNamesData().then((loaded) => {
                epicenterNamesGeoDataRef.current = loaded;
                const name = findEpicenterNameByPoint(loaded, lat, lng);
                onPickQuakeEpicenterRef.current?.(lat, lng, name);
              }).catch((err) => {
                console.error("震央地名データの読み込みに失敗しました:", err);
                onPickQuakeEpicenterRef.current?.(lat, lng, null);
              });
            }
          });

          // 現在地マーカー(iOSの地図でおなじみの、白フチ付きの青い丸+薄いハロー)。
          // 気象タブ「地点」モードでGPS取得に成功している間だけ、App側から
          // currentLocationPointが渡ってきてsetDataされる(下のuseEffect参照)。
          // それ以外のタブ・モードでは常に空のFeatureCollectionのままで何も描かれない。
          map.addSource("user-location-point", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "user-location-halo-layer",
            type: "circle",
            source: "user-location-point",
            paint: {
              "circle-radius": 16,
              "circle-color": "#0A84FF",
              "circle-opacity": 0.2,
              "circle-stroke-width": 0,
            },
          });
          map.addLayer({
            id: "user-location-dot-layer",
            type: "circle",
            source: "user-location-point",
            paint: {
              "circle-radius": 7,
              "circle-color": "#0A84FF",
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 3,
              "circle-opacity": 1,
              "circle-stroke-opacity": 1,
            },
          });

          // 緊急地震速報(EEW)の地域ごとの予測震度塗りつぶしは、専用レイヤーは
          // 持たず、地震情報の震度分布と同じ"areas"ソース/"areas-intensity-fill"・
          // "areas-intensity-line"レイヤー(feature-state)を共用する(下のuseEffectで
          // setFeatureStateする)。塗り方・線・重なり順を地震情報の震度塗りつぶしと
          // 完全に一致させるため。

          // ─────────────────────────────────────────────
          // 緊急地震速報(EEW): P波・S波の伝播円と震源マーカー。
          // データは別のuseEffect(下方)がrequestAnimationFrameで頻繁に
          // setDataするため、ここでは空のソースを用意するだけでよい。
          // 他のレイヤーより後に追加し、常に最前面に描画されるようにする。
          map.addSource("eew-pwave", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          map.addLayer({
            id: "eew-pwave-fill-layer", type: "fill", source: "eew-pwave",
            paint: { "fill-color": "#32ADE6", "fill-opacity": 0.08 },
          });
          map.addLayer({
            id: "eew-pwave-line-layer", type: "line", source: "eew-pwave",
            paint: { "line-color": "#32ADE6", "line-width": 1.5, "line-opacity": 0.8 },
          });

          map.addSource("eew-swave", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          map.addLayer({
            id: "eew-swave-fill-layer", type: "fill", source: "eew-swave",
            paint: { "fill-color": "#FF453A", "fill-opacity": 0.12 },
          });
          map.addLayer({
            id: "eew-swave-line-layer", type: "line", source: "eew-swave",
            paint: { "line-color": "#FF453A", "line-width": 2.2, "line-opacity": 0.9 },
          });

          map.addSource("eew-hypocenter", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          map.addLayer({
            id: "eew-hypocenter-symbol", type: "symbol", source: "eew-hypocenter",
            layout: {
              // PLUM法は震源からの距離だけで判定し到達時刻の予測を伴わないため、
              // バツ印ではなく円のアイコンで区別する(index.html版と同じ考え方)。
              "icon-image": ["case", ["boolean", ["get", "isPlum"], false], "hypocenter-plum-circle", "hypocenter-cross"],
              "icon-size": 28 / 36,
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            },
          });

          // ─────────────────────────────────────────────
          // 台風情報。1つのgeojson sourceに全台風ぶんの中心点・予報円・
          // 暴風域/強風域・過去/予測経路・警戒領域(結合ポリゴン)・暴風警戒域を
          // properties.typeで区別して入れ、typeごとにfilterした複数レイヤーを
          // 重ねる。データ本体はtyphoonGeojsonが変わるたびに動く別のuseEffectが
          // setDataするため、ここでは空のソースを用意するだけでよい。
          map.addSource("typhoon", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

          map.addLayer({
            id: "layer-typhoon-forecast-fill", type: "fill", source: "typhoon",
            layout: { visibility: "none" }, filter: ["==", "type", "forecastArea"],
            paint: { "fill-color": "#FFFFFF", "fill-opacity": 0.1 },
          });
          map.addLayer({
            id: "layer-typhoon-storm-warning-fill", type: "fill", source: "typhoon",
            layout: { visibility: "none" }, filter: ["==", "type", "stormWarningArea"],
            paint: { "fill-color": "#FF2800", "fill-opacity": 0.12 },
          });
          map.addLayer({
            id: "layer-typhoon-storm-warning-line", type: "line", source: "typhoon",
            layout: { visibility: "none" }, filter: ["==", "type", "stormWarningArea"],
            paint: { "line-color": "#FF2800", "line-width": 2.5, "line-opacity": 0.95 },
          });
          map.addLayer({
            id: "layer-typhoon-forecast-area-line", type: "line", source: "typhoon",
            layout: { visibility: "none" }, filter: ["==", "type", "forecastArea"],
            paint: { "line-color": "#FFFFFF", "line-width": 1.5, "line-opacity": 0.6 },
          });
          map.addLayer({
            id: "layer-typhoon-forecast-circle-line", type: "line", source: "typhoon",
            layout: { visibility: "none" }, filter: ["==", "type", "forecastCircle"],
            paint: {
              // 熱帯低気圧・温帯低気圧に変化した予報円はグレーで区別する
              "line-color": ["case", ["==", ["get", "weakened"], true], "#9AA0A6", "#FFFFFF"],
              "line-width": 1.4, "line-dasharray": [3, 4], "line-opacity": 0.8,
            },
          });
          map.addLayer({
            id: "layer-typhoon-area", type: "fill", source: "typhoon",
            layout: { visibility: "none" }, filter: ["in", "type", "stormArea", "windArea"],
            paint: {
              "fill-color": ["match", ["get", "type"], "stormArea", "#FF2800", "windArea", "#FFEF00", "#FFFFFF"],
              "fill-opacity": 0.35,
            },
          });
          map.addLayer({
            id: "layer-typhoon-past-track", type: "line", source: "typhoon",
            layout: { visibility: "none" }, filter: ["==", "type", "pastTrack"],
            paint: { "line-color": "#FFFFFF", "line-width": 1.6, "line-opacity": 0.55 },
          });
          map.addLayer({
            id: "layer-typhoon-track", type: "line", source: "typhoon",
            layout: { visibility: "none" }, filter: ["==", "type", "track"],
            paint: { "line-color": "#FFFFFF", "line-width": 2, "line-dasharray": [3, 3], "line-opacity": 0.75 },
          });
          map.addLayer({
            id: "layer-typhoon-center", type: "circle", source: "typhoon",
            layout: { visibility: "none" }, filter: ["==", "type", "center"],
            paint: {
              "circle-radius": 6,
              // 暴風域(赤)と紛らわしいため、現在位置の点はただの白丸にする。
              // 熱帯低気圧・温帯低気圧に変化している場合のみグレーで区別する。
              "circle-color": ["case", ["==", ["get", "weakened"], true], "#9AA0A6", "#FFFFFF"],
              "circle-stroke-width": 2, "circle-stroke-color": "#1c1c1e",
            },
          });
          map.on("mouseenter", "layer-typhoon-center", () => {
            map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", "layer-typhoon-center", () => {
            map.getCanvas().style.cursor = "";
          });
          map.on("click", "layer-typhoon-center", (e) => {
            if (!e.features || !e.features.length) return;
            onSelectTyphoonCenterRef.current?.(e.features[0].properties);
          });

          setStatus("ready");
          if (onReady) onReady(map);
        });

        map.on("error", (e) => {
          console.error("MapLibre error event:", e?.error || e);
          if (cancelled) return;
          setStatus("error");
          setErrorMsg(e?.error?.message || "地図の描画中にエラーが発生しました");
        });

        mapRef.current = map;
      })
      .catch((err) => {
        console.error("地図の読み込みに失敗:", err);
        if (cancelled) return;
        setStatus("error");
        setErrorMsg(err.message || "地図データまたはMapLibre GL JS本体の読み込みに失敗しました");
      });

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 選択中の地震(stationPoints)が変わるたびに、観測点マーカーのGeoJSONを更新する。
  // 緯度経度が引けなかった観測点(マスタに見つからなかったもの)は地図には出さない。
  // sortOrder(震度の小さい順の連番)をsymbol-sort-keyに渡すことで、
  // 震度が大きい観測点ほど前面に描画されるようにする。
  // 震度速報・震源に関する情報(isArea:true、細分区域単位)は、通常の観測点とは
  // 別のソース(area-points、角丸正方形アイコン)に分けて表示する。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const stationSource = map.getSource("station-points");
    const areaSource = map.getSource("area-points");
    if (!stationSource || !areaSource) return;

    const toFeature = (p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
      properties: {
        intensityKey: STATION_ICON_KEYS.includes(p.intensityKey) ? p.intensityKey : "0",
        sortOrder: STATION_ICON_KEYS.indexOf(p.intensityKey),
      },
    });

    const resolvedPoints = stationMarkersVisible
      ? (stationPoints || []).filter(p => p.latitude != null && p.longitude != null)
      : [];
    const stationFeatures = resolvedPoints.filter(p => !p.isArea).map(toFeature);
    const areaFeatures = resolvedPoints.filter(p => p.isArea).map(toFeature);

    stationSource.setData({ type: "FeatureCollection", features: stationFeatures });
    areaSource.setData({ type: "FeatureCollection", features: areaFeatures });
  }, [stationPoints, status, stationMarkersVisible]);

  // 緊急地震速報: P波・S波の伝播円と震源マーカーをリアルタイムに更新する。
  // eews自体は1秒間隔のstate更新(App側の生存タイマー)にしか追従しないため、
  // 経過時間から円を滑らかに広げるにはrequestAnimationFrameで独自に回す必要がある。
  // ただしGeoJSONのsetDataは決して軽くないので、フレームごとではなく
  // 約180ms間隔に間引いて呼び出す(タブが非表示の間は自動的に止まる)。
  const eewsRef = useRef(eews);
  eewsRef.current = eews;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    let frameId = null;
    let lastTick = 0;

    function tick(ts) {
      if (ts - lastTick >= 180) {
        lastTick = ts;
        const list = eewsRef.current || [];
        const pFeatures = [];
        const sFeatures = [];
        const hypoFeatures = [];

        list.forEach(eew => {
          if (eew.cancelled || eew.latitude == null || eew.longitude == null) return;
          hypoFeatures.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [eew.longitude, eew.latitude] },
            properties: { isPlum: !!eew.isPlum },
          });
          if (eew.isPlum) return; // PLUM法は到達時刻の予測が無いため円は描かない
          const originMs = eew.originTime ? new Date(eew.originTime.replace(/-/g, "/")).getTime() : NaN;
          if (!Number.isFinite(originMs)) return;
          const elapsedSec = (Date.now() - originMs) / 1000;
          const pRadiusKm = eewWaveSurfaceRadiusKm(elapsedSec, eew.depth, EEW_P_WAVE_SPEED_KM_S);
          const sRadiusKm = eewWaveSurfaceRadiusKm(elapsedSec, eew.depth, EEW_S_WAVE_SPEED_KM_S);
          const pRing = eewCirclePolygon(eew.latitude, eew.longitude, pRadiusKm);
          if (pRing) pFeatures.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [pRing] }, properties: {} });
          const sRing = eewCirclePolygon(eew.latitude, eew.longitude, sRadiusKm);
          if (sRing) sFeatures.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [sRing] }, properties: {} });
        });

        const pSource = map.getSource("eew-pwave");
        const sSource = map.getSource("eew-swave");
        const hypoSource = map.getSource("eew-hypocenter");
        if (pSource) pSource.setData({ type: "FeatureCollection", features: pFeatures });
        if (sSource) sSource.setData({ type: "FeatureCollection", features: sFeatures });
        if (hypoSource) hypoSource.setData({ type: "FeatureCollection", features: hypoFeatures });
      }
      frameId = requestAnimationFrame(tick);
    }
    frameId = requestAnimationFrame(tick);

    return () => { if (frameId != null) cancelAnimationFrame(frameId); };
  }, [status]);

  // 台風情報: typhoonGeojsonが変わるたびにsourceへ流し込み、予報円の横に出す
  // 時刻ラベル(maplibregl.Marker)も同じタイミングで作り直す。
  // マーカーはDOM要素なのでReactツリー外で自前管理し、古いものは必ず先にremoveする。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const source = map.getSource("typhoon");
    if (source) source.setData(typhoonGeojson || { type: "FeatureCollection", features: [] });

    // 既存マーカーを掃除
    typhoonForecastMarkersRef.current.forEach(marker => marker.remove());
    typhoonForecastMarkersRef.current = [];

    if (!typhoonVisible || !typhoonGeojson?.features) return;

    let maplibregl = window.maplibregl;
    if (!maplibregl) return; // 地図自体が読めていればここは通常falsyにならない

    typhoonGeojson.features
      .filter(f => f.properties?.type === "forecastCircle")
      .forEach(f => {
        const label = f.properties.forecastTime;
        const center = f.properties.labelPoint;
        if (!label || !center) return;

        const el = document.createElement("div");
        el.className = "typhoon-forecast-time-marker";
        if (f.properties.weakened && f.properties.category) {
          // 「熱帯低気圧(TD)」のように括弧付きで格納されているため、日本語部分のみ短く表示する
          const classText = String(f.properties.category).split("(")[0] || f.properties.category;
          const timeEl = document.createElement("span");
          timeEl.textContent = label;
          const badgeEl = document.createElement("span");
          badgeEl.className = "typhoon-forecast-class-badge";
          badgeEl.textContent = classText;
          el.appendChild(timeEl);
          el.appendChild(badgeEl);
        } else {
          el.textContent = label;
        }
        el.onclick = (event) => {
          event.stopPropagation();
          onSelectTyphoonCenterRef.current?.(f.properties);
        };
        typhoonForecastMarkersRef.current.push(
          new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat(center).addTo(map)
        );
      });

    return () => {
      typhoonForecastMarkersRef.current.forEach(marker => marker.remove());
      typhoonForecastMarkersRef.current = [];
    };
  }, [status, typhoonGeojson, typhoonVisible]);

  // 台風情報レイヤーのON/OFF切り替え。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const vis = typhoonVisible ? "visible" : "none";
    [
      "layer-typhoon-forecast-fill", "layer-typhoon-storm-warning-fill",
      "layer-typhoon-storm-warning-line", "layer-typhoon-forecast-area-line",
      "layer-typhoon-forecast-circle-line", "layer-typhoon-area",
      "layer-typhoon-past-track", "layer-typhoon-track", "layer-typhoon-center",
    ].forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
    });
  }, [status, typhoonVisible]);

  // 台風一覧の項目をタップした時、その台風の強風域(無ければ暴風域)が画面に
  // 収まるズーム倍率でflyToする。半径データが無い(弱い熱帯低気圧等で強風域・
  // 暴風域のどちらも出ていない)場合だけ、中心点への通常のflyToにフォールバックする。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready" || !typhoonFlyToRequest) return;
    const { lon, lat, areaLon, areaLat, areaRadiusKm } = typhoonFlyToRequest;
    if (areaRadiusKm) {
      // 中心+半径(km)から単純な矩形バウンディングボックスを作る。
      // 緯度1度 ≈ 111.32km、経度1度 ≈ 111.32km×cos(緯度) で近似する。
      const latDelta = areaRadiusKm / 111.32;
      const lonDelta = areaRadiusKm / (111.32 * Math.max(0.1, Math.cos(areaLat * Math.PI / 180)));
      map.fitBounds(
        [[areaLon - lonDelta, areaLat - latDelta], [areaLon + lonDelta, areaLat + latDelta]],
        {
          padding: isWide
            ? { top: 40, bottom: 40, left: 460, right: 40 }
            : { top: 80, bottom: 220, left: 40, right: 40 },
          maxZoom: 9,
          duration: 800,
        }
      );
    } else {
      map.flyTo({ center: [lon, lat], zoom: 6, duration: 800 });
    }
  }, [status, typhoonFlyToRequest]);

  // 緊急地震速報: areas[]に予測震度がある場合、その地域を細分区域.json上で
  // 名前が一致するポリゴンを探し、震度の色で塗りつぶす。P/S波の円と違って
  // 頻繁には変わらないため、requestAnimationFrameではなくeewsが変化した時だけ
  // 計算する。取消・タイムアウトで対象のEEWが無くなったら自動的に消える。
  // 地震情報の震度分布(下のuseEffect)と全く同じ"areas"ソース/feature-stateの
  // 仕組み(setFeatureState)を使い、同じ"areas-intensity-fill"・
  // "areas-intensity-line"レイヤーで描画する。塗った区域コードは
  // eewPaintedAreaCodesRefで別管理し、地震情報側が塗った区域(paintedAreaCodesRef)
  // を巻き込んで消してしまわないようにしている。
  const eewPaintedAreaCodesRef = useRef([]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    let cancelled = false;

    loadGeoData().then(({ areas: areasGeoJSON }) => {
      if (cancelled) return;

      for (const code of eewPaintedAreaCodesRef.current) {
        map.setFeatureState({ source: "areas", id: code }, { color: null, hasIntensity: 0 });
      }
      eewPaintedAreaCodesRef.current = [];

      const paintedCodes = new Set();
      let minOrderIdx = Infinity, maxOrderIdx = -Infinity;
      for (const eew of eews) {
        if (eew.cancelled || !Array.isArray(eew.areas)) continue;
        for (const area of eew.areas) {
          const intensityKey = area.maxIntensityKey;
          if (!intensityKey || intensityKey === "?") continue;
          const codes = findAreaCodesByName(areasGeoJSON, area.name);
          if (codes.length === 0) continue;
          const color = (colorScheme.colors[intensityKey] || colorScheme.colors["0"]).bg;
          const orderIdx = EEW_FILL_LEGEND_ORDER.indexOf(intensityKey);
          for (const code of codes) {
            if (paintedCodes.has(code)) continue; // 複数EEWが同じ地域を含む場合は先勝ちでよい
            paintedCodes.add(code);
            map.setFeatureState({ source: "areas", id: code }, { color, hasIntensity: 1 });
            if (orderIdx !== -1) {
              if (orderIdx < minOrderIdx) minOrderIdx = orderIdx;
              if (orderIdx > maxOrderIdx) maxOrderIdx = orderIdx;
            }
          }
        }
      }
      eewPaintedAreaCodesRef.current = [...paintedCodes];
      setEewFillRange(
        maxOrderIdx >= 0
          ? { minKey: EEW_FILL_LEGEND_ORDER[minOrderIdx], maxKey: EEW_FILL_LEGEND_ORDER[maxOrderIdx] }
          : null
      );
    }).catch(err => {
      console.error("緊急地震速報の地域塗りつぶし用データの読み込みに失敗:", err);
    });

    return () => { cancelled = true; };
  }, [eews, status, colorScheme]);

  // 配色スキームが切り替わったら、観測点アイコン(丸+白フチ+数字)を焼き直す。
  // symbolレイヤー側は同じicon-image名を参照し続けるので、updateImageするだけで
  // 表示中のマーカーにも即座に反映される。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    registerStationIcons(map, colorScheme);
    registerAreaIcons(map, colorScheme);
  }, [colorScheme, status]);

  // 震度分布(細分区域ごとの塗り分け)を更新する。
  // 前回塗った区域は毎回リセットしてから、今回の集計結果を塗り直す
  // (そうしないと、観測点が無くなった区域の色が古いまま残ってしまう)。
  // 設定でOFFにされている場合は、リセットだけ行って塗り直しはしない(塗りつぶし無し状態にする)。
  const paintedAreaCodesRef = useRef([]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    for (const code of paintedAreaCodesRef.current) {
      map.setFeatureState({ source: "areas", id: code }, { color: null, hasIntensity: 0 });
    }
    paintedAreaCodesRef.current = [];

    if (!areaFillEnabled) return;

    const maxByArea = aggregateByArea(stationPoints || []);
    const codes = [];
    maxByArea.forEach((intensityKey, code) => {
      const color = (colorScheme.colors[intensityKey] || colorScheme.colors["0"]).bg;
      map.setFeatureState({ source: "areas", id: code }, { color, hasIntensity: 1 });
      codes.push(code);
    });
    paintedAreaCodesRef.current = codes;
  }, [stationPoints, status, colorScheme, areaFillEnabled]);

  // 断層(faults.geojson)の表示ON/OFF。トグルがONになった最初の1回だけ
  // 実データ(数MB)を取得してsetDataで流し込み、以降のON/OFF切り替えは
  // レイヤーのvisibilityを変えるだけ(再取得しない)にすることで、
  // OFFのままなら通信自体が発生しないようにしている。
  const faultsLoadedRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("faults-layer")) return;

    const v = faultsEnabled ? "visible" : "none";
    map.setLayoutProperty("faults-halo-layer", "visibility", v);
    map.setLayoutProperty("faults-layer", "visibility", v);

    if (faultsEnabled && !faultsLoadedRef.current) {
      faultsLoadedRef.current = true;
      loadFaultsData()
        .then((geojson) => {
          const source = map.getSource("faults");
          if (source) source.setData(geojson);
        })
        .catch((err) => {
          console.error("断層データの読み込みに失敗しました:", err);
          faultsLoadedRef.current = false; // 失敗時は次回ONで再試行できるようにする
        });
    }
  }, [faultsEnabled, status]);

  // プレート境界(plate-boundaries.json)の表示ON/OFF。断層と同様の遅延読み込み。
  const plateBoundariesLoadedRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("plate-boundaries-layer")) return;

    const v = plateBoundariesEnabled ? "visible" : "none";
    map.setLayoutProperty("plate-boundaries-halo-layer", "visibility", v);
    map.setLayoutProperty("plate-boundaries-layer", "visibility", v);

    if (plateBoundariesEnabled && !plateBoundariesLoadedRef.current) {
      plateBoundariesLoadedRef.current = true;
      loadPlateBoundariesData()
        .then((geojson) => {
          const source = map.getSource("plate-boundaries");
          if (source) source.setData(geojson);
        })
        .catch((err) => {
          console.error("プレート境界データの読み込みに失敗しました:", err);
          plateBoundariesLoadedRef.current = false; // 失敗時は次回ONで再試行できるようにする
        });
    }
  }, [plateBoundariesEnabled, status]);

  // 津波予報区(海岸線)。断層・プレート境界と同じ遅延読み込みだが、こちらは
  // 設定トグルではなく「表示すべき予報区(tsunamiAreas)が1件以上ある」ことが
  // トリガーになる(=津波タブで津波情報の詳細を開いた時だけ実データを取得する)。
  const tsunamiAreasLoadedRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("tsunami-areas-layer")) return;

    // ピックモード中は、まだ何も選ばれていなくても海岸線自体が見えていないと
    // タップする場所が分からないため、全予報区を薄く一律で見せる。
    // 通常時は今まで通り、実際に有効な津波情報の予報区だけをグレードの色で塗る。
    map.setPaintProperty(
      "tsunami-areas-layer",
      "line-color",
      tsunamiAreaPickActive ? "rgba(120,190,255,0.55)" : buildTsunamiAreaColorExpr(tsunamiAreas)
    );
    map.getCanvas().style.cursor = tsunamiAreaPickActive ? "crosshair" : "";

    if ((tsunamiAreas.length > 0 || tsunamiAreaPickActive) && !tsunamiAreasLoadedRef.current) {
      tsunamiAreasLoadedRef.current = true;
      loadTsunamiAreasData()
        .then((geojson) => {
          tsunamiAreasGeoDataRef.current = geojson; // クリック時の最近傍探索用に保持
          const source = map.getSource("tsunami-areas");
          if (source) source.setData(geojson);
        })
        .catch((err) => {
          console.error("津波予報区データの読み込みに失敗しました:", err);
          tsunamiAreasLoadedRef.current = false; // 失敗時は次回表示対象が出た時に再試行できるようにする
        });
    }
  }, [tsunamiAreas, tsunamiAreaPickActive, status]);

  // 警報タブ: 警報・注意報レイヤー。境界データ(warning_areas.json、1,821件)は
  // 警報タブを一度でも開いた時だけ遅延読み込みする(断層・津波予報区と同じ方式)。
  // warningLevelMapが実際に更新された時だけ、色を塗り直す(=setDataし直す)。
  const warningAreasLoadedRef = useRef(false);
  const warningAreasBaseGeoJsonRef = useRef(null);
  // 直近でsetDataに使ったwarningLevelMapの参照。タブを開き直しただけで
  // warningLevelMapの中身が変わっていない(=Appの再取得がまだ終わっていない)
  // 間は、visibilityの切り替えだけにして、1,821件分の塗り直し
  // (setData、MapLibre内部の再タイル化を伴う重い処理)をスキップする。
  const warningAreasLastMergedLevelMapRef = useRef(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("warning-areas-fill-layer")) return;

    map.setLayoutProperty("warning-areas-fill-layer", "visibility", warningVisible ? "visible" : "none");
    map.setLayoutProperty("warning-areas-line-layer", "visibility", warningVisible ? "visible" : "none");
    // キキクル表示中は警報の塗り分けを見た目上だけ消す(visibilityではなく
    // opacityを0にする)。visibility:noneにするとMapLibreのクリック判定
    // (queryRenderedFeatures)も効かなくなり、キキクル表示中に市区町村を
    // タップできなくなってしまうため。
    map.setPaintProperty("warning-areas-fill-layer", "fill-opacity", riskVisible ? 0 : 0.55);
    map.setPaintProperty("warning-areas-line-layer", "line-opacity", riskVisible ? 0 : 1);
    if (!warningVisible) return;

    if (!warningAreasLoadedRef.current) {
      warningAreasLoadedRef.current = true;
      loadWarningAreasFullGeoJson()
        .then((geojson) => {
          warningAreasBaseGeoJsonRef.current = geojson;
          warningAreasLastMergedLevelMapRef.current = warningLevelMap;
          const merged = buildWarningAreasGeoJson(geojson, warningLevelMap);
          const source = map.getSource("warning-areas");
          if (source) source.setData(merged);
        })
        .catch((err) => {
          console.error("警報・注意報の境界データの読み込みに失敗しました:", err);
          warningAreasLoadedRef.current = false; // 失敗時は次回表示された時に再試行できるようにする
        });
    } else if (
      warningAreasBaseGeoJsonRef.current &&
      warningAreasLastMergedLevelMapRef.current !== warningLevelMap
    ) {
      // 境界データは既にあり、かつwarningLevelMapが前回塗り直した時から
      // 実際に変わっている場合(ポーリング更新、または再取得完了)だけ
      // setDataし直す(再取得は不要)。
      warningAreasLastMergedLevelMapRef.current = warningLevelMap;
      const merged = buildWarningAreasGeoJson(warningAreasBaseGeoJsonRef.current, warningLevelMap);
      const source = map.getSource("warning-areas");
      if (source) source.setData(merged);
    }
  }, [warningVisible, warningLevelMap, riskVisible, status]);

  // 警報タブ: 河川水位観測所。riverStations(BottomDock側で10分おきに取得した
  // GeoJSON)をそのままsetDataし、riverVisibleでON/OFFする。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("river-stations-layer")) return;

    map.setLayoutProperty("river-stations-layer", "visibility", riverVisible ? "visible" : "none");
    map.setLayoutProperty("river-stations-highlight-layer", "visibility", riverVisible ? "visible" : "none");
    const source = map.getSource("river-stations");
    if (source) source.setData(riverStations || { type: "FeatureCollection", features: [] });
  }, [riverVisible, riverStations, status]);

  // 警報タブ: タップ中の河川水位観測所を強調表示する。obs_fcdで絞り込む。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("river-stations-highlight-layer")) return;
    map.setFilter("river-stations-highlight-layer", [
      "==", ["get", "obs_fcd"], selectedRiverStation?.obs_fcd ?? "__none__",
    ]);
  }, [selectedRiverStation, status]);


  // 警報タブ: タップ/一覧選択中のエリアを強調するレイヤーの表示切り替え。
  // 選択が無い間は("__none__"は実在しないregioncodeなので)何も塗られない状態にしておく。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("warning-areas-highlight-layer")) return;

    map.setLayoutProperty(
      "warning-areas-highlight-layer",
      "visibility",
      warningVisible && selectedWarningArea ? "visible" : "none"
    );
    if (selectedWarningArea) {
      map.setFilter("warning-areas-highlight-layer", ["==", ["get", "regioncode"], selectedWarningArea]);
    }
  }, [warningVisible, selectedWarningArea, status]);

  // 警報タブ: 一覧の項目をタップした時、そのエリアの代表座標へflyToする
  // (台風一覧のflyToと同じ考え方)。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready" || !warningAreaFlyToRequest) return;
    const { lon, lat } = warningAreaFlyToRequest;
    if (lon == null || lat == null) return;
    map.flyTo({ center: [lon, lat], zoom: 8, duration: 800 });
  }, [status, warningAreaFlyToRequest]);

  // 緊急地震速報テスト配信「地図をタップして震源を指定」モード用。ONになったら
  // カーソルをcrosshairにし、震央地名データをこの時点で先読みしておく
  // (タップ時に読めていればそのまま同期的に確定でき、待たせずに済む)。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    map.getCanvas().style.cursor = (tsunamiAreaPickActive || eewEpicenterPickActive || quakeEpicenterPickActive) ? "crosshair" : "";

    if ((eewEpicenterPickActive || quakeEpicenterPickActive) && !epicenterNamesLoadedRef.current) {
      epicenterNamesLoadedRef.current = true;
      loadEpicenterNamesData()
        .then((geojson) => { epicenterNamesGeoDataRef.current = geojson; })
        .catch((err) => {
          console.error("震央地名データの読み込みに失敗しました:", err);
          epicenterNamesLoadedRef.current = false; // 失敗時は次回ONで再試行できるようにする
        });
    }
  }, [eewEpicenterPickActive, quakeEpicenterPickActive, tsunamiAreaPickActive, status]);

  // ピックモードで選ばれている予報区(pickedTsunamiAreas、複数・グレード別可)を、
  // それぞれの実際の配色で強調レイヤーに反映する。buildTsunamiAreaColorExprは
  // 「(name, grade)の配列→match式」を作る関数で、実際の津波警報表示と全く同じロジックを
  // 使うことで、選択中の色と本番配信時の色が必ず一致するようにしている。
  // このレイヤーは「テスト配信のピックモード中」だけの一時的な下書き表示のため、
  // ピックモードを抜けたら(=tsunamiAreaPickActiveがfalseになったら)pickedTsunamiAreas
  // が配列に残っていても必ず消す。これをしないと、テスト配信で選んだ予報区が
  // タブを切り替えても地図に残り続け、あたかも本物の警報が出ているように
  // 見えてしまう。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("tsunami-areas-pick-highlight-layer")) return;
    map.setPaintProperty(
      "tsunami-areas-pick-highlight-layer",
      "line-color",
      tsunamiAreaPickActive ? buildTsunamiAreaColorExpr(pickedTsunamiAreas) : "rgba(0,0,0,0)"
    );
  }, [pickedTsunamiAreas, tsunamiAreaPickActive, status]);

  // 選択中の地震(hypocenters)が変わるたびに、震源のバツ印マーカーを更新し、
  // 震源(複数の場合は全件)+周辺の観測点がちょうど収まる範囲へズームする。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const source = map.getSource("hypocenter-point");
    if (!source) return;

    const validHypocenters = (hypocenters || [])
      .filter(h => h && h.latitude != null && h.longitude != null);

    if (validHypocenters.length === 0) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    source.setData({
      type: "FeatureCollection",
      features: validHypocenters.map(h => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [h.longitude, h.latitude] },
        properties: {},
      })),
    });

    // 震源(複数あれば全件) + 観測点(緯度経度が引けたもの)が全部収まる
    // bounding boxを作ってfitBoundsする。観測点が1件も無い(マッチできなかった)
    // 場合は、震源(複数なら重心)を中心にほどよいズームへ寄せる。
    const coords = validHypocenters.map(h => [h.longitude, h.latitude]);
    (stationPoints || []).forEach(p => {
      if (p.latitude != null && p.longitude != null) coords.push([p.longitude, p.latitude]);
    });

    if (coords.length > 1) {
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      coords.forEach(([lon, lat]) => {
        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      });
      // 横画面(isWide)ではフローティングパネルが画面左側を覆っているため、
      // 左のpaddingを広めに取り、パネルに隠れない範囲にズームする。
      map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
        padding: isWide
          ? { top: 40, bottom: 40, left: 460, right: 40 }
          : { top: 80, bottom: 220, left: 40, right: 40 },
        maxZoom: 9,
        duration: 800,
      });
    } else {
      const [lon, lat] = coords[0];
      map.flyTo({
        center: [lon, lat], zoom: 7, duration: 800,
        // 横画面ではパネルぶん(360px)画面左側が隠れているので、
        // 見た目の中心が隠れない範囲の中央に来るようずらす。
        offset: isWide ? [230, 0] : [0, 0],
      });
    }
  }, [hypocenters, stationPoints, status, isWide]);

  // 現在地マーカー(青丸)の更新。currentLocationPointはApp側で気象タブ
  // 「地点」モード中のGPS取得結果のみを保持しているため、それ以外のタブ・
  // モードでは自動的にnullになり、ここで空のFeatureCollectionに戻る
  // (=地図から消える)。ズーム・パン等は一切行わない(観測点選択と違い、
  // 現在地の表示のために地図を動かすと津波タブ等での閲覧を邪魔するため)。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const source = map.getSource("user-location-point");
    if (!source) return;
    if (!currentLocationPoint || currentLocationPoint.lat == null || currentLocationPoint.lon == null) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    source.setData({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "Point", coordinates: [currentLocationPoint.lon, currentLocationPoint.lat] },
        properties: {},
      }],
    });
  }, [currentLocationPoint, status]);

  // 雨雲レーダー(高解像度降水ナウキャスト)。
  // 表示中のコマ(nowcastFrame)に加えて、前後の先読み対象コマ(nowcastPreloadFrames)
  // ぶんもopacity:0のレイヤーとしてあらかじめ追加しておく。MapLibreは
  // visibility:visibleなレイヤーであればopacityが0でもタイルを読み込むため、
  // これで「表示に使う前からバックグラウンドでタイルを読み込んでおく」先読みになる。
  // コマが切り替わった時は、既存レイヤーのopacityを差し替えるだけで済むので
  // (先読み済みなら)一瞬レーダーが消える瞬間が無くなる。
  // コマ(validtime)ごとに専用のsource/layerを持たせ、一度読み込んだコマは
  // (配色スキームを変えない限り)ずっとキャッシュしておく。ただし予測コマは
  // 5分おきの一覧更新のたびにほぼ総入れ替えになるので、nowcastKnownValidtimes
  // に無くなったコマだけは都度削除する(でないとキャッシュが際限なく増え続ける)。
  const nowcastPreloadKey = nowcastPreloadFrames.map(f => f.validtime).join(",");
  const nowcastKnownValidtimesKey = nowcastKnownValidtimes.join(",");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const removeAllNowcastLayers = () => {
      const style = map.getStyle();
      if (!style) return;
      (style.layers || []).forEach(l => {
        if (l.id.startsWith("nowcast-layer-")) map.removeLayer(l.id);
      });
      Object.keys(style.sources || {}).forEach(id => {
        if (id.startsWith("nowcast-src-")) map.removeSource(id);
      });
    };

    if (!nowcastVisible || !nowcastFrame) {
      removeAllNowcastLayers();
      return;
    }

    const wantedFrames = [nowcastFrame, ...nowcastPreloadFrames];
    const keyOf = (f) => `${nowcastColorSchemeId}-${f.validtime}`;
    const knownValidtimeSet = new Set(nowcastKnownValidtimes);

    // 一度読み込んだコマはそのまま(opacity:0で)残しておき、後で戻ってきた時に
    // 再取得・再デコードしなくて済むようにする。削除するのは、(1)配色スキームが
    // 変わって別物になったもの、(2)実況/予測の一覧更新でもう存在しなくなったコマ
    // (特に予測コマは「今から60分先まで」を毎回丸ごと再計算するので、5分おきの
    // 更新のたびにほぼ総入れ替えになる)の2種類だけ。
    // ソースはレイヤーから参照されている間は削除できないので、必ずレイヤー→ソースの順で消す。
    const style = map.getStyle();
    if (style) {
      (style.layers || []).forEach(l => {
        if (!l.id.startsWith("nowcast-layer-")) return;
        const [scheme, validtime] = l.id.slice("nowcast-layer-".length).split("-");
        const stale = scheme !== nowcastColorSchemeId || !knownValidtimeSet.has(validtime);
        if (stale) map.removeLayer(l.id);
      });
      Object.keys(style.sources || {}).forEach(srcId => {
        if (!srcId.startsWith("nowcast-src-")) return;
        const [scheme, validtime] = srcId.slice("nowcast-src-".length).split("-");
        const stale = scheme !== nowcastColorSchemeId || !knownValidtimeSet.has(validtime);
        if (stale) map.removeSource(srcId);
      });
    }

    // 細分区域の震度塗り分け(areas-intensity-fill)より下に挿入することで、
    // 震度分布・各種マーカーの上に雨雲がかぶらないようにする。
    const beforeId = map.getLayer("areas-intensity-fill") ? "areas-intensity-fill" : undefined;

    // 既にキャッシュ済み(=前に一度でも表示したことがある)レイヤーは、現在のコマだけ
    // 不透明にし、それ以外は透明に戻す。ここで既存レイヤーのopacityを直接切り替える
    // ことで、先読み・キャッシュ済みのコマへはremoveLayer/addLayerを介さず瞬時に切り替わる。
    const currentKey = keyOf(nowcastFrame);
    if (style) {
      (style.layers || []).forEach(l => {
        if (!l.id.startsWith("nowcast-layer-")) return;
        const key = l.id.slice("nowcast-layer-".length);
        if (!key.startsWith(`${nowcastColorSchemeId}-`)) return;
        // styleは冒頭で一度だけ取得したスナップショットなので、直前のremoveLayerで
        // 既に消されたレイヤーがまだ載っていることがある。setPaintPropertyは
        // 存在しないレイヤーに対して呼ぶと例外を投げるため、実際に地図上に
        // まだ存在するか(map.getLayer)を確認してから呼ぶ。
        if (!map.getLayer(l.id)) return;
        map.setPaintProperty(l.id, "raster-opacity", key === currentKey ? 0.75 : 0);
      });
    }

    // 先読み対象コマ(まだキャッシュに無いもの)だけ、新たにsource/layerを追加する。
    wantedFrames.forEach(f => {
      const key = keyOf(f);
      const srcId = `nowcast-src-${key}`;
      const layerId = `nowcast-layer-${key}`;
      if (map.getSource(srcId) && map.getLayer(layerId)) return; // キャッシュ済み(上のループで処理済み)
      if (!map.getSource(srcId)) {
        map.addSource(srcId, {
          type: "raster",
          tiles: [nowcastProtocolUrl(nowcastColorSchemeId, f.basetime, f.validtime)],
          tileSize: 256,
          minzoom: 4, // JMAのナウキャストは偶数ズーム(4,6,8,10)にしか実データが無く、
                      // minzoom=3だと奇数ズーム丸め処理で存在しないズーム2を取りに行き
                      // 404になって何も表示されなくなっていたため、確実に存在する4にする
          maxzoom: 10,
          bounds: NOWCAST_BOUNDS,
          attribution: "気象庁",
        });
      }
      if (!map.getLayer(layerId)) {
        map.addLayer({
          id: layerId,
          type: "raster",
          source: srcId,
          paint: { "raster-opacity": key === currentKey ? 0.75 : 0 },
        }, beforeId);
      }
    });
    // このeffectは既存レイヤーのopacity書き換え・不足分の追加だけで完結しており、
    // 依存配列の値が変わるたびに(=コマが変わるたびに)全部作り直す必要は無いので、
    // ここではクリーンアップ関数を返さない(返すとコマが変わるたびにキャッシュが
    // 消えてしまい、先読み・キャッシュの意味が無くなる)。OFF時の後片付けは上の
    // 早期returnブランチで、マウント解除時の後片付けは地図本体の破棄(map.remove())
    // で行われる。
  }, [nowcastVisible, nowcastFrame?.basetime, nowcastFrame?.validtime, nowcastColorSchemeId, status, nowcastPreloadKey, nowcastKnownValidtimesKey]);

  // 1/3/24時間降水量。雨雲レーダーとは排他(BottomDock側でどちらか一方しか
  // ONにならない)。
  // 以前は「コマが変わるたびに他のレイヤーを全部消してから作り直す」実装に
  // なっており、切り替えるたびに(1)前のコマが即座に消える→(2)新しいタイルを
  // 取得し終わるまで空白になる、という2段階のチカチカが起きていた。
  // 雨雲レーダーと同じく「一度読み込んだコマのレイヤーは残しておき、
  // 表示中のコマだけopacityを上げる」方式に変更し、既に見たことのあるコマへ
  // 戻る時は通信無しで瞬時に切り替わるようにする。
  const precipKnownValidtimesKey = precipKnownValidtimes.join(",");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const removeAllPrecipLayers = () => {
      const style = map.getStyle();
      if (!style) return;
      (style.layers || []).forEach(l => {
        if (l.id.startsWith("precip-layer-")) map.removeLayer(l.id);
      });
      Object.keys(style.sources || {}).forEach(id => {
        if (id.startsWith("precip-src-")) map.removeSource(id);
      });
    };

    if (!precipVisible || !precipMode || !precipFrame) {
      removeAllPrecipLayers();
      return;
    }

    // レイヤーid/sourceidの名前空間にmode+schemeを含めることで、モードや
    // 配色を切り替えた時は「別物」として扱われ、古いキャッシュとは混ざらない。
    const keyOf = (mode, validtime) => `${mode}-${nowcastColorSchemeId}-${validtime}`;
    const knownValidtimeSet = new Set(precipKnownValidtimes);

    // 掃除するのは、(1)モード・配色が変わって別物になったもの、
    // (2)一覧の再取得でもう存在しなくなったコマ、の2種類だけ。
    const style = map.getStyle();
    if (style) {
      (style.layers || []).forEach(l => {
        if (!l.id.startsWith("precip-layer-")) return;
        const [mode, scheme, validtime] = l.id.slice("precip-layer-".length).split("-");
        const stale = mode !== precipMode || scheme !== nowcastColorSchemeId || !knownValidtimeSet.has(validtime);
        if (stale) map.removeLayer(l.id);
      });
      Object.keys(style.sources || {}).forEach(srcId => {
        if (!srcId.startsWith("precip-src-")) return;
        const [mode, scheme, validtime] = srcId.slice("precip-src-".length).split("-");
        const stale = mode !== precipMode || scheme !== nowcastColorSchemeId || !knownValidtimeSet.has(validtime);
        if (stale) map.removeSource(srcId);
      });
    }

    // 細分区域の震度塗り分けより下に挿入し、震度分布・各種マーカーの上に
    // かぶらないようにする(雨雲レーダーと同じ考え方)。
    const beforeId = map.getLayer("areas-intensity-fill") ? "areas-intensity-fill" : undefined;

    // 既にキャッシュ済みのレイヤーは、現在のコマだけ不透明にし、それ以外は
    // 透明に戻す(既存レイヤーのopacityを直接切り替えるだけなので瞬時)。
    const currentKey = keyOf(precipMode, precipFrame.validtime);
    if (style) {
      (style.layers || []).forEach(l => {
        if (!l.id.startsWith("precip-layer-")) return;
        const key = l.id.slice("precip-layer-".length);
        // styleは冒頭で一度だけ取得したスナップショットなので、直前のremoveLayerで
        // 既に消されたレイヤーがまだ載っていることがある(モードを切り替えた時など)。
        // setPaintPropertyは存在しないレイヤーに対して呼ぶと例外を投げるため、
        // 実際に地図上にまだ存在するか(map.getLayer)を確認してから呼ぶ。
        if (!map.getLayer(l.id)) return;
        map.setPaintProperty(l.id, "raster-opacity", key === currentKey ? 0.75 : 0);
      });
    }

    // 現在のコマがまだキャッシュに無ければ、新たにsource/layerを追加する。
    const srcId = `precip-src-${currentKey}`;
    const layerId = `precip-layer-${currentKey}`;
    if (!map.getSource(srcId)) {
      map.addSource(srcId, {
        type: "raster",
        tiles: [precipProtocolUrl(precipMode, nowcastColorSchemeId, precipFrame.member, precipFrame.basetime, precipFrame.validtime)],
        tileSize: 256,
        minzoom: 4,
        maxzoom: 10,
        bounds: NOWCAST_BOUNDS,
        attribution: "気象庁",
      });
    }
    if (!map.getLayer(layerId)) {
      map.addLayer({
        id: layerId,
        type: "raster",
        source: srcId,
        paint: { "raster-opacity": 0.75 },
      }, beforeId);
    }
    // このeffectは既存レイヤーのopacity書き換え・不足分の追加だけで完結しており、
    // コマが変わるたびに全部作り直す必要は無いので、ここではクリーンアップ関数を
    // 返さない(雨雲レーダーと同じ考え方)。OFF時の後片付けは上の早期returnで、
    // マウント解除時の後片付けは地図本体の破棄(map.remove())で行われる。
  }, [precipVisible, precipMode, precipFrame?.basetime, precipFrame?.validtime, nowcastColorSchemeId, status, precipKnownValidtimesKey]);

  // 警報タブ: キキクル(土砂/浸水)。雨雲レーダー・降水量と全く同じキャッシュ方式
  // (一度読み込んだコマのレイヤーは残しておき、表示中のコマだけopacityを
  // 上げる)。配色は固定(JMAのPNGが既に危険度で色分け済み)なので、
  // nowcastColorSchemeIdには依存しない。
  const riskKnownValidtimesKey = riskKnownValidtimes.join(",");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const removeAllRiskLayers = () => {
      const style = map.getStyle();
      if (!style) return;
      (style.layers || []).forEach(l => {
        if (l.id.startsWith("risk-layer-")) map.removeLayer(l.id);
      });
      Object.keys(style.sources || {}).forEach(id => {
        if (id.startsWith("risk-src-")) map.removeSource(id);
      });
    };

    if (!riskVisible || !riskMode || !riskFrame) {
      removeAllRiskLayers();
      return;
    }

    // レイヤーid/sourceidの名前空間にmode(土砂/浸水)を含めることで、
    // 切り替えた時は「別物」として扱われ、古いキャッシュとは混ざらない。
    const keyOf = (mode, validtime) => `${mode}-${validtime}`;
    const knownValidtimeSet = new Set(riskKnownValidtimes);

    // 掃除するのは、(1)モードが変わって別物になったもの、
    // (2)一覧の再取得でもう存在しなくなったコマ、の2種類だけ。
    const style = map.getStyle();
    if (style) {
      (style.layers || []).forEach(l => {
        if (!l.id.startsWith("risk-layer-")) return;
        const [mode, validtime] = l.id.slice("risk-layer-".length).split("-");
        const stale = mode !== riskMode || !knownValidtimeSet.has(validtime);
        if (stale) map.removeLayer(l.id);
      });
      Object.keys(style.sources || {}).forEach(srcId => {
        if (!srcId.startsWith("risk-src-")) return;
        const [mode, validtime] = srcId.slice("risk-src-".length).split("-");
        const stale = mode !== riskMode || !knownValidtimeSet.has(validtime);
        if (stale) map.removeSource(srcId);
      });
    }

    // 選択中エリアの強調リング(warning-areas-highlight-layer)より下、
    // 警報の塗り分け(fill/line。キキクル表示中はopacity:0)より上に挿入する。
    const beforeId = map.getLayer("warning-areas-highlight-layer") ? "warning-areas-highlight-layer" : undefined;

    // 既にキャッシュ済みのレイヤーは、現在のコマだけ不透明にし、それ以外は
    // 透明に戻す(既存レイヤーのopacityを直接切り替えるだけなので瞬時)。
    const currentKey = keyOf(riskMode, riskFrame.validtime);
    if (style) {
      (style.layers || []).forEach(l => {
        if (!l.id.startsWith("risk-layer-")) return;
        const key = l.id.slice("risk-layer-".length);
        if (!map.getLayer(l.id)) return;
        map.setPaintProperty(l.id, "raster-opacity", key === currentKey ? 0.8 : 0);
      });
    }

    // 現在のコマがまだキャッシュに無ければ、新たにsource/layerを追加する。
    const srcId = `risk-src-${currentKey}`;
    const layerId = `risk-layer-${currentKey}`;
    if (!map.getSource(srcId)) {
      map.addSource(srcId, {
        type: "raster",
        tiles: [riskProtocolUrl(riskMode, riskFrame.basetime, riskFrame.validtime)],
        tileSize: 256,
        minzoom: 4, // 土砂・浸水キキクルも雨雲レーダーと同じく偶数ズーム(2,4,6,8,10)にしか
                    // 実データが無いため、確実に存在する4にする
        maxzoom: 10,
        bounds: NOWCAST_BOUNDS,
        attribution: "<a href='https://www.jma.go.jp/bosai/risk/' target='_blank'>気象庁 危険度分布（キキクル）</a>",
      });
    }
    if (!map.getLayer(layerId)) {
      map.addLayer({
        id: layerId,
        type: "raster",
        source: srcId,
        paint: { "raster-opacity": 0.8 },
      }, beforeId);
    }
    // このeffectは既存レイヤーのopacity書き換え・不足分の追加だけで完結しており、
    // コマが変わるたびに全部作り直す必要は無いので、ここではクリーンアップ関数を
    // 返さない(雨雲レーダー・降水量と同じ考え方)。OFF時の後片付けは上の早期returnで、
    // マウント解除時の後片付けは地図本体の破棄(map.remove())で行われる。
  }, [riskVisible, riskMode, riskFrame?.basetime, riskFrame?.validtime, status, riskKnownValidtimesKey]);

  // 天気分布予報(天気分布・気温分布)。雨雲レーダー・降水量とは排他。
  // 配色スキームには依存しない(色は固定)が、モード(天気/気温)によって
  // 中身が全く別物になるため、レイヤーid/sourceidの名前空間にはmode+validtimeを
  // 含める。キャッシュの仕組み(既読みコマは残してopacityだけ切り替える)は
  // 降水量と同じ。
  const wdistKnownValidtimesKey = wdistKnownValidtimes.join(",");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const removeAllWdistLayers = () => {
      const style = map.getStyle();
      if (!style) return;
      (style.layers || []).forEach(l => {
        if (l.id.startsWith("wdist-layer-")) map.removeLayer(l.id);
      });
      Object.keys(style.sources || {}).forEach(id => {
        if (id.startsWith("wdist-src-")) map.removeSource(id);
      });
    };

    if (!wdistVisible || !wdistMode || !wdistFrame) {
      removeAllWdistLayers();
      return;
    }

    const keyOf = (mode, validtime) => `${mode}-${validtime}`;
    const knownValidtimeSet = new Set(wdistKnownValidtimes);

    // 掃除するのは、(1)モードが変わって別物になったもの、
    // (2)一覧の再取得でもう存在しなくなったコマ、の2種類だけ。
    const style = map.getStyle();
    if (style) {
      (style.layers || []).forEach(l => {
        if (!l.id.startsWith("wdist-layer-")) return;
        const [mode, validtime] = l.id.slice("wdist-layer-".length).split("-");
        const stale = mode !== wdistMode || !knownValidtimeSet.has(validtime);
        if (stale) map.removeLayer(l.id);
      });
      Object.keys(style.sources || {}).forEach(srcId => {
        if (!srcId.startsWith("wdist-src-")) return;
        const [mode, validtime] = srcId.slice("wdist-src-".length).split("-");
        const stale = mode !== wdistMode || !knownValidtimeSet.has(validtime);
        if (stale) map.removeSource(srcId);
      });
    }

    // 細分区域の震度塗り分けより下に挿入し、震度分布・各種マーカーの上に
    // かぶらないようにする(雨雲レーダー・降水量と同じ考え方)。
    const beforeId = map.getLayer("areas-intensity-fill") ? "areas-intensity-fill" : undefined;

    // 既にキャッシュ済みのレイヤーは、現在のコマだけ不透明にし、それ以外は
    // 透明に戻す。
    const currentKey = keyOf(wdistMode, wdistFrame.validtime);
    if (style) {
      (style.layers || []).forEach(l => {
        if (!l.id.startsWith("wdist-layer-")) return;
        const key = l.id.slice("wdist-layer-".length);
        if (!map.getLayer(l.id)) return;
        map.setPaintProperty(l.id, "raster-opacity", key === currentKey ? 0.75 : 0);
      });
    }

    // 現在のコマがまだキャッシュに無ければ、新たにsource/layerを追加する。
    const srcId = `wdist-src-${currentKey}`;
    const layerId = `wdist-layer-${currentKey}`;
    if (!map.getSource(srcId)) {
      map.addSource(srcId, {
        type: "raster",
        tiles: [wdistProtocolUrl(wdistMode, wdistFrame.member, wdistFrame.basetime, wdistFrame.validtime)],
        tileSize: 256,
        minzoom: 4,
        maxzoom: 10,
        bounds: NOWCAST_BOUNDS,
        attribution: "気象庁",
      });
    }
    if (!map.getLayer(layerId)) {
      map.addLayer({
        id: layerId,
        type: "raster",
        source: srcId,
        paint: { "raster-opacity": 0.75 },
      }, beforeId);
    }
  }, [wdistVisible, wdistMode, wdistFrame?.basetime, wdistFrame?.validtime, status, wdistKnownValidtimesKey]);

  // 推計震度分布(気象庁 estimated_intensity_map)を更新する。
  // 選択中の地震・設定トグルが変わるたびに、画像を取得・ピクセル解析してGeoJSONに変換し、
  // 塗り(est-intensity-fill)・境界線(est-intensity-line)の2つのソースにsetData()する。
  // 画像デコード・320×320のピクセル走査はメッシュ数によっては時間がかかるため、
  // 処理中はestIntensityLoadingをtrueにして呼び出し側(このコンポーネント自身)で
  // ローディング表示を出す。
  const estIntensityRequestIdRef = useRef(0);
  const [estIntensityLoading, setEstIntensityLoading] = useState(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const requestId = ++estIntensityRequestIdRef.current;
    const isStale = () => requestId !== estIntensityRequestIdRef.current || mapRef.current !== map;

    const clearData = () => {
      if (map.getSource("est-intensity-fill")) {
        map.getSource("est-intensity-fill").setData({ type: "FeatureCollection", features: [] });
      }
      if (map.getSource("est-intensity-line")) {
        map.getSource("est-intensity-line").setData({ type: "FeatureCollection", features: [] });
      }
    };

    clearData();
    setEstIntensityLoading(false);

    // 対象外(トグルOFF・震度5弱未満・地震未選択)ならここで終了
    if (!estIntensityEnabled || !EST_INTENSITY_MIN_INTENSITY_KEYS.includes(maxIntensityKey)) {
      return;
    }

    setEstIntensityLoading(true);

    fetchEstimatedIntensityMatch(quakeTimeStr, maxIntensityKey)
      .then(async matched => {
        if (isStale()) return;
        if (!matched) { setEstIntensityLoading(false); return; }

        const baseUrl = `https://www.jma.go.jp/bosai/estimated_intensity_map/data/${matched.url}/`;

        // フェーズ1: 全メッシュ画像を取得してピクセル解析し、格子(grid)だけ先に揃える。
        // 境界線の判定で隣接メッシュの実データを参照できるようにするため、
        // 先に全メッシュ分のgridを用意してから、フェーズ2で塗り・境界線を組み立てる。
        // 1枚の取得・解析に失敗しても、他のメッシュは表示できるよう処理を継続する。
        // 1枚ごとにわずかに間を空け(setTimeout 0)、ピクセル走査中もブラウザが
        // 操作やアニメーションに応答できるようにする(長時間のフリーズを避けるため)。
        const gridsByMeshCode = new Map();
        const boundsByMeshCode = new Map();
        for (const meshCode of matched.mesh_num) {
          if (isStale()) return;
          try {
            const bounds = meshCodeToBounds(meshCode);
            const img = await loadImageElement(`${baseUrl}${meshCode}.png`);
            if (isStale()) return;
            gridsByMeshCode.set(meshCode, buildEstIntensityGridFromImage(img));
            boundsByMeshCode.set(meshCode, bounds);
            await new Promise(resolve => setTimeout(resolve, 0));
          } catch (err) {
            console.error(`推計震度分布メッシュ(${meshCode})の変換に失敗:`, err);
          }
        }

        if (isStale()) return;

        // フェーズ2: 各メッシュの塗り・境界線を組み立てる。
        // 境界線は、画像の端(1次メッシュの継ぎ目)で誤って線を引いてしまわないよう、
        // 東隣・南隣のメッシュが取得できていれば、その実データを参照して判定する。
        const allFillFeatures = [];
        const allOuterLineCoords = [];
        const allInnerLineCoords = [];
        for (const [meshCode, grid] of gridsByMeshCode) {
          const bounds = boundsByMeshCode.get(meshCode);
          allFillFeatures.push(...buildEstIntensityFillFeatures(grid, bounds));

          const eastCode = offsetMeshCode(meshCode, 0, 1);
          const southCode = offsetMeshCode(meshCode, -1, 0);
          const neighborGrids = {
            eastGrid: eastCode ? gridsByMeshCode.get(eastCode) : undefined,
            southGrid: southCode ? gridsByMeshCode.get(southCode) : undefined,
          };
          const { outerCoords, innerCoords } = buildEstIntensityLineCoords(grid, bounds, neighborGrids);
          allOuterLineCoords.push(...outerCoords);
          allInnerLineCoords.push(...innerCoords);
        }

        if (isStale()) return;

        map.getSource("est-intensity-fill")?.setData({ type: "FeatureCollection", features: allFillFeatures });
        map.getSource("est-intensity-line")?.setData({
          type: "FeatureCollection",
          features: [
            // 色が付いた範囲と地図の背景との境目(外周)。暗い地図に対して見やすいよう白線にする。
            { type: "Feature", properties: { edgeType: "outer" }, geometry: { type: "MultiLineString", coordinates: allOuterLineCoords } },
            // 震度階級同士の境目(4と5-の間など)。両側とも明るい色なので黒線のままでよい。
            { type: "Feature", properties: { edgeType: "inner" }, geometry: { type: "MultiLineString", coordinates: allInnerLineCoords } },
          ],
        });
        setEstIntensityLoading(false);
      })
      .catch(err => {
        console.error("推計震度分布の取得に失敗:", err);
        if (!isStale()) setEstIntensityLoading(false);
      });
  }, [status, quakeTimeStr, maxIntensityKey, estIntensityEnabled]);

  // 震度配色スキームが変わったら、既に表示中の推計震度分布の塗り色だけを塗り替える
  // (データの再取得・再解析は不要なため、これは別のuseEffectに分けている)。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (map.getLayer("est-intensity-fill-layer")) {
      map.setPaintProperty("est-intensity-fill-layer", "fill-color", buildEstIntensityFillColorExpr(colorScheme));
    }
  }, [colorScheme, status]);

  // ライト/ダークモードが切り替わったら、地図の基本配色(海・陸・都道府県境界線)
  // だけを塗り替える。マップの再生成は行わない(ソースの再読み込みが走ると
  // 一瞬地図が消えてちらつくため)。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    map.setPaintProperty("bg", "background-color", themeTokens.mapBg);
    map.setPaintProperty("world-fill", "fill-color", themeTokens.mapWorldFill);
    map.setPaintProperty("world-line", "line-color", themeTokens.mapWorldLine);
    map.setPaintProperty("prefectures-fill", "fill-color", themeTokens.mapPrefFill);
    map.setPaintProperty("prefectures-line", "line-color", themeTokens.mapPrefLine);
    // 警報タブの市区町村境界線 — ライトモードは警報の塗り分け(黄〜赤)の上で
    // 白線だと見えづらいので黒にする。ダークモードは従来通り薄い白のまま。
    if (map.getLayer("warning-areas-line-layer")) {
      map.setPaintProperty(
        "warning-areas-line-layer",
        "line-color",
        mode === "light" ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.25)"
      );
    }
  }, [themeTokens, mode, status]);

  // 断層・プレート境界の「枠内の色」を、設定で選んだ色に合わせて塗り替える。
  // 縁取り(halo)は基本的にライト/ダーク・設定を問わず固定色だが、
  // 枠内の色が「グレー」の時だけ白にして、芯とのコントラストを保つ。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const core = (BOUNDARY_LINE_COLORS[boundaryLineColorId] || BOUNDARY_LINE_COLORS.gray).color;
    const halo = getBoundaryHaloColor(boundaryLineColorId);
    if (map.getLayer("plate-boundaries-layer")) {
      map.setPaintProperty("plate-boundaries-layer", "line-color", core);
      map.setPaintProperty("plate-boundaries-halo-layer", "line-color", halo);
    }
    if (map.getLayer("faults-layer")) {
      map.setPaintProperty("faults-layer", "line-color", core);
      map.setPaintProperty("faults-halo-layer", "line-color", halo);
    }
  }, [boundaryLineColorId, status]);

  // 震央分布(P2P地震一覧・近傍地震検索・データベース検索)のデータを反映する。
  // 呼び出し元(App/BottomDock)側で、今どの一覧を表示中かに応じて渡す点の
  // 配列を切り替えているので、ここでは受け取った配列をGeoJSON化するだけ。
  // MapLibreのcircleレイヤーには「z-index」に相当するものが無く、重なった時の
  // 上下関係はソースの配列順(後ろにあるものほど上)がそのまま描画順になるため、
  // 最大震度が大きいものほど後ろに来るよう昇順にソートしてから渡す。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const source = map.getSource("epicenter-points");
    if (!source) return;
    const sortedPoints = [...(epicenterPoints || [])].sort((a, b) => {
      const ra = QUAKE_INTENSITY_RANK[a.maxIntensityKey] ?? -1;
      const rb = QUAKE_INTENSITY_RANK[b.maxIntensityKey] ?? -1;
      return ra - rb;
    });
    const features = sortedPoints
      .filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
      .map(p => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
        properties: {
          id: p.id,
          mag: p.magnitude,
          depth: p.depth,
          scaleKey: p.maxIntensityKey,
          time: p.time,
          place: p.place,
        },
      }));
    source.setData({ type: "FeatureCollection", features });
  }, [epicenterPoints, status]);

  // 潮位観測点ピンの更新。tideStationPointsが空の間(潮位計モードでもなく、有効な
  // 津波情報も無い間)は何も表示されない。選択中の地点は"selected"プロパティを立てて、レイヤー側の
  // data-drivenなpaint式で強調表示させるのに加え、配列の最後に置くことで
  // (MapLibreは描画順=配列順のため)他のピンより必ず前面に来るようにする。
  // 選択中でないもの同士は、より南(緯度が小さい)ものが前面に来るよう並べる
  // (津波の高さバーのレイヤーもsymbol-sort-keyで同じ考え方に揃えている。MapCanvas内)。
  // tideStationBarsModeがtrueの間は、丸自体の見た目は下のtsunami-height-bars-layer
  // (丸+バーをまとめて描くレイヤー)に任せ、このレイヤーは透明にしてタップ判定
  // だけを担う(データそのものは変わらず入れておく=クリックは引き続き機能する)。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (map.getLayer("tide-station-points-layer")) {
      map.setPaintProperty("tide-station-points-layer", "circle-opacity", tideStationBarsMode ? 0 : 1);
      map.setPaintProperty("tide-station-points-layer", "circle-stroke-opacity", tideStationBarsMode ? 0 : 1);
    }
    const source = map.getSource("tide-station-points");
    if (!source) return;
    const points = [...(tideStationPoints || [])].sort((a, b) => {
      const aSel = a.code === selectedTideStationCode ? 1 : 0;
      const bSel = b.code === selectedTideStationCode ? 1 : 0;
      if (aSel !== bSel) return aSel - bSel; // 選択中のものが最後(=最前面)に来るよう昇順ソート
      return b.lat - a.lat; // より南のものが後(=前面)に来るよう並べる
    });
    const features = points
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map(p => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
        properties: { code: p.code, name: p.name, selected: p.code === selectedTideStationCode, dotColor: p.dotColor || "#B9B9C0" },
      }));
    source.setData({ type: "FeatureCollection", features });
  }, [tideStationPoints, selectedTideStationCode, tideStationBarsMode, status]);

  // 観測点の丸+観測された津波の高さバーをまとめて描画する(tsunamiStationIconId参照)。
  // tideStationBarsModeがfalseの間は何もしない(通常の丸レイヤーがそのまま見える)。
  // 長さ(高さ方向)はズームで変わらない固定ピクセルだが、太さは観測点の丸に合わせて
  // ズームごとに変える必要があるため、データが変わった時だけでなく、ズーム段階が
  // 変わった時にも再描画する(ズーム段階が変わっていない間は何もしない=無駄な
  // 再生成をしない)。
  const combinedTideDataRef = useRef({ points: tideStationPoints, bars: tsunamiHeightBars, selectedCode: selectedTideStationCode });
  combinedTideDataRef.current = { points: tideStationPoints, bars: tsunamiHeightBars, selectedCode: selectedTideStationCode };
  const tsunamiBarZoomBucketRef = useRef(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const source = map.getSource("tsunami-height-bars");
    if (!source) return;

    if (!tideStationBarsMode) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const MAX_PX = 210;  // 10m でこの長さになる(比例式の基準点。以前より少し急な傾きに)
    const geom = { maxPx: MAX_PX, maxM: 10 };

    function render() {
      const { points, bars, selectedCode } = combinedTideDataRef.current;
      const heightByCode = new Map((bars || []).map(b => [b.code, b]));
      const dotDiameterPx = tsunamiBarWidthForZoom(map.getZoom());
      const barWidthPx = dotDiameterPx; // 太さは丸の直径と同じにする(ご要望どおり)
      // icon-anchor: "bottom" は「アイコン画像の一番下」を地図上の座標に合わせるが、
      // 実際の観測点(丸)の中心は画像の一番下からBORDER+丸の半径ぶん上にある
      // (バーの分だけ画像全体の高さが観測点より高くなるため)。そのままだと丸が
      // 実際の位置より北へズレて見えてしまうので、その分だけ画像を下にずらす
      // (icon-offsetは画面ピクセル単位で、+yが下向き)。
      const dotD = Math.max(4, Math.round(dotDiameterPx));
      const offsetY = TSUNAMI_ICON_BORDER + dotD / 2;
      const features = (points || [])
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))
        .map(p => {
          const bar = heightByCode.get(p.code);
          const heightM = bar ? Math.abs(bar.heightM) : null;
          const selected = p.code === selectedCode;
          const iconId = tsunamiStationIconId(map, p.dotColor || "#B9B9C0", heightM, dotDiameterPx, barWidthPx, geom, selected);
          return {
            type: "Feature",
            geometry: { type: "Point", coordinates: [p.lon, p.lat] },
            // より南(緯度が小さい)ものほど前面に描く。選択中は無条件で最前面。
            properties: { code: p.code, iconId, sortKey: selected ? 1e9 : -p.lat, offset: [0, offsetY] },
          };
        });
      source.setData({ type: "FeatureCollection", features });
      // addImageで登録したばかりのアイコン(=新しく選択された観測点のオレンジ色の
      // アイコンなど)が、まれに次の描画までパッと反映されないことがあるため、
      // setData直後に明示的に再描画を促す。
      map.triggerRepaint();
    }

    render(); // データ自体が変わった時は、ズーム段階に関わらず必ず再描画する

    // ズームは連続的に発火するので、太さの見た目が変わるバケット(0.25刻み程度)が
    // 実際に変わった時だけ再描画する。
    function handleZoom() {
      const bucket = Math.round(map.getZoom() * 4);
      if (bucket === tsunamiBarZoomBucketRef.current) return;
      tsunamiBarZoomBucketRef.current = bucket;
      render();
    }
    tsunamiBarZoomBucketRef.current = Math.round(map.getZoom() * 4);
    map.on("zoom", handleZoom);
    return () => { map.off("zoom", handleZoom); };
  }, [tideStationPoints, tsunamiHeightBars, selectedTideStationCode, tideStationBarsMode, status]);

  // 配色スキームが切り替わったら、震央分布の丸の色も塗り直す。
  // 縁取り色はライト/ダークでも変わりうるため(気象庁配色の震度1のみ)、modeも依存に含める。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("epicenter-points-layer")) return;
    map.setPaintProperty("epicenter-points-layer", "circle-color", buildEpicenterCircleColorExpr(colorScheme));
    map.setPaintProperty("epicenter-points-layer", "circle-stroke-color", buildEpicenterCircleStrokeColorExpr(colorScheme, mode));
  }, [colorScheme, mode, status]);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: themeTokens.mapBg }}>
      <div
        ref={containerRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          opacity: status === "ready" ? 1 : 0,
          transition: "opacity 0.4s ease",
        }}
      />

      {/* ロード中インジケータ */}
      {status === "loading" && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 10, color: `rgba(${tokens.ink},0.4)`,
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: "50%",
            border: `2px solid rgba(${tokens.ink},0.15)`,
            borderTopColor: `rgba(${tokens.ink},0.6)`,
            animation: "spin 0.8s linear infinite",
          }}/>
          <span style={{ fontSize: 12 }}>地図を読み込み中…</span>
        </div>
      )}

      {/* 震央分布の丸をホバー/タッチした時に出る簡易ツールチップ */}
      {epicenterTooltip && (
        <div style={{
          position: "absolute",
          left: epicenterTooltip.x,
          top: epicenterTooltip.y,
          transform: "translate(-50%, -100%) translateY(-10px)",
          pointerEvents: "none",
          zIndex: 20,
          padding: "6px 10px",
          borderRadius: 10,
          background: mode === "dark" ? "rgba(28,28,30,0.92)" : "rgba(255,255,255,0.95)",
          boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
          color: tokens.text,
          fontSize: 11,
          lineHeight: 1.4,
          whiteSpace: "nowrap",
          maxWidth: 220,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 2 }}>{epicenterTooltip.title}</div>
          <div>{epicenterTooltip.text}</div>
        </div>
      )}

      {/* 推計震度分布の画像→ベクター変換中、観測点データの突き合わせ処理中、
          または震央分布の丸をバックグラウンドで読み込み中に、地図を隠さない
          小さなローディング表示を出す。複数同時に走ることもあるが、その場合は
          推計震度分布 → 観測点データ → 震央分布 の優先順で1つだけ文言を出す。 */}
      {status === "ready" && (estIntensityLoading || pointsLoading || epicenterLoading) && (
        <div style={{
          position: "absolute",
          top: "calc(14px + env(safe-area-inset-top, 0px))",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 5,
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 14px",
          borderRadius: 999,
          background: tokens.glassOpaqueBg,
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          color: tokens.text,
          fontSize: 12,
          fontWeight: 600,
          // 直下に地図(任意の色)が透けるため、文字の可読性を担保する縁取り。
          textShadow: mode === "light"
            ? "0 1px 2px rgba(255,255,255,0.6)"
            : "0 1px 3px rgba(0,0,0,0.6)",
          boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
          pointerEvents: "none",
        }}>
          <div style={{
            width: 14, height: 14, borderRadius: "50%",
            border: `2px solid rgba(${tokens.ink},0.25)`,
            borderTopColor: `rgba(${tokens.ink},0.9)`,
            animation: "spin 0.8s linear infinite",
            flexShrink: 0,
          }}/>
          {estIntensityLoading ? "推計震度分布を計算中…"
            : pointsLoading ? "観測点データを処理中…"
            : "震央分布を読み込み中…"}
        </div>
      )}

      {/* 緊急地震速報の予想震度の凡例。地図に塗られている震度のうち最も低いものから
          最も高いものまでを一覧できる、右上固定のミニ凡例。EEW詳細(びっくりボタン)を
          開いている間だけ出す — 塗り潰しに興味が無い場面で常時出っぱなしにしないため。 */}
      {status === "ready" && eewDetailOpen && eewFillRange && (() => {
        const minIdx = EEW_FILL_LEGEND_ORDER.indexOf(eewFillRange.minKey);
        const maxIdx = EEW_FILL_LEGEND_ORDER.indexOf(eewFillRange.maxKey);
        if (minIdx === -1 || maxIdx === -1) return null;
        const keys = EEW_FILL_LEGEND_ORDER.slice(minIdx, maxIdx + 1).reverse(); // 強い震度を上に
        return (
          <Glass
            radius={12}
            style={{
              position: "absolute",
              top: "calc(14px + env(safe-area-inset-top, 0px))",
              right: 16,
              zIndex: 6,
              pointerEvents: "none",
              animation: "appear 0.35s cubic-bezier(.25,1,.5,1)",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 0, padding: "8px 10px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: `rgba(${tokens.ink},0.5)`, marginBottom: 3 }}>予想震度</div>
              {keys.map(key => {
                const c = colorScheme.colors[key] || colorScheme.colors["0"];
                return (
                  <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, padding: "0px 0" }}>
                    <span style={{ width: 14, height: 14, borderRadius: 4, background: c.bg, flexShrink: 0 }}/>
                    <span style={{ fontSize: 12, fontWeight: 700, color: tokens.text }}>{INTENSITY_LABEL[key]}</span>
                  </div>
                );
              })}
            </div>
          </Glass>
        );
      })()}

      {/* エラー表示 */}
      {status === "error" && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 10, color: "rgba(255,140,140,0.9)", padding: 24, textAlign: "center",
          textShadow: mode === "light" ? "0 1px 2px rgba(255,255,255,0.7)" : "0 1px 3px rgba(0,0,0,0.6)",
        }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>地図を表示できませんでした</span>
          <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.5)`, maxWidth: 280 }}>{errorMsg}</span>
          <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.3)`, maxWidth: 280, marginTop: 4 }}>
            public/map/world.json と public/map/prefectures.json が正しい場所に
            配置されているか、CDNへのアクセスが制限されていないか確認してください。
          </span>
        </div>
      )}
    </div>
  );
}
