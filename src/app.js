import { ControlledClock } from "./clock.js";
import { EventStore } from "./event-store.js";
import { LineageService } from "./lineage.js";
import { IngestionService } from "./ingestion.js";
import { ComputationService } from "./computation.js";
import { PublicationService } from "./publication.js";
import { ProvenanceService } from "./provenance.js";

/**
 * 应用装配：把仅追加事件存储、可控时钟与各领域服务组装为一个整体，
 * 并提供整体快照/恢复，用于故障恢复演练（继续未完成计算、不重复发布）。
 */
export class IndicatorRegistry {
  /**
   * @param {{clockIso?: string, store?: EventStore, clock?: ControlledClock}} [options]
   */
  constructor(options = {}) {
    this.clock = options.clock ?? new ControlledClock(options.clockIso);
    this.store = options.store ?? new EventStore();
    this.lineage = new LineageService(this.store, this.clock);
    this.ingestion = new IngestionService(this.store, this.clock);
    this.computation = new ComputationService(this.store, this.clock, this.lineage, this.ingestion);
    this.publication = new PublicationService(this.store, this.clock, this.computation);
    this.provenance = new ProvenanceService(this.store, this.lineage, this.ingestion, this.computation, this.publication);
  }

  /** 整体可持久化快照（事件 + 时钟位置）。 */
  snapshot() {
    return { clock_now: this.clock.now(), store: this.store.toJSON() };
  }

  /**
   * 从快照恢复：事件原样回放（event_id 幂等），时钟回到崩溃前位置。
   * @param {{clock_now: string, store: object}} snapshot
   */
  static restore(snapshot) {
    const clock = new ControlledClock(snapshot.clock_now);
    const store = EventStore.fromSnapshot(snapshot.store);
    return new IndicatorRegistry({ clock, store });
  }
}
