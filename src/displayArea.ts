/** 画面内にアプリを表示する領域(上下左右の余白)の計算。初期は余白0(全画面)。 */
export interface Insets { top: number; right: number; bottom: number; left: number }
export interface Rect { l: number; t: number; r: number; b: number }
export interface PinchSample { cx: number; cy: number; dx: number; dy: number }

export const ZERO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
export const MIN_AREA_SIZE = 160;
const MIN_PINCH_SEPARATION = 30;

export function isFullScreen(i: Insets): boolean {
  return i.top === 0 && i.right === 0 && i.bottom === 0 && i.left === 0;
}

export function insetsToRect(i: Insets, vw: number, vh: number): Rect {
  return { l: i.left, t: i.top, r: vw - i.right, b: vh - i.bottom };
}

export function rectToInsets(r: Rect, vw: number, vh: number): Insets {
  const f = (n: number) => Math.max(0, Math.round(n));
  return { top: f(r.t), left: f(r.l), right: f(vw - r.r), bottom: f(vh - r.b) };
}

/** 最小サイズを保ち、画面内に収める(はみ出す分は平行移動)。 */
export function clampRect(r: Rect, vw: number, vh: number): Rect {
  const minW = Math.min(MIN_AREA_SIZE, vw), minH = Math.min(MIN_AREA_SIZE, vh);
  const w = Math.min(Math.max(r.r - r.l, minW), vw);
  const h = Math.min(Math.max(r.b - r.t, minH), vh);
  const l = Math.min(Math.max(r.l, 0), vw - w);
  const t = Math.min(Math.max(r.t, 0), vh - h);
  return { l, t, r: l + w, b: t + h };
}

export function pinchSample(x1: number, y1: number, x2: number, y2: number): PinchSample {
  return {
    cx: (x1 + x2) / 2,
    cy: (y1 + y2) / 2,
    dx: Math.max(Math.abs(x1 - x2), MIN_PINCH_SEPARATION),
    dy: Math.max(Math.abs(y1 - y2), MIN_PINCH_SEPARATION),
  };
}

/** ピンチ操作: 指の横の間隔で幅、縦の間隔で高さが変わり、2本の指の中心の移動で位置が動く。 */
export function pinchRect(rect0: Rect, p0: PinchSample, p1: PinchSample, vw: number, vh: number): Rect {
  const w = (rect0.r - rect0.l) * (p1.dx / p0.dx);
  const h = (rect0.b - rect0.t) * (p1.dy / p0.dy);
  const cx = (rect0.l + rect0.r) / 2 + (p1.cx - p0.cx);
  const cy = (rect0.t + rect0.b) / 2 + (p1.cy - p0.cy);
  return clampRect({ l: cx - w / 2, t: cy - h / 2, r: cx + w / 2, b: cy + h / 2 }, vw, vh);
}

export function sanitizeInsets(raw: unknown): Insets {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const f = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 0), 4000) : 0);
  return { top: f(o.top), right: f(o.right), bottom: f(o.bottom), left: f(o.left) };
}

export interface AreaLayout {
  /** 領域の左上(画面上の位置、px) */
  left: number; top: number;
  /** 領域の大きさ(px)。アプリはこの大きさを「画面の大きさ」として扱い、元々ある画面サイズ依存の
   *  配置計算(横画面レイアウトへの切り替え・画面の高さに応じた縮小・全画面スナップの高さなど)を
   *  この大きさで行う。CSSでの拡大縮小はしない。 */
  width: number; height: number;
}

export function computeAreaLayout(i: Insets, vw: number, vh: number): AreaLayout {
  return {
    left: i.left,
    top: i.top,
    width: Math.max(vw - i.left - i.right, 1),
    height: Math.max(vh - i.top - i.bottom, 1),
  };
}
