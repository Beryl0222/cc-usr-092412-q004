import { validateEvent } from "./validator.js";
import { fingerprint } from "./event-store.js";

/**
 * 数据上报服务：数据源登记（到期/复核期限）、观察批次上报（含迟到补报）、
 * 冲突待决队列。
 *
 * 关键约定：
 * - 上报不可变；更正以“补报批次 + 更正链 supersedes_batch_id”表达。
 * - 同一 (指标, 期, 区划) 出现两个互无更正关系的批次时，进入冲突队列，
 *   计算作业跳过冲突未决的输入，候选序列对应点置空并注明原因。
 * - 迟到补报只可重算“尚未冻结发布”的候选序列；已发布包只追加修订。
 */
export class IngestionService {
  /**
   * @param {import("./event-store.js").EventStore} store
   * @param {import("./clock.js").ControlledClock} clock
   */
  constructor(store, clock) {
    this.store = store;
    this.clock = clock;
  }

  #append(event) {
    const errors = validateEvent(event);
    if (errors.length) throw new Error(`事件不合法：${errors.join("；")}`);
    return this.store.append(event);
  }

  #nextVersion(aggregateId) {
    return this.store.forAggregate(aggregateId).length + 1;
  }

  // -- 数据源 -------------------------------------------------------------

  registerDataSource(source) {
    if (this.store.forAggregate(source.source_id).length) {
      throw new Error(`数据源 ${source.source_id} 已存在`);
    }
    return this.#append({
      event_id: `src-${source.source_id}`,
      event_type: "DATA_SOURCE_REGISTERED",
      aggregate_type: "data_source",
      aggregate_id: source.source_id,
      occurred_at: this.clock.now(),
      version: 1,
      summary: `登记数据源 ${source.name}，到期 ${source.expires_at}，复核期限 ${source.review_due_after_days} 天`,
      payload: { ...source }
    });
  }

  /** 到期续期：旧到期时间保留在谱系中，新期限作为后继版本。 */
  renewDataSource(sourceId, newExpiresAt, note) {
    const version = this.#nextVersion(sourceId);
    if (version < 2) throw new Error(`数据源 ${sourceId} 不存在，无法续期`);
    return this.#append({
      event_id: `src-${sourceId}-renew-v${version}`,
      event_type: "DATA_SOURCE_RENEWED",
      aggregate_type: "data_source",
      aggregate_id: sourceId,
      occurred_at: this.clock.now(),
      version,
      summary: `数据源 ${sourceId} 续期至 ${newExpiresAt}：${note}`,
      payload: { source_id: sourceId, expires_at: newExpiresAt, note }
    });
  }

  getDataSource(sourceId) {
    const events = this.store.forAggregate(sourceId);
    const registered = events.find((e) => e.event_type === "DATA_SOURCE_REGISTERED");
    if (!registered) throw new Error(`数据源 ${sourceId} 不存在`);
    const renewals = events.filter((e) => e.event_type === "DATA_SOURCE_RENEWED");
    const latest = renewals.at(-1);
    return { ...registered.payload, expires_at: latest ? latest.payload.expires_at : registered.payload.expires_at };
  }

  /** @returns {boolean} 数据源按可控时钟是否已到期 */
  isExpired(sourceId) {
    return this.clock.isDue(this.getDataSource(sourceId).expires_at);
  }

  // -- 观察批次 -----------------------------------------------------------

  /**
   * 上报一批观察值。
   * @param {object} batch
   * @param {string} batch.batch_id
   * @param {string} batch.indicator_id
   * @param {string} batch.source_id
   * @param {boolean} [batch.is_late] 是否迟到补报
   * @param {string|null} [batch.supersedes_batch_id] 更正链：本批次取代的旧批次
   * @param {{geography_id: string, period: string, numerator: number, denominator: number}[]} batch.observations
   */
  submitBatch(batch) {
    if (this.store.forAggregate(batch.batch_id).length) {
      throw new Error(`批次 ${batch.batch_id} 已存在`);
    }
    const source = this.getDataSource(batch.source_id);
    const submittedAt = this.clock.now();
    const reviewDeadline = this.clock.reviewDeadline(submittedAt, source.review_due_after_days);
    const observations = batch.observations.map((o) => ({ ...o }));
    const batchFingerprint = fingerprint({
      indicator_id: batch.indicator_id,
      source_id: batch.source_id,
      observations
    });
    return this.#append({
      event_id: `batch-${batch.batch_id}`,
      event_type: "OBSERVATION_SUBMITTED",
      aggregate_type: "observation_batch",
      aggregate_id: batch.batch_id,
      occurred_at: submittedAt,
      version: 1,
      summary: `${batch.is_late ? "迟到补报" : "常规上报"}批次 ${batch.batch_id}（${observations.length} 条，来源 ${batch.source_id}）`,
      payload: {
        batch_id: batch.batch_id,
        indicator_id: batch.indicator_id,
        source_id: batch.source_id,
        is_late: !!batch.is_late,
        supersedes_batch_id: batch.supersedes_batch_id ?? null,
        submitted_at: submittedAt,
        review_deadline: reviewDeadline,
        observations,
        batch_fingerprint: batchFingerprint
      }
    });
  }

  getBatch(batchId) {
    const event = this.store
      .forAggregate(batchId)
      .find((e) => e.event_type === "OBSERVATION_SUBMITTED");
    if (!event) throw new Error(`批次 ${batchId} 不存在`);
    return event.payload;
  }

  allBatches(indicatorId = null) {
    return this.store
      .ofType("OBSERVATION_SUBMITTED")
      .map((e) => e.payload)
      .filter((b) => !indicatorId || b.indicator_id === indicatorId);
  }

  // -- 冲突待决队列 --------------------------------------------------------

  /**
   * 记录冲突：同一 (指标, 期) 若干区划上互无更正关系的来源批次，按“期”聚合为一条待决项。
   * @returns {object|null} 冲突事件；若幂等已存在则返回既有事件
   */
  recordConflict({ conflictId, indicatorId, period, geographyIds, batchIds, reason }) {
    const existing = this.store.forAggregate(conflictId);
    if (existing.length) return existing[0];
    return this.#append({
      event_id: `conflict-${conflictId}`,
      event_type: "CONFLICT_RECORDED",
      aggregate_type: "conflict",
      aggregate_id: conflictId,
      occurred_at: this.clock.now(),
      version: 1,
      summary: `待决冲突 ${conflictId}：${indicatorId} ${period}，区划 ${geographyIds.join("、")}，批次 ${batchIds.join(" / ")}`,
      payload: {
        conflict_id: conflictId,
        indicator_id: indicatorId,
        period,
        geography_ids: [...geographyIds],
        batch_ids: [...batchIds],
        reason,
        status: "open"
      }
    });
  }

  /** 裁决冲突：记录依据与胜出批次；败出批次从此被计算跳过。 */
  resolveConflict(conflictId, winningBatchId, basis, decidedBy) {
    const current = this.#nextVersion(conflictId) - 1;
    if (current < 1) throw new Error(`冲突 ${conflictId} 不存在`);
    const recorded = this.store.forAggregate(conflictId)[0].payload;
    if (!recorded.batch_ids.includes(winningBatchId)) {
      throw new Error("胜出批次必须是冲突当事批次之一");
    }
    return this.#append({
      event_id: `conflict-${conflictId}-resolve-v${current + 1}`,
      event_type: "CONFLICT_RESOLVED",
      aggregate_type: "conflict",
      aggregate_id: conflictId,
      occurred_at: this.clock.now(),
      version: current + 1,
      summary: `冲突 ${conflictId} 裁决：采用 ${winningBatchId}（${basis}）`,
      payload: {
        conflict_id: conflictId,
        winning_batch_id: winningBatchId,
        basis,
        decided_by: decidedBy
      }
    });
  }

  /** @returns {object[]} 仍未裁决的冲突 */
  openConflicts() {
    return this.store
      .ofType("CONFLICT_RECORDED")
      .map((e) => e.payload)
      .filter((c) => c.status === "open" && !this.store.ofType("CONFLICT_RESOLVED").some((r) => r.payload.conflict_id === c.conflict_id));
  }

  /**
   * 检测并登记指定指标的全部来源冲突（不考虑已存在更正链的情形）。
   * 同一 (指标, 期) 的多个矛盾区划聚合为一条待决项。
   * @returns {object[]} 本次新发现（或已存在）的冲突事件
   */
  detectConflicts(indicatorId) {
    const found = [];
    const periodCells = new Map(); // period -> Map(geo -> batches[])
    for (const b of this.allBatches(indicatorId)) {
      for (const o of b.observations) {
        if (!periodCells.has(o.period)) periodCells.set(o.period, new Map());
        const geoMap = periodCells.get(o.period);
        if (!geoMap.has(o.geography_id)) geoMap.set(o.geography_id, []);
        geoMap.get(o.geography_id).push(b.batch_id);
      }
    }
    for (const [period, geoMap] of periodCells) {
      const conflictGeos = [];
      const batchSet = new Set();
      for (const [geo, batchIds] of geoMap) {
        // 去掉被同组其他批次通过更正链取代的批次后仍有多个有效来源 => 该单元冲突
        const live = batchIds.filter(
          (id) => !batchIds.some((other) => other !== id && this.getBatch(other).supersedes_batch_id === id)
        );
        if (live.length > 1) {
          conflictGeos.push(geo);
          live.forEach((id) => batchSet.add(id));
        }
      }
      if (conflictGeos.length) {
        const conflictId = `cf-${indicatorId}-${period}`;
        if (!this.store.forAggregate(conflictId).length) {
          found.push(
            this.recordConflict({
              conflictId,
              indicatorId: indicatorId,
              period,
              geographyIds: conflictGeos,
              batchIds: [...batchSet],
              reason: "同一指标/期存在相互冲突且无更正链的来源"
            })
          );
        }
      }
    }
    return found;
  }
}
