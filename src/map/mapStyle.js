import { THEME_TOKENS } from "../settings/prefs.js";

/* ─────────────────────────────────────────────────────
   MAPLIBREスタイル生成
   ローカルのworld.json(GeometryCollection)・prefectures.json(FeatureCollection)を
   そのままGeoJSONソースとしてMapLibreに渡し、ダークテーマで塗り分ける。
   外部タイルサーバー・外部スタイルには一切依存しない。

   areas(細分区域.json)は、気象庁の細分区域ごとの震度分布を塗るためのソース。
   実際の色は震度分布モードがONの間だけ、feature-state(setFeatureState)で
   区域ごとに動的に設定する。ここでは初期値(無色・透明)のレイヤーだけ用意しておく。
   ───────────────────────────────────────────────────── */
export function buildMapStyle({ world, prefectures, areas }, mapColors = THEME_TOKENS.dark) {
  return {
    version: 8,
    sources: {
      world: { type: "geojson", data: world },
      prefectures: { type: "geojson", data: prefectures },
      // idをproperties.code(気象庁の細分区域コード)に昇格しておくことで、
      // setFeatureState({ source: "areas", id: code }, ...) で個別に塗り分けできる。
      areas: { type: "geojson", data: areas, promoteId: "code" },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": mapColors.mapBg } },
      {
        id: "world-fill", type: "fill", source: "world",
        paint: { "fill-color": mapColors.mapWorldFill },
      },
      {
        id: "world-line", type: "line", source: "world",
        paint: { "line-color": mapColors.mapWorldLine, "line-width": 0.5 },
      },
      {
        id: "prefectures-fill", type: "fill", source: "prefectures",
        paint: { "fill-color": mapColors.mapPrefFill },
      },
      {
        id: "prefectures-line", type: "line", source: "prefectures",
        paint: { "line-color": mapColors.mapPrefLine, "line-width": 0.6 },
      },
      {
        // 震度分布(細分区域ごとの塗り分け)。feature-stateが無い区域は透明のまま。
        id: "areas-intensity-fill", type: "fill", source: "areas",
        paint: {
          "fill-color": ["coalesce", ["feature-state", "color"], "rgba(0,0,0,0)"],
          "fill-opacity": 0.75,
        },
      },
      {
        id: "areas-intensity-line", type: "line", source: "areas",
        paint: {
          "line-color": "rgba(0,0,0,0.35)",
          "line-width": ["coalesce", ["feature-state", "hasIntensity"], 0],
        },
      },
    ],
  };
}


/* ─────────────────────────────────────────────────────
   観測点の丸+観測された津波の高さバーを、1枚のアイコンにまとめて描画する。
   まとめる理由: バー(symbolレイヤー)と観測点の丸(circleレイヤー)を別々のレイヤーに
   分けたままだと、MapLibreは「レイヤー単位」でしか重なり順を制御できない
   (同じレイヤー内の重なり順はsymbol-sort-key等で調整できても、レイヤーをまたいだ
   重なり順=どちらのレイヤーが手前かは常に固定になってしまう)。そのため、
   「より南のバーが、より北の丸より手前に来る」ような、地物ごとに入り組んだ重なり順を
   実現するには、丸とバーを同じレイヤーの同じ地物(=1枚のアイコン)として描く必要がある。
   地図の座標オフセットで長さを表現する線分だと、ズームするたびに実際の距離のまま
   拡大縮小されて見た目の長さが変わってしまうため、キャンバスに描いた画像をアイコンと
   して貼り付けるsymbolレイヤー(icon-size固定)にしている。丸の直径・バーの太さは
   観測点の丸(circle-radius)と揃えたいので、丸の半径と全く同じズーム連動の式
   (TSUNAMI_BAR_WIDTH_STOPS)を使い、ズーム段階が変わった時だけアイコンを差し替える。
   ───────────────────────────────────────────────────── */
