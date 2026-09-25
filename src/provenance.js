/**
 * 血缘追溯与可比性判定服务（只读）。
 *
 * 评估人员可以：
 * - explainValue：查任意数值采用的口径版本、边界、换算方案、输入批次、
 *   数据源有效期与完整批准链；
 * - compareSeries：判断两段时间序列为何可比或不可比，逐条给出理由。
 */
export class ProvenanceService {
  /**
   * @param {import("./event-store.js").EventStore} store
   * @param {import("./lineage.js").LineageService} lineage
   * @param {import("./ingestion.js").IngestionService} ingestion
   * @param {import("./computation.js").ComputationService} computation
   * @param {import("./publication.js").PublicationService} publication
   */
  constructor(store, lineage, ingestion, computation, publication) {
    this.store = store;
    this.lineage = lineage;
    this.ingestion = ingestion;
    this.computation = computation;
    this.publication = publication;
  }

  /**
   * 追溯候选序列某一期数值的完整血缘。
   * @returns {object}
   */
  explainValue(seriesId, period) {
    const series = this.computation.getSeries(seriesId);
    const point = series.points.find((p) => p.period === period);
    if (!point) throw new Error(`序列 ${seriesId} 不存在期 ${period} 的点位`);

    const definition = this.lineage.getDefinition(series.indicator_id, series.definition_version);

    // 输入批次与来源
    const batches = point.input_batch_ids.map((id) => {
      const b = this.ingestion.getBatch(id);
      const source = this.ingestion.getDataSource(b.source_id);
      return {
        batch_id: b.batch_id,
        source_id: b.source_id,
        source_name: source.name,
        is_late: b.is_late,
        supersedes_batch_id: b.supersedes_batch_id,
        submitted_at: b.submitted_at,
        review_deadline: b.review_deadline,
        source_expires_at: source.expires_at,
        batch_fingerprint: b.batch_fingerprint
      };
    });

    // 换算方案及残差守恒证据
    let conversion = null;
    if (point.conversion_scheme_id) {
      conversion = point.conversion_scheme_id.split("+").map((id) => {
        const scheme = this.lineage.getConversionScheme(id);
        return {
          scheme_id: id,
          from: scheme.from_boundary_version,
          to: scheme.to_boundary_version,
          component: scheme.component,
          basis: scheme.basis,
          residual_policy: scheme.residual_policy,
          mapping_count: scheme.mappings.length
        };
      });
    }

    // 批准链
    const seriesEvents = this.store.forAggregate(seriesId);
    const approvalChain = {
      proposed: seriesEvents.find((e) => e.event_type === "CANDIDATE_SERIES_PROPOSED")?.occurred_at ?? null,
      automatic_quality_review: seriesEvents.find((e) => e.event_type === "QUALITY_REVIEWED")?.payload ?? null,
      quality_confirmed: seriesEvents.find((e) => e.event_type === "QUALITY_CONFIRMED")?.payload ?? null,
      use_approved: seriesEvents.find((e) => e.event_type === "USE_APPROVED")?.payload ?? null
    };

    // 冻结包（若已发布）
    const frozenIn = this.store
      .ofType("RELEASE_FROZEN")
      .filter((e) => e.payload.snapshot[seriesId])
      .map((e) => ({
        release_id: e.payload.release_id,
        planning_review_id: e.payload.planning_review_id,
        frozen_at: e.payload.frozen_at,
        snapshot_hash: e.payload.snapshot_hash
      }));

    return {
      indicator_id: series.indicator_id,
      period,
      value: point.value,
      formula: definition.formula,
      definition: {
        version: definition.definition_version,
        predecessor_version: definition.predecessor_version,
        numerator_source: definition.numerator_source,
        denominator_source: definition.denominator_source,
        denominator_definition_version: definition.denominator_definition_version,
        applicable_population: definition.applicable_population,
        quality_rules: definition.quality_rules,
        change_note: definition.change_note,
        effective_from: definition.effective_from
      },
      boundary: {
        source: point.source_boundary_version,
        target: point.target_boundary_version,
        converted_with: conversion
      },
      counts: {
        numerator: point.numerator,
        denominator: point.denominator,
        unallocated_residual_numerator: point.unallocated_residual_numerator ?? 0,
        unallocated_residual_denominator: point.unallocated_residual_denominator ?? 0
      },
      quality_rule_results: point.quality_rule_results,
      input_batches: batches,
      input_fingerprint: series.input_fingerprint,
      approval_chain: approvalChain,
      frozen_in: frozenIn,
      notes: point.notes
    };
  }

