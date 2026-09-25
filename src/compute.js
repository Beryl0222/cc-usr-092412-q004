import { definitionForPeriod } from "./definitions.js";
import { findScheme, convertValues } from "./boundaries.js";
import { activeBatches } from "./observations.js";
import { evaluateFormula } from "./formula.js";
import { candidateKey } from "./state.js";
import { groupBy, requireFields } from "./util.js";

/**
 * 候选序列计算。
 *
 * 自动计算只产出"候选"条目，绝不直接发布。计算按期间逐个进行，
 * 每个期间的完成都先落事件再推进——故障后重放日志即可知道哪些期间
 * 已完成，恢复时只补算缺口，不重复计算、不重复发布。
 */

/** 只建任务不计算；与 resumeComputation 配合可逐期推进、随时中断恢复。 */
export function openComputation(ctx, { job_id, indicator_id, periods, review_window_days = 30 }) {
  requireFields({ job_id, indicator_id, periods }, ["job_id", "indicator_id", "periods"]);
  if (!ctx.state.jobs.has(job_id)) {
    const reviewDueAt = new Date(ctx.clock.nowMs() + review_window_days * 86400000).toISOString();
    ctx.emit(
      "COMPUTATION_JOB_STARTED",
      "candidate_series",
      job_id,
      `启动计算任务 ${job_id}（${indicator_id}，${periods.length} 个期间）`,
      { job_id, indicator_id, periods, review_due_at: reviewDueAt },
      `job:${job_id}`,
    );
  }
  return ctx.state.jobs.get(job_id);
}

/** 建任务并立即补算全部缺口。 */
export function startComputation(ctx, input) {
  openComputation(ctx, input);
  return resumeComputation(ctx, input.job_id);
}

/** 补算任务中尚未计算的期间；已完成的期间一律跳过（恢复安全）。 */
export function resumeComputation(ctx, jobId) {
  const job = ctx.state.jobs.get(jobId);
  if (!job) throw new Error(`未知计算任务：${jobId}`);
  const computed = [];
  for (const period of job.periods) {
    if (ctx.state.candidates.has(candidateKey(job.indicator_id, period))) continue;
    computePeriod(ctx, job.indicator_id, period, jobId);
    computed.push(period);
  }
  return {
    job_id: jobId,
    computed,
    remaining: job.periods.filter((p) => !ctx.state.candidates.has(candidateKey(job.indicator_id, p))),
  };
}

/** 只推进一个期间，返回该期间条目；无缺口时返回 null。用于断点续算演练。 */
export function computeNextPeriod(ctx, jobId) {
  const job = ctx.state.jobs.get(jobId);
  if (!job) throw new Error(`未知计算任务：${jobId}`);
  const next = job.periods.find((p) => !ctx.state.candidates.has(candidateKey(job.indicator_id, p)));
  if (!next) return null;
  return computePeriod(ctx, job.indicator_id, next, jobId);
}

/** 重算满足条件的已有条目（迟到补报、换算方案落地、口径获批后触发）。 */
export function recomputeWhere(ctx, predicate) {
  const recomputed = [];
  for (const entry of [...ctx.state.candidates.values()]) {
    if (predicate(entry)) {
      computePeriod(ctx, entry.indicator_id, entry.period, null);
      recomputed.push(candidateKey(entry.indicator_id, entry.period));
    }
  }
  return recomputed;
}

/**
 * 计算单个期间的候选条目。无论成功与否都落 CANDIDATE_COMPUTED 事件，
 * 条目的 status 区分：candidate / no_definition / no_data /
 * missing_conversion / pending_conflict。
 */
export function computePeriod(ctx, indicatorId, period, jobId = null) {
  const key = candidateKey(indicatorId, period);
  const seq = (ctx.state.candidateSeqs.get(key) ?? 0) + 1;
  const base = { indicator_id: indicatorId, period };
  let entry;

  const def = definitionForPeriod(ctx.state, indicatorId, period);
  if (!def) {
    entry = { ...base, status: "no_definition", value: null };
  } else {
    const batches = activeBatches(ctx.state, indicatorId, period);
    if (batches.length === 0) {
      entry = { ...base, status: "no_data", value: null, definition_version: def.version };
    } else {
      entry = computeWithDefinition(ctx, def, base, batches);
    }
  }

  ctx.emit(
    "CANDIDATE_COMPUTED",
    "candidate_series",
    `${indicatorId}:${period}`,
    `计算候选条目 ${indicatorId} ${period}（第 ${seq} 次，${entry.status}）`,
    { entry, job_id: jobId },
    `compute:${indicatorId}:${period}:${seq}`,
  );
  return entry;
}

