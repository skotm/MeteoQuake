/**
 * analysisClient.ts
 * ------------------------------------------------------------
 * メインスレッド側から、Worker上のAnalysisPipelineを呼ぶためのクライアント。
 *
 * ・tick()は結果を非同期(Promise)で返す。Worker内の処理が終わる前に次のtickが来た場合は、溜めておき、
 *   前の結果が返った時に、まとめて1回のメッセージで送る。Worker側は、検知は溜まった全tick分進め、
 *   重い震源推定は最後の1tickだけ行う(推定が追いつかなくても、遅延が積み上がらない)。
 * ・まとめられた(最後ではない)tickのPromiseは、nullで解決する。結果(描画に使う値)は最後のtickのPromiseで返る。
 * ・同じMapのままの再呼び出しは、Mapを送り直さずsameValuesで知らせる(Worker側で前回のMapを使い回す)。
 */
import type { AnalysisTickInput, AnalysisTickOutput, Station } from "./analysisPipeline";
import type { FromWorkerMessage, TickItem, ToWorkerMessage, TravelTableJson } from "./analysisProtocol";

/** Workerまたは、その代わりになるもの(テストではworker_threadsのアダプタ)。 */
export interface AnalysisTransport {
  postMessage(message: ToWorkerMessage): void;
  onmessage: ((event: { data: FromWorkerMessage }) => void) | null;
  terminate?(): void;
}

interface PendingTick {
  input: AnalysisTickInput;
  resolve: (output: AnalysisTickOutput | null) => void;
  reject: (error: Error) => void;
}

export class AnalysisClient {
  private seq = 0;
  private inFlight: { seq: number; resolve: PendingTick["resolve"]; reject: PendingTick["reject"] } | null = null;
  private pending: PendingTick[] = [];
  private lastSentValues: Map<number, number> | null = null;

  private transport: AnalysisTransport;

  constructor(transport: AnalysisTransport) {
    this.transport = transport;
    transport.onmessage = (event) => this.onMessage(event.data);
  }

  setTravelTable(json: TravelTableJson): void {
    this.transport.postMessage({ type: "setTravelTable", json });
  }

  setStations(stations: Station[], weakArrayEnabled: boolean): void {
    this.transport.postMessage({ type: "setStations", stations, weakArrayEnabled });
  }

  setWeakArrayEnabled(enabled: boolean): void {
    this.transport.postMessage({ type: "setWeakArrayEnabled", enabled });
  }

  /** 1tick分進める。Worker処理中に呼ばれて、後続のtickにまとめられた場合は、nullで解決する。 */
  tick(input: AnalysisTickInput): Promise<AnalysisTickOutput | null> {
    return new Promise((resolve, reject) => {
      this.pending.push({ input, resolve, reject });
      this.flush();
    });
  }

  terminate(): void {
    this.transport.terminate?.();
    const error = new Error("AnalysisClient terminated");
    this.inFlight?.reject(error);
    this.inFlight = null;
    for (const p of this.pending) p.reject(error);
    this.pending = [];
  }

  private flush(): void {
    if (this.inFlight || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    const items: TickItem[] = batch.map((p) => {
      const { values, ...rest } = p.input;
      const same = this.lastSentValues === values;
      this.lastSentValues = values;
      return { seq: ++this.seq, input: same ? { ...rest, sameValues: true } : { ...rest, values: [...values] } };
    });
    // まとめられた(最後ではない)tickは、結果を返さずnullで解決する。
    for (let i = 0; i < batch.length - 1; i++) batch[i].resolve(null);
    const last = batch[batch.length - 1];
    this.inFlight = { seq: items[items.length - 1].seq, resolve: last.resolve, reject: last.reject };
    this.transport.postMessage({ type: "ticks", items });
  }

  private onMessage(msg: FromWorkerMessage): void {
    if (msg.type === "result") {
      const current = this.inFlight;
      if (!current || current.seq !== msg.seq) return;
      this.inFlight = null;
      current.resolve(msg.output);
      this.flush();
    } else if (msg.type === "error") {
      const current = this.inFlight;
      if (current && (msg.seq === null || msg.seq === current.seq)) {
        this.inFlight = null;
        current.reject(new Error(msg.message));
        this.flush();
      }
    }
  }
}
