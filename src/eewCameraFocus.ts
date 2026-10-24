// 緊急地震速報(EEW)が発表された時に、地図の視点を震源へ移動させるかどうかの判定。
//
// 移動するのは「そのEEW(同じeventId)の第一報」と、「アプリを開いた時点で既に発表
// されていたEEW」だけ。続報(同じeventIdで報番号だけが進むもの)では動かさない。
// どちらも「このセッションで初めて見たeventId」という同じ条件で判定できる
// (起動時のバックフィルで取り込まれたEEWも、新規に届いたEEWも、eews配列に初めて
// 現れた時点で『初めて見たeventId』になる)。
//
// 取消報、および震源の緯度経度がまだ無い報は対象外で、「見た」ことにもしない
// (後続の報で緯度経度が付いた時点で、その報が移動の対象になる)。

export type EewForFocus = {
  id?: string;
  eventId?: string | null;
  cancelled?: boolean;
  latitude?: number | null;
  longitude?: number | null;
};

export function eewFocusKey(eew: EewForFocus): string {
  return String(eew.eventId ?? eew.id ?? "");
}

// focusedIds(既に視点移動の対象にしたeventIdの集合)を更新しつつ、今回新たに視点移動の
// 対象になったEEWを返す。
export function pickEewsToFocus<T extends EewForFocus>(eews: T[] | null | undefined, focusedIds: Set<string>): T[] {
  const picked: T[] = [];
  for (const eew of eews || []) {
    if (eew.cancelled || eew.latitude == null || eew.longitude == null) continue;
    const key = eewFocusKey(eew);
    if (!key || focusedIds.has(key)) continue;
    focusedIds.add(key);
    picked.push(eew);
  }
  return picked;
}

// ── 揺れ検知(shakeDetection.ts)のイベント ──────────────────────────────
// 揺れ検知では、確定したイベント(confirmed)の観測点を全部まとめて「追従」する
// (pickShakeFollowPoints)。離れた場所で別々の地震が起きた時に、片方だけにズームして
// もう片方が画面の外に出てしまわないよう、確定している全イベントの観測点が
// 画面に収まるように視点を合わせる。追従中は、観測点が増えたり、別の場所のイベントが
// 確定したりして、観測点が画面の端からはみ出しそうになったら、視点を調整する
// (shakeCameraFollow.js)。確定イベントが1つも無くなれば追従を終え、次に確定した
// イベントは「最初の検知」として改めて視点移動の対象になる。
//
// pickShakeFollowTarget は、以前の「確定イベントを1つ選んで追従する」方式の選び方で、
// 今は使っていない(外部のテスト等から参照されていても壊れないよう残してある)。
export type ShakeEventForFollow = {
  id: number;
  confirmed?: boolean;
  pointCount?: number;
  detections?: { lat: number; lon: number }[];
};

export function pickShakeFollowTarget<T extends ShakeEventForFollow>(
  events: T[] | null | undefined,
  followedId: number | null,
): { target: T | null; switched: boolean } {
  const confirmed = (events || []).filter(e => e.confirmed && Array.isArray(e.detections) && e.detections.length > 0);
  if (confirmed.length === 0) return { target: null, switched: followedId != null };
  const current = confirmed.find(e => e.id === followedId);
  if (current) return { target: current, switched: false };
  const target = confirmed.reduce((a, b) => ((b.pointCount ?? 0) > (a.pointCount ?? 0) ? b : a));
  return { target, switched: true };
}

// 確定済み(confirmed)で観測点の位置(detections)があるイベントを全部集めて、
// その観測点をまとめて返す。active=false は、追従するイベントが無いこと。
export function pickShakeFollowPoints<T extends ShakeEventForFollow>(
  events: T[] | null | undefined,
): { active: boolean; points: { lat: number; lon: number }[] } {
  const confirmed = (events || []).filter(e => e.confirmed && Array.isArray(e.detections) && e.detections.length > 0);
  if (confirmed.length === 0) return { active: false, points: [] };
  const points: { lat: number; lon: number }[] = [];
  for (const e of confirmed) for (const d of e.detections!) points.push(d);
  return { active: true, points };
}
