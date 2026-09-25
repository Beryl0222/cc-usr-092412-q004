import assert from "node:assert/strict";
import test from "node:test";

import { convertValues } from "../src/boundaries.js";
import {
  BOUNDARY_NEW,
  BOUNDARY_OLD,
  INDICATOR,
  adoptMergeScheme,
  feedPeriod,
  makePlatform,
  oldBoundaryValues,
  registerDefV1,
} from "./helpers.js";

test("合并换算守恒：输入合计等于输出合计加残差", () => {
  const p = makePlatform();
  adoptMergeScheme(p);
  const scheme = p.state.schemes.get("SCH-MERGE-1");

  const input = {
    东城: { num: 800, den: 1000 },
    西城: { num: 600, den: 800 },
    南湖: { num: 450, den: 500 },
  };
  const { values, residual, conserved } = convertValues(scheme, input);
  assert.equal(conserved, true);
  assert.equal(values["城中"].num, 1400);
  assert.equal(values["城中"].den, 1800);
  assert.equal(values["南湖"].num, 450);
  assert.equal(residual.num, 0);
});

test("拆分方案权重不足 1 且未说明残差去向时被拒绝", () => {
  const p = makePlatform();
  assert.throws(
    () =>
      p.adoptConversionScheme({
        scheme_id: "SCH-SPLIT-BAD",
        kind: "split",
        from_boundary: BOUNDARY_OLD,
        to_boundary: BOUNDARY_NEW,
        mappings: [
          { from_region: "东城", to_region: "城中", weight: 0.7 },
          { from_region: "西城", to_region: "城中", weight: 1 },
          { from_region: "南湖", to_region: "南湖", weight: 1 },
        ],
        evidence: "区划调整公告",
      }),
    /未分摊残差.*必须说明/,
  );
});

test("拆分方案超分配（权重合计大于 1）被拒绝", () => {
  const p = makePlatform();
  assert.throws(
    () =>
      p.adoptConversionScheme({
        scheme_id: "SCH-OVER",
        kind: "split",
        from_boundary: BOUNDARY_OLD,
        to_boundary: BOUNDARY_NEW,
        mappings: [
          { from_region: "东城", to_region: "城中", weight: 0.8 },
          { from_region: "东城", to_region: "南湖", weight: 0.5 },
        ],
        evidence: "区划调整公告",
      }),
    /超过守恒上限/,
  );
});

test("带说明的残差可以入账，换算结果明确报告残差量", () => {
  const p = makePlatform();
  p.adoptConversionScheme({
    scheme_id: "SCH-SPLIT-1",
    kind: "split",
    from_boundary: BOUNDARY_OLD,
    to_boundary: BOUNDARY_NEW,
    mappings: [
      { from_region: "东城", to_region: "城中", weight: 0.9 },
      { from_region: "西城", to_region: "城中", weight: 1 },
      { from_region: "南湖", to_region: "南湖", weight: 1 },
    ],
    residuals: [{ from_region: "东城", residual: 0.1, explanation: "飞地常住人口无法归属任何新街道，单列不分摊" }],
    evidence: "区划调整公告",
  });
  const scheme = p.state.schemes.get("SCH-SPLIT-1");
  const { values, residual, conserved } = convertValues(scheme, {
    东城: { num: 800, den: 1000 },
    西城: { num: 600, den: 800 },
    南湖: { num: 450, den: 500 },
  });
  assert.equal(conserved, true);
  assert.ok(Math.abs(values["城中"].num - (720 + 600)) < 1e-9);
  assert.ok(Math.abs(residual.num - 80) < 1e-9);
  assert.ok(Math.abs(residual.den - 100) < 1e-9);
});

test("冲突的换算方案进入待决队列，计算挂起，裁决后自动补算", () => {
  const p = makePlatform();
  // 口径站在新边界，历史数据按旧边界上报，必须换算
  registerDefV1(p, { boundary_basis: BOUNDARY_NEW });
  adoptMergeScheme(p);
  feedPeriod(p, { period: "2021", values: oldBoundaryValues() });

  // 另一来源给出权重不同的冲突方案
  const queued = p.adoptConversionScheme({
    scheme_id: "SCH-MERGE-ALT",
    kind: "merge",
    from_boundary: BOUNDARY_OLD,
    to_boundary: BOUNDARY_NEW,
    mappings: [
      { from_region: "东城", to_region: "城中", weight: 0.95 },
      { from_region: "西城", to_region: "城中", weight: 1 },
      { from_region: "南湖", to_region: "南湖", weight: 1 },
    ],
    residuals: [{ from_region: "东城", residual: 0.05, explanation: "争议地块人口暂缓分摊" }],
    evidence: "另一来源的测算稿",
  });
  assert.equal(queued.status, "queued");
  assert.equal(p.state.conflicts.get(queued.conflict_id).status, "pending");

  // 冲突待决期间，该边界对的计算挂起，不静默沿用任何一方
  p.startComputation({ job_id: "JOB-C1", indicator_id: INDICATOR, periods: ["2021"] });
  const blocked = p.state.candidates.get(`${INDICATOR}|2021`);
  assert.equal(blocked.status, "pending_conflict");
  assert.equal(blocked.conflict_id, queued.conflict_id);

  // 裁决：改用新方案，旧方案作废，挂起的条目自动补算
  p.resolveConflict({
    conflict_id: queued.conflict_id,
    winning_scheme_id: "SCH-MERGE-ALT",
    resolved_by: "统计负责人-王某",
    note: "以最新人口普查底册为准",
  });
  assert.equal(p.state.schemes.get("SCH-MERGE-ALT").status, "adopted");
  assert.equal(p.state.schemes.get("SCH-MERGE-1").status, "rejected");

  const entry = p.state.candidates.get(`${INDICATOR}|2021`);
  assert.equal(entry.status, "candidate");
  assert.equal(entry.schemes_used[0].scheme_id, "SCH-MERGE-ALT");
  // 东城按 0.95 分摊，残差 0.05 入账：(800*0.95+600+450)/(1000*0.95+800+500)*100
  assert.ok(Math.abs(entry.value - (1810 / 2250) * 100) < 1e-9);
  assert.ok(Math.abs(entry.residual.num - 40) < 1e-9);
});

test("缺少换算方案时计算挂起为 missing_conversion，方案落地后自动补算", () => {
  const p = makePlatform();
  registerDefV1(p, { boundary_basis: BOUNDARY_NEW });
  feedPeriod(p, { period: "2021", values: oldBoundaryValues() });

  p.startComputation({ job_id: "JOB-M1", indicator_id: INDICATOR, periods: ["2021"] });
  const blocked = p.state.candidates.get(`${INDICATOR}|2021`);
  assert.equal(blocked.status, "missing_conversion");
  assert.deepEqual(blocked.needed_conversion, { from: BOUNDARY_OLD, to: BOUNDARY_NEW });

  adoptMergeScheme(p);
  const entry = p.state.candidates.get(`${INDICATOR}|2021`);
  assert.equal(entry.status, "candidate");
  // (800+600+450)/(1000+800+500)*100
  assert.ok(Math.abs(entry.value - (1850 / 2300) * 100) < 1e-9);
  assert.equal(entry.schemes_used[0].scheme_id, "SCH-MERGE-1");
});
