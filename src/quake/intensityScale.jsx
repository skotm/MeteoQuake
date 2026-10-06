/* ─────────────────────────────────────────────────────
   震度スケール — JMA震度階(0〜7、10区分)を液体ガラスのダークUIに合わせて配色。
   明るい色(〜5強)は黒文字、暗く濃い色(6弱〜7)は白文字でコントラストを確保。

   ユーザーが「地震」タブの設定画面から配色スキームを切り替えられるよう、
   色(bg/fg)だけを複数パレット化している。ラベル("6弱"等)はスキームに
   依存しない共通の情報なのでINTENSITY_LABELに1本化した。
   ───────────────────────────────────────────────────── */
export const INTENSITY_LABEL = {
  "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
  "5": "5", "5-": "5弱", "5+": "5強", "6": "6", "6-": "6弱", "6+": "6強", "7": "7",
  "5u": "5弱以上未入電", // 観測点の震度計が検知したが、確定した震度をまだ入電できていない状態(scale=46)
  "?": "?", // 震度が取得できなかった場合(「0」と区別する)
};


// INTENSITY_LABELの逆引き("5弱"→"5-"等)。Wolfx APIは震度を"5弱"のような
// 表示用文字列そのもので返してくるため、内部キーへ変換するのに使う。
const INTENSITY_LABEL_TO_KEY = Object.fromEntries(
  Object.entries(INTENSITY_LABEL).map(([key, label]) => [label, key])
);

export function intensityLabelToKey(label) {
  if (!label) return "?";
  return INTENSITY_LABEL_TO_KEY[label] ?? "?";
}


// 震度の弱い順(緊急地震速報の塗り潰し範囲の凡例表示用)。"5"/"6"は1996年10月改定前
// 専用の値なので、実運用の並びには含めない。
// (下方のQuakeIntensityLegend用のINTENSITY_LEGEND_ORDERとは別物 — あちらは
//  震度1始まりで実際の地震向け、こちらは震度0を含む緊急地震速報の塗り潰し向け)
export const EEW_FILL_LEGEND_ORDER = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];


// 観測点マーカーをMapLibreのsymbolレイヤーで描くための下準備。
// 震度キーは有限個(0〜7,5-,5+,6-,6+,?)しかないので、キーごとに
// 「丸+白フチ+震度番号」を1枚のbitmapとして事前にcanvasへ焼いておき、
// addImageでMapLibreに登録する。text-fieldを使わないため、
// スタイルにglyphs(フォント配信)を用意しなくても数字を表示できる。
export const STATION_ICON_KEYS = ["0", "1", "2", "3", "4", "5", "5-", "5u", "5+", "6", "6-", "6+", "7", "?"];


// 震度キーの弱い順(小さい順)の並び。震度リストのソート・グループ化・
// 折りたたみ判定など、複数箇所で「震度の大小比較」が必要な場面で共通して使う。
// "5u"(震度5弱以上未入電)は、実際の値が5弱〜7のどれになるか分からず、
// 気象庁も速報として最優先で扱う情報のため、震度の大小比較上は一番大きい
// 場所(最後尾)に置き、「各地の震度」一覧で一番上に来るようにしている。
export const INTENSITY_ORDER = ["0","1","2","3","4","5","5-","5+","6","6-","6+","7","5u"];

export const STATION_ICON_BASE_RADIUS = 32;
 // bitmap側の半径(px)。icon-sizeで実際の大きさへスケールする。

