import assert from "node:assert/strict";
import test from "node:test";

import { buildRegistry, INDICATOR, definitionV1, freezeSeries } from "./helpers.js";

function oneSeries(reg) {
  reg.lineage.approveBoundary({
    geography_id: "geo-city",
    boundary_version: 1,
    predecessor_version: null,
    name: "市辖区",
    members: ["g-a"],
    effective_from: "2021-01-01T00:00:00+08:00",
    change_note: "单区"
  });
  reg.lineage.approveDefinition(definitionV1());
  reg.ingestion.submitBatch({
    batch_id: "b1",
    indicator_id: ID,
    source_id: "src-ledger",
    observations: [{ geography_id: "g-a", period: "2021", numerator: 100, denominator: 1000 }]
  });
  return reg.computation.runJob({
    job_id: "job-1",
    indicator_id: ID,
    definition_version: 1,
    target_boundary_version: "geo-city:1",
    periods: ["2021"]
  }).series_id;
}

const ID = INDICATOR;

test("闸门：未质量确认不得批准用途；未批准不得冻结", () => {
  const reg = buildRegistry();
  const sid = oneSeries(reg);
  assert.throws(() => reg.publication.approveUse(sid, "乙", "r1", "用途"), /质量确认/);
  reg.publication.confirmQuality(sid, "甲");
  reg.publication.approveUse(sid, "乙", "r1", "用途");
  // 评审不一致不得冻结
  assert.throws(
    () => reg.publication.freezeRelease({ releaseId: "rel-x", planningReviewId: "r2", seriesIds: [sid] }),
    /与本次 r2 不一致/
  );
});

test("冻结幂等：重复调用返回同一事件、同一快照哈希", () => {
  const reg = buildRegistry();
  const sid = oneSeries(reg);
  const f1 = freezeSeries(reg, sid, "r1", "rel-1");
  const f2 = freezeSeries(reg, sid, "r1", "rel-1");
  assert.equal(f1, f2);
  assert.equal(reg.store.ofType("RELEASE_FROZEN").length, 1);
  const release = reg.publication.getRelease("rel-1");
  assert.equal(release.snapshot[sid].points[0].value, 10);
});

test("已被取代的序列不能冻结", () => {
  const reg = buildRegistry();
  const sid = oneSeries(reg);
  reg.publication.confirmQuality(sid, "甲");
  reg.publication.approveUse(sid, "乙", "r1", "用途");
  reg.computation.supersedeSeries(sid, "series-fake-next", "重算");
  assert.throws(
    () => reg.publication.freezeRelease({ releaseId: "rel-2", planningReviewId: "r1", seriesIds: [sid] }),
    /已被/
  );
});

test("迟到修订只追加：原快照不变，报告只收到修订影响追加", () => {
  const reg = buildRegistry();

  // 边界 + 口径 + 2021/2022 数据
  reg.lineage.approveBoundary({
    geography_id: "geo-city", boundary_version: 1, predecessor_version: null, name: "市辖区",
    members: ["g-a"], effective_from: "2021-01-01T00:00:00+08:00", change_note: "单区"
  });
  reg.lineage.approveDefinition(definitionV1());
  reg.ingestion.submitBatch({
    batch_id: "b-2021", indicator_id: ID, source_id: "src-ledger",
    observations: [{ geography_id: "g-a", period: "2021", numerator: 100, denominator: 1000 }]
  });
  reg.ingestion.submitBatch({
    batch_id: "b-2022", indicator_id: ID, source_id: "src-ledger",
    observations: [{ geography_id: "g-a", period: "2022", numerator: 110, denominator: 1000 }]
  });
  const first = reg.computation.runJob({
    job_id: "job-a", indicator_id: ID, definition_version: 1,
    target_boundary_version: "geo-city:1", periods: ["2021", "2022"]
  });
  freezeSeries(reg, first.series_id, "review-5y", "rel-5y");
  reg.publication.recordReportReference({ reportId: "rpt-1", releaseId: "rel-5y", reportName: "慢病五年规划评估报告" });
  const originalHash = reg.publication.getRelease("rel-5y").snapshot_hash;
  const originalValue = reg.publication.getRelease("rel-5y").snapshot[first.series_id].points.find((p) => p.period === "2022").value;

  // 迟到补报：2022 分子 110 -> 115（未发布的新作业重算）
  reg.clock.advance({ days: 200 });
  reg.ingestion.submitBatch({
    batch_id: "b-2022-corr", indicator_id: ID, source_id: "src-ledger", is_late: true, supersedes_batch_id: "b-2022",
    observations: [{ geography_id: "g-a", period: "2022", numerator: 115, denominator: 1000 }]
  });
  const recomputed = reg.computation.runJob({
    job_id: "job-b", indicator_id: ID, definition_version: 1,
    target_boundary_version: "geo-city:1", periods: ["2021", "2022"]
  });
  assert.notEqual(recomputed.series_id, first.series_id);
  reg.publication.confirmQuality(recomputed.series_id, "甲", "迟到补报复核通过");

  // 未质量确认不得追加修订
  const unconfirmed = reg.computation.runJob({
    job_id: "job-c", indicator_id: ID, definition_version: 1,
    target_boundary_version: "geo-city:1", periods: ["2021"]
  });
  assert.throws(
    () => reg.publication.appendRevision({
      release_id: "rel-5y", old_series_id: first.series_id, new_series_id: unconfirmed.series_id,
      statistician: "甲", business_owner: "乙", impact: "x"
    }),
    /须先经统计负责人质量确认/
  );

  reg.publication.appendRevision({
    release_id: "rel-5y",
    old_series_id: first.series_id,
    new_series_id: recomputed.series_id,
    statistician: "甲",
    business_owner: "乙",
    impact: "2022 年规范管理率由 11.00% 修正为 11.50%，五年趋势方向不变，不影响评审结论"
  });

  // 原快照不改写
  const release = reg.publication.getRelease("rel-5y");
  assert.equal(release.snapshot_hash, originalHash);
  assert.equal(release.snapshot[first.series_id].points.find((p) => p.period === "2022").value, originalValue);
  assert.equal(release.revisions.length, 1);
  assert.equal(release.revisions[0].trigger, "late_report");

  // 报告只追加
  const report = reg.publication.getReport("rpt-1");
  assert.equal(report.revisions_appended.length, 1);
  assert.match(report.revisions_appended[0].impact, /11.50%/);
});
