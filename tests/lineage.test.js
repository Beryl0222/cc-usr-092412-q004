import assert from "node:assert/strict";
import test from "node:test";

import { ControlledClock } from "../src/clock.js";
import { EventStore } from "../src/event-store.js";
import { LineageService } from "../src/lineage.js";
import { INDICATOR, definitionV1 } from "./helpers.js";

function makeLineage() {
  const clock = new ControlledClock();
  const store = new EventStore();
  return new LineageService(store, clock);
}

test("口径版本谱系：版本与前驱必须连续，不可变", () => {
  const lineage = makeLineage();
  lineage.approveDefinition(definitionV1());
  lineage.approveDefinition({
    ...definitionV1(),
    definition_version: 2,
    predecessor_version: 1,
    denominator_definition_version: "DEN-2023",
    change_note: "分母定义修订：年末在管→年内曾管理",
    effective_from: "2023-01-01T00:00:00+08:00"
  });
  assert.throws(() => lineage.approveDefinition({ ...definitionV1(), definition_version: 4, predecessor_version: 2 }), /下一版本应为 3/);
  assert.throws(() => lineage.approveDefinition({ ...definitionV1(), definition_version: 1, predecessor_version: null, change_note: "重复" }), /下一版本应为 3|不可变|版本/);

  const versions = lineage.definitionVersions(INDICATOR);
  assert.deepEqual(versions.map((v) => v.definition_version), [1, 2]);
  assert.equal(lineage.effectiveDefinition(INDICATOR, "2022-12-31T00:00:00+08:00").definition_version, 1);
  assert.equal(lineage.effectiveDefinition(INDICATOR, "2023-06-01T00:00:00+08:00").definition_version, 2);
});

test("换算方案守恒：流出权重和必须在 (0,1]，必须有依据", () => {
  const lineage = makeLineage();
  const good = {
    scheme_id: "sc-1",
    indicator_id: INDICATOR,
    from_boundary_version: "geo-city:1",
    to_boundary_version: "geo-city:2",
    component: "both",
    mappings: [
      { source_geography_id: "g-a", target_geography_id: "g-x", weight: 0.6 },
      { source_geography_id: "g-a", target_geography_id: "g-y", weight: 0.4 },
      { source_geography_id: "g-b", target_geography_id: "g-x", weight: 0.9 }, // 10% 无法归属
      { source_geography_id: "g-c", target_geography_id: "g-y", weight: 1 }
    ],
    residual_policy: "report_only",
    basis: "2023 年行政区划调整文件 + 常住人口普查",
    effective_from: "2023-01-01T00:00:00+08:00"
  };
  lineage.approveConversionScheme(good);
  assert.throws(
    () => lineage.approveConversionScheme({ ...good, scheme_id: "sc-bad", basis: "x", mappings: [{ source_geography_id: "g-a", target_geography_id: "g-x", weight: 1.2 }] }),
    /权重必须在/
  );
  assert.throws(
    () => lineage.approveConversionScheme({ ...good, scheme_id: "sc-bad2", basis: "x", mappings: [
      { source_geography_id: "g-a", target_geography_id: "g-x", weight: 0.6 },
      { source_geography_id: "g-a", target_geography_id: "g-y", weight: 0.6 }
    ] }),
    /不守恒/
  );
  assert.throws(() => lineage.approveConversionScheme({ ...good, scheme_id: "sc-nobasis", basis: "  " }), /依据/);
  assert.throws(() => lineage.approveConversionScheme(good), /已存在/);
});

test("换算执行守恒：分摊+残差恒等于输入，残差按来源披露", () => {
  const lineage = makeLineage();
  const scheme = {
    scheme_id: "sc-2",
    indicator_id: INDICATOR,
    from_boundary_version: "geo-city:1",
    to_boundary_version: "geo-city:2",
    component: "both",
    mappings: [
      { source_geography_id: "g-a", target_geography_id: "g-x", weight: 0.6 },
      { source_geography_id: "g-a", target_geography_id: "g-y", weight: 0.4 },
      { source_geography_id: "g-b", target_geography_id: "g-x", weight: 0.9 } // 10% 缺口
    ],
    residual_policy: "report_only",
    basis: "区划文件",
    effective_from: "2023-01-01T00:00:00+08:00"
  };
  lineage.approveConversionScheme(scheme);
  const counts = { "g-a": 101, "g-b": 100 };
  const r = lineage.applyConversion(scheme, counts);

  const allocatedTotal = Object.values(r.allocated).reduce((s, n) => s + n, 0);
  assert.equal(allocatedTotal + r.residual, 201, "守恒：分摊 + 残差 = 输入总量");
  // g-a: 60.6 -> 61 / 40.4 -> 40（最大余数补 x）；g-b: 90 + 残差 10
  assert.equal(r.allocated["g-x"], 61 + 90);
  assert.equal(r.allocated["g-y"], 40);
  assert.equal(r.residual, 10);
  assert.deepEqual(r.perSourceResidual, { "g-b": 10 });  assert.ok(r.detail.find((d) => d.source === "g-b").reason.includes("无归属依据"));
});

test("无映射来源整体进入残差且不丢失", () => {
  const lineage = makeLineage();
  const scheme = {
    scheme_id: "sc-3",
    indicator_id: INDICATOR,
    from_boundary_version: "geo-city:1",
    to_boundary_version: "geo-city:2",
    component: "numerator",
    mappings: [{ source_geography_id: "g-a", target_geography_id: "g-x", weight: 1 }],
    residual_policy: "hold_unallocated",
    basis: "区划文件",
    effective_from: "2023-01-01T00:00:00+08:00"
  };
  lineage.approveConversionScheme(scheme);
  const r = lineage.applyConversion(scheme, { "g-a": 50, "g-unknown": 7 });
  assert.equal(r.allocated["g-x"], 50);
  assert.equal(r.residual, 7);
  assert.equal(r.perSourceResidual["g-unknown"], 7);
});
