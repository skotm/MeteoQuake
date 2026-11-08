/**
 * workerHandler.ts
 * ------------------------------------------------------------
 * Worker側のメッセージ処理。AnalysisPipelineを1つ持ち、メインスレッドからのメッセージに従って動かし、
 * 結果を返す。Workerの実体(workers/earthquakeWorker.ts)は、これをself(DedicatedWorkerGlobalScope)に
 * 取り付けるだけ。テストでは、worker_threadsやMessageChannelのポートに取り付ける。
 */
import { setJmaTravelTimeTable, tableFromJSON } from "../engines/jmaTravelTime";
import { AnalysisPipeline, type AnalysisTickInput } from "./analysisPipeline";
import type { FromWorkerMessage, ToWorkerMessage } from "./analysisProtocol";

/** Worker・MessagePort・worker_threadsのアダプタが共通して持つ、必要最小限の口。 */
export interface WorkerPort {
  postMessage(message: FromWorkerMessage): void;
  onmessage: ((event: { data: ToWorkerMessage }) => void) | null;
}

export function attachWorkerHandler(port: WorkerPort): AnalysisPipeline {
  const pipeline = new AnalysisPipeline();
  // 前回のtickで使った震度値のMap(sameValuesの時に、そのまま使い回す)。
  let lastValues: Map<number, number> = new Map();

  port.onmessage = (event) => {
    const msg = event.data;
    try {
      switch (msg.type) {
        case "setTravelTable":
          setJmaTravelTimeTable(tableFromJSON(msg.json));
          break;
        case "setStations":
          pipeline.setStations(msg.stations, msg.weakArrayEnabled);
          break;
        case "setWeakArrayEnabled":
          pipeline.setWeakArrayEnabled(msg.enabled);
          break;
        case "ticks": {
          const last = msg.items.length - 1;
          msg.items.forEach((item, i) => {
            const { values, sameValues, ...rest } = item.input;
            if (!sameValues && values) lastValues = new Map(values);
            const input: AnalysisTickInput = { ...rest, values: lastValues };
            try {
              // 溜まったtickは、検知(軽い)は全て進め、震源推定(重い)は最後の1tickだけ行う。
              const output = pipeline.tick(input, { skipEstimation: i < last });
              if (i === last) port.postMessage({ type: "result", seq: item.seq, output });
            } catch (e) {
              port.postMessage({ type: "error", seq: item.seq, message: e instanceof Error ? e.message : String(e) });
            }
          });
          break;
        }
      }
    } catch (e) {
      port.postMessage({ type: "error", seq: null, message: e instanceof Error ? e.message : String(e) });
    }
  };
  return pipeline;
}
