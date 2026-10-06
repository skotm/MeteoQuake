import { useContext, useEffect, useRef, useState } from "react";
import { GlassOpaqueContext, NAV } from "../ui/glass.jsx";
import { ThemeContext, touchGlassBackdropFilter } from "../settings/prefs.js";

/* ─────────────────────────────────────────────────────
   TOGGLE (iOS-style)
   ───────────────────────────────────────────────────── */
export function Toggle({ on, onChange, disabled = false }) {
  const { tokens } = useContext(ThemeContext);

  return (
    <div
      onClick={disabled ? undefined : onChange}
      role="switch" aria-checked={on} aria-disabled={disabled || undefined}
      style={{
        width: 44, height: 26, borderRadius: 13, flexShrink: 0,
        background: on ? "#32D74B" : `rgba(${tokens.ink},0.2)`,
        position: "relative", cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 0.22s",
        boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.2)",
      }}
    >
      <div style={{
        position: "absolute", top: 3,
        left: on ? 21 : 3, width: 20, height: 20,
        borderRadius: "50%", background: "#fff",
        boxShadow: "0 1px 4px rgba(0,0,0,0.35)",
        transition: "left 0.22s cubic-bezier(.25,1,.5,1)",
      }}/>
    </div>
  );
}


/* ─────────────────────────────────────────────────────
   NAV ICONS
   ───────────────────────────────────────────────────── */
export const NAV_ICONS = {
  quake: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <polyline points="2,12 4,12 5,7 6,17 8,4 9,20 11,10 12,12 14,12"/>
      <polyline points="14,12 15,9 16,15 18,12 22,12"/>
    </svg>
  ),
  tsunami: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none"
         stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2,10.5C5,10.5 5,2.5 10.3,2.5 14.1,2.5 16,5.1 16,7.4
               c0,1.8 -1.2,3.1 -2.7,3.1 -1.3,0 -2.3,-0.9 -2.3,-2.1
               0,-0.9 0.7,-1.6 1.5,-1.6 0.6,0 1.1,0.5 1.1,1"/>
      <path d="M2,13h20"/>
      <path d="M2,19c1.5,0 1.5,-2.2 3,-2.2s1.5,2.2 3,2.2 1.5,-2.2 3,-2.2 1.5,2.2 3,2.2
               1.5,-2.2 3,-2.2 1.5,2.2 3,2.2 1.5,-2.2 3,-2.2 1.5,2.2 3,2.2"/>
    </svg>
  ),
  weather: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M20,17.58A5,5 0 0 0 18,8h-1.26A8,8 0 1 0 4,16.25"/>
      <line x1="8" y1="19" x2="8" y2="21"/><line x1="12" y1="19" x2="12" y2="21"/>
      <line x1="16" y1="19" x2="16" y2="21"/>
    </svg>
  ),
  alert: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2 1 21h22z"/>
      <line x1="12" y1="9" x2="12" y2="14"/>
      <line x1="12" y1="17.5" x2="12" y2="17.5"/>
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  ),
};


/* ─────────────────────────────────────────────────────
   SIDE NAV RAIL
   広い画面(isWide)用の、縦タブバーの中身(アイコン列+スライドする
   ハイライト)。ドラッグ操作は無く、単純なクリックだけでタブを切り替える
   (PC・タブレットでは横スワイプよりクリック/タップの方が自然なため)。
   このコンポーネント自身はGlassや位置決めを持たない。フローティング
   パネルと1枚の連続したガラスに見せるため、App側で用意した共有の
   Glassの中に、コンテンツ(BottomDock)と並べて描画される。
   ───────────────────────────────────────────────────── */
export const WIDE_RAIL_WIDTH = 44;
      // 横幅[px]
const WIDE_RAIL_TOP = 16;
        // 画面上端からの余白[px]。フローティングパネルと揃える
const WIDE_RAIL_RADIUS = 28;
     // 角丸[px](共有Glass全体に適用する)