function roundRectPath(ctx, x, y, w, h, topR, bottomR = topR) {
  const tr = Math.max(0, Math.min(topR, w / 2, h / 2));
  const br = Math.max(0, Math.min(bottomR, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + tr, y);
  ctx.arcTo(x + w, y, x + w, y + h, tr);   // 右上
  ctx.arcTo(x + w, y + h, x, y + h, br);   // 右下
  ctx.arcTo(x, y + h, x, y, br);           // 左下
  ctx.arcTo(x, y, x + w, y, tr);           // 左上
  ctx.closePath();
}


// 観測点の丸(tide-station-points-layerの非選択時circle-radius)と全く同じズーム段階・
// 半径の組み合わせ(直径に換算済み)。バーの太さ・アイコン内の丸の直径をこれに揃える。
const TSUNAMI_BAR_WIDTH_STOPS = [[4, 9], [8, 11], [12, 14], [16, 19]];
 // [zoom, 直径px]
export function tsunamiBarWidthForZoom(zoom) {
  const stops = TSUNAMI_BAR_WIDTH_STOPS;
  if (zoom <= stops[0][0]) return stops[0][1];
  if (zoom >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [z0, w0] = stops[i], [z1, w1] = stops[i + 1];
    if (zoom >= z0 && zoom <= z1) return w0 + ((zoom - z0) / (z1 - z0)) * (w1 - w0);
  }
  return stops[stops.length - 1][1];
}


// heightM(観測された津波の高さ、実測のm)から、バー本体の長さ(CSSピクセル)を
// 求める式。「高さと長さが比例する」という要件どおり、0mの時に0px・maxMの時に
// maxPxになる単純な比例式にしている(以前は最小の高さ(negligibleM)の時に
// minPxになる、原点を通らない式だったため、高さを2倍にしても長さが2倍にならない
// 問題があった)。目盛りの位置も同じ式を使うので、自動的に等間隔になる。
function tsunamiBarPxForHeight(heightM, geom) {
  const { maxPx, maxM } = geom;
  const h = Math.max(0, Math.min(heightM, maxM));
  return (h / maxM) * maxPx;
}


// (丸の色, バーの色, 高さ, 太さ, 選択状態)の組み合わせごとにキャンバスへ描画し、
// map.addImageで登録して使い回す。heightMがnull/undefinedの間はバー無し(丸だけ)。
// 同じ組み合わせなら2回目以降は再描画せずキャッシュを返す。
// アイコンの見た目を変える修正をするたびに、この値を上げる。map.addImageは
// マップのインスタンスが生きている間ずっと使い回されるため、IDの構成が同じままだと
// (ページを再読み込みしない限り)古い見た目のアイコンがキャッシュされたまま
// 残ってしまうことがある。バージョンをキーに含めておくことで、コードを直しても
// 必ず新しい見た目で再描画されるようにする。
const TSUNAMI_ICON_VERSION = 5;


// 白縁の太さ(CSSピクセル)。アイコン生成側だけでなく、呼び出し側(MapCanvasのrender)
// でもicon-offsetの計算に同じ値が必要なため、モジュールスコープで共有する。
export const TSUNAMI_ICON_BORDER = 2;


export function tsunamiStationIconId(map, color, heightM, dotDiameterPx, barWidthPx, geom, selected) {
  const BORDER = TSUNAMI_ICON_BORDER;
  const DOT_D = Math.max(4, Math.round(dotDiameterPx));
  const BAR_W = Math.max(4, Math.round(barWidthPx));
  const fillColor = selected ? "#FF9F0A" : color;
  const hasBar = heightM != null;

  const heightPx = hasBar ? tsunamiBarPxForHeight(Math.min(heightM, geom.maxM), geom) : 0;
  // 矩形の高さ(=バーの長さ)は、見た目の変化を細かく反映できるよう1px単位で丸める
  // (4px単位でまとめていると、0.1m刻みの入力では見た目が変わらないことがあったため)。
  const bucket = hasBar ? Math.max(4, Math.round(heightPx)) : 0; // 4px未満は描画上の下限(比例関係をなるべく保つため最小限に)
  // 目盛りの位置計算にはheightMそのものを使うので、キャッシュキーにも含めておく。
  // 切り上げてしまうと「まだ届いていない目盛り」が出てしまうため、必ず切り捨てる
  // (0.47mを0.5m相当として点を打ってしまう、といった誤差を防ぐ)。
  const heightM10 = hasBar ? Math.floor(Math.min(heightM, geom.maxM) * 10 + 1e-6) : -1;

  const id = `tsunami-station-icon-v${TSUNAMI_ICON_VERSION}-${fillColor.replace("#", "")}-${DOT_D}-${hasBar ? `${BAR_W}-${bucket}-${heightM10}` : "nobar"}`;
  if (map.hasImage(id)) return id;

  const pixelRatio = typeof window !== "undefined" && window.devicePixelRatio ? Math.min(window.devicePixelRatio, 3) : 1;
  const contentW = Math.max(DOT_D, BAR_W);
  const totalW = contentW + BORDER * 2;
  const totalH = DOT_D + bucket + BORDER * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(totalW * pixelRatio);
  canvas.height = Math.ceil(totalH * pixelRatio);
  const ctx = canvas.getContext("2d");
  ctx.scale(pixelRatio, pixelRatio);

  const cx = totalW / 2;
  const dotCy = totalH - BORDER - DOT_D / 2; // 一番下 = 観測点そのものの位置
  const dotTopY = dotCy - DOT_D / 2; // 観測点の丸の上端

  if (hasBar) {
    // バーは観測点の丸に食い込ませず、丸の上端からちょうど数えた長さになるようにする
    // (以前は少し丸に重ねていたため、重なった分だけ見た目の長さが短くなっていた)。
    // 見た目の長さ(bucket)は、これまで通り丸の上端(dotTopY)からの距離として保つ
    // (目盛りの位置もdotTopY基準のまま)。ただし実際に塗る矩形は、丸の中心(dotCy)まで
    // 深く伸ばしておく。ぴったり同じ座標・わずかな重なり(前回の1.5px)でも、
    // キャンバスのアンチエイリアシングにより境目に細い隙間が見えることがあったため、
    // 丸の半径ぶんまるごと重ねて、後から描く丸で確実に覆い隠すようにする
    // (丸の中心より下には塗らないので、丸の下側からはみ出すことはない)。
    const barTopY = dotTopY - bucket;
    const barBottomY = dotCy;
    const drawnH = barBottomY - barTopY; // 見た目にはdotTopYより下は丸に隠れて見えない
    const TOP_CORNER_R = 3;
    roundRectPath(
      ctx,
      cx - BAR_W / 2 - BORDER, barTopY - BORDER,
      BAR_W + BORDER * 2, drawnH + BORDER,
      TOP_CORNER_R + BORDER, 0
    );
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    roundRectPath(ctx, cx - BAR_W / 2, barTopY, BAR_W, drawnH, TOP_CORNER_R, 0);
    ctx.fillStyle = fillColor;
    ctx.fill();

    // 0.5m刻みの目盛り(白い点)。丸の上端(dotTopY)を基準に、実際の高さの
    // 0.5, 1.0, 1.5m…の位置へ、バー全体の長さと同じ式で点を打つ。観測された高さを
    // 超える位置には打たない。1.0mごと(1.0, 2.0, 3.0m…)は少し濃く、0.5m刻みの
    // 残り(0.5, 1.5, 2.5m…)は薄く描いて、読み取りやすくする。
    const exactHeightM = heightM10 / 10;
    for (let h = 0.5; h <= exactHeightM + 1e-9; h += 0.5) {
      // 先端(=観測点の高さちょうど)にほぼ一致する点まで、必ず描く。棒の外にはみ出さない
      // よう、先端付近だけ位置をわずかにクランプする(以前は先端付近を丸ごと除外して
      // いたため、ちょうど0.5m単位の高さの時に最後の点が消えてしまっていた)。
      const d = Math.min(tsunamiBarPxForHeight(h, geom), bucket - 1);
      const isWholeMeter = Math.round(h * 10) % 10 === 0;
      ctx.fillStyle = isWholeMeter ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.arc(cx, dotTopY - d, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 観測点の丸(白縁+本体色)。バーより後に描くことで、バーの根本に重なって
  // 一体感のある土台に見える。
  ctx.beginPath();
  ctx.arc(cx, dotCy, DOT_D / 2 + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, dotCy, DOT_D / 2, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();

  map.addImage(id, ctx.getImageData(0, 0, canvas.width, canvas.height), { pixelRatio });
  return id;
}
