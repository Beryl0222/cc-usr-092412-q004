import assert from "node:assert/strict";
import test from "node:test";

import { IndicatorRegistry } from "../src/app.js";
import { buildRegistry, INDICATOR, definitionV1, freezeSeries } from "./helpers.js";

const BOUNDARY_V1 = {
  geography_id: "geo-city",
  boundary_version: 1,
  predecessor_version: null,
  name: "市辖区（调整前：东城/西城/南郊）",
  members: ["g-a", "g-b", "g-c"],
  effective_from: "2021-01-01T00:00:00+08:00",
  change_note: "三区县"
};
const BOUNDARY_V2 = {
  geography_id: "geo-city",
  boundary_version: 2,
  predecessor_version: 1,
  name: "市辖区（调整后：中心城区/新城）",
  members: ["g-x", "g-y"],
  effective_from: "2023-01-01T00:00:00+08:00",
  change_note: "东城西城合并为中心城区 g-x；南郊更名新城 g-y"
};

function setup(reg) {
  reg.lineage.approveBoundary(BOUNDARY_V1);
  reg.lineage.approveBoundary(BOUNDARY_V2);
  reg.lineage.approveDefinition(definitionV1());
}

function yearlyBatches(reg) {
  // 三年数据，分子=分母/10 便于核对率值
  const rows = {
    "2021": { "g-a": 600, "g-b": 300, "g-c": 100 },
    "2022": { "g-a": 620, "g-b": 310, "g-c": 110 }
  };
  for (const [period, m] of Object.entries(rows)) {
    reg.ingestion.submitBatch({
      batch_id: `b-${period}`,
      indicator_id: INDICATOR,
      source_id: "src-ledger",
      observations: Object.entries(m).map(([geography_id, denominator]) => ({
        geography_id,
        period,
        numerator: Math.round(denominator / 10),
        denominator
      }))
    });
  }
}

test("同边界直接计算：候选序列含质量证据，全部规则通过", () => {
  const reg = buildRegistry();
  setup(reg);
  yearlyBatches(reg);
  const { series_id } = reg.computation.runJob({
    job_id: "job-direct",
    indicator_id: INDICATOR,
    definition_version: 1,
    target_boundary_version: "geo-city:1",
    periods: ["2021", "2022"]
  });
  const series = reg.computation.getSeries(series_id);
  assert.equal(series.quality_confirmed, false);
  assert.equal(series.use_approved, false);
  const p2021 = series.points.find((p) => p.period === "2021");
  assert.equal(p2021.denominator, 1000);
  assert.equal(p2021.numerator, 100);
  assert.equal(p2021.value, 10);
  assert.equal(p2021.conversion_scheme_id, null);
  assert.deepEqual(p2021.quality_rule_results, {
    denominator_nonzero: true,
    residual_within_5pct: true,
    source_not_expired: true,
    no_unresolved_conflict: true,
    review_not_overdue: true
  });
});

test("跨边界缺换算方案时点位置空并说明不可比原因", () => {
  const reg = buildRegistry();
  setup(reg);
  yearlyBatches(reg);
  const { series_id } = reg.computation.runJob({
    job_id: "job-no-scheme",
    indicator_id: INDICATOR,
    definition_version: 1,
    target_boundary_version: "geo-city:2",
    periods: ["2021", "2022"]
  });
  for (const p of reg.computation.getSeries(series_id).points) {
    assert.equal(p.value, null);
    assert.ok(p.notes.some((n) => n.includes("缺少") && n.includes("换算方案")));
  }
});

