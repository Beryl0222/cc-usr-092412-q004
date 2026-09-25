import { validateEvent } from "./validator.js";
import { fingerprint } from "./event-store.js";
import { computeValue } from "./formulas.js";
import { evaluateRules } from "./quality.js";

/**
 * 候选序列计算服务。
 *
 * 自动计算只产出“候选序列”：未经统计负责人质量确认、业务负责人用途批准，
 * 任何候选序列都不得进入冻结数据包。
 *
 * 作业按 (指标 × 期) 拆成确定性步骤并持久化 JOB_STEP_COMPLETED：
 * 进程崩溃后 runJob 会跳过已完成步骤继续未完成计算，已产出的候选序列
 * 与已冻结发布不会重复产生（事件存储对 event_id 幂等）。
 */
export class ComputationService {
  /**
   * @param {import("./event-store.js").EventStore} store
   * @param {import("./clock.js").ControlledClock} clock
   * @param {import("./lineage.js").LineageService} lineage
   * @param {import("./ingestion.js").IngestionService} ingestion
   */
  constructor(store, clock, lineage, ingestion) {
    this.store = store;
    this.clock = clock;
    this.lineage = lineage;
    this.ingestion = ingestion;
  }

  #append(event) {
    const errors = validateEvent(event);
    if (errors.length) throw new Error(`事件不合法：${errors.join("；")}`);
    return this.store.append(event);
  }

  #nextVersion(aggregateId) {
    return this.store.forAggregate(aggregateId).length + 1;
  }

  /** 已被经质量确认的候选序列覆盖的全部输入批次（视为已履行复核义务）。 */
  #confirmedBatchIds() {
    const ids = new Set();
    for (const proposed of this.store.ofType("CANDIDATE_SERIES_PROPOSED").map((e) => e.payload)) {
      const confirmed = this.store
        .forAggregate(proposed.series_id)
        .some((e) => e.event_type === "QUALITY_CONFIRMED");
      if (confirmed) {
        for (const p of proposed.points) for (const id of p.input_batch_ids) ids.add(id);
      }
    }
    return ids;
  }

  // -- 输入甄别 -----------------------------------------------------------

  /**
   * 计算指标在指定期的“有效批次集合”：
   * - 落在更正链上被取代的批次剔除；
   * - 冲突已裁决的败出批次剔除；
   * - 未决冲突的期打标记，对应点位留空待裁决后重算。
   */
  #liveInputs(indicatorId, periods) {
    const batches = this.ingestion.allBatches(indicatorId);
    const superseded = new Set(
      batches.filter((b) => b.supersedes_batch_id).map((b) => b.supersedes_batch_id)
    );
    const conflictLosers = new Set();
    const openConflictPeriods = new Set();
    for (const recorded of this.store.ofType("CONFLICT_RECORDED").map((e) => e.payload)) {
      const resolution = this.store
        .ofType("CONFLICT_RESOLVED")
        .map((e) => e.payload)
        .find((r) => r.conflict_id === recorded.conflict_id);
      if (resolution) {
        for (const id of recorded.batch_ids) if (id !== resolution.winning_batch_id) conflictLosers.add(id);
      } else {
        openConflictPeriods.add(`${recorded.indicator_id}|${recorded.period}`);
      }
    }
    const live = batches.filter((b) => !superseded.has(b.batch_id) && !conflictLosers.has(b.batch_id));
    const periodSet = new Set(periods);
    const inScope = live.filter((b) => b.observations.some((o) => periodSet.has(o.period)));
    const cells = new Map(); // period|geo -> {numerator, denominator, batchIds, sourceIds, conflict}
    for (const b of inScope) {
      for (const o of b.observations) {
        if (!periodSet.has(o.period)) continue;
        const key = `${o.period}|${o.geography_id}`;
        if (!cells.has(key)) {
          cells.set(key, {
            period: o.period,
            source_geography_id: o.geography_id,
            numerator: 0,
            denominator: 0,
            batch_ids: [],
            source_ids: new Set(),
            conflict: false
          });
        }
        const cell = cells.get(key);
        cell.numerator += o.numerator;
        cell.denominator += o.denominator;
        cell.batch_ids.push(b.batch_id);
        cell.source_ids.add(b.source_id);
        if (openConflictPeriods.has(`${indicatorId}|${o.period}`)) cell.conflict = true;
      }
    }
    return { live, cells: [...cells.values()] };
  }

  /** 找出观察值来源区划所属的边界版本（成员命中最多的版本）。 */
  #resolveSourceBoundary(geographyFamilyId, observedGeos) {
    const versions = this.lineage.boundaryVersions(geographyFamilyId);
    if (!versions.length) throw new Error(`边界族 ${geographyFamilyId} 没有任何版本`);
    let best = null;
    let bestHits = -1;
    for (const v of versions) {
      const hits = observedGeos.filter((g) => v.members.includes(g)).length;
      if (hits > bestHits) {
        bestHits = hits;
        best = v;
      }
    }
    if (!best || bestHits === 0) throw new Error("观察值区划不属于已知边界版本的任何成员");
    return { version: best, hits: bestHits, total: observedGeos.length };
  }

  // -- 作业 ---------------------------------------------------------------

  /**
   * 登记并执行计算作业（可安全重复调用：崩溃恢复时续跑，完成后重放无副作用）。
   *
   * @param {object} req
   * @param {string} req.job_id
   * @param {string} req.indicator_id
   * @param {number} req.definition_version
   * @param {string} req.target_boundary_version 例如 "geo-city:2"
   * @param {string[]} req.periods
   * @param {(stepId: string) => void} [req.beforeStep] 故障注入钩子（测试用）：抛错模拟崩溃
   * @returns {{series_id: string, resumed_steps: number, executed_steps: number}}
   */
  runJob(req) {
    const definition = this.lineage.getDefinition(req.indicator_id, req.definition_version);
    const [familyId, targetVersionNum] = req.target_boundary_version.split(":");
    const targetBoundary = this.lineage.getBoundary(familyId, Number(targetVersionNum));
    const periods = [...req.periods].sort();

    // 先做冲突检测：相互冲突且无更正链的来源进入待决队列
    this.ingestion.detectConflicts(req.indicator_id);
    const { live, cells } = this.#liveInputs(req.indicator_id, periods);

    const inputFingerprint = fingerprint({
      indicator_id: req.indicator_id,
      definition_version: req.definition_version,
      target_boundary_version: req.target_boundary_version,
      periods,
      batches: live
        .filter((b) => b.observations.some((o) => periods.includes(o.period)))
        .map((b) => [b.batch_id, b.batch_fingerprint])
        .sort((a, b) => a[0].localeCompare(b[0]))
    });
    const seriesId = `series-${req.indicator_id}-v${req.definition_version}-${req.target_boundary_version.replace(":", "-")}-${inputFingerprint.slice(0, 12)}`;

    // JOB_REGISTERED 幂等
    this.#append({
      event_id: `job-${req.job_id}`,
      event_type: "JOB_REGISTERED",
      aggregate_type: "computation_job",
      aggregate_id: req.job_id,
      occurred_at: this.clock.now(),
      version: 1,
      summary: `登记作业 ${req.job_id}：${req.indicator_id} v${req.definition_version}，期 ${periods.join("、")}，目标边界 ${req.target_boundary_version}`,
      payload: {
        job_id: req.job_id,
        indicator_id: req.indicator_id,
        definition_version: req.definition_version,
        target_boundary_version: req.target_boundary_version,
        periods,
        input_fingerprint: inputFingerprint,
        series_id: seriesId
      }
    });

    const jobEvents = this.store.forAggregate(req.job_id);
    if (jobEvents.some((e) => e.event_type === "JOB_COMPLETED")) {
      return { series_id: seriesId, resumed_steps: 0, executed_steps: 0, already_completed: true };
    }
    const completedSteps = new Set(
      jobEvents.filter((e) => e.event_type === "JOB_STEP_COMPLETED").map((e) => e.payload.step_id)
    );

    // 逐期计算（每个完成的步骤落事件，崩溃后从断点继续）
    const pointByStep = new Map(
      jobEvents.filter((e) => e.event_type === "JOB_STEP_COMPLETED").map((e) => [e.payload.step_id, e.payload.point])
    );
    let resumed = 0;
    let executed = 0;
    for (const period of periods) {
      const stepId = `${req.job_id}:step:${period}`;
      if (completedSteps.has(stepId)) {
        resumed += 1;
        continue;
      }
      req.beforeStep?.(stepId);

      const point = this.#computePeriodPoint({
        indicatorId: req.indicator_id,
        definition,
        period,
        periodCells: cells.filter((c) => c.period === period),
        familyId,
        targetBoundary,
        targetBoundaryVersion: req.target_boundary_version
      });

      const version = this.store.forAggregate(req.job_id).length + 1;
      this.#append({
        event_id: `job-${req.job_id}-step-${period}`,
        event_type: "JOB_STEP_COMPLETED",
        aggregate_type: "computation_job",
        aggregate_id: req.job_id,
        occurred_at: this.clock.now(),
        version,
        summary: `作业 ${req.job_id} 完成期 ${period}（目标区划 ${point.geography_id}）`,
        payload: { job_id: req.job_id, step_id: stepId, period, point }
      });
      pointByStep.set(stepId, point);
      executed += 1;
    }

    const points = periods.map((p) => pointByStep.get(`${req.job_id}:step:${p}`));
    this.#proposeSeries({
      seriesId,
      indicatorId: req.indicator_id,
      definition,
      targetBoundaryVersion: req.target_boundary_version,
      points,
      inputFingerprint
    });

    const version = this.store.forAggregate(req.job_id).length + 1;
    this.#append({
      event_id: `job-${req.job_id}-completed`,
      event_type: "JOB_COMPLETED",
      aggregate_type: "computation_job",
      aggregate_id: req.job_id,
      occurred_at: this.clock.now(),
      version,
      summary: `作业 ${req.job_id} 完成，候选序列 ${seriesId}`,
      payload: { job_id: req.job_id, series_id: seriesId }
    });

    return { series_id: seriesId, resumed_steps: resumed, executed_steps: executed, already_completed: false };
  }

  /** 作业失败登记（故障注入时由调用方捕获后记录断点）。 */
  markJobFailed(jobId, atStepId, message) {
    if (this.store.forAggregate(jobId).some((e) => e.event_type === "JOB_COMPLETED")) return null;
    const version = this.store.forAggregate(jobId).length + 1;
    return this.#append({
      event_id: `job-${jobId}-failed-v${version}`,
      event_type: "JOB_FAILED",
      aggregate_type: "computation_job",
      aggregate_id: jobId,
      occurred_at: this.clock.now(),
      version,
      summary: `作业 ${jobId} 在步骤 ${atStepId} 中断：${message}`,
      payload: { job_id: jobId, failed_at_step: atStepId, message }
    });
  }

  // -- 单期点位 -----------------------------------------------------------

  #computePeriodPoint({ indicatorId, definition, period, periodCells, familyId, targetBoundary, targetBoundaryVersion }) {
    const notes = [];
    const inputBatchIds = [...new Set(periodCells.flatMap((c) => c.batch_ids))];
    const usedSourceIds = [...new Set(periodCells.flatMap((c) => [...c.source_ids]))];
    const conflictCellKeys = [...new Set(periodCells.filter((c) => c.conflict).map((c) => `${indicatorId}|${c.period}`))];
    if (conflictCellKeys.length) notes.push(`存在未决冲突，相关来源不参与计算：${conflictCellKeys.join("、")}`);

    let numerator = 0;
    let denominator = 0;
    let residualNumerator = 0;
    let residualDenominator = 0;
    let usedSchemeId = null;
    let resolvedSourceBoundaryVersion = null;
    let value = null;

    if (periodCells.length === 0) {
      notes.push("该期无任何有效上报数据");
    } else if (periodCells.some((c) => c.conflict)) {
      // 未决冲突：不猜测、不合并任一方，整期置空，裁决后以新作业重算
      notes.push("该期存在未决来源冲突，数值留空，待冲突裁决后重算");
      value = null;
    } else {
      const observedGeos = [...new Set(periodCells.map((c) => c.source_geography_id))];
      const sourceBoundary = this.#resolveSourceBoundary(familyId, observedGeos);
      resolvedSourceBoundaryVersion = `${familyId}:${sourceBoundary.version.boundary_version}`;

      if (resolvedSourceBoundaryVersion === targetBoundaryVersion) {
        for (const c of periodCells) {
          numerator += c.numerator;
          denominator += c.denominator;
        }
      } else {
        // 分子、分母各查专用换算方案，缺省时回退到同时适用于两者的 "both" 方案
        const bothScheme = this.lineage.findConversionScheme(indicatorId, resolvedSourceBoundaryVersion, targetBoundaryVersion, "both");
        const numScheme = this.lineage.findConversionScheme(indicatorId, resolvedSourceBoundaryVersion, targetBoundaryVersion, "numerator") ?? bothScheme;
        const denScheme = this.lineage.findConversionScheme(indicatorId, resolvedSourceBoundaryVersion, targetBoundaryVersion, "denominator") ?? bothScheme;

        if (!numScheme || !denScheme) {
          notes.push(`缺少 ${resolvedSourceBoundaryVersion}→${targetBoundaryVersion} 的完整跨边界换算方案（分子/分母），点位无法计算`);
        } else {
          usedSchemeId = [numScheme.scheme_id, denScheme.scheme_id].filter((x, i, a) => a.indexOf(x) === i).join("+");
          const numCounts = Object.fromEntries(periodCells.map((c) => [c.source_geography_id, c.numerator]));
          const denCounts = Object.fromEntries(periodCells.map((c) => [c.source_geography_id, c.denominator]));
          const numResult = this.lineage.applyConversion(numScheme, numCounts);
          const denResult = this.lineage.applyConversion(denScheme, denCounts);
          // 汇总到目标边界成员（合并后可能是单个新成员，也可能多对多）
          for (const geo of targetBoundary.members) {
            numerator += numResult.allocated[geo] ?? 0;
            denominator += denResult.allocated[geo] ?? 0;
          }
          residualNumerator = numResult.residual;
          residualDenominator = denResult.residual;
          if (residualNumerator + residualDenominator > 0) {
            notes.push(
              `跨边界换算残差：分子 ${residualNumerator}、分母 ${residualDenominator} 无法分摊（来源明细：${JSON.stringify(numResult.perSourceResidual)} / ${JSON.stringify(denResult.perSourceResidual)}）`
            );
          }
        }
      }
      value = computeValue(definition.formula, numerator, denominator);
      if (value === null) notes.push("分母为零或非有限值，公式无定义");
    }

    // 质量规则证据
    const expiredSources = usedSourceIds.filter((id) => this.ingestion.isExpired(id));
    // 已被某条经质量确认的候选序列覆盖的批次视为已履行复核义务
    const confirmedBatchIds = this.#confirmedBatchIds();
    const overdueBatches = inputBatchIds.filter((id) => {
      if (confirmedBatchIds.has(id)) return false;
      const b = this.ingestion.getBatch(id);
      return this.clock.isDue(b.review_deadline);
    });
    const openConflicts = this.store.ofType("CONFLICT_RECORDED").map((e) => e.payload).filter((c) =>
      !this.store.ofType("CONFLICT_RESOLVED").some((r) => r.payload.conflict_id === c.conflict_id)
    );
    const ruleEvals = evaluateRules(definition.quality_rules, {
      numerator,
      denominator,
      residualNumerator,
      residualDenominator,
      expiredSources,
      overdueBatches,
      nowIso: this.clock.now(),
      conflictCellKeys,
      conflicts: openConflicts
    });
    const quality_rule_results = {};
    for (const [id, r] of Object.entries(ruleEvals)) {
      quality_rule_results[id] = r.passed;
      if (!r.passed) notes.push(`质量规则 ${id} 未通过：${r.evidence}`);
    }

    return {
      period,
      geography_id: targetBoundary.geography_id,
      value,
      numerator,
      denominator,
      unallocated_residual_numerator: residualNumerator,
      unallocated_residual_denominator: residualDenominator,
      input_batch_ids: inputBatchIds,
      conversion_scheme_id: usedSchemeId,
      source_boundary_version: resolvedSourceBoundaryVersion,
      target_boundary_version: targetBoundaryVersion,
      quality_rule_results,
      notes
    };
  }

  #proposeSeries({ seriesId, indicatorId, definition, targetBoundaryVersion, points, inputFingerprint }) {
    // 幂等：相同输入指纹的候选序列已存在则不重复产出
    if (this.store.forAggregate(seriesId).length) return;
    this.#append({
      event_id: `candidate-${seriesId}`,
      event_type: "CANDIDATE_SERIES_PROPOSED",
      aggregate_type: "candidate_series",
      aggregate_id: seriesId,
      occurred_at: this.clock.now(),
      version: 1,
      summary: `候选序列 ${seriesId}：${points.length} 个年度点，自动计算产物，待质量确认与用途批准`,
      payload: {
        series_id: seriesId,
        indicator_id: indicatorId,
        definition_version: definition.definition_version,
        denominator_definition_version: definition.denominator_definition_version,
        boundary_version: targetBoundaryVersion,
        applicable_population: definition.applicable_population,
        formula: definition.formula,
        points,
        input_fingerprint: inputFingerprint,
        superseded_by: null,
        quality_confirmed: false,
        use_approved: false,
        proposed_at: this.clock.now()
      }
    });

    // 自动质量复核留痕（证据摘要）
    this.#append({
      event_id: `quality-${seriesId}-auto`,
      event_type: "QUALITY_REVIEWED",
      aggregate_type: "candidate_series",
      aggregate_id: seriesId,
      occurred_at: this.clock.now(),
      version: 2,
      summary: `自动质量评估完成：${points.every((p) => Object.values(p.quality_rule_results).every(Boolean)) ? "全部点位通过" : "存在未通过点位，需统计负责人研判"}`,
      payload: {
        series_id: seriesId,
        automatic: true,
        per_period: points.map((p) => ({
          period: p.period,
          rules: p.quality_rule_results,
          notes: p.notes
        }))
      }
    });
  }

  // -- 查询 ---------------------------------------------------------------

  getSeries(seriesId) {
    const events = this.store.forAggregate(seriesId);
    const event = events.find((e) => e.event_type === "CANDIDATE_SERIES_PROPOSED");
    if (!event) throw new Error(`候选序列 ${seriesId} 不存在`);
    let series = { ...event.payload };
    const superseded = events.find((e) => e.event_type === "CANDIDATE_SERIES_SUPERSEDED");
    if (superseded) series.superseded_by = superseded.payload.new_series_id;
    if (events.some((e) => e.event_type === "QUALITY_CONFIRMED")) series.quality_confirmed = true;
    if (events.some((e) => e.event_type === "USE_APPROVED")) series.use_approved = true;
    return series;
  }

  /** 某指标的全部候选序列（按提出时间升序）。 */
  listSeries(indicatorId) {
    return this.store
      .ofType("CANDIDATE_SERIES_PROPOSED")
      .map((e) => this.getSeries(e.payload.series_id))
      .filter((s) => s.indicator_id === indicatorId);
  }

  /** 最新一版候选序列。 */
  latestSeries(indicatorId) {
    return this.listSeries(indicatorId).at(-1) ?? null;
  }

  /**
   * 迟到补报后重算并取代未发布的候选序列。
   * 已冻结序列不重算、不改写；其修订影响由发布服务追加。
   * @param {object} req
   * @param {string} req.indicatorId
   * @param {number} req.definitionVersion
   * @param {string} req.targetBoundaryVersion
   * @param {string[]} req.periods
   * @param {string} req.newJobId
   * @param {string} [req.supersededSeriesId] 指定被取代的序列；缺省取最新未冻结序列
   * @param {string} [req.reason] 取代原因
   * @returns {{new_series_id: string, superseded_series_id: string} | null}
   */
  recomputeAfterLateReport(req) {
    const frozenSeriesIds = new Set(
      this.store
        .ofType("RELEASE_FROZEN")
        .flatMap((e) => Object.keys(e.payload.snapshot))
    );
    let target;
    if (req.supersededSeriesId) {
      target = this.getSeries(req.supersededSeriesId);
      if (frozenSeriesIds.has(target.series_id)) {
        throw new Error(`${target.series_id} 已冻结发布，不能重算改写；请对冻结包追加修订`);
      }
    } else {
      target = this.listSeries(req.indicatorId)
        .filter((s) => !frozenSeriesIds.has(s.series_id) && s.superseded_by === null)
        .at(-1);
    }
    if (!target) return null;

    const result = this.runJob({
      job_id: req.newJobId,
      indicator_id: req.indicatorId,
      definition_version: req.definitionVersion,
      target_boundary_version: req.targetBoundaryVersion,
      periods: req.periods
    });
    this.supersedeSeries(target.series_id, result.series_id, req.reason ?? "late_report_recompute");
    return { new_series_id: result.series_id, superseded_series_id: target.series_id };
  }

  /** 标记旧候选序列被新序列取代（仅限未冻结序列）。 */
  supersedeSeries(oldSeriesId, newSeriesId, reason) {
    const frozenIds = new Set(this.store.ofType("RELEASE_FROZEN").flatMap((e) => Object.keys(e.payload.snapshot)));
    if (frozenIds.has(oldSeriesId)) {
      throw new Error(`${oldSeriesId} 已冻结发布，不能被取代；修订只能追加到冻结包`);
    }
    if (this.store.forAggregate(oldSeriesId).some((e) => e.event_type === "CANDIDATE_SERIES_SUPERSEDED")) {
      throw new Error(`${oldSeriesId} 已被取代`);
    }
    const version = this.store.forAggregate(oldSeriesId).length + 1;
    return this.#append({
      event_id: `candidate-${oldSeriesId}-superseded-by-${newSeriesId.slice(-12)}`,
      event_type: "CANDIDATE_SERIES_SUPERSEDED",
      aggregate_type: "candidate_series",
      aggregate_id: oldSeriesId,
      occurred_at: this.clock.now(),
      version,
      summary: `候选序列 ${oldSeriesId} 被 ${newSeriesId} 取代（${reason}；未发布，安全替换）`,
      payload: { series_id: oldSeriesId, new_series_id: newSeriesId, reason }
    });
  }
}
