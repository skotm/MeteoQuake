/**
 * eewVisibility.js
 * ------------------------------------------------------------
 * 緊急地震速報(EEW)の表示と、「地震を選択して見ている」状態の、競合の解決。
 *
 * 【背景】緊急地震速報が出ている間、地震タブは「リアルタイム」に固定される。リアルタイムタブでは、
 * フローティングの上にEEWカード、その下に「直近の地震一覧/選択した地震の詳細」が並び、地図にはEEWの
 * P波・S波の円・予想震度の塗り分け・予想震度凡例が出る。この状態で、一覧から地震を選ぶと、以前は:
 *   ・EEWの円・予想震度・カード・凡例が、そのまま残る
 *   ・新規の速報で自動的にtrueになるeewDetailOpenが、リアルタイムタブでは「閉じる」ボタンが無いため
 *     trueのまま残り、それが理由で、選んだ地震の震源・観測点・震度凡例・戻るボタンが出ない
 * という状態になっていた。
 *
 * 【方針】リアルタイムタブで地震を選択している間は、EEWの表示を隠し、選んだ地震の表示に集中させる。
 * 選択を解除(戻る)すれば、発表中の速報が元どおり表示される。ただし、隠れている間に、新しい速報が
 * 来た時・予報から警報へ切り上がった時は、見逃さないよう、選択を解除して速報を見せる
 * (shouldRevealIncomingEew)。
 */

/**
 * 画面(地図・BottomDock)へ渡す、EEWの一覧と詳細表示フラグを決める。
 * - effectiveNav: 今見ている内容("realtime"|"quake"|"tsunami"|...)。地震タブがリアルタイム表示の間は"realtime"。
 * - effectiveEews: テスト配信を合成した、EEWの一覧(取消済みを含む)
 * - realtimeTabSelectedQuakeId: リアルタイムタブの一覧から選んだ地震のid(未選択はnull)
 * - eewDetailOpen: EEW詳細の表示状態(新規の速報で自動的にtrueになる)
 */
export function computeEewVisibility({ effectiveNav, effectiveEews, realtimeTabSelectedQuakeId, eewDetailOpen }) {
  const eewActive = effectiveEews.some(e => !e.cancelled);
  const eewHiddenBySelection = effectiveNav === "realtime" && eewActive && realtimeTabSelectedQuakeId != null;
  return {
    eewHiddenBySelection,
    // 隠している間は、空の一覧を渡す(地図の円・塗り分け・凡例、BottomDockのカード・FABがすべて消える)。
    // 隠さない時は、元の配列をそのまま渡す(同一性を保つ。不要な再描画・再計算を起こさない)。
    displayedEews: eewHiddenBySelection ? EMPTY : effectiveEews,
    // EEW以外の表示(震源・観測点・断層・震度凡例・戻るボタンなど)を塞ぐかどうか。
    displayedEewDetailOpen: eewDetailOpen && !eewHiddenBySelection,
  };
}
const EMPTY = Object.freeze([]);

/**
 * 地震を選択して見ている最中に、速報が来た時、選択を解除して速報を見せるべきか。
 * 見せるのは、次の場合のみ(見ている地震を不必要に奪わないため):
 *   ・新規の速報(取消でないもの)
 *   ・続報で、予報(isWarnLevel:false)から警報(isWarnLevel:true)へ切り上がった時
 * 対象は、リアルタイムタブで選んだ地震(origin:"realtime")だけ。地震タブで選んだ地震は、リアルタイムタブでは
 * 無視される選択で、速報が終われば地震タブに戻って続きを見られるよう、解除しない。
 */
export function shouldRevealIncomingEew({ selectedQuakeId, selectedQuakeOrigin, existing, incoming }) {
  if (selectedQuakeId == null || selectedQuakeOrigin !== "realtime") return false;
  if (incoming.cancelled) return false;
  if (!existing) return true;
  return existing.isWarnLevel === false && incoming.isWarnLevel === true;
}
