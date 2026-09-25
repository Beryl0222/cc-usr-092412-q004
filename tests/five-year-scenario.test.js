import assert from "node:assert/strict";
import test from "node:test";

import { IndicatorRegistry } from "../src/app.js";
import { buildRegistry, INDICATOR, definitionV1 } from "./helpers.js";

/**
 * 五年（2021–2025）慢病指标端到端场景：
 * 行政区划调整 + 分母定义修订 + 迟到补报同时发生，验证
 * 口径谱系、守恒换算、冲突待决、双签冻结、只追加修订、故障恢复与血缘/可比性。
 */

const REVIEW = "review-2026-five-year";

function scenarioSetup(reg) {
  // 边界 v1：三区；v2（2023 起）：中心城区 g-x（东城+西城合并）、新城 g-y（南郊更名，10% 辖区划出市外）
  reg.lineage.approveBoundary({
    geography_id: "geo-city", boundary_version: 1, predecessor_version: null,
    name: "市辖区（调整前）", members: ["g-a", "g-b", "g-c"],
    effective_from: "2021-01-01T00:00:00+08:00", change_note: "东城/西城/南郊三区县"
  });
  reg.lineage.approveBoundary({
    geography_id: "geo-city", boundary_version: 2, predecessor_version: 1,
    name: "市辖区（调整后）", members: ["g-x", "g-y"],
    effective_from: "2023-01-01T00:00:00+08:00",
    change_note: "东城 g-a 与西城 g-b 合并为中心城区 g-x；南郊 g-c 更名新城 g-y，10% 面积随区划划出市外"
  });

  // 口径 v1（分母 DEN-2021）
  reg.lineage.approveDefinition(definitionV1());

  // 换算方案：v1→v2，分子分母同一权重；g-c 仅 90% 可归属，10% 残差必须披露
  reg.lineage.approveConversionScheme({
    scheme_id: "sc-merge-2023",
    indicator_id: INDICATOR,
    from_boundary_version: "geo-city:1",
    to_boundary_version: "geo-city:2",
    component: "both",
    mappings: [
      { source_geography_id: "g-a", target_geography_id: "g-x", weight: 0.6 },
      { source_geography_id: "g-a", target_geography_id: "g-y", weight: 0.4 },
      { source_geography_id: "g-b", target_geography_id: "g-x", weight: 1 },
      { source_geography_id: "g-c", target_geography_id: "g-y", weight: 0.9 }
    ],
    residual_policy: "report_only",
    basis: "《2023 年市区行政区划调整通知》+ 2020 年第七次人口普查街道级常住人口分布；g-c 西部 10% 辖区划出市外，无归属依据",
    effective_from: "2023-01-01T00:00:00+08:00"
  });
}

