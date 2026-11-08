// Node用(テスト・tools/replay-eval.mts): worker_threadsのWorkerとして、解析のメッセージ処理(workerHandler)を動かす入口。
// ブラウザでは、同じ処理をsrc/workers/earthquakeWorker.tsが担う。
import { parentPort } from "node:worker_threads";
import { attachWorkerHandler, type WorkerPort } from "../src/analysis/workerHandler";

const port: WorkerPort = { postMessage: (m) => parentPort!.postMessage(m), onmessage: null };
parentPort!.on("message", (data) => port.onmessage?.({ data }));
attachWorkerHandler(port);
