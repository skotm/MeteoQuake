import { FONT_SANS } from "./fonts";

// アメダスの観測値ラベル(角丸の吹き出し)アイコン。スタイルにglyphs(フォント配信)が
// 無いためtext-fieldは使えず、値ごとにcanvasで焼いて登録する。
// 画像idは "am|{ラベル}|{背景色}|{文字色}"。地図が未登録のidを要求した時に発火する
// styleimagemissing で、その場で生成して登録する(値の種類は限られるので数は増えすぎない)。
export const AMEDAS_ICON_PREFIX = "am|";
export const AMEDAS_ARROW_ID = "am-arrow";

const SCALE = 2; // 高DPI用。pixelRatio=2で登録する

function pillCanvas(label, bg, fg) {
  const fontPx = 12 * SCALE;
  const padX = 6 * SCALE, h = 20 * SCALE;
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = `800 ${fontPx}px ${FONT_SANS}`;
  const w = Math.max(h, Math.ceil(probe.measureText(label).width) + padX * 2);
  const canvas = document.createElement("canvas");
  canvas.width = w + 4; canvas.height = h + 4;
  const ctx = canvas.getContext("2d");
  const x = 2, y = 2, r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = bg; ctx.fill();
  ctx.lineWidth = 1.6 * SCALE; ctx.strokeStyle = "rgba(255,255,255,0.95)"; ctx.stroke();
  ctx.font = `800 ${fontPx}px ${FONT_SANS}`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = fg;
  ctx.fillText(label, x + w / 2, y + h / 2 + 1);
  return ctx;
}

function addPill(map, id) {
  const [, label, bg, fg] = id.split("|");
  if (!label || !bg || !fg) return;
  const ctx = pillCanvas(label, bg, fg);
  const { width, height } = ctx.canvas;
  map.addImage(id, ctx.getImageData(0, 0, width, height), { pixelRatio: SCALE });
}

function addArrow(map) {
  if (map.hasImage(AMEDAS_ARROW_ID)) return;
  const s = 18 * SCALE;
  const canvas = document.createElement("canvas");
  canvas.width = s; canvas.height = s;
  const ctx = canvas.getContext("2d");
  ctx.translate(s / 2, s / 2);
  ctx.beginPath();            // 上向き(北向き)の矢じり。icon-rotateで回す
  ctx.moveTo(0, -s * 0.42);
  ctx.lineTo(s * 0.26, s * 0.3);
  ctx.lineTo(0, s * 0.14);
  ctx.lineTo(-s * 0.26, s * 0.3);
  ctx.closePath();
  ctx.fillStyle = "#0A84FF";
  ctx.fill();
  ctx.lineWidth = 1.4 * SCALE; ctx.strokeStyle = "#ffffff"; ctx.lineJoin = "round"; ctx.stroke();
  map.addImage(AMEDAS_ARROW_ID, ctx.getImageData(0, 0, s, s), { pixelRatio: SCALE });
}

// 風の矢印。画像id "am|W|{風速段階}|{色}"。上向きに描き、icon-rotateで風向きへ回す。
// 風速が強いほど長く・太くする(上限あり)。中心が観測点の位置になるよう正方形のキャンバスにする。
function addWindArrow(map, id) {
  const [, , bStr, color] = id.split("|");
  const b = Math.max(0, Math.min(30, Number(bStr) || 0));
  // 棒のない矢じりだけ。大きさで風速を表す(弱い風は小さく、強い風は大きく: 約9〜55px)。
  const L = (9 + Math.min(b, 22) * 2.1) * SCALE;
  const W = L * 0.62;
  const pad = 5 * SCALE;
  const s = Math.ceil(L + pad * 2);
  const canvas = document.createElement("canvas");
  canvas.width = s; canvas.height = s;
  const ctx = canvas.getContext("2d");
  ctx.translate(s / 2, s / 2);
  ctx.beginPath();            // 上向き(北向き)。icon-rotateで風向きへ回す。中心が観測点の位置
  ctx.moveTo(0, -L / 2);
  ctx.lineTo(W / 2, L / 2);
  ctx.lineTo(0, L * 0.2);
  ctx.lineTo(-W / 2, L / 2);
  ctx.closePath();
  // 縁は濃い色(白い縁だとライトモードの明るい地図で見えないため)。
  // 先に太い縁を描いてから塗ると、内側の半分は塗りで隠れ、外側だけが縁として残る。
  ctx.lineJoin = "round";
  ctx.lineWidth = 3 * SCALE; ctx.strokeStyle = "rgba(20,30,42,0.9)"; ctx.stroke();
  ctx.fillStyle = color || "#0A84FF";
  ctx.fill();
  map.addImage(id, ctx.getImageData(0, 0, s, s), { pixelRatio: SCALE });
}

// 地図作成直後に1回だけ呼ぶ。
export function registerAmedasImages(map) {
  addArrow(map);
  map.on("styleimagemissing", (e) => {
    if (!e.id || !e.id.startsWith(AMEDAS_ICON_PREFIX)) return;
    try { if (!map.hasImage(e.id)) (e.id.startsWith("am|W|") ? addWindArrow(map, e.id) : addPill(map, e.id)); } catch { /* ignore */ }
  });
}
