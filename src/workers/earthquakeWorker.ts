/**
 * earthquakeWorker.ts
 * ------------------------------------------------------------
 * 地震検知・震源推定を行うWeb Workerの入口。処理の本体はanalysis/workerHandler.ts。
 * メインスレッドからは analysis/analysisClient.ts 経由で使う。
 */
import { attachWorkerHandler, type WorkerPort } from "../analysis/workerHandler";

attachWorkerHandler(self as unknown as WorkerPort);
