import assert from "node:assert/strict";
import test from "node:test";

import {
  INDICATOR,
  adoptMergeScheme,
  feedPeriod,
  makePlatform,
  newBoundaryValues,
  oldBoundaryValues,
  registerDefV1,
  registerDefV2,
} from "./helpers.js";

const REVIEW_ID = "PLAN-2026-五年评估";

/** 连续五年场景：2021–2023 用 v1/旧边界，2024 起口径修订并启用新边界。 */
function fiveYearPlatform({ withScheme = true, comparable = false } = {}) {
  const p = makePlatform();
  registerDefV1(p);
  if (withScheme) adoptMergeScheme(p);
  registerDefV2(p, { comparable });
  feedPeriod(p, { period: "2021", values: oldBoundaryValues() });
  feedPeriod(p, { period: "2022", values: oldBoundaryValues() });
  feedPeriod(p, { period: "2023", values: oldBoundaryValues() });
  feedPeriod(p, { period: "2024", boundary: "区划2025", values: newBoundaryValues() });
  feedPeriod(p, { period: "2025", boundary: "区划2025", values: newBoundaryValues() });
  p.startComputation({ job_id: "JOB-5Y", indicator_id: INDICATOR, periods: ["2021", "2022", "2023", "2024", "2025"] });
  return p;
}

function freezeFiveYears(p) {
  p.reviewQuality({ indicator_id: INDICATOR, reviewer: "统计负责人-王某", decision: "pass" });
  p.approveUsage({ indicator_id: INDICATOR, approver: "业务负责人-赵某", review_id: REVIEW_ID });
  p.freezeRelease({
    release_id: "REL-5Y",
    indicator_id: INDICATOR,
    review_id: REVIEW_ID,
    periods: ["2021", "2022", "2023", "2024", "2025"],
    frozen_by: "平台主管-钱某",
  });
}

test("谱系查询：任意数值都能追出口径、边界、输入批次和批准链", () => {
  const p = fiveYearPlatform();
  freezeFiveYears(p);

  const explain = p.explainValue({ indicator_id: INDICATOR, period: "2023" });
  assert.equal(explain.status, "frozen");
  // 口径
  assert.equal(explain.caliber.definition_version, 1);
  assert.equal(explain.caliber.formula, "num/den*100");
  assert.equal(explain.caliber.denominator_source.description, "在管患者数");
  // 边界
  assert.equal(explain.boundary.basis, "区划2020");
  // 输入批次
  assert.deepEqual(explain.batches.map((b) => b.batch_id).sort(), ["B-2023-东城", "B-2023-南湖", "B-2023-西城"]);
  assert.equal(explain.batches[0].is_late, false);
  // 批准链
  assert.equal(explain.approval_chain.quality_review.reviewer, "统计负责人-王某");
  assert.equal(explain.approval_chain.usage_approval.approver, "业务负责人-赵某");
  assert.equal(explain.approval_chain.review_id, REVIEW_ID);

  // 2024 年数值使用 v2 口径与新边界
  const explain2024 = p.explainValue({ indicator_id: INDICATOR, period: "2024" });
  assert.equal(explain2024.caliber.definition_version, 2);
  assert.equal(explain2024.boundary.basis, "区划2025");
});

test("分母定义修订且声明不可比：两段曲线判定为不可比并给出原因", () => {
  const p = fiveYearPlatform({ comparable: false });
  freezeFiveYears(p);

  const verdict = p.comparePeriods({ indicator_id: INDICATOR, period_a: "2023", period_b: "2024" });
  assert.equal(verdict.verdict, "not_comparable");
  assert.ok(verdict.reasons.some((r) => r.level === "break" && /不可比.*分母定义修订/.test(r.message)));
  // 边界差异有守恒方案兜底，作为保留意见而非断点
  assert.ok(verdict.reasons.some((r) => r.level === "caveat" && /SCH-MERGE-1/.test(r.message)));
});

test("口径一致、边界一致的两个期间完全可比", () => {
  const p = fiveYearPlatform();
  freezeFiveYears(p);

  const verdict = p.comparePeriods({ indicator_id: INDICATOR, period_a: "2021", period_b: "2023" });
  assert.equal(verdict.verdict, "comparable");
  assert.ok(verdict.reasons.every((r) => r.level === "ok"));
});

test("口径声明可比且边界有守恒换算：可比但有保留", () => {
  const p = fiveYearPlatform({ comparable: true });
  freezeFiveYears(p);

  const verdict = p.comparePeriods({ indicator_id: INDICATOR, period_a: "2022", period_b: "2025" });
  assert.equal(verdict.verdict, "comparable_with_caveats");
  assert.ok(verdict.reasons.some((r) => r.level === "caveat" && /已声明可比/.test(r.message)));
  assert.ok(verdict.reasons.some((r) => r.level === "caveat" && /守恒换算/.test(r.message)));
});

test("边界不同且没有任何换算方案：不可比", () => {
  const p = fiveYearPlatform({ withScheme: false, comparable: true });
  freezeFiveYears(p);

  const verdict = p.comparePeriods({ indicator_id: INDICATOR, period_a: "2022", period_b: "2025" });
  assert.equal(verdict.verdict, "not_comparable");
  assert.ok(verdict.reasons.some((r) => r.level === "break" && /没有已采纳的换算方案/.test(r.message)));
});

test("迟到补报的修订影响在谱系查询中可见", () => {
  const p = fiveYearPlatform();
  freezeFiveYears(p);

  p.advanceClockTo("2026-02-10T09:00:00+08:00");
  p.submitObservation({
    batch_id: "B-2023-南湖-补报",
    source_id: "SRC-2023",
    region_id: "南湖",
    num: 480,
    den: 500,
    boundary_basis: "区划2020",
  });

  const explain = p.explainValue({ indicator_id: INDICATOR, period: "2023" });
  assert.equal(explain.status, "frozen");
  assert.equal(explain.revisions.length, 1);
  assert.equal(explain.revisions[0].cause, "迟到补报重算");
  // 冻结值未改写
  assert.ok(Math.abs(explain.value - (1850 / 2300) * 100) < 1e-9);
});
