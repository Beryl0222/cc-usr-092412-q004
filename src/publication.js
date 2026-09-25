import { validateEvent } from "./validator.js";
import { fingerprint } from "./event-store.js";

/**
 * 发布冻结服务。
 *
 * 闸门顺序（缺一不可）：
 *   自动候选 → 统计负责人 QUALITY_CONFIRMED → 业务负责人 USE_APPROVED（指定规划评审）
 *   → RELEASE_PROPOSED → RELEASE_FROZEN（快照哈希，幂等）
 *
 * 冻结后：
 * - 快照永不改写；迟到补报产生的新结果只能以 RELEASE_REVISED 追加，
 *   并向所有引用该包的报告追加 REPORT_REVISION_APPENDED 修订影响。
 */
export class PublicationService {
  /**
   * @param {import("./event-store.js").EventStore} store
   * @param {import("./clock.js").ControlledClock} clock
   * @param {import("./computation.js").ComputationService} computation
   */
  constructor(store, clock, computation) {
    this.store = store;
    this.clock = clock;
    this.computation = computation;
  }

  #append(event) {
    const errors = validateEvent(event);
    if (errors.length) throw new Error(`事件不合法：${errors.join("；")}`);
    return this.store.append(event);
  }

  #seriesEvents(seriesId) {
    return this.store.forAggregate(seriesId);
  }

  // -- 双重批准 -----------------------------------------------------------

  /** 统计负责人确认质量（可附例外接受说明）。 */
  confirmQuality(seriesId, statistician, note = "") {
    this.computation.getSeries(seriesId); // 存在性
    if (this.#seriesEvents(seriesId).some((e) => e.event_type === "QUALITY_CONFIRMED")) {
      return this.#seriesEvents(seriesId).find((e) => e.event_type === "QUALITY_CONFIRMED");
    }
    const version = this.#seriesEvents(seriesId).length + 1;
    return this.#append({
      event_id: `quality-${seriesId}-confirmed`,
      event_type: "QUALITY_CONFIRMED",
      aggregate_type: "candidate_series",
      aggregate_id: seriesId,
      occurred_at: this.clock.now(),
      version,
      summary: `统计负责人 ${statistician} 确认 ${seriesId} 质量${note ? `：${note}` : ""}`,
      payload: { series_id: seriesId, confirmed_by: statistician, note, confirmed_at: this.clock.now() }
    });
  }

  /** 业务负责人批准用途（面向某次规划评审）。 */
  approveUse(seriesId, businessOwner, planningReviewId, intendedUse) {
    const series = this.computation.getSeries(seriesId);
    if (!series.quality_confirmed) {
      throw new Error(`用途批准被拒：${seriesId} 尚未经统计负责人质量确认`);
    }
    if (this.#seriesEvents(seriesId).some((e) => e.event_type === "USE_APPROVED")) {
      return this.#seriesEvents(seriesId).find((e) => e.event_type === "USE_APPROVED");
    }
    const version = this.#seriesEvents(seriesId).length + 1;
    return this.#append({
      event_id: `use-${seriesId}-approved`,
      event_type: "USE_APPROVED",
      aggregate_type: "candidate_series",
      aggregate_id: seriesId,
      occurred_at: this.clock.now(),
      version,
      summary: `业务负责人 ${businessOwner} 批准 ${seriesId} 用于规划评审 ${planningReviewId}`,
      payload: {
        series_id: seriesId,
        approved_by: businessOwner,
        planning_review_id: planningReviewId,
        intended_use: intendedUse,
        approved_at: this.clock.now()
      }
    });
  }

  // -- 冻结数据包 ---------------------------------------------------------

  /**
   * 提案并一次性冻结面向某次规划评审的数据包。
   * 重复调用（相同 release_id）幂等返回既有冻结事件，不会重复发布。
   */
  freezeRelease({ releaseId, planningReviewId, seriesIds }) {
    const existing = this.store
      .forAggregate(releaseId)
      .find((e) => e.event_type === "RELEASE_FROZEN");
    if (existing) return existing;

    if (!this.store.forAggregate(releaseId).some((e) => e.event_type === "RELEASE_PROPOSED")) {
      const series = seriesIds.map((id) => this.computation.getSeries(id));
      for (const s of series) {
        if (s.superseded_by) throw new Error(`候选序列 ${s.series_id} 已被 ${s.superseded_by} 取代，不能冻结`);
        if (!s.quality_confirmed) throw new Error(`候选序列 ${s.series_id} 缺少统计负责人质量确认`);
        const approval = this.#seriesEvents(s.series_id).find((e) => e.event_type === "USE_APPROVED");
        if (!approval) throw new Error(`候选序列 ${s.series_id} 缺少业务负责人用途批准`);
        if (approval.payload.planning_review_id !== planningReviewId) {
          throw new Error(
            `候选序列 ${s.series_id} 批准的评审是 ${approval.payload.planning_review_id}，与本次 ${planningReviewId} 不一致`
          );
        }
      }
      this.#append({
        event_id: `release-${releaseId}-proposed`,
        event_type: "RELEASE_PROPOSED",
        aggregate_type: "publication_release",
        aggregate_id: releaseId,
        occurred_at: this.clock.now(),
        version: 1,
        summary: `冻结提案 ${releaseId}：规划评审 ${planningReviewId}，含 ${seriesIds.length} 条候选序列`,
        payload: { release_id: releaseId, planning_review_id: planningReviewId, series_ids: [...seriesIds] }
      });
    }

    const proposal = this.store.forAggregate(releaseId)[0].payload;
    const snapshot = {};
    for (const id of proposal.series_ids) {
      const s = this.computation.getSeries(id);
      snapshot[id] = JSON.parse(JSON.stringify(s)); // 深拷贝：冻结后与后续事件物理隔离
    }
    const snapshotHash = fingerprint(snapshot);
    return this.#append({
      event_id: `release-${releaseId}-frozen`,
      event_type: "RELEASE_FROZEN",
      aggregate_type: "publication_release",
      aggregate_id: releaseId,
      occurred_at: this.clock.now(),
      version: 2,
      summary: `数据包 ${releaseId} 已冻结发布（规划评审 ${planningReviewId}），快照哈希 ${snapshotHash.slice(0, 16)}…`,
      payload: {
        release_id: releaseId,
        planning_review_id: proposal.planning_review_id,
        series_ids: [...proposal.series_ids],
        snapshot,
        snapshot_hash: snapshotHash,
        frozen_at: this.clock.now()
      }
    });
  }

  /** 读取冻结包：原始快照 + 追加修订列表（快照本身永不变）。 */
  getRelease(releaseId) {
    const frozen = this.store.forAggregate(releaseId).find((e) => e.event_type === "RELEASE_FROZEN");
    if (!frozen) throw new Error(`冻结包 ${releaseId} 不存在`);
    const revisions = this.store
      .forAggregate(releaseId)
      .filter((e) => e.event_type === "RELEASE_REVISED")
      .map((e) => e.payload);
    return { ...frozen.payload, revisions };
  }

  // -- 报告引用与修订追加 --------------------------------------------------

  /** 登记报告对冻结包的引用。 */
  recordReportReference({ reportId, releaseId, reportName }) {
    this.getRelease(releaseId); // 必须已冻结
    if (this.store.forAggregate(reportId).length) {
      return this.store.forAggregate(reportId)[0];
    }
    return this.#append({
      event_id: `report-${reportId}`,
      event_type: "REPORT_REFERENCE_RECORDED",
      aggregate_type: "report_reference",
      aggregate_id: reportId,
      occurred_at: this.clock.now(),
      version: 1,
      summary: `报告 ${reportName}（${reportId}）引用冻结包 ${releaseId}`,
      payload: { report_id: reportId, report_name: reportName, release_id: releaseId, referenced_at: this.clock.now() }
    });
  }

  /**
   * 已发布包的修订只追加：迟到补报重算得到的新候选序列经质量确认后，
   * 以修订形式附在冻结包上，并通知全部引用报告；原快照与原值不改写。
   *
   * @param {object} req
   * @param {string} req.release_id
   * @param {string} req.old_series_id 冻结包内被影响的序列
   * @param {string} req.new_series_id 迟到数据重算后的新序列（须已质量确认）
   * @param {string} req.statistician 确认修订质量的统计负责人
   * @param {string} req.business_owner 知悉并接受修订影响的业务负责人
   * @param {string} req.impact 修订影响说明
   */
  appendRevision({ release_id: releaseId, old_series_id: oldSeriesId, new_series_id: newSeriesId, statistician, business_owner: businessOwner, impact }) {
    const release = this.getRelease(releaseId);
    if (!release.snapshot[oldSeriesId]) throw new Error(`冻结包 ${releaseId} 不含序列 ${oldSeriesId}`);
    const fresh = this.computation.getSeries(newSeriesId);
    if (!fresh.quality_confirmed) throw new Error(`修订序列 ${newSeriesId} 须先经统计负责人质量确认`);

    const revisionId = `rev-${releaseId}-${oldSeriesId}-${newSeriesId}`.replaceAll("series-", "");
    if (this.store.forAggregate(releaseId).some((e) => e.payload?.revision_id === revisionId)) {
      return this.store.forAggregate(releaseId).find((e) => e.payload?.revision_id === revisionId);
    }
    const version = this.store.forAggregate(releaseId).length + 1;
    const revisedEvent = this.#append({
      event_id: `release-${releaseId}-revision-${version}`,
      event_type: "RELEASE_REVISED",
      aggregate_type: "publication_release",
      aggregate_id: releaseId,
      occurred_at: this.clock.now(),
      version,
      summary: `冻结包 ${releaseId} 追加修订（${oldSeriesId} → ${newSeriesId}）：${impact}`,
      payload: {
        revision_id: revisionId,
        release_id: releaseId,
        old_series_id: oldSeriesId,
        new_series_id: newSeriesId,
        trigger: "late_report",
        impact,
        confirmed_by: statistician,
        acknowledged_by: businessOwner,
        appended_at: this.clock.now()
      }
    });

    // 向所有引用该包的报告追加修订影响（报告原文不改写）
    for (const ref of this.store.ofType("REPORT_REFERENCE_RECORDED").map((e) => e.payload).filter((r) => r.release_id === releaseId)) {
      const reportVersion = this.store.forAggregate(ref.report_id).length + 1;
      this.#append({
        event_id: `report-${ref.report_id}-revision-${revisionId}`,
        event_type: "REPORT_REVISION_APPENDED",
        aggregate_type: "report_reference",
        aggregate_id: ref.report_id,
        occurred_at: this.clock.now(),
        version: reportVersion,
        summary: `报告 ${ref.report_name} 追加修订影响：${impact}`,
        payload: {
          report_id: ref.report_id,
          release_id: releaseId,
          revision_id: revisionId,
          impact,
          appended_at: this.clock.now()
        }
      });
    }
    return revisedEvent;
  }

  /** 报告的引用与全部已收修订（供评估人员查看）。 */
  getReport(reportId) {
    const events = this.store.forAggregate(reportId);
    const reference = events.find((e) => e.event_type === "REPORT_REFERENCE_RECORDED")?.payload;
    if (!reference) throw new Error(`报告 ${reportId} 不存在`);
    const revisions = events.filter((e) => e.event_type === "REPORT_REVISION_APPENDED").map((e) => e.payload);
    return { ...reference, revisions_appended: revisions };
  }
}
