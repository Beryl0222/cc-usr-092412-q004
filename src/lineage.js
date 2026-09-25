import { findVersion } from "./definitions.js";
import { findScheme } from "./boundaries.js";
import { candidateKey } from "./state.js";

/**
 * 谱系查询与可比性判断。
 *
 * 评估人员对任意一个数值都能追问四个问题：用了哪版口径、站在哪套边界、
 * 吃了哪些输入批次、经过怎样的批准链；对任意两个期间都能得到
 * "可比 / 可比但有保留 / 不可比"的结论及原因。
 */

/** 取某期间的展示条目：优先已冻结发布包中的快照，否则取当前候选。 */
function entryFor(state, indicatorId, period) {
  let frozen = null;
  for (const rel of state.releases.values()) {
    if (rel.indicator_id !== indicatorId || !rel.periods.includes(period)) continue;
    if (!frozen || rel.frozen_at > frozen.frozen_at) frozen = rel;
  }
  if (frozen) {
    return { source: "release", release: frozen, entry: frozen.entries.find((e) => e.period === period) };
  }
  const candidate = state.candidates.get(candidateKey(indicatorId, period));
  return candidate ? { source: "candidate", entry: candidate } : null;
}

export function explainValue(ctx, { indicator_id, period }) {
  const found = entryFor(ctx.state, indicator_id, period);
  if (!found) throw new Error(`指标 ${indicator_id} 在 ${period} 没有任何数值`);
  const { entry } = found;

  const def = entry.definition_version
    ? findVersion(ctx.state, indicator_id, entry.definition_version)
    : null;
  const batches = (entry.batch_ids ?? []).map((id) => {
    const b = ctx.state.batches.get(id);
    return b
      ? { batch_id: id, source_id: b.source_id, region_id: b.region_id, submitted_at: b.submitted_at, is_late: b.is_late }
      : { batch_id: id, missing: true };
  });

  let approvalChain = null;
  let revisions = [];
  if (found.source === "release") {
    const rel = found.release;
    approvalChain = {
      quality_review: rel.quality_review,
      usage_approval: rel.usage_approval,
      frozen_by: rel.frozen_by,
      frozen_at: rel.frozen_at,
      review_id: rel.review_id,
    };
    revisions = ctx.state.revisions.get(rel.release_id) ?? [];
  }

  return {
    indicator_id,
    period,
    status: found.source === "release" ? "frozen" : entry.status,
    value: entry.value,
    caliber: def
      ? {
          definition_version: def.version,
          formula: def.formula,
          numerator_source: def.numerator_source,
          denominator_source: def.denominator_source,
          population: def.population,
          quality_rules: def.quality_rules ?? [],
        }
      : null,
    boundary: {
      basis: entry.boundary_basis ?? null,
      schemes_used: entry.schemes_used ?? [],
      residual: entry.residual ?? null,
    },
    batches,
    approval_chain: approvalChain,
    revisions,
  };
}

/**
 * 比较同一指标两个期间的可比性。
 * 返回 { verdict, reasons }，verdict ∈ comparable / comparable_with_caveats / not_comparable。
 */
export function comparePeriods(ctx, { indicator_id, period_a, period_b }) {
  const a = entryFor(ctx.state, indicator_id, period_a);
  const b = entryFor(ctx.state, indicator_id, period_b);
  if (!a || !b) throw new Error("两个期间都必须已有数值才能比较");
  const reasons = [];

  // 1. 口径版本
  if (a.entry.definition_version === b.entry.definition_version) {
    reasons.push({ level: "ok", message: `口径版本一致（v${a.entry.definition_version}）` });
  } else {
    const newer = findVersion(ctx.state, indicator_id, b.entry.definition_version);
    const link = newer?.supersedes;
    if (link && link.version === a.entry.definition_version) {
      reasons.push(
        link.comparable
          ? { level: "caveat", message: `口径 v${link.version} → v${newer.version} 已声明可比：${link.note}` }
          : { level: "break", message: `口径 v${link.version} → v${newer.version} 声明不可比：${link.note}` },
      );
    } else {
      reasons.push({
        level: "break",
        message: `口径版本 v${a.entry.definition_version} 与 v${b.entry.definition_version} 之间未声明可比关系`,
      });
    }
  }

  // 2. 地域边界
  if (a.entry.boundary_basis === b.entry.boundary_basis) {
    reasons.push({ level: "ok", message: `地域边界一致（${a.entry.boundary_basis}）` });
  } else {
    const { scheme } = findScheme(ctx.state, a.entry.boundary_basis, b.entry.boundary_basis);
    if (scheme) {
      reasons.push({
        level: "caveat",
        message: `边界 ${a.entry.boundary_basis} → ${b.entry.boundary_basis} 经方案 ${scheme.scheme_id} 守恒换算，未分摊残差已说明`,
      });
    } else {
      reasons.push({
        level: "break",
        message: `边界 ${a.entry.boundary_basis} 与 ${b.entry.boundary_basis} 之间没有已采纳的换算方案`,
      });
    }
  }

  // 3. 质量标记
  for (const [label, e] of [[period_a, a.entry], [period_b, b.entry]]) {
    for (const flag of e.quality_flags ?? []) {
      reasons.push({ level: "caveat", message: `期间 ${label} 存在质量标记：${flag.message}` });
    }
  }

  const verdict = reasons.some((r) => r.level === "break")
    ? "not_comparable"
    : reasons.some((r) => r.level === "caveat")
      ? "comparable_with_caveats"
      : "comparable";
  return { indicator_id, period_a, period_b, verdict, reasons };
}
