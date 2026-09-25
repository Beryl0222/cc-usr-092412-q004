import { requireFields } from "./util.js";

/**
 * 地区边界换算。
 *
 * 行政区划合并、拆分通过"有依据的换算方案"进行：方案必须附依据（evidence），
 * 且必须守恒——每个来源地区分摊出去的权重合计不得超过 1；不足 1 的部分
 * 是无法分摊的残差，必须逐地区说明去向。相互冲突的方案不自动生效，
 * 留在待决队列，由负责人裁决。
 */

export const EPS = 1e-9;

export function adoptConversionScheme(ctx, input) {
  requireFields(input, ["scheme_id", "kind", "from_boundary", "to_boundary", "mappings", "evidence"]);
  if (!["merge", "split", "redistrict"].includes(input.kind)) {
    throw new Error(`未知换算类型：${input.kind}`);
  }
  validateMappings(input.mappings, input.residuals ?? []);

  const conflictWith = findConflict(ctx.state, input);
  if (conflictWith) {
    const conflictId = `conflict:${input.scheme_id}`;
    ctx.emit(
      "CONVERSION_CONFLICT_QUEUED",
      "boundary_conversion",
      conflictId,
      `换算方案 ${input.scheme_id} 与已采纳方案 ${conflictWith.scheme_id} 冲突，转入待决队列`,
      { conflict_id: conflictId, pending_scheme: input, existing_scheme_id: conflictWith.scheme_id },
    );
    return { status: "queued", conflict_id: conflictId };
  }

  ctx.emit(
    "CONVERSION_SCHEME_ADOPTED",
    "boundary_conversion",
    input.scheme_id,
    `采纳换算方案 ${input.scheme_id}（${input.from_boundary} → ${input.to_boundary}）`,
    { ...input },
  );
  return { status: "adopted", scheme_id: input.scheme_id };
}

export function resolveConflict(ctx, { conflict_id, winning_scheme_id, resolved_by, note }) {
  const conflict = ctx.state.conflicts.get(conflict_id);
  if (!conflict) throw new Error(`未知待决冲突：${conflict_id}`);
  if (conflict.status !== "pending") return conflict; // 幂等：已裁决不重复处理
  if (![conflict.pending_scheme_id, conflict.existing_scheme_id].includes(winning_scheme_id)) {
    throw new Error("胜出的方案必须是冲突双方之一");
  }
  ctx.emit(
    "CONVERSION_CONFLICT_RESOLVED",
    "boundary_conversion",
    conflict_id,
    `裁决换算冲突 ${conflict_id}：采用 ${winning_scheme_id}`,
    { conflict_id, winning_scheme_id, resolved_by, note },
  );
  return ctx.state.conflicts.get(conflict_id);
}

/**
 * 守恒校验：每个来源地区的分摊权重合计 ∈ (0, 1]；
 * 合计不足 1 的残差必须带有文字说明，超过 1 直接拒绝。
 */
function validateMappings(mappings, residuals) {
  if (!Array.isArray(mappings) || mappings.length === 0) throw new Error("换算映射不能为空");
  const allocatedByFrom = new Map();
  for (const m of mappings) {
    requireFields(m, ["from_region", "to_region", "weight"]);
    if (!(m.weight > 0 && m.weight <= 1)) {
      throw new Error(`权重必须在 (0,1] 区间：${m.from_region} → ${m.to_region}`);
    }
    allocatedByFrom.set(m.from_region, (allocatedByFrom.get(m.from_region) ?? 0) + m.weight);
  }
  for (const [from, allocated] of allocatedByFrom) {
    if (allocated > 1 + EPS) {
      throw new Error(`地区 ${from} 分摊权重合计 ${allocated.toFixed(6)}，超过守恒上限 1`);
    }
    const residual = 1 - allocated;
    if (residual > EPS) {
      const explained = residuals.some((r) => r.from_region === from && r.explanation);
      if (!explained) {
        throw new Error(`地区 ${from} 存在未分摊残差 ${residual.toFixed(6)}，必须说明其去向`);
      }
    }
  }
}

/** 已采纳方案中是否存在与待采纳方案覆盖同一来源地区但映射不同的冲突。 */
function findConflict(state, input) {
  for (const s of state.schemes.values()) {
    if (s.status !== "adopted") continue;
    if (s.from_boundary !== input.from_boundary || s.to_boundary !== input.to_boundary) continue;
    for (const m of input.mappings) {
      for (const old of s.mappings) {
        if (old.from_region !== m.from_region) continue;
        if (old.to_region !== m.to_region || Math.abs(old.weight - m.weight) > EPS) return s;
      }
    }
  }
  return null;
}

/** 查询某对边界之间当前可用的换算方案，以及是否存在待决冲突。 */
export function findScheme(state, fromBoundary, toBoundary) {
  let scheme = null;
  for (const s of state.schemes.values()) {
    if (s.status === "adopted" && s.from_boundary === fromBoundary && s.to_boundary === toBoundary) {
      if (!scheme || s.adopted_at > scheme.adopted_at) scheme = s;
    }
  }
  let pendingConflict = null;
  for (const c of state.conflicts.values()) {
    if (c.status !== "pending") continue;
    const pending = state.schemes.get(c.pending_scheme_id);
    if (pending && pending.from_boundary === fromBoundary && pending.to_boundary === toBoundary) {
      pendingConflict = c;
    }
  }
  return { scheme, pendingConflict };
}

/**
 * 按方案把一组来源地区的分子/分母换算到目标边界。
 * 分子分母分别换算，保证率值在新边界下仍可复算。
 * 返回换算结果与残差，并校验守恒：输入合计 = 输出合计 + 残差。
 */
export function convertValues(scheme, valuesByRegion) {
  const out = {};
  const residual = { num: 0, den: 0 };
  for (const [from, v] of Object.entries(valuesByRegion)) {
    const maps = scheme.mappings.filter((m) => m.from_region === from);
    const allocated = maps.reduce((s, m) => s + m.weight, 0);
    for (const m of maps) {
      out[m.to_region] ??= { num: 0, den: 0 };
      out[m.to_region].num += v.num * m.weight;
      out[m.to_region].den += v.den * m.weight;
    }
    residual.num += v.num * (1 - allocated);
    residual.den += v.den * (1 - allocated);
  }
  const sumIn = Object.values(valuesByRegion).reduce((s, v) => s + v.num, 0);
  const sumOut = Object.values(out).reduce((s, v) => s + v.num, 0);
  const conserved = Math.abs(sumIn - (sumOut + residual.num)) < 1e-6;
  return { values: out, residual, conserved };
}
