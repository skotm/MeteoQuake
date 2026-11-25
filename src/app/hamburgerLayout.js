/* ─────────────────────────────────────────────────────
   「ハンバーガー式」のタブ配置(縦画面のみ)で使う、画面の寸法と判定。
   ・フローティング: 今までどおり(下のタブドックあり)。カードの右上に「全画面」ボタンが付く。
   ・全画面: 左上にハンバーガーボタン、右上に「フローティングに戻す」ボタン。タブドックは出さない。
   ───────────────────────────────────────────────────── */

// 全画面の時、パネルの上に空けておく高さ[px]。上部のボタン行(top 56px + 48px)と余白、
// その下の「戻る」ボタン行(各タブの戻るボタンが、パネルの右上のすぐ上に出る)を含む。
export const HAM_TOP_GAP = 172;
// 上部のボタン行の上端。ノッチ・ステータスバーを避けるため、安全領域の内側に置く。
export const HAM_BAR_TOP = "max(56px, calc(env(safe-area-inset-top, 0px) + 8px))";
export const HAM_BTN_SIZE = 48;
// 「速報を受信して地震タブに切り替えました」の帯を出しておく時間[ms]。
export const HAM_NOTICE_MS = 5000;

const eewKey = (e) => e?.eventId ?? e?.id ?? null;

/**
 * 緊急地震速報が「新しく」届いたかを判定する。
 * prevIds: 前回の判定時点で有効だった速報のid(Set)。初回はnull(アプリ起動時の既存の速報では切り替えない)。
 * 取消済み・過去の速報の再生(isReplay)は数えない。試験配信・シミュレーションは数える。
 * @returns {{ ids: Set, arrived: boolean }}
 */
export function detectNewActiveEew(prevIds, eews) {
  const ids = new Set();
  for (const e of eews || []) {
    if (!e || e.cancelled || e.isReplay) continue;
    const k = eewKey(e);
    if (k != null) ids.add(k);
  }
  if (prevIds == null) return { ids, arrived: false };
  let arrived = false;
  ids.forEach((k) => { if (!prevIds.has(k)) arrived = true; });
  return { ids, arrived };
}