export function SideNavRail({ active, onNav, uiScale = 1 }) {
  const { tokens, mode } = useContext(ThemeContext);
  const { opaque: glassOpaque } = useContext(GlassOpaqueContext);

  const RAIL_PAD_Y = 14; // 内側コンテンツ(ボタン列)の上下パディング[px]。JSXと一致させる
  const N = NAV.length;
  const tabH = 100 / N;  // 1タブぶんの高さ[%](内側領域基準)
  const activeIndex = Math.max(0, NAV.findIndex(n => n.id === active));

  // 縦画面のナビ行(%ベースで指に連続追従するハイライト)と全く同じ考え方を、
  // 横→縦の軸を入れ替えて再現する。バーの全長自体がclamp(vh)で画面サイズに
  // 応じて伸縮するため、pxではなく%で管理する(そうしないと画面サイズが
  // 変わった時にハイライトの位置・サイズがずれてしまう)。
  const contentRef    = useRef(null);
  const pointerIdRef  = useRef(null);
  const movedRef      = useRef(false);
  const startYRef     = useRef(0);
  const [highlightTop, setHighlightTop] = useState(activeIndex * tabH); // %
  const [dragging,     setDragging]     = useState(false);
  const [pressed,      setPressed]      = useState(false); // 指が触れている間ずっとtrue
  const [previewIdx,   setPreviewIdx]   = useState(null);

  // active が外部から変わった時(タップ以外の切替)にハイライトを追従させる
  useEffect(() => {
    if (!dragging) setHighlightTop(activeIndex * tabH);
  }, [activeIndex, dragging, tabH]);

  // clientY → 内側領域(上下RAIL_PAD_Y除外)を基準にした正規化top [%]
  function clientYToTop(clientY) {
    const el = contentRef.current;
    if (!el) return activeIndex * tabH;
    const { top, height } = el.getBoundingClientRect();
    const innerTop    = top + RAIL_PAD_Y;
    const innerHeight = height - RAIL_PAD_Y * 2;
    const ratio = Math.max(0, Math.min(1, (clientY - innerTop) / innerHeight));
    return Math.max(0, Math.min(100 - tabH, ratio * 100 - tabH / 2));
  }

  // clientY に最も近いタブのindexを返す
  function clientYToIndex(clientY) {
    const el = contentRef.current;
    if (!el) return activeIndex;
    const { top, height } = el.getBoundingClientRect();
    const innerTop    = top + RAIL_PAD_Y;
    const innerHeight = height - RAIL_PAD_Y * 2;
    const ratio = Math.max(0, Math.min(1, (clientY - innerTop) / innerHeight));
    return Math.max(0, Math.min(N - 1, Math.round(ratio * 100 / tabH - 0.5)));
  }

  function handlePointerDown(e) {
    pointerIdRef.current = e.pointerId;
    movedRef.current = false;
    startYRef.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    const idx = clientYToIndex(e.clientY);
    setPreviewIdx(idx);
    setPressed(true);
    // タップの可能性がある間はtransitionを効かせたまま、目的のタブへ
    // スライドするアニメーションを見せる(縦画面版と同じ考え方)。
    setHighlightTop(idx * tabH);
  }

  function handlePointerMove(e) {
    if (pointerIdRef.current !== e.pointerId) return;
    if (Math.abs(e.clientY - startYRef.current) > 3 && !movedRef.current) {
      movedRef.current = true;
      setDragging(true);
    }
    const idx = clientYToIndex(e.clientY);
    setPreviewIdx(idx);
    if (movedRef.current) {
      setHighlightTop(clientYToTop(e.clientY)); // 指の連続位置に追従
    } else {
      setHighlightTop(idx * tabH);
    }
  }

  function handlePointerUp(e) {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    const idx = clientYToIndex(e.clientY);
    setDragging(false);
    setPressed(false);
    setPreviewIdx(null);
    setHighlightTop(idx * tabH);
    onNav(NAV[idx].id);
  }

  function handleClick(id) {
    if (movedRef.current) return; // ドラッグ完了後の二重発火を防ぐ
    const idx = NAV.findIndex(n => n.id === id);
    setHighlightTop(idx * tabH);
    onNav(id);
  }

  const displayIdx = dragging && previewIdx != null ? previewIdx : activeIndex;

  return (
      <div style={{
        width: `${100 / uiScale}%`,
        height: `${100 / uiScale}%`,
        transform: `scale(${uiScale})`,
        transformOrigin: "top left",
      }}>
        <div
          ref={contentRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          style={{
            position: "relative",
              height: "100%",
              display: "flex", flexDirection: "column",
              alignItems: "stretch",
              padding: `${RAIL_PAD_Y}px 5px`,
              touchAction: "none",
              userSelect: "none",
              WebkitUserSelect: "none",
              WebkitTouchCallout: "none",
            }}
          >
            {/* ガラスのハイライトピル — 縦画面のナビ行と全く同じ見た目・挙動
                (完全な丸ピル、指に連続追従、押し込むと少し膨らむ)。
                バーの全長がclamp(vh)で伸縮するため、位置・高さとも%で
                管理し、画面サイズが変わっても常に正しい位置に来るようにする。 */}
            <div
              aria-hidden
              style={{
                position: "absolute",
                left: 3, right: 3,
                top: `calc(${RAIL_PAD_Y}px + (100% - ${RAIL_PAD_Y * 2}px) * ${highlightTop / 100})`,
                height: `calc((100% - ${RAIL_PAD_Y * 2}px) * ${tabH / 100})`,
                borderRadius: 999,
                background: (pressed || dragging) && !glassOpaque ? tokens.glassTint : tokens.navPillBg,
                boxShadow: (pressed || dragging) && !glassOpaque
                  ? `inset 0 0 0 0.5px ${tokens.rimLight}, inset 0 1px 0 ${tokens.rimHighlight}`
                  : tokens.navPillShadow,
                // タッチ/ドラッグ中だけ本物のガラス(backdrop-filter blur)にする。
                // 通常時は軽量なフラットピルのままにして、常時ブラーによる
                // 描画負荷を避ける。
                backdropFilter: (pressed || dragging) && !glassOpaque ? touchGlassBackdropFilter(mode) : "none",
                WebkitBackdropFilter: (pressed || dragging) && !glassOpaque ? touchGlassBackdropFilter(mode) : "none",
                transform: pressed ? "scale(1.08)" : "scale(1)",
                transformOrigin: "center",
                transition: dragging
                  ? "transform 0.18s cubic-bezier(.22,1,.36,1)"
                  : "top 0.38s cubic-bezier(.22,1,.36,1), transform 0.18s cubic-bezier(.22,1,.36,1)",
                pointerEvents: "none",
                zIndex: 0,
              }}
            />

            {NAV.map(({ id, label }, idx) => {
              const isActive = idx === displayIdx;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => handleClick(id)}
                  style={{
                    position: "relative", zIndex: 1,
                    flex: 1, minHeight: 0, width: "100%",
                    display: "flex", flexDirection: "column",
                    alignItems: "center", justifyContent: "center",
                    gap: 1,
                    borderRadius: 999, border: "none", cursor: "pointer",
                    background: "transparent",
                    color: isActive ? tokens.text : `rgba(${tokens.ink},0.6)`,
                    transition: "color 0.15s",
                    touchAction: "none",
                    userSelect: "none",
                    WebkitUserSelect: "none",
                    WebkitTouchCallout: "none",
                  }}
                >
                  <span style={{ transform: "scale(0.7)" }}>{NAV_ICONS[id]}</span>
                  <span style={{ fontSize: 9, fontWeight: isActive ? 700 : 500, letterSpacing: -0.1 }}>
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
  );
}


/* ─────────────────────────────────────────────────────
   useSnapDrag
   ハンドルをドラッグして、高さを複数のスナップ位置のどれかに
   固定できるようにする汎用フック。UIロジックを切り離してあるので、
   heights配列を変えるだけで他のフローティングパネルにも流用できる。

   引数:
     heights: 昇順のスナップ高さ配列(px)。例: [0, 中, 高, 全画面]
     index:   現在のスナップ位置のindex(外部stateで管理)
     onSnap:  ドラッグが終わり、最も近いスナップ位置が決まった時に呼ばれる
   戻り値:
     { height, isDragging, handlePointerDown }
   ───────────────────────────────────────────────────── */
export function useSnapDrag({ heights, index, onSnap }) {
  const [dragHeight, setDragHeight] = useState(null);
  const dragStartY      = useRef(0);
  const dragStartHeight = useRef(0);
  const liveHeight       = useRef(0);
  // フリック速度検出用: 直近の(時刻, 高さ)を記録しておき、
  // 指を離す直前の「速度」を算出する。
  const velocityTrack = useRef([]); // [{ t, h }, ...]

  const isDragging  = dragHeight !== null;
  const restHeight  = heights[index] ?? 0;
  const height      = isDragging ? dragHeight : restHeight;
  const maxHeight   = heights[heights.length - 1];

  function handlePointerMove(e) {
    const dy = dragStartY.current - e.clientY; // 上に引くほど高さが増える
    const h = Math.max(0, Math.min(maxHeight, dragStartHeight.current + dy));
    liveHeight.current = h;
    setDragHeight(h);

    // 直近120ms分だけ (時刻, 高さ) を保持し、速度計算に使う
    const now = performance.now();
    const track = velocityTrack.current;
    track.push({ t: now, h });
    while (track.length > 2 && now - track[0].t > 120) track.shift();
  }
  function endDrag() {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
    const finalH = liveHeight.current;

    // フリック速度(px/ms)を算出。track の最初と最後の差分から求める。
    // 正 = 上向き(高さが増える方向)、負 = 下向き(高さが減る方向)。
    const track = velocityTrack.current;
    let velocity = 0;
    if (track.length >= 2) {
      const first = track[0], last = track[track.length - 1];
      const dt = last.t - first.t;
      if (dt > 0) velocity = (last.h - first.h) / dt;
    }
    velocityTrack.current = [];

    // 現在のスナップ位置に一番近いindexを求めておく(通常時のフォールバック用)
    let nearest = 0, nearestDist = Infinity;
    heights.forEach((h, i) => {
      const d = Math.abs(h - finalH);
      if (d < nearestDist) { nearestDist = d; nearest = i; }
    });

    // 明確な勢い(フリック)がある場合は、最近傍ではなく
    // 「現在地から見て指の動いた方向にある次のスナップ」を優先する。
    // これにより、上→下へサッとスワイプした時に中間で止まらず、
    // 意図通り1段階(またはそれ以上)下まで閉じやすくなる。
    //
    // ただし、指を離した位置がすでに特定のスナップのすぐ近くにある場合は、
    // そこで止めようとした意図とみなし、フリック判定より最近傍を優先する。
    // 許容範囲は「最も近いスナップと、その両隣との間隔」から決める
    // (全スナップ中の最小間隔を使うと、無関係な離れた場所の間隔が極端に
    //  狭い場合に引きずられて許容範囲が潰れてしまうため)。
    const lowerNeighbor = heights[nearest - 1];
    const upperNeighbor = heights[nearest + 1];
    const distToLower = lowerNeighbor !== undefined ? heights[nearest] - lowerNeighbor : Infinity;
    const distToUpper = upperNeighbor !== undefined ? upperNeighbor - heights[nearest] : Infinity;
    const localGap = Math.min(distToLower, distToUpper);
    const SNAP_STICK_PX = Math.max(8, Math.min(30, localGap / 2));

    const FLICK_THRESHOLD = 0.45; // px/ms。これを超えたら明確なフリックとみなす
    let target = nearest;
    if (Math.abs(velocity) > FLICK_THRESHOLD && nearestDist > SNAP_STICK_PX) {
      // 現在の指位置(finalH)がどのスナップ帯にいるかを求め、
      // フリック方向にある隣接スナップへ進める。
      let below = 0;
      for (let i = 0; i < heights.length; i++) {
        if (heights[i] <= finalH) below = i; else break;
      }
      target = velocity < 0
        ? below                                   // 下向きフリック → 現在地点以下の直近スナップ
        : Math.min(below + 1, heights.length - 1); // 上向きフリック → 直近の上のスナップ
    }

    setDragHeight(null);
    onSnap(target);
  }
  function handlePointerDown(e) {
    e.preventDefault();
    dragStartY.current = e.clientY;
    dragStartHeight.current = restHeight;
    liveHeight.current = restHeight;
    velocityTrack.current = [{ t: performance.now(), h: restHeight }];
    setDragHeight(restHeight);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
  }

  return { height, isDragging, handlePointerDown };
}
