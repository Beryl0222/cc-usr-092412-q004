import assert from "node:assert/strict";
import test from "node:test";

import { buildRegistry, INDICATOR, definitionV1 } from "./helpers.js";

test("数据源到期与续期由可控时钟判定", () => {
  const reg = buildRegistry("2026-01-01T00:00:00+08:00");
  assert.equal(reg.ingestion.isExpired("src-ledger"), false);
  reg.clock.advance({ days: 200 });
  assert.equal(reg.ingestion.isExpired("src-ledger"), true);
  reg.ingestion.renewDataSource("src-ledger", "2027-06-30T23:59:59+08:00", "完成系统对接复核");
  assert.equal(reg.ingestion.isExpired("src-ledger"), false);
  assert.equal(reg.ingestion.getDataSource("src-ledger").expires_at, "2027-06-30T23:59:59+08:00");
});

test("上报批次记录复核期限与指纹；迟到补报有标记", () => {
  const reg = buildRegistry("2026-01-01T00:00:00+08:00");
  reg.ingestion.submitBatch({
    batch_id: "b1",
    indicator_id: INDICATOR,
    source_id: "src-ledger",
    observations: [{ geography_id: "g-a", period: "2021", numerator: 100, denominator: 1000 }]
  });
  const b1 = reg.ingestion.getBatch("b1");
  assert.equal(b1.is_late, false);
  assert.equal(b1.review_deadline, "2026-01-30T16:00:00.000Z");
  assert.ok(b1.batch_fingerprint);

  reg.clock.advance({ days: 400 });
  reg.ingestion.submitBatch({
    batch_id: "b1-late",
    indicator_id: INDICATOR,
    source_id: "src-ledger",
    is_late: true,
    supersedes_batch_id: "b1",
    observations: [{ geography_id: "g-a", period: "2021", numerator: 102, denominator: 1001 }]
  });
  assert.equal(reg.ingestion.getBatch("b1-late").is_late, true);
});

test("相互冲突且无更正链的来源进入待决队列；裁决后败出批次被剔除", () => {
  const reg = buildRegistry();
  reg.ingestion.submitBatch({
    batch_id: "b-qa",
    indicator_id: INDICATOR,
    source_id: "src-ledger",
    observations: [{ geography_id: "g-a", period: "2022", numerator: 100, denominator: 1000 }]
  });
  reg.ingestion.submitBatch({
    batch_id: "b-qa2",
    indicator_id: INDICATOR,
    source_id: "src-archive",
    observations: [{ geography_id: "g-a", period: "2022", numerator: 160, denominator: 1200 }]
  });
  const found = reg.ingestion.detectConflicts(INDICATOR);
  assert.equal(found.length, 1);
  assert.equal(reg.ingestion.openConflicts().length, 1);

  reg.ingestion.resolveConflict(found[0].payload.conflict_id, "b-qa", "以随访台账原始记录为准，档案数为口径外估算", "统计负责人甲");
  assert.equal(reg.ingestion.openConflicts().length, 0);

  assert.throws(
    () => reg.ingestion.resolveConflict(found[0].payload.conflict_id, "b-not-party", "x", "y"),
    /胜出批次必须是冲突当事批次/
  );
});

test("存在更正链的批次不报冲突", () => {
  const reg = buildRegistry();
  reg.ingestion.submitBatch({
    batch_id: "b-old",
    indicator_id: INDICATOR,
    source_id: "src-ledger",
    observations: [{ geography_id: "g-a", period: "2022", numerator: 100, denominator: 1000 }]
  });
  reg.ingestion.submitBatch({
    batch_id: "b-new",
    indicator_id: INDICATOR,
    source_id: "src-ledger",
    supersedes_batch_id: "b-old",
    observations: [{ geography_id: "g-a", period: "2022", numerator: 101, denominator: 1000 }]
  });
  assert.deepEqual(reg.ingestion.detectConflicts(INDICATOR), []);
});

test("复核期限：超期未确认的批次触发质量规则；经确认覆盖后不再报警", () => {
  const reg = buildRegistry("2026-01-01T00:00:00+08:00");
  reg.lineage.approveBoundary({
    geography_id: "geo-city", boundary_version: 1, predecessor_version: null, name: "市辖区",
    members: ["g-a"], effective_from: "2021-01-01", change_note: "x"
  });
  reg.lineage.approveDefinition({
    ...definitionV1(),
    quality_rules: ["denominator_nonzero", "review_not_overdue"]
  });
  reg.ingestion.submitBatch({
    batch_id: "b1", indicator_id: INDICATOR, source_id: "src-ledger",
    observations: [{ geography_id: "g-a", period: "2021", numerator: 100, denominator: 1000 }]
  });

  reg.clock.advance({ days: 31 }); // 超过 30 天复核期限
  const late = reg.computation.runJob({
    job_id: "job-overdue", indicator_id: INDICATOR, definition_version: 1,
    target_boundary_version: "geo-city:1", periods: ["2021"]
  });
  assert.equal(reg.computation.getSeries(late.series_id).points[0].quality_rule_results.review_not_overdue, false);

  // 统计负责人履行确认（即使超期也可研判后确认）
  reg.publication.confirmQuality(late.series_id, "统计负责人甲", "超期复核，数据核对无误");

  // 新作业追加 2022 期（在复核窗口内上报），重算含 2021 的序列：
  // 已确认覆盖的 b1 不再被标记超期
  reg.ingestion.submitBatch({
    batch_id: "b2", indicator_id: INDICATOR, source_id: "src-ledger",
    observations: [{ geography_id: "g-a", period: "2022", numerator: 101, denominator: 1000 }]
  });
  const rerun = reg.computation.runJob({
    job_id: "job-rerun", indicator_id: INDICATOR, definition_version: 1,
    target_boundary_version: "geo-city:1", periods: ["2021", "2022"]
  });
  const points = Object.fromEntries(reg.computation.getSeries(rerun.series_id).points.map((p) => [p.period, p]));
  assert.equal(points["2021"].quality_rule_results.review_not_overdue, true);
  assert.equal(points["2022"].quality_rule_results.review_not_overdue, true);
});
