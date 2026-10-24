#!/usr/bin/env node
/**
 * scripts/build-jma-travel-time.mjs
 * ------------------------------------------------------------
 * 気象庁が配布しているJMA2001走時表(tjma2001.zip)をダウンロード・展開・
 * パースし、epicenterEstimation.ts(jmaTravelTime.ts)がfetchして読み込める
 * 形のJSON(public/jma-travel-time.json)を生成する、開発時に1回だけ実行する
 * 変換スクリプト。
 *
 * 【なぜこのスクリプトが要るのか】
 * 実データ(tjma2001.zip)は気象庁のサイトから直接取得する必要があり、
 * アプリのソースコードには含めない(ライセンス・更新の都合上、リポジトリに
 * バイナリを同梱せず、このスクリプトで都度取得する運用にしている)。
 *
 * 【使い方】
 *   node scripts/build-jma-travel-time.mjs
 * 実行すると、このリポジトリの public/jma-travel-time.json が
 * 作成/更新される。ビルド成果物ではなくpublic/配下の静的アセットなので、
 * 通常はアプリのデプロイ前に1回実行しておけば良い(気象庁側でテーブルが
 * 改訂されない限り、毎回のビルドで実行し直す必要はない)。
 *
 * 【依存関係】
 * Node.js 18以降のfetch・組み込みのzlib(DEFLATE展開)のみを使用しており、
 * 追加のnpmパッケージは不要。ZIPファイルの解析(セントラルディレクトリ・
 * ローカルファイルヘッダの読み取り)は本スクリプト内で最小限だけ自前実装
 * している(tjma2001.zipが単一ファイルを含む一般的なZIPである前提)。
 *
 * 【出力JSONの形式】
 * jmaTravelTime.tsのtableFromJSON()が期待する形(distances/depths/
 * pTimesSec/sTimesSecの4つのプレーンな配列)。pTimesSec・sTimesSecは
 * depths.length × distances.length の行優先1次元配列で、値が無い
 * (表の穴)場所はnull(JSONにNaNは無いため)。
 */
import { writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const JMA_TRAVEL_TIME_ZIP_URL =
  "https://www.data.jma.go.jp/eqev/data/bulletin/catalog/appendix/trtime/tjma2001.zip";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "public", "jma-travel-time.json");

// --- 最小限のZIP展開(単一エントリのZIPを想定) ---
// ZIPフォーマット: 末尾のEnd Of Central Directory(EOCD, シグネチャ
// 0x06054b50)からセントラルディレクトリの位置を辿り、最初のエントリの
// ローカルファイルヘッダ(シグネチャ0x04034b50)から圧縮データを取り出す。
// 圧縮方式が0(無圧縮)ならそのまま、8(DEFLATE)ならzlibのinflateRawSyncで
// 展開する。tjma2001.zipのように単一ファイルのシンプルなZIPであれば
// これで十分。
function unzipFirstEntry(buf) {
  const eocdSig = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error("EOCDが見つかりません(ZIPとして不正な可能性があります)");

  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);
  const centralDirSig = 0x02014b50;
  if (buf.readUInt32LE(centralDirOffset) !== centralDirSig) {
    throw new Error("セントラルディレクトリのシグネチャが不正です");
  }

  const compressionMethod = buf.readUInt16LE(centralDirOffset + 10);
  const localHeaderOffset = buf.readUInt32LE(centralDirOffset + 42);

  const localSig = 0x04034b50;
  if (buf.readUInt32LE(localHeaderOffset) !== localSig) {
    throw new Error("ローカルファイルヘッダのシグネチャが不正です");
  }
  const compressedSize = buf.readUInt32LE(localHeaderOffset + 18);
  const fileNameLength = buf.readUInt16LE(localHeaderOffset + 26);
  const extraFieldLength = buf.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + fileNameLength + extraFieldLength;
  const compressedData = buf.subarray(dataStart, dataStart + compressedSize);

  if (compressionMethod === 0) return compressedData;
  if (compressionMethod === 8) return inflateRawSync(compressedData);
  throw new Error(`未対応の圧縮方式です(method=${compressionMethod})。tjma2001.zipの形式が変わった可能性があります。`);
}

// --- 走時表のパース(jmaTravelTime.tsのparseJmaTravelTimeTableと同じロジック) ---
// 気象庁の走時表フォーマット仕様(固定長)は、連続する空白を1つに詰めてから
// 空白区切りで分割すると ["P", <P走時>, "S", <S走時>, <深さ>, <震央距離>]
// の6要素になる(01:相名P, 03-10:P波走時, 12:相名S, 14-21:S波走時,
// 23-25:深さ, 28-32:震央距離)。
function parseTravelTimeText(text) {
  const distanceSet = new Set();
  const depthSet = new Set();
  const rows = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.replace(/\s+/g, " ").split(" ");
    if (parts.length < 6) continue;
    const p = parseFloat(parts[1]);
    const s = parseFloat(parts[3]);
    const depth = parseInt(parts[4], 10);
    const distance = parseInt(parts[5], 10);
    if (!Number.isFinite(p) || !Number.isFinite(depth) || !Number.isFinite(distance)) continue;
    rows.push({ depth, distance, p, s: Number.isFinite(s) ? s : null });
    distanceSet.add(distance);
    depthSet.add(depth);
  }
  const distances = [...distanceSet].sort((a, b) => a - b);
  const depths = [...depthSet].sort((a, b) => a - b);
  const distIndex = new Map(distances.map((d, i) => [d, i]));
  const depthIndex = new Map(depths.map((d, i) => [d, i]));

  const pTimesSec = new Array(depths.length * distances.length).fill(null);
  const sTimesSec = new Array(depths.length * distances.length).fill(null);
  for (const row of rows) {
    const di = depthIndex.get(row.depth);
    const xi = distIndex.get(row.distance);
    if (di == null || xi == null) continue;
    const idx = di * distances.length + xi;
    pTimesSec[idx] = row.p;
    sTimesSec[idx] = row.s;
  }
  return { distances, depths, pTimesSec, sTimesSec };
}

async function main() {
  console.log(`Downloading ${JMA_TRAVEL_TIME_ZIP_URL} ...`);
  const res = await fetch(JMA_TRAVEL_TIME_ZIP_URL);
  if (!res.ok) throw new Error(`ダウンロードに失敗しました(status=${res.status})`);
  const zipBuf = Buffer.from(await res.arrayBuffer());

  console.log("Extracting...");
  const rawBuf = unzipFirstEntry(zipBuf);
  const text = rawBuf.toString("utf-8");

  console.log("Parsing...");
  const table = parseTravelTimeText(text);
  console.log(`  distances: ${table.distances.length}点 (${table.distances[0]}〜${table.distances.at(-1)}km)`);
  console.log(`  depths: ${table.depths.length}点 (${table.depths[0]}〜${table.depths.at(-1)}km)`);

  writeFileSync(OUTPUT_PATH, JSON.stringify(table));
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