test("有依据的守恒换算：跨边界序列可计算，残差=0 时全部通过", () => {
  const reg = buildRegistry();
  setup(reg);
  yearlyBatches(reg);
  reg.lineage.approveConversionScheme({
    scheme_id: "sc-merge",
    indicator_id: INDICATOR,
    from_boundary_version: "geo-city:1",
    to_boundary_version: "geo-city:2",
    component: "both",
    mappings: [
      { source_geography_id: "g-a", target_geography_id: "g-x", weight: 0.6 },
      { source_geography_id: "g-a", target_geography_id: "g-y", weight: 0.4 },
      { source_geography_id: "g-b", target_geography_id: "g-x", weight: 1 },
      { source_geography_id: "g-c", target_geography_id: "g-y", weight: 1 }
    ],
    residual_policy: "report_only",
    basis: "2023 年市政府区划调整文件（东城西城合并）与 2020 年人口普查分布",
    effective_from: "2023-01-01T00:00:00+08:00"
  });
  const { series_id } = reg.computation.runJob({
    job_id: "job-convert",
    indicator_id: INDICATOR,
    definition_version: 1,
    target_boundary_version: "geo-city:2",
    periods: ["2021", "2022"]
  });
  const p = reg.computation.getSeries(series_id).points.find((x) => x.period === "2021");
  // 分母守恒：1000 全部分摊（600*.6=360→x, 600*.4=240→y, g-b 300→x, g-c 100→y）
  assert.equal(p.denominator, 1000);
  assert.equal(p.unallocated_residual_denominator, 0);
  // 最大余数法：分子 60 → 36/24；30→30；10→10
  assert.equal(p.numerator, 100);
  assert.equal(p.value, 10);
  assert.equal(p.conversion_scheme_id, "sc-merge");
});

test("无法归属的份额形成残差，超过容忍线则质量规则不放行", () => {
  const reg = buildRegistry();
  setup(reg);
  reg.ingestion.submitBatch({
    batch_id: "b-2021-gap",
    indicator_id: INDICATOR,
    source_id: "src-ledger",
    observations: [{ geography_id: "g-a", period: "2021", numerator: 100, denominator: 1000 }]
  });
  reg.lineage.approveConversionScheme({
    scheme_id: "sc-gap",
    indicator_id: INDICATOR,
    from_boundary_version: "geo-city:1",
    to_boundary_version: "geo-city:2",
    component: "both",
    // 仅 80% 可归属，20%（如划出本市的人口）无分摊依据
    mappings: [
      { source_geography_id: "g-a", target_geography_id: "g-x", weight: 0.5 },
      { source_geography_id: "g-a", target_geography_id: "g-y", weight: 0.3 }
    ],
    residual_policy: "report_only",
    basis: "区划文件：20% 辖区划出本市，无法取得后续归属",
    effective_from: "2023-01-01T00:00:00+08:00"
  });
  const { series_id } = reg.computation.runJob({
    job_id: "job-gap",
    indicator_id: INDICATOR,
    definition_version: 1,
    target_boundary_version: "geo-city:2",
    periods: ["2021"]
  });
  const p = reg.computation.getSeries(series_id).points[0];
  assert.equal(p.denominator + p.unallocated_residual_denominator, 1000, "守恒");
  assert.equal(p.unallocated_residual_denominator, 200);
  assert.equal(p.quality_rule_results.residual_within_5pct, false);
});

test("作业崩溃后从断点继续：不重复步骤、不重复发布候选", () => {
  const reg = buildRegistry();
  setup(reg);
  yearlyBatches(reg);

  let crashed = false;
  try {
    reg.computation.runJob({
      job_id: "job-crash",
      indicator_id: INDICATOR,
      definition_version: 1,
      target_boundary_version: "geo-city:1",
      periods: ["2021", "2022"],
      beforeStep: (stepId) => {
        if (stepId.endsWith(":2022") && !crashed) {
          crashed = true;
          throw new Error("模拟进程崩溃");
        }
      }
    });
    assert.fail("应当抛出崩溃");
  } catch (err) {
    assert.match(err.message, /模拟进程崩溃/);
  }
  reg.computation.markJobFailed("job-crash", "job-crash:step:2022", "模拟进程崩溃");

  // 崩溃时只有 2021 步骤落盘，尚无候选序列
  assert.equal(reg.store.ofType("CANDIDATE_SERIES_PROPOSED").length, 0);

  // 用整体快照恢复到新进程后继续
  const resumed = IndicatorRegistry.restore(reg.snapshot());
  const result = resumed.computation.runJob({
    job_id: "job-crash",
    indicator_id: INDICATOR,
    definition_version: 1,
    target_boundary_version: "geo-city:1",
    periods: ["2021", "2022"]
  });
  assert.equal(result.resumed_steps, 1);
  assert.equal(result.executed_steps, 1);
  assert.equal(resumed.store.ofType("JOB_COMPLETED").length, 1);
  assert.equal(resumed.store.ofType("CANDIDATE_SERIES_PROPOSED").length, 1);

  // 再次重放：全部幂等，不产生任何重复
  const again = resumed.computation.runJob({
    job_id: "job-crash",
    indicator_id: INDICATOR,
    definition_version: 1,
    target_boundary_version: "geo-city:1",
    periods: ["2021", "2022"]
  });
  assert.equal(again.already_completed, true);
  assert.equal(resumed.store.ofType("JOB_COMPLETED").length, 1);
  assert.equal(resumed.store.ofType("CANDIDATE_SERIES_PROPOSED").length, 1);
});

