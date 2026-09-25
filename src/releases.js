import { candidateKey } from "./state.js";
import { requireFields } from "./util.js";

/**
 * 发布冻结。
 *
 * 候选序列走向发布必须过两道闸：统计负责人确认质量（QUALITY_REVIEWED pass），
 * 业务负责人批准用途（USAGE_APPROVED，面向某次规划评审）。两者齐备才允许
 * 冻结成发布包；冻结快照不可改写，同一 release_id 重复冻结幂等返回原包。
 * 冻结后若候选序列因迟到补报变化，只向发布包追加修订影响（RELEASE_REVISED）。
 */

export function reviewQuality(ctx, { indicator_id, reviewer, decision, notes }) {
  requireFields({ indicator_id, reviewer, decision }, ["indicator_id", "reviewer", "decision"]);
  if (!["pass", "fail"].includes(decision)) throw new Error("复核结论必须是 pass 或 fail");
  ctx.emit(
    "QUALITY_REVIEWED",
    "candidate_series",
    `${indicator_id}:quality-review`,
    `质量复核 ${indicator_id}：${decision}（${reviewer}）`,
    { indicator_id, reviewer, decision, notes },
  );
}

export function approveUsage(ctx, { indicator_id, approver, review_id, note }) {
  requireFields({ indicator_id, approver, review_id }, ["indicator_id", "approver", "review_id"]);
  ctx.emit(
    "USAGE_APPROVED",
    "publication_release",
    `usage:${indicator_id}:${review_id}`,
    `批准 ${indicator_id} 用于规划评审 ${review_id}（${approver}）`,
    { indicator_id, approver, review_id, note },
  );
}

export function latestPassingReview(state, indicatorId) {
  const list = state.reviews.get(indicatorId) ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].decision === "pass") return list[i];
  }
  return null;
}

export function freezeRelease(ctx, { release_id, indicator_id, review_id, periods, frozen_by }) {
  requireFields({ release_id, indicator_id, review_id, periods, frozen_by }, [
    "release_id",
    "indicator_id",
    "review_id",
    "periods",
    "frozen_by",
  ]);
  // 幂等：同一 release_id 重复冻结直接返回原发布包，不产生新事件。
  const existing = ctx.state.releases.get(release_id);
  if (existing) return { release: existing, duplicate: true };

  const entries = periods.map((p) => ctx.state.candidates.get(candidateKey(indicator_id, p)));
  const notReady = periods.filter((p, i) => !entries[i] || entries[i].status !== "candidate");
  if (notReady.length > 0) {
    throw new Error(`以下期间没有可冻结的候选条目：${notReady.join("、")}`);
  }

  const latestComputedAt = entries.map((e) => e.computed_at).reduce((a, b) => (a > b ? a : b));
  const review = latestPassingReview(ctx.state, indicator_id);
  if (!review) throw new Error("缺少统计负责人的质量确认，不能冻结");
  if (review.reviewed_at < latestComputedAt) {
    throw new Error("候选序列在质量确认后发生变化，需重新复核后才能冻结");
  }

  const approval = ctx.state.approvals.get(`${indicator_id}|${review_id}`);
  if (!approval) throw new Error(`缺少业务负责人对规划评审 ${review_id} 的用途批准，不能冻结`);

  const snapshot = entries.map((e) => ({
    period: e.period,
    value: e.value,
    num: e.num,
    den: e.den,
    residual: e.residual,
    definition_version: e.definition_version,
    boundary_basis: e.boundary_basis,
    schemes_used: e.schemes_used,
    batch_ids: e.batch_ids,
    quality_flags: e.quality_flags,
  }));

  ctx.emit(
    "RELEASE_FROZEN",
    "publication_release",
    release_id,
    `冻结发布包 ${release_id}（${indicator_id}，面向规划评审 ${review_id}）`,
    {
      release_id,
      indicator_id,
      review_id,
      periods: [...periods],
      entries: snapshot,
      quality_review: { reviewer: review.reviewer, reviewed_at: review.reviewed_at, notes: review.notes },
      usage_approval: { approver: approval.approver, approved_at: approval.approved_at, note: approval.note },
      frozen_by,
    },
    `freeze:${release_id}`,
  );
  return { release: ctx.state.releases.get(release_id), duplicate: false };
}

/**
 * 迟到补报重算后，对覆盖该期间的已冻结发布包追加修订影响。
 * 冻结快照本身永远不改写。
 */
export function appendRevisionIfFrozen(ctx, indicatorId, period) {
  const candidate = ctx.state.candidates.get(candidateKey(indicatorId, period));
  if (!candidate || candidate.status !== "candidate") return [];
  const revised = [];
  for (const rel of ctx.state.releases.values()) {
    if (rel.indicator_id !== indicatorId || !rel.periods.includes(period)) continue;
    const frozenEntry = rel.entries.find((e) => e.period === period);
    const delta = (candidate.value ?? 0) - (frozenEntry.value ?? 0);
    if (Math.abs(delta) < 1e-12) continue;
    const n = (ctx.state.revisions.get(rel.release_id) ?? []).length + 1;
    ctx.emit(
      "RELEASE_REVISED",
      "publication_release",
      rel.release_id,
      `迟到补报影响发布包 ${rel.release_id} 的 ${period}（Δ=${delta}）`,
      {
        release_id: rel.release_id,
        period,
        previous_value: frozenEntry.value,
        revised_value: candidate.value,
        delta,
        cause: "迟到补报重算",
      },
      `revise:${rel.release_id}:${period}:${n}`,
    );
    revised.push(rel.release_id);
  }
  return revised;
}
