import assert from "node:assert/strict";
import test from "node:test";

import {
  BOUNDARY_NEW,
  INDICATOR,
  adoptMergeScheme,
  feedPeriod,
  makePlatform,
  newBoundaryValues,
  oldBoundaryValues,
  registerDefV1,
} from "./helpers.js";

test("自动计算只产出候选序列，不产生任何发布", () => {
  const p = makePlatform();
  registerDefV1(p);
  feedPeriod(p, { period: "2021", values: oldBoundaryValues() });

  p.startComputation({ job_id: "JOB-1", indicator_id: INDICATOR, periods: ["2021"] });
  const entry = p.state.candidates.get(`${INDICATOR}|2021`);
  assert.equal(entry.status, "candidate");
  assert.ok(Math.abs(entry.value - (1850 / 2300) * 100) < 1e-9);
  assert.equal(p.state.releases.size, 0);
  assert.equal(p.store.byAggregate("publication_release", "REL-1").length, 0);
});

test("跨边界期间使用已采纳换算方案，谱系记录方案与残差", () => {
  const p = makePlatform();
  registerDefV1(p, { boundary_basis: BOUNDARY_NEW }); // 口径站在现行边界
  adoptMergeScheme(p);
  feedPeriod(p, { period: "2021", values: oldBoundaryValues() }); // 历史数据按旧边界上报

  p.startComputation({ job_id: "JOB-2", indicator_id: INDICATOR, periods: ["2021"] });
  const entry = p.state.candidates.get(`${INDICATOR}|2021`);
  assert.equal(entry.status, "candidate");
  assert.equal(entry.boundary_basis, BOUNDARY_NEW);
  assert.equal(entry.schemes_used.length, 1);
  assert.equal(entry.schemes_used[0].scheme_id, "SCH-MERGE-1");
  assert.equal(entry.residual.num, 0);
  assert.deepEqual(entry.batch_ids.sort(), ["B-2021-东城", "B-2021-南湖", "B-2021-西城"].sort());
});

test("迟到补报触发未发布序列重算，历史计算事件全部保留", () => {
  const p = makePlatform();
  registerDefV1(p);
  feedPeriod(p, { period: "2021", values: oldBoundaryValues() });
  p.startComputation({ job_id: "JOB-3", indicator_id: INDICATOR, periods: ["2021"] });
  const before = p.state.candidates.get(`${INDICATOR}|2021`).value;

  // 时钟越过截止时间后，南湖补报更大数据
  p.advanceClockTo("2026-02-10T09:00:00+08:00");
  const late = p.submitObservation({
    batch_id: "B-2021-南湖-补报",
    source_id: "SRC-2021",
    region_id: "南湖",
    num: 480,
    den: 500,
    boundary_basis: "区划2020",
  });
  assert.equal(late.is_late, true);

  const after = p.state.candidates.get(`${INDICATOR}|2021`);
  assert.equal(after.status, "candidate");
  assert.ok(Math.abs(after.value - (1880 / 2300) * 100) < 1e-9);
  assert.notEqual(after.value, before);

  const computeEvents = p.store.byAggregate("candidate_series", `${INDICATOR}:2021`);
  assert.equal(computeEvents.length, 2); // 初算 + 重算，都留痕
  // 旧批次被取代但仍在日志中
  const oldBatch = p.state.batches.get("B-2021-南湖");
  assert.equal(oldBatch.superseded_by, "B-2021-南湖-补报");
});

test("质量规则在候选条目上落标记", () => {
  const p = makePlatform();
  registerDefV1(p); // min_denominator = 100
  feedPeriod(p, { period: "2021", values: { 南湖: { num: 40, den: 50 } } });

  p.startComputation({ job_id: "JOB-4", indicator_id: INDICATOR, periods: ["2021"] });
  const entry = p.state.candidates.get(`${INDICATOR}|2021`);
  assert.equal(entry.status, "candidate");
  assert.ok(entry.quality_flags.some((f) => f.kind === "min_denominator"));
});

test("分母为零得到空值与质量标记，而不是异常", () => {
  const p = makePlatform();
  registerDefV1(p, { quality_rules: [] });
  feedPeriod(p, { period: "2021", values: { 南湖: { num: 0, den: 0 } } });

  p.startComputation({ job_id: "JOB-5", indicator_id: INDICATOR, periods: ["2021"] });
  const entry = p.state.candidates.get(`${INDICATOR}|2021`);
  assert.equal(entry.value, null);
  assert.ok(entry.quality_flags.some((f) => f.kind === "formula_not_finite"));
});