function computeWithDefinition(ctx, def, base, batches) {
  const byBoundary = groupBy(batches, (b) => b.boundary_basis);
  let num = 0;
  let den = 0;
  const residual = { num: 0, den: 0 };
  const schemesUsed = [];
  const batchIds = [];

  for (const [basis, group] of byBoundary) {
    batchIds.push(...group.map((b) => b.batch_id));
    const values = {};
    for (const b of group) values[b.region_id] = { num: b.num, den: b.den };

    if (basis === def.boundary_basis) {
      for (const v of Object.values(values)) {
        num += v.num;
        den += v.den;
      }
      continue;
    }

    const { scheme, pendingConflict } = findScheme(ctx.state, basis, def.boundary_basis);
    if (pendingConflict) {
      return {
        ...base,
        status: "pending_conflict",
        value: null,
        definition_version: def.version,
        needed_conversion: { from: basis, to: def.boundary_basis },
        conflict_id: pendingConflict.conflict_id,
        batch_ids: batchIds,
      };
    }
    if (!scheme) {
      return {
        ...base,
        status: "missing_conversion",
        value: null,
        definition_version: def.version,
        needed_conversion: { from: basis, to: def.boundary_basis },
        batch_ids: batchIds,
      };
    }
    const converted = convertValues(scheme, values);
    if (!converted.conserved) {
      throw new Error(`换算方案 ${scheme.scheme_id} 不守恒，已中止计算`);
    }
    for (const v of Object.values(converted.values)) {
      num += v.num;
      den += v.den;
    }
    residual.num += converted.residual.num;
    residual.den += converted.residual.den;
    schemesUsed.push({
      scheme_id: scheme.scheme_id,
      from_boundary: basis,
      to_boundary: def.boundary_basis,
      residual: converted.residual,
    });
  }

  let value = null;
  const flags = [];
  try {
    const raw = evaluateFormula(def.formula, { num, den });
    if (Number.isFinite(raw)) {
      value = raw;
    } else {
      flags.push({ kind: "formula_not_finite", message: "公式结果非有限值（如分母为零）" });
    }
  } catch (err) {
    flags.push({ kind: "formula_error", message: err.message });
  }

  const coverage = regionCoverage(ctx, base.indicator_id, base.period, batches);
  flags.push(...evaluateQualityRules(def.quality_rules ?? [], { num, den, residual, coverage }));

  return {
    ...base,
    status: "candidate",
    value,
    num,
    den,
    residual,
    definition_version: def.version,
    boundary_basis: def.boundary_basis,
    schemes_used: schemesUsed,
    batch_ids: batchIds,
    coverage,
    quality_flags: flags,
  };
}

function regionCoverage(ctx, indicatorId, period, batches) {
  const expected = new Set();
  for (const s of ctx.state.sources.values()) {
    if (s.indicator_id === indicatorId && s.period === period) {
      for (const r of s.regions) expected.add(r);
    }
  }
  if (expected.size === 0) return 1;
  const reported = new Set(batches.map((b) => b.region_id));
  const hit = [...expected].filter((r) => reported.has(r)).length;
  return hit / expected.size;
}

/** 质量规则：分母下限、残差占比上限、地区覆盖率下限。 */
export function evaluateQualityRules(rules, { num, den, residual, coverage }) {
  const flags = [];
  for (const rule of rules) {
    if (rule.kind === "min_denominator" && den < rule.threshold) {
      flags.push({ rule_id: rule.rule_id, kind: rule.kind, message: `分母 ${den} 低于下限 ${rule.threshold}` });
    }
    if (rule.kind === "max_residual_ratio" && den > 0 && residual.den / den > rule.threshold) {
      flags.push({
        rule_id: rule.rule_id,
        kind: rule.kind,
        message: `未分摊残差占分母 ${(residual.den / den).toFixed(4)}，超过上限 ${rule.threshold}`,
      });
    }
    if (rule.kind === "min_coverage" && coverage < rule.threshold) {
      flags.push({ rule_id: rule.rule_id, kind: rule.kind, message: `地区覆盖率 ${coverage} 低于下限 ${rule.threshold}` });
    }
  }
  return flags;
}
