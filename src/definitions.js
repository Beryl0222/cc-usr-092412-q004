import { requireFields } from "./util.js";

/**
 * 指标口径谱系。
 *
 * 每个指标保存口径的完整版本链：公式、分子分母来源、适用人群、
 * 地域边界与质量规则。版本一经批准不可改写，修订只能登记后继版本；
 * 自第二个版本起，登记时必须声明与上一版本的可比关系（supersedes），
 * 这是评估"两段时间序列为何可比或不可比"的依据之一。
 */

export function registerDefinition(ctx, input) {
  requireFields(input, [
    "indicator_id",
    "formula",
    "numerator_source",
    "denominator_source",
    "population",
    "boundary_basis",
    "effective_from",
    "registered_by",
  ]);
  const existing = ctx.state.definitions.get(input.indicator_id) ?? [];
  const version = existing.length + 1;
  if (version > 1 && !input.supersedes) {
    throw new Error("登记新版本必须声明与上一版本的可比关系（supersedes.comparable 及说明）");
  }
  ctx.emit(
    "DEFINITION_REGISTERED",
    "indicator_definition",
    input.indicator_id,
    `登记口径版本 v${version}（${input.indicator_id}）`,
    { ...input, version },
  );
  return { indicator_id: input.indicator_id, version };
}

export function approveDefinition(ctx, { indicator_id, version, approved_by }) {
  requireFields({ indicator_id, version, approved_by }, ["indicator_id", "version", "approved_by"]);
  const target = findVersion(ctx.state, indicator_id, version);
  if (!target) throw new Error(`指标 ${indicator_id} 不存在口径版本 v${version}`);
  if (target.status === "approved") return target; // 幂等：重复批准不产生新事件
  if (target.status === "superseded") throw new Error("已被取代的版本不能再次批准");
  ctx.emit(
    "DEFINITION_APPROVED",
    "indicator_definition",
    indicator_id,
    `批准口径版本 v${version}（${indicator_id}）`,
    { version, approved_by },
  );
  return findVersion(ctx.state, indicator_id, version);
}

export function findVersion(state, indicatorId, version) {
  return (state.definitions.get(indicatorId) ?? []).find((v) => v.version === version);
}

/**
 * 取某期间实际生效的口径版本：已被批准（含后被取代）且 effective_from 不晚于
 * 该期间的最高版本。未批准版本对计算不可见。
 */
export function definitionForPeriod(state, indicatorId, period) {
  const eligible = (state.definitions.get(indicatorId) ?? []).filter(
    (v) => (v.status === "approved" || v.status === "superseded") && v.effective_from <= period,
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((a, b) => (a.version > b.version ? a : b));
}
