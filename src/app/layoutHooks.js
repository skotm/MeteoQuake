import { useState, useEffect } from "react";
import { getLogicalViewportSize, subscribeLogicalViewport } from "./viewportScale";


/* ─────────────────────────────────────────────────────
   RESPONSIVE LAYOUT
   スマホ縦持ちでは「下部タブバー + 下からドラッグして開くボトムシート」、
   横画面スマホ・タブレット・PCなど横幅が十分ある場合は「左端の縦タブバー
   (レール) + 常に画面右側に居るパネル」に切り替える。
   ここではその判定(=isWideLayout)だけを提供する。実際のレイアウト分岐は
   BottomDock側で行う。
   ───────────────────────────────────────────────────── */
const WIDE_LAYOUT_MIN_WIDTH = 720; // これ未満は常にスマホ縦持ち相当の下部タブバーを使う

export function useIsWideLayout() {
  // 表示領域を狭めている間は、その見かけ上の画面の大きさ(viewportScale)で判定する。
  const [isWide, setIsWide] = useState(() =>
    typeof window !== "undefined" && getLogicalViewportSize().width >= WIDE_LAYOUT_MIN_WIDTH
  );
  useEffect(() => {
    const update = () => setIsWide(getLogicalViewportSize().width >= WIDE_LAYOUT_MIN_WIDTH);
    update();
    return subscribeLogicalViewport(update);
  }, []);
  return isWide;
}

// 「ホーム画面に追加」して起動した、いわゆるスタンドアロンPWAかどうかを判定する。
// 通常のSafari/Chromeのタブとして開いている場合はfalse。
// スタンドアロンだとブラウザ自身のツールバーが無いためbottomのセーフエリアの
// 余白の付け方が変わるので、下部ナビの余白調整で使い分ける(BottomDock参照)。
export function useIsStandalonePwa() {
  const [isStandalone, setIsStandalone] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(display-mode: standalone)").matches
      || window.navigator.standalone === true; // iOS Safariの旧来のフラグ
  });
  useEffect(() => {
    const mq = window.matchMedia("(display-mode: standalone)");
    const update = () => setIsStandalone(mq.matches || window.navigator.standalone === true);
    update();
    if (mq.addEventListener) mq.addEventListener("change", update);
    else mq.addListener(update);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", update);
      else mq.removeListener(update);
    };
  }, []);
  return isStandalone;
}

// 横画面レイアウト用のUI縮小率。PC・タブレットの横画面では画面の縦幅に
// 余裕があるので等倍(1)のままでよいが、横画面のスマホ(高さ400px前後)
// では同じ大きさのまま出すと文字・要素が窮屈になり壊滅的に見づらくなる
// ため、画面の縦幅に応じて0.7〜1の範囲で縮小する。
// 基準の700pxは、タブレット横画面などで概ね窮屈にならない高さの目安。
export function useWideUIScale(isWide) {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!isWide) { setScale(1); return; }
    const update = () => {
      const h = getLogicalViewportSize().height;
      setScale(Math.max(0.7, Math.min(1, h / 700)));
    };
    update();
    return subscribeLogicalViewport(update);
  }, [isWide]);
  return scale;
}