  /**
   * 比较两段序列（可分别限定期段）的可比性。
   * @param {string} seriesIdA
   * @param {string} seriesIdB
   * @returns {{comparable: boolean, converted: boolean, reasons: string[], residual_rates: object}}
   */
  compareSeries(seriesIdA, seriesIdB) {
    const a = this.computation.getSeries(seriesIdA);
    const b = this.computation.getSeries(seriesIdB);
    const reasons = [];
    let comparable = true;
    let converted = false;

    if (a.indicator_id !== b.indicator_id) {
      comparable = false;
      reasons.push(`指标不同：${a.indicator_id} vs ${b.indicator_id}`);
      return { comparable, converted, reasons, residual_rates: {} };
    }

    // 1) 口径版本
    if (a.definition_version === b.definition_version) {
      reasons.push(`口径版本一致（v${a.definition_version}）`);
    } else {
      const defA = this.lineage.getDefinition(a.indicator_id, a.definition_version);
      const defB = this.lineage.getDefinition(a.indicator_id, b.definition_version);
      const diffs = [];
      if (defA.formula !== defB.formula) diffs.push(`公式 ${defA.formula}→${defB.formula}`);
      if (defA.numerator_source !== defB.numerator_source) diffs.push("分子来源修订");
      if (defA.denominator_definition_version !== defB.denominator_definition_version) {
        diffs.push(`分母定义修订（${defA.denominator_definition_version}→${defB.denominator_definition_version}）`);
      }
      if (defA.applicable_population !== defB.applicable_population) diffs.push("适用人群修订");
      if (diffs.length) {
        comparable = false;
        reasons.push(`口径版本 v${a.definition_version}→v${b.definition_version} 存在语义断裂：${diffs.join("；")}`);
      } else {
        reasons.push(`口径版本 v${a.definition_version}→v${b.definition_version} 仅文档性差异，语义连续（谱系 predecessor=${defB.predecessor_version}）`);
      }
    }

    // 2) 边界（逐点检查换算）
    const residualRates = {};
    const pointsA = a.points;
    const pointsB = b.points;
    for (const p of [...pointsA, ...pointsB]) {
      if (p.source_boundary_version && p.target_boundary_version && p.source_boundary_version !== p.target_boundary_version) {
        if (p.conversion_scheme_id) {
          converted = true;
          const base = p.numerator + p.denominator;
          const residual = (p.unallocated_residual_numerator ?? 0) + (p.unallocated_residual_denominator ?? 0);
          const rate = base + residual > 0 ? residual / (base + residual) : 0;
          residualRates[p.period] = Number(rate.toFixed(6));
          reasons.push(
            `${p.period} 经有依据的换算方案 ${p.conversion_scheme_id} 由 ${p.source_boundary_version} 折算到 ${p.target_boundary_version}，残差率 ${(rate * 100).toFixed(2)}%（守恒：分摊+残差=输入总量）`
          );
          if (rate > 0.05) {
            comparable = false;
            reasons.push(`${p.period} 残差率超过 5% 容忍线，换算后数值不足以支撑跨期比较`);
          }
        } else {
          comparable = false;
          reasons.push(`${p.period} 来源边界 ${p.source_boundary_version} 与目标边界 ${p.target_boundary_version} 之间没有换算方案，曲线在该年断点、不可比`);
        }
      }
    }
    if (!converted && a.boundary_version === b.boundary_version) {
      reasons.push(`地域边界一致（${a.boundary_version}），未发生跨边界换算`);
    }
    if (a.boundary_version !== b.boundary_version) {
      reasons.push(`两段序列的发布边界不同：${a.boundary_version} vs ${b.boundary_version}（需依赖各点的换算证据衔接）`);
      if (!converted) {
        comparable = false;
        reasons.push("两段之间没有任何点位留下跨边界换算证据，无法把不同地域边界上的曲线接起来");
      }
    }

    // 3) 数据状态：未决冲突 / 被取代 / 质量规则
    for (const [tag, s] of [["前段", a], ["后段", b]]) {
      for (const p of s.points) {
        if (Object.entries(p.quality_rule_results).some(([, passed]) => !passed)) {
          reasons.push(`${tag} ${p.period} 存在未通过的质量规则（详见血缘 notes），比较结论需谨慎`);
        }
      }
      if (s.superseded_by) reasons.push(`${tag}序列 ${s.series_id} 已被 ${s.superseded_by} 取代（迟到补报重算），比较应使用后继序列`);
    }

    if (comparable && !reasons.some((r) => r.includes("谨慎"))) {
      reasons.unshift(converted ? "结论：可比（经由守恒换算，残差已披露）" : "结论：可比（同一口径、同一边界）");
    } else if (comparable) {
      reasons.unshift("结论：有条件可比（换算成立但存在质量提示）");
    } else {
      reasons.unshift("结论：不可比");
    }
    return { comparable, converted, reasons: [...new Set(reasons)], residual_rates: residualRates };
  }
}
