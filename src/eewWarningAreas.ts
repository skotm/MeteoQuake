/**
 * eewWarningAreas.ts
 * ------------------------------------------------------------
 * 緊急地震速報(警報)の「対象地域」を決める共通のルール。
 * リプレイ(replayEew.ts)と、シミュレーション(app/simEewRules.js)が同じ処理を使う。
 *
 * 気象庁の仕組み:
 *  ・警報は、最大予測震度が5弱以上(または長周期地震動階級3以上)になった時に発表される。
 *    その時点で震度4以上が予想される地域も、すべて警報の対象地域になる。
 *  ・警報の対象地域は、続報で広がることはあっても、狭まらない。
 *  ・続報で対象地域が広がるのは、これまで対象外だった地域に、新たに震度5弱以上
 *    (または長周期階級3以上)が予想された時だけ。その時、新たに震度4が予想された地域も
 *    まとめて対象に加わる。
 *  ・震度4の予想地域だけが増えても、続報は出ない(対象地域も増えない)。
 *  ・警報になる前(予報の段階)は、対象地域は無い。
 */

export interface WarningAreaCandidate {
  name: string;
  /** 震度4以上が予想されている地域か(予測震度の上限側で判定)。 */
  isTarget: boolean;
  /** 震度5弱以上、または長周期地震動階級3以上が予想されている地域か。 */
  isStrong: boolean;
}

export interface WarningAreaStep {
  /** 警報の対象地域(この報の時点)。 */
  names: Set<string>;
  /** この報で新たに加わった地域。 */
  added: string[];
  /** 警報になっているか(この報の時点)。 */
  warned: boolean;
}

/**
 * 1つの報を処理して、警報の対象地域を進める。
 * @param current これまでの対象地域(第1報の前や、警報の前は空)
 * @param candidates この報で予想されている地域
 */
export function advanceWarningAreas(current: ReadonlySet<string>, candidates: Iterable<WarningAreaCandidate>): WarningAreaStep {
  const list = [...candidates];
  const names = new Set(current);
  const triggered = list.some((c) => c.isStrong && !names.has(c.name));
  const added: string[] = [];
  if (triggered) {
    for (const c of list) {
      if ((c.isTarget || c.isStrong) && !names.has(c.name)) {
        names.add(c.name);
        added.push(c.name);
      }
    }
  }
  return { names, added, warned: names.size > 0 };
}