// withText=falseの場合は数字を描かない(低ズームで円が小さいときに文字が潰れるのを避けるため)。
// strokeColorは通常は白固定だが、配色によっては塗りが白に近く縁が見えなくなる
// 震度キーがあるため、呼び出し側(registerStationIcons)で個別に上書きできるようにしている。
function buildStationIconCanvas(bg, fg, label, withText, strokeColor = "#ffffff") {
  const size = STATION_ICON_BASE_RADIUS * 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const cx = size / 2, cy = size / 2, r = STATION_ICON_BASE_RADIUS - 2;

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = strokeColor;
  ctx.stroke();

  if (withText) {
    // アプリ全体のCSSと同じフォントスタックに揃える。iOSではSan Francisco、
    // それ以外ではNoto Sans JP等に自然にフォールバックし、見た目を統一する。
    const STATION_ICON_FONT_STACK =
      '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", "Noto Sans JP", sans-serif';
    // 文字数で単純に切り替えると「5-」「6+」のような2文字が「1」等の1文字より
    // 見た目に小さくなってしまうため、実際の文字幅を測って、丸からはみ出さない
    // 範囲でできるだけ大きく表示されるようフォントサイズを自動調整する。
    const maxTextWidth = r * 1.7;
    let fontSize = r * 1.3;
    ctx.font = `800 ${fontSize}px ${STATION_ICON_FONT_STACK}`;
    const width = ctx.measureText(label).width;
    if (width > maxTextWidth) {
      fontSize *= maxTextWidth / width;
      ctx.font = `800 ${fontSize.toFixed(1)}px ${STATION_ICON_FONT_STACK}`;
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = fg;
    ctx.fillText(label, cx, cy + 1);
  }
  return ctx.getImageData(0, 0, size, size);
}


// 現在の配色スキームに合わせて、観測点アイコン(数字あり/なしの2種類 x 震度キー分)を
// まとめて生成し、MapLibreへaddImage/updateImageする。配色スキームが切り替わるたびに呼ぶ。
export function registerStationIcons(map, scheme) {
  STATION_ICON_KEYS.forEach(key => {
    const style = scheme.colors[key === "5u" ? "5-" : key] || scheme.colors["0"];
    // 地図上の丸には「5弱」「6強」ではなくキー表記(5-,6+等)をそのまま出すが、
    // "5u"(震度5弱以上未入電)だけは内部キーをそのまま出さず「未」にする。
    const label = key === "5u" ? "未" : key;
    // 気象庁配色の震度1は塗りがほぼ白(#F2F2FF)なので、既定の白い縁のままだと
    // 塗りと縁が同化して見分けづらい。この組み合わせの時だけ縁を黒にする。
    const strokeColor = (scheme.id === "jma" && key === "1") ? "#000000" : "#ffffff";
    const dotImg = buildStationIconCanvas(style.bg, style.fg, label, false, strokeColor);
    const numImg = buildStationIconCanvas(style.bg, style.fg, label, true, strokeColor);
    const dotId = `station-icon-${key}-dot`;
    const numId = `station-icon-${key}-num`;
    if (map.hasImage(dotId)) map.updateImage(dotId, dotImg); else map.addImage(dotId, dotImg);
    if (map.hasImage(numId)) map.updateImage(numId, numImg); else map.addImage(numId, numImg);
  });
}


// buildStationIconCanvasの角丸正方形(スクイーカル)版。震度速報・震源に関する情報
// (細分区域単位、isArea:true)専用のアイコンに使う。観測点一覧の同じ場面で使っている
// 角丸正方形バッジと見た目を揃え、「これは区域単位のざっくりした震度」だと地図上でも
// 一目で分かるようにする。
function buildAreaIconCanvas(bg, fg, label, withText, strokeColor = "#ffffff") {
  const size = STATION_ICON_BASE_RADIUS * 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const inset = 3; // 縁の線幅分、正方形を少し内側に描く(はみ出し防止)。数字を大きく見せるため、円のアイコンより少し薄めの余白にしている。
  const rectSize = size - inset * 2;
  const cornerRadius = rectSize * 0.14; // 角の丸め具合(値が大きいほど丸くなる)。より四角く見えるよう控えめにする。

  ctx.beginPath();
  ctx.roundRect(inset, inset, rectSize, rectSize, cornerRadius);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = strokeColor;
  ctx.stroke();

  if (withText) {
    const STATION_ICON_FONT_STACK =
      '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", "Noto Sans JP", sans-serif';
    const maxTextWidth = rectSize * 0.86;
    let fontSize = rectSize * 0.66;
    ctx.font = `800 ${fontSize}px ${STATION_ICON_FONT_STACK}`;
    const width = ctx.measureText(label).width;
    if (width > maxTextWidth) {
      fontSize *= maxTextWidth / width;
      ctx.font = `800 ${fontSize.toFixed(1)}px ${STATION_ICON_FONT_STACK}`;
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = fg;
    ctx.fillText(label, size / 2, size / 2 + 1);
  }
  return ctx.getImageData(0, 0, size, size);
}


// registerStationIconsの角丸正方形版。area-icon-{key}-dot / -num を生成・登録する。
export function registerAreaIcons(map, scheme) {
  STATION_ICON_KEYS.forEach(key => {
    const style = scheme.colors[key === "5u" ? "5-" : key] || scheme.colors["0"];
    const label = key === "5u" ? "未" : key;
    const strokeColor = (scheme.id === "jma" && key === "1") ? "#000000" : "#ffffff";
    const dotImg = buildAreaIconCanvas(style.bg, style.fg, label, false, strokeColor);
    const numImg = buildAreaIconCanvas(style.bg, style.fg, label, true, strokeColor);
    const dotId = `area-icon-${key}-dot`;
    const numId = `area-icon-${key}-num`;
    if (map.hasImage(dotId)) map.updateImage(dotId, dotImg); else map.addImage(dotId, dotImg);
    if (map.hasImage(numId)) map.updateImage(numId, numImg); else map.addImage(numId, numImg);
  });
}