test("迟到补报只重算未发布序列；已冻结序列不改写", () => {
  const reg = buildRegistry();
  setup(reg);
  yearlyBatches(reg);
  const first = reg.computation.runJob({
    job_id: "job-late-1",
    indicator_id: INDICATOR,
    definition_version: 1,
    target_boundary_version: "geo-city:1",
    periods: ["2021", "2022"]
  });
  freezeSeries(reg, first.series_id, "review-1", "rel-1");
  const frozenHash = reg.publication.getRelease("rel-1").snapshot_hash;

  // 迟到补报 2022 年（取代原 b-2022 整批，东城分子由 62 更正为 90）
  reg.clock.advance({ days: 120 });
  reg.ingestion.submitBatch({
    batch_id: "b-2022-late",
    indicator_id: INDICATOR,
    source_id: "src-ledger",
    is_late: true,
    supersedes_batch_id: "b-2022",
    observations: [
      { geography_id: "g-a", period: "2022", numerator: 90, denominator: 620 },
      { geography_id: "g-b", period: "2022", numerator: 31, denominator: 310 },
      { geography_id: "g-c", period: "2022", numerator: 11, denominator: 110 }
    ]
  });
  // 已冻结序列不能重算
  assert.throws(
    () =>
      reg.computation.recomputeAfterLateReport({
        indicatorId: INDICATOR,
        definitionVersion: 1,
        targetBoundaryVersion: "geo-city:1",
        periods: ["2021", "2022"],
        newJobId: "job-late-x",
        supersededSeriesId: first.series_id
      }),
    /已冻结发布/
  );
  // 冻结包快照保持原样
  assert.equal(reg.publication.getRelease("rel-1").snapshot_hash, frozenHash);
});

test("迟到补报重算未发布序列：新候选产生、旧候选标记取代", () => {
  const reg = buildRegistry();
  setup(reg);
  yearlyBatches(reg);
  const first = reg.computation.runJob({
    job_id: "job-recompute-1",
    indicator_id: INDICATOR,
    definition_version: 1,
    target_boundary_version: "geo-city:1",
    periods: ["2021", "2022"]
  });

  reg.clock.advance({ days: 100 });
  reg.ingestion.submitBatch({
    batch_id: "b-2022-corr",
    indicator_id: INDICATOR,
    source_id: "src-ledger",
    is_late: true,
    supersedes_batch_id: "b-2022",
    observations: [
      { geography_id: "g-a", period: "2022", numerator: 90, denominator: 620 },
      { geography_id: "g-b", period: "2022", numerator: 31, denominator: 310 },
      { geography_id: "g-c", period: "2022", numerator: 11, denominator: 110 }
    ]
  });
  const out = reg.computation.recomputeAfterLateReport({
    indicatorId: INDICATOR,
    definitionVersion: 1,
    targetBoundaryVersion: "geo-city:1",
    periods: ["2021", "2022"],
    newJobId: "job-recompute-2"
  });
  assert.equal(out.superseded_series_id, first.series_id);
  assert.notEqual(out.new_series_id, first.series_id);
  assert.equal(reg.computation.getSeries(first.series_id).superseded_by, out.new_series_id);
  const fresh = reg.computation.getSeries(out.new_series_id);
  assert.equal(fresh.points.find((p) => p.period === "2022").numerator, 132);
  assert.equal(fresh.quality_confirmed, false, "重算结果仍是候选，必须重新走双签");
  assert.equal(reg.computation.latestSeries(INDICATOR).series_id, out.new_series_id);
});
