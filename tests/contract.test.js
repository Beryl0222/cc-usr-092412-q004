import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
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

const load = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8").then(JSON.parse);

test("样例符合领域约定", async () => {
  const sample = await load("data/sample.json");
  assert.deepEqual(validateEvent(sample), []);
});

test("冻结发布包样例符合领域约定", async () => {
  const sample = await load("data/sample-release.json");
  assert.deepEqual(validateEvent(sample), []);
});

test("平台真实产出的每一类事件都符合契约枚举与信封约定", async () => {
  const schema = await load("contracts/domain.schema.json");
  const eventTypes = new Set(schema.properties.event_type.enum);
  const aggregateTypes = new Set(schema.properties.aggregate_type.enum);

  // 跑一遍覆盖全部机制的五年场景
  const p = makePlatform();
  registerDefV1(p);
  adoptMergeScheme(p);
  registerDefV2(p);
  feedPeriod(p, { period: "2021", values: oldBoundaryValues() });
  feedPeriod(p, { period: "2024", boundary: "区划2025", values: newBoundaryValues() });
  p.startComputation({ job_id: "JOB-CONTRACT", indicator_id: INDICATOR, periods: ["2021", "2024"] });
  p.reviewQuality({ indicator_id: INDICATOR, reviewer: "统计负责人-王某", decision: "pass" });
  p.approveUsage({ indicator_id: INDICATOR, approver: "业务负责人-赵某", review_id: "PLAN-X" });
  p.freezeRelease({ release_id: "REL-C", indicator_id: INDICATOR, review_id: "PLAN-X", periods: ["2021", "2024"], frozen_by: "平台主管" });
  p.advanceClockTo("2026-02-10T09:00:00+08:00");
  p.submitObservation({
    batch_id: "B-2021-南湖-补报",
    source_id: "SRC-2021",
    region_id: "南湖",
    num: 480,
    den: 500,
    boundary_basis: "区划2020",
  });
  // 另起一个始终未经复核的任务，让复核期限事件到期触发
  p.openComputation({ job_id: "JOB-NOREVIEW", indicator_id: "DM-CONTROL", periods: ["2025"] });
  p.advanceClockTo("2026-05-01T00:00:00+08:00");

  assert.ok(p.store.count() > 0);
  const seenTypes = new Set();
  for (const event of p.store.all()) {
    assert.deepEqual(validateEvent(event), [], `事件 ${event.event_id} 信封不完整`);
    assert.ok(eventTypes.has(event.event_type), `事件类型不在契约中：${event.event_type}`);
    assert.ok(aggregateTypes.has(event.aggregate_type), `聚合类型不在契约中：${event.aggregate_type}`);
    seenTypes.add(event.event_type);
  }
  // 关键机制确实都被这场演练覆盖到了
  for (const expected of [
    "DEFINITION_REGISTERED",
    "DEFINITION_APPROVED",
    "CONVERSION_SCHEME_ADOPTED",
    "SOURCE_REGISTERED",
    "OBSERVATION_SUBMITTED",
    "COMPUTATION_JOB_STARTED",
    "CANDIDATE_COMPUTED",
    "QUALITY_REVIEWED",
    "USAGE_APPROVED",
    "RELEASE_FROZEN",
    "RELEASE_REVISED",
    "REVIEW_DEADLINE_PASSED",
  ]) {
    assert.ok(seenTypes.has(expected), `场景未覆盖事件类型：${expected}`);
  }
});
