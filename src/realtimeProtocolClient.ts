/**
 * realtimeProtocolClient.ts
 * ------------------------------------------------------------
 * サーバー側 protocol.ts のデコード部分をブラウザ向けに複製したもの。
 * サーバーとクライアントで別プロジェクト(Cloudflare Workers / React SPA)に
 * 分かれているため、当面はコピーで運用する。将来的にモノレポ化するか、
 * npm packageとして切り出して両側から参照する形に統合するのが望ましい。
 *
 * ⚠️ フォーマットを変更する場合は、サーバー側 protocol.ts と必ず同時に
 *   更新すること(バイト配置が一致していないと単に壊れる)。
 */

export const NO_DATA_SENTINEL = -32768;

export interface IntensityEntry {
  id: number;
  intensity: number | null;
}

export interface IntensityDeltaMessage {
  dataTime: Date;
  entries: IntensityEntry[];
}

export function decodeIntensityDelta(buf: ArrayBuffer): IntensityDeltaMessage {
  const view = new DataView(buf);

  const type = view.getUint8(0);
  if (type !== 0x01) {
    throw new Error(`想定外のmessageType: 0x${type.toString(16)}`);
  }

  const dataTimeUnixSec = view.getUint32(1, true);
  const entryCount = view.getUint16(5, true);

  const expectedSize = 7 + entryCount * 4;
  if (buf.byteLength !== expectedSize) {
    throw new Error(`メッセージ長が不正です: expected=${expectedSize} actual=${buf.byteLength}`);
  }

  const entries: IntensityEntry[] = new Array(entryCount);
  let offset = 7;
  for (let i = 0; i < entryCount; i++) {
    const id = view.getUint16(offset, true);
    const scaled = view.getInt16(offset + 2, true);
    entries[i] = { id, intensity: scaled === NO_DATA_SENTINEL ? null : scaled / 100 };
    offset += 4;
  }

  return { dataTime: new Date(dataTimeUnixSec * 1000), entries };
}