test("五年场景：区划调整+分母修订+补报并发下的口径谱系、冻结与追溯", () => {
  const reg = buildRegistry("2026-01-05T09:00:00+08:00");
  scenarioSetup(reg);

  // -- 2021/2022 按旧边界上报 ------------------------------------------------
  reg.ingestion.submitBatch({
    batch_id: "b-2021", indicator_id: INDICATOR, source_id: "src-ledger",
    observations: [
      { geography_id: "g-a", period: "2021", numerator: 60, denominator: 600 },
      { geography_id: "g-b", period: "2021", numerator: 30, denominator: 300 },
      { geography_id: "g-c", period: "2021", numerator: 10, denominator: 100 }
    ]
  });
  reg.ingestion.submitBatch({
    batch_id: "b-2022", indicator_id: INDICATOR, source_id: "src-ledger",
    observations: [
      { geography_id: "g-a", period: "2022", numerator: 62, denominator: 620 },
      { geography_id: "g-b", period: "2022", numerator: 31, denominator: 310 },
      { geography_id: "g-c", period: "2022", numerator: 11, denominator: 110 }
    ]
  });

  // -- 2023 起按新边界上报；2024 另有一个相互冲突的档案来源 -------------------
  reg.ingestion.submitBatch({
    batch_id: "b-2023", indicator_id: INDICATOR, source_id: "src-ledger",
    observations: [
      { geography_id: "g-x", period: "2023", numerator: 90, denominator: 900 },
      { geography_id: "g-y", period: "2023", numerator: 40, denominator: 400 }
    ]
  });
  reg.ingestion.submitBatch({
    batch_id: "b-2024-ledger", indicator_id: INDICATOR, source_id: "src-ledger",
    observations: [
      { geography_id: "g-x", period: "2024", numerator: 95, denominator: 920 },
      { geography_id: "g-y", period: "2024", numerator: 40, denominator: 380 }
    ]
  });
  reg.ingestion.submitBatch({
    batch_id: "b-2024-archive", indicator_id: INDICATOR, source_id: "src-archive",
    observations: [
      { geography_id: "g-x", period: "2024", numerator: 120, denominator: 950 },
      { geography_id: "g-y", period: "2024", numerator: 42, denominator: 380 }
    ]
  });
  reg.ingestion.submitBatch({
    batch_id: "b-2025", indicator_id: INDICATOR, source_id: "src-ledger",
    observations: [
      { geography_id: "g-x", period: "2025", numerator: 99, denominator: 940 },
      { geography_id: "g-y", period: "2025", numerator: 43, denominator: 410 }
    ]
  });

  // -- 旧口径前段（21–22 折算到新边界） --------------------------------------
  const oldSeg = reg.computation.runJob({
    job_id: "job-oldseg", indicator_id: INDICATOR, definition_version: 1,
    target_boundary_version: "geo-city:2", periods: ["2021", "2022"]
  });

  // -- 第一次架桥尝试：2024 冲突未决，该年必须留空 -----------------------------
  const pending = reg.computation.runJob({
    job_id: "job-bridge-pending", indicator_id: INDICATOR, definition_version: 1,
    target_boundary_version: "geo-city:2", periods: ["2021", "2022", "2023", "2024", "2025"]
  });
  const pendingSeries = reg.computation.getSeries(pending.series_id);
  assert.equal(pendingSeries.points.find((p) => p.period === "2024").value, null);
  assert.equal(pendingSeries.points.find((p) => p.period === "2024").quality_rule_results.no_unresolved_conflict, false);
  assert.equal(reg.ingestion.openConflicts().length, 1);

  // 冲突裁决：以随访台账为准（档案批次为口径外估算）
  const conflictId = reg.ingestion.openConflicts()[0].conflict_id;
  reg.ingestion.resolveConflict(conflictId, "b-2024-ledger", "随访台账为原始报数；档案口径含年内退出人员，与指标分母定义不一致", "统计负责人甲");
  assert.equal(reg.ingestion.openConflicts().length, 0);

  // 裁决后重算得到完整架桥序列；未发布的旧候选被取代
  const bridge = reg.computation.runJob({
    job_id: "job-bridge", indicator_id: INDICATOR, definition_version: 1,
    target_boundary_version: "geo-city:2", periods: ["2021", "2022", "2023", "2024", "2025"]
  });
  reg.computation.supersedeSeries(pending.series_id, bridge.series_id, "冲突裁决后重算");
  const bridgeSeries = reg.computation.getSeries(bridge.series_id);
  assert.equal(bridgeSeries.superseded_by, null);
  assert.equal(reg.computation.getSeries(pending.series_id).superseded_by, bridge.series_id);

  // -- 架桥结果核对：守恒换算 + 残差披露 --------------------------------------
  const p2021 = bridgeSeries.points.find((p) => p.period === "2021");
  const p2022 = bridgeSeries.points.find((p) => p.period === "2022");
  // 2021: 分母 660+330=990，残差 10；分子 66+33=99，残差 1
  assert.equal(p2021.denominator + p2021.unallocated_residual_denominator, 1000);
  assert.equal(p2021.numerator + p2021.unallocated_residual_numerator, 100);
  assert.equal(p2021.unallocated_residual_denominator, 10);
  assert.equal(p2021.unallocated_residual_numerator, 1);
  assert.equal(p2021.value, 10); // 99/990
  assert.equal(p2022.denominator + p2022.unallocated_residual_denominator, 1040);
  assert.equal(p2022.conversion_scheme_id, "sc-merge-2023");
  assert.equal(p2022.source_boundary_version, "geo-city:1");
  assert.equal(bridgeSeries.points.find((p) => p.period === "2023").source_boundary_version, "geo-city:2");
  // 残差率 1%，质量规则放行
  assert.equal(p2021.quality_rule_results.residual_within_5pct, true);

  // -- 分母定义修订：口径 v2（DEN-2023），2023 起生效 --------------------------
  reg.lineage.approveDefinition({
    ...definitionV1(),
    definition_version: 2,
    predecessor_version: 1,
    denominator_source: "居民电子健康档案（年内任一时点曾在管人数）",
    denominator_definition_version: "DEN-2023",
    boundary_version: "geo-city:2",
    change_note: "分母定义修订：年末在管 → 年内曾管理；分子与适用人群不变",
    effective_from: "2023-01-01T00:00:00+08:00"
  });
  const newSeg = reg.computation.runJob({
    job_id: "job-newseg", indicator_id: INDICATOR, definition_version: 2,
    target_boundary_version: "geo-city:2", periods: ["2023", "2024", "2025"]
  });

  // -- 可比性判定 -------------------------------------------------------------
  const sameCaliber = reg.provenance.compareSeries(oldSeg.series_id, bridge.series_id);
  assert.equal(sameCaliber.comparable, true);
  assert.equal(sameCaliber.converted, true);
  assert.ok(sameCaliber.reasons.some((r) => r.includes("sc-merge-2023") && r.includes("守恒")));
  assert.ok(sameCaliber.reasons.some((r) => r.includes("残差率 1.00%")));

  const brokenCaliber = reg.provenance.compareSeries(bridge.series_id, newSeg.series_id);
  assert.equal(brokenCaliber.comparable, false);
  assert.ok(brokenCaliber.reasons.some((r) => r.includes("分母定义修订") && r.includes("DEN-2021") && r.includes("DEN-2023")));

  // -- 血缘追溯：任意数值可查口径、边界、输入批次、批准链 -----------------------
  const explain = reg.provenance.explainValue(bridge.series_id, "2022");
  assert.equal(explain.definition.denominator_definition_version, "DEN-2021");
  assert.equal(explain.boundary.converted_with[0].basis.startsWith("《2023"), true);
  assert.deepEqual(explain.input_batches.map((b) => b.batch_id), ["b-2022"]);
  assert.equal(explain.counts.unallocated_residual_denominator, 11);

  // -- 双签闸门 ---------------------------------------------------------------
  assert.throws(
    () => reg.publication.approveUse(bridge.series_id, "业务负责人乙", REVIEW, "五年趋势"),
    /尚未经统计负责人质量确认/
  );
  reg.publication.confirmQuality(bridge.series_id, "统计负责人甲", "含 21/22 守恒换算（残差率 1%）与 2024 冲突裁决，全部质量规则通过");
  reg.publication.approveUse(bridge.series_id, "业务负责人乙", REVIEW, "2026 年慢病五年规划评审趋势比较");
  // 评审用途与批准记录不一致不得冻结
  assert.throws(
    () => reg.publication.freezeRelease({ releaseId: "rel-wrong-review", planningReviewId: "review-other", seriesIds: [bridge.series_id] }),
    /与本次 review-other 不一致/
  );
  const frozen = reg.publication.freezeRelease({
    releaseId: "rel-2026", planningReviewId: REVIEW, seriesIds: [bridge.series_id]
  });
  const frozenHash = frozen.payload.snapshot_hash;
  assert.ok(frozenHash);

  // 重复冻结幂等：不重复发布
  const again = reg.publication.freezeRelease({ releaseId: "rel-2026", planningReviewId: REVIEW, seriesIds: [bridge.series_id] });
  assert.equal(again, frozen);
  assert.equal(reg.store.ofType("RELEASE_FROZEN").length, 1);

  // 报告引用冻结包
  reg.publication.recordReportReference({ reportId: "rpt-eval", releaseId: "rel-2026", reportName: "慢病防治五年规划中期评估报告" });
  const frozenValue2025 = reg.publication.getRelease("rel-2026").snapshot[bridge.series_id].points.find((p) => p.period === "2025").value;

  // -- 评审后迟到补报 ----------------------------------------------------------
  reg.clock.advance({ days: 200 }); // 2026-07-24：数据源已过期
  assert.equal(reg.ingestion.isExpired("src-ledger"), true);
  // 到期来源下重算：质量规则不放行
  const expiredJob = reg.computation.runJob({
    job_id: "job-expired", indicator_id: INDICATOR, definition_version: 1,
    target_boundary_version: "geo-city:2", periods: ["2025"]
  });
  assert.equal(reg.computation.getSeries(expiredJob.series_id).points[0].quality_rule_results.source_not_expired, false);
  // 续期后再算
  reg.ingestion.renewDataSource("src-ledger", "2027-06-30T23:59:59+08:00", "新版慢病系统对接完成，来源续期");
  reg.ingestion.renewDataSource("src-archive", "2027-06-30T23:59:59+08:00", "年度复核通过");

  reg.ingestion.submitBatch({
    batch_id: "b-2025-correction", indicator_id: INDICATOR, source_id: "src-ledger",
    is_late: true, supersedes_batch_id: "b-2025",
    observations: [
      { geography_id: "g-x", period: "2025", numerator: 100, denominator: 940 },
      { geography_id: "g-y", period: "2025", numerator: 43, denominator: 410 }
    ]
  });
  const revised = reg.computation.runJob({
    job_id: "job-post-review", indicator_id: INDICATOR, definition_version: 1,
    target_boundary_version: "geo-city:2", periods: ["2021", "2022", "2023", "2024", "2025"]
  });
  assert.notEqual(revised.series_id, bridge.series_id);
  assert.equal(reg.computation.getSeries(revised.series_id).points.find((p) => p.period === "2025").quality_rule_results.source_not_expired, true);
  reg.publication.confirmQuality(revised.series_id, "统计负责人甲", "迟到补报复核：仅 2025 年中心城区分子 +1");

  // 已引用的冻结包只能追加修订，原快照不改写
  reg.publication.appendRevision({
    release_id: "rel-2026",
    old_series_id: bridge.series_id,
    new_series_id: revised.series_id,
    statistician: "统计负责人甲",
    business_owner: "业务负责人乙",
    impact: "2025 年全市规范管理率由 10.52% 修正为 10.59%，五年上升趋势不变，不改变评审结论"
  });
  const release = reg.publication.getRelease("rel-2026");
  assert.equal(release.snapshot_hash, frozenHash, "冻结快照哈希永不改变");
  assert.equal(release.snapshot[bridge.series_id].points.find((p) => p.period === "2025").value, frozenValue2025);
  assert.equal(release.revisions.length, 1);
  const report = reg.publication.getReport("rpt-eval");
  assert.equal(report.revisions_appended.length, 1);
  assert.match(report.revisions_appended[0].impact, /10.59%/);

  // 血缘中可见冻结归属与批准链
  const explainAfter = reg.provenance.explainValue(bridge.series_id, "2025");
  assert.equal(explainAfter.approval_chain.quality_confirmed.confirmed_by, "统计负责人甲");
  assert.equal(explainAfter.approval_chain.use_approved.approved_by, "业务负责人乙");
  assert.equal(explainAfter.frozen_in[0].release_id, "rel-2026");
  assert.equal(explainAfter.frozen_in[0].snapshot_hash, frozenHash);

  // -- 故障恢复：快照恢复后状态完整，重复操作全部幂等 ---------------------------
  const recovered = IndicatorRegistry.restore(reg.snapshot());
  assert.equal(recovered.publication.getRelease("rel-2026").revisions.length, 1);
  recovered.publication.freezeRelease({ releaseId: "rel-2026", planningReviewId: REVIEW, seriesIds: [bridge.series_id] });
  assert.equal(recovered.store.ofType("RELEASE_FROZEN").length, 1);
  assert.equal(recovered.publication.getReport("rpt-eval").revisions_appended.length, 1);
});
