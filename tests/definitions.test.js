import assert from "node:assert/strict";
import test from "node:test";

import { definitionForPeriod } from "../src/definitions.js";
import { INDICATOR, makePlatform, registerDefV1, registerDefV2 } from "./helpers.js";

test("口径版本完整保存公式、分子分母来源、适用人群、边界与质量规则", () => {
  const p = makePlatform();
  registerDefV1(p);

  const v1 = definitionForPeriod(p.state, INDICATOR, "2021");
  assert.equal(v1.version, 1);
  assert.equal(v1.formula, "num/den*100");
  assert.equal(v1.numerator_source.system, "慢病随访系统");
  assert.equal(v1.denominator_source.description, "在管患者数");
  assert.match(v1.population, /35岁/);
  assert.equal(v1.boundary_basis, "区划2020");
  assert.equal(v1.quality_rules[0].kind, "min_denominator");
});

test("谱系：新版本批准后旧版本被取代但保留，各期间取对应版本", () => {
  const p = makePlatform();
  registerDefV1(p);
  registerDefV2(p);

  const versions = p.state.definitions.get(INDICATOR);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].status, "superseded");
  assert.equal(versions[1].status, "approved");
  assert.equal(versions[1].supersedes.comparable, false);

  assert.equal(definitionForPeriod(p.state, INDICATOR, "2022").version, 1);
  assert.equal(definitionForPeriod(p.state, INDICATOR, "2024").version, 2);
});

test("登记新版本必须声明与上一版本的可比关系", () => {
  const p = makePlatform();
  registerDefV1(p);
  assert.throws(
    () =>
      p.registerDefinition({
        indicator_id: INDICATOR,
        formula: "num/den*100",
        numerator_source: {},
        denominator_source: {},
        population: "同上",
        boundary_basis: "区划2020",
        effective_from: "2024",
        registered_by: "统计科-李某",
      }),
    /可比关系/,
  );
});

test("未批准的口径版本对计算不可见", () => {
  const p = makePlatform();
  p.registerDefinition({
    indicator_id: INDICATOR,
    formula: "num/den*100",
    numerator_source: {},
    denominator_source: {},
    population: "测试人群",
    boundary_basis: "区划2020",
    effective_from: "2021",
    registered_by: "统计科-李某",
  });
  // 只登记不批准：计算结果为 no_definition
  const result = p.startComputation({ job_id: "JOB-1", indicator_id: INDICATOR, periods: ["2021"] });
  assert.deepEqual(result.remaining, []);
  assert.equal(p.state.candidates.get(`${INDICATOR}|2021`).status, "no_definition");

  // 批准后自动补算（无数据则为 no_data，但不再是 no_definition）
  p.approveDefinition({ indicator_id: INDICATOR, version: 1, approved_by: "统计负责人-王某" });
  assert.equal(p.state.candidates.get(`${INDICATOR}|2021`).status, "no_data");
});
