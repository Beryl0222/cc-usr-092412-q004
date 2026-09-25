import assert from "node:assert/strict";
import test from "node:test";

import { INDICATOR, feedPeriod, makePlatform, oldBoundaryValues, registerDefV1 } from "./helpers.js";

const REVIEW_ID = "PLAN-2026-中期评审";

function readyPlatform() {
  const p = makePlatform();
  registerDefV1(p);
  feedPeriod(p, { period: "2021", values: oldBoundaryValues() });
  p.startComputation({ job_id: "JOB-R1", indicator_id: INDICATOR, periods: ["2021"] });
  return p;
}

test("缺少质量确认不能冻结", () => {
  const p = readyPlatform();
  p.approveUsage({ indicator_id: INDICATOR, approver: "业务负责人-赵某", review_id: REVIEW_ID });
  assert.throws(
    () => p.freezeRelease({ release_id: "REL-1", indicator_id: INDICATOR, review_id: REVIEW_ID, periods: ["2021"], frozen_by: "平台主管" }),
    /质量确认/,
  );
});

test("缺少用途批准不能冻结", () => {
  const p = readyPlatform();
  p.reviewQuality({ indicator_id: INDICATOR, reviewer: "统计负责人-王某", decision: "pass" });
  assert.throws(
    () => p.freezeRelease({ release_id: "REL-1", indicator_id: INDICATOR, review_id: REVIEW_ID, periods: ["2021"], frozen_by: "平台主管" }),
    /用途批准/,
  );
});

test("双批准齐备后冻结成功，快照携带完整谱系", () => {
  const p = readyPlatform();
  p.reviewQuality({ indicator_id: INDICATOR, reviewer: "统计负责人-王某", decision: "pass", notes: "分母充足" });
  p.approveUsage({ indicator_id: INDICATOR, approver: "业务负责人-赵某", review_id: REVIEW_ID });
  const { release } = p.freezeRelease({
    release_id: "REL-1",
    indicator_id: INDICATOR,
    review_id: REVIEW_ID,
    periods: ["2021"],
    frozen_by: "平台主管-钱某",
  });

  assert.equal(release.review_id, REVIEW_ID);
  const entry = release.entries[0];
  assert.ok(Math.abs(entry.value - (1850 / 2300) * 100) < 1e-9);
  assert.equal(entry.definition_version, 1);
  assert.equal(entry.boundary_basis, "区划2020");
  assert.equal(entry.batch_ids.length, 3);
  assert.equal(release.quality_review.reviewer, "统计负责人-王某");
  assert.equal(release.usage_approval.approver, "业务负责人-赵某");
});

test("质量确认后候选序列发生变化，必须重新复核才能冻结", () => {
  const p = readyPlatform();
  p.reviewQuality({ indicator_id: INDICATOR, reviewer: "统计负责人-王某", decision: "pass" });
  p.approveUsage({ indicator_id: INDICATOR, approver: "业务负责人-赵某", review_id: REVIEW_ID });

  // 复核之后又有补报，候选值改变
  p.advanceClockTo("2026-02-10T09:00:00+08:00");
  p.submitObservation({
    batch_id: "B-2021-南湖-补报",
    source_id: "SRC-2021",
    region_id: "南湖",
    num: 480,
    den: 500,
    boundary_basis: "区划2020",
  });

  assert.throws(
    () => p.freezeRelease({ release_id: "REL-1", indicator_id: INDICATOR, review_id: REVIEW_ID, periods: ["2021"], frozen_by: "平台主管" }),
    /重新复核/,
  );

  // 重新复核后即可冻结
  p.reviewQuality({ indicator_id: INDICATOR, reviewer: "统计负责人-王某", decision: "pass", notes: "确认补报" });
  const { release } = p.freezeRelease({
    release_id: "REL-1",
    indicator_id: INDICATOR,
    review_id: REVIEW_ID,
    periods: ["2021"],
    frozen_by: "平台主管",
  });
  assert.ok(Math.abs(release.entries[0].value - (1880 / 2300) * 100) < 1e-9);
});

test("冻结后迟到补报只追加修订影响，冻结快照不改写", () => {
  const p = readyPlatform();
  p.reviewQuality({ indicator_id: INDICATOR, reviewer: "统计负责人-王某", decision: "pass" });
  p.approveUsage({ indicator_id: INDICATOR, approver: "业务负责人-赵某", review_id: REVIEW_ID });
  p.freezeRelease({ release_id: "REL-1", indicator_id: INDICATOR, review_id: REVIEW_ID, periods: ["2021"], frozen_by: "平台主管" });
  const frozenValue = p.state.releases.get("REL-1").entries[0].value;

  p.advanceClockTo("2026-02-10T09:00:00+08:00");
  p.submitObservation({
    batch_id: "B-2021-南湖-补报",
    source_id: "SRC-2021",
    region_id: "南湖",
    num: 480,
    den: 500,
    boundary_basis: "区划2020",
  });

  // 冻结值不变
  assert.equal(p.state.releases.get("REL-1").entries[0].value, frozenValue);
  // 修订影响已追加
  const revisions = p.state.revisions.get("REL-1");
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].period, "2021");
  assert.equal(revisions[0].previous_value, frozenValue);
  assert.ok(Math.abs(revisions[0].revised_value - (1880 / 2300) * 100) < 1e-9);
  assert.ok(Math.abs(revisions[0].delta - revisions[0].revised_value + frozenValue) < 1e-9);
  // 候选序列已重算，发布包未改写
  assert.ok(Math.abs(p.state.candidates.get(`${INDICATOR}|2021`).value - (1880 / 2300) * 100) < 1e-9);
});

test("同一 release_id 重复冻结幂等，不重复发布", () => {
  const p = readyPlatform();
  p.reviewQuality({ indicator_id: INDICATOR, reviewer: "统计负责人-王某", decision: "pass" });
  p.approveUsage({ indicator_id: INDICATOR, approver: "业务负责人-赵某", review_id: REVIEW_ID });
  const first = p.freezeRelease({ release_id: "REL-1", indicator_id: INDICATOR, review_id: REVIEW_ID, periods: ["2021"], frozen_by: "平台主管" });
  const second = p.freezeRelease({ release_id: "REL-1", indicator_id: INDICATOR, review_id: REVIEW_ID, periods: ["2021"], frozen_by: "平台主管" });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(p.store.byAggregate("publication_release", "REL-1").filter((e) => e.event_type === "RELEASE_FROZEN").length, 1);
});
