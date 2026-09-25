import assert from "node:assert/strict";
import test from "node:test";

import { createEventStore } from "../src/store.js";
import { INDICATOR, feedPeriod, makePlatform, oldBoundaryValues, registerDefV1 } from "./helpers.js";

test("故障恢复：重放日志后继续未完成计算，不重复计算已完成期间", () => {
  const store = createEventStore();
  const p1 = makePlatform("2026-01-05T08:00:00+08:00", store);
  registerDefV1(p1);
  feedPeriod(p1, { period: "2021", values: oldBoundaryValues() });
  feedPeriod(p1, { period: "2022", values: oldBoundaryValues() });
  feedPeriod(p1, { period: "2023", values: oldBoundaryValues() });

  // 只推进一个期间就"宕机"
  p1.openComputation({ job_id: "JOB-F1", indicator_id: INDICATOR, periods: ["2021", "2022", "2023"] });
  p1.computeNextPeriod("JOB-F1");
  assert.equal(p1.state.candidates.size, 1);

  // 用同一事件日志重建平台（恢复），继续补算
  const p2 = makePlatform("2026-01-05T08:00:00+08:00", store);
  assert.equal(p2.state.candidates.size, 1); // 状态从日志完整重建
  const result = p2.resumeComputation("JOB-F1");
  assert.deepEqual(result.computed.sort(), ["2022", "2023"]);
  assert.deepEqual(result.remaining, []);

  const computeEvents = store.all().filter((e) => e.event_type === "CANDIDATE_COMPUTED");
  assert.equal(computeEvents.length, 3); // 每个期间恰好一次
  assert.deepEqual(
    computeEvents.map((e) => e.payload.entry.period).sort(),
    ["2021", "2022", "2023"],
  );
});

test("故障恢复：已冻结的发布包不会因恢复而重复发布", () => {
  const store = createEventStore();
  const p1 = makePlatform("2026-01-05T08:00:00+08:00", store);
  registerDefV1(p1);
  feedPeriod(p1, { period: "2021", values: oldBoundaryValues() });
  p1.startComputation({ job_id: "JOB-F2", indicator_id: INDICATOR, periods: ["2021"] });
  p1.reviewQuality({ indicator_id: INDICATOR, reviewer: "统计负责人-王某", decision: "pass" });
  p1.approveUsage({ indicator_id: INDICATOR, approver: "业务负责人-赵某", review_id: "PLAN-X" });
  p1.freezeRelease({ release_id: "REL-F1", indicator_id: INDICATOR, review_id: "PLAN-X", periods: ["2021"], frozen_by: "平台主管" });

  // 恢复后重复执行同一冻结请求
  const p2 = makePlatform("2026-01-05T08:00:00+08:00", store);
  const again = p2.freezeRelease({ release_id: "REL-F1", indicator_id: INDICATOR, review_id: "PLAN-X", periods: ["2021"], frozen_by: "平台主管" });
  assert.equal(again.duplicate, true);
  assert.equal(store.all().filter((e) => e.event_type === "RELEASE_FROZEN").length, 1);
});

test("重复提交相同 event_id 的事件被幂等忽略", () => {
  const store = createEventStore();
  const event = {
    event_id: "evt-dup-1",
    event_type: "TARGET_ASSIGNED",
    aggregate_type: "target_commitment",
    aggregate_id: "T-1",
    occurred_at: "2026-01-05T00:00:00.000Z",
    version: 1,
    summary: "重复提交测试",
  };
  const first = store.append(event);
  const second = store.append(event);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(store.count(), 1);
});

test("可控制时钟推进数据源到期与复核期限", () => {
  const p = makePlatform();
  registerDefV1(p);
  // 数据源只报了一个地区，南湖始终缺报
  p.registerSource({
    source_id: "SRC-EXP",
    indicator_id: INDICATOR,
    period: "2021",
    regions: ["东城", "南湖"],
    due_at: "2026-02-01T00:00:00+08:00",
    expires_at: "2026-04-01T00:00:00+08:00",
  });
  p.submitObservation({ batch_id: "B-EXP-1", source_id: "SRC-EXP", region_id: "东城", num: 800, den: 1000, boundary_basis: "区划2020" });
  p.startComputation({ job_id: "JOB-EXP", indicator_id: INDICATOR, periods: ["2021"] });

  // 越过到期时间与复核期限（任务默认 30 天）
  p.advanceClockTo("2026-04-02T00:00:00+08:00");

  const expired = p.store.all().filter((e) => e.event_type === "SOURCE_EXPIRED");
  assert.equal(expired.length, 1);
  assert.equal(expired[0].aggregate_id, "SRC-EXP");
  assert.equal(p.state.sources.get("SRC-EXP").expired, true);

  const deadlines = p.store.all().filter((e) => e.event_type === "REVIEW_DEADLINE_PASSED");
  assert.equal(deadlines.length, 1);
  assert.equal(deadlines[0].payload.job_id, "JOB-EXP");

  // 再次推进时钟不重复落事件
  p.advanceClockTo("2026-04-10T00:00:00+08:00");
  assert.equal(p.store.all().filter((e) => e.event_type === "SOURCE_EXPIRED").length, 1);
  assert.equal(p.store.all().filter((e) => e.event_type === "REVIEW_DEADLINE_PASSED").length, 1);
});

test("复核期限内已通过质量复核的指标不落期限事件", () => {
  const p = makePlatform();
  registerDefV1(p);
  feedPeriod(p, { period: "2021", values: oldBoundaryValues() });
  p.startComputation({ job_id: "JOB-OK", indicator_id: INDICATOR, periods: ["2021"] });
  p.reviewQuality({ indicator_id: INDICATOR, reviewer: "统计负责人-王某", decision: "pass" });

  p.advanceClockTo("2026-04-02T00:00:00+08:00");
  assert.equal(p.store.all().filter((e) => e.event_type === "REVIEW_DEADLINE_PASSED").length, 0);
});
