import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ControlledClock } from "../src/clock.js";
import { EventStore, fingerprint, canonicalize } from "../src/event-store.js";
import { validateEvent } from "../src/validator.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("可控时钟推进与到期判定", () => {
  const clock = new ControlledClock("2026-01-01T00:00:00+08:00");
  assert.equal(clock.isDue("2026-01-01T00:00:00+08:00"), true);
  assert.equal(clock.isDue("2026-01-02T00:00:00+08:00"), false);
  clock.advance({ days: 2 });
  assert.equal(clock.isDue("2026-01-02T00:00:00+08:00"), true);
  assert.equal(clock.reviewDeadline("2026-01-01T00:00:00Z", 30), "2026-01-31T00:00:00.000Z");
});

test("事件存储：版本递增、event_id 幂等、快照恢复", () => {
  const store = new EventStore();
  const base = {
    event_type: "DATA_SOURCE_REGISTERED",
    aggregate_type: "data_source",
    aggregate_id: "a1",
    occurred_at: "2026-01-01T00:00:00Z",
    summary: "s"
  };
  const e1 = store.append({ ...base, event_id: "x1", version: 1 });
  const e1Again = store.append({ ...base, event_id: "x1", version: 1 });
  assert.equal(e1, e1Again, "同一 event_id 必须幂等返回");

  assert.throws(() => store.append({ ...base, event_id: "x2", version: 3 }), /版本乱序/);

  store.append({ ...base, event_id: "x2", version: 2 });
  assert.throws(() => store.append({ ...base, event_id: "x3", version: 4 }), /版本乱序/);

  const restored = EventStore.fromSnapshot(JSON.parse(JSON.stringify(store.toJSON())));
  assert.equal(restored.all.length, 2);
  assert.equal(restored.append({ ...base, event_id: "x1", version: 1 }).event_id, "x1");
  assert.equal(restored.all.length, 2);
  assert.equal(restored.append({ ...base, event_id: "x1", version: 1 }).event_id, "x1");
});

test("指纹：键序无关且稳定", () => {
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
  assert.equal(canonicalize([1, { z: 2, a: 3 }]), "[1,{\"a\":3,\"z\":2}]");
});

test("校验器拒绝未知类型与坏版本", () => {
  assert.deepEqual(validateEvent({}), ["缺少字段：event_id", "缺少字段：event_type", "缺少字段：aggregate_type", "缺少字段：aggregate_id", "缺少字段：occurred_at", "缺少字段：version", "缺少字段：summary"]);
  const errors = validateEvent({
    event_id: "e",
    event_type: "NOPE",
    aggregate_type: "nope",
    aggregate_id: "a",
    occurred_at: "not-a-date",
    version: 0,
    summary: ""
  });
  assert.ok(errors.some((m) => m.includes("version")));
  assert.ok(errors.some((m) => m.includes("未知事件类型")));
  assert.ok(errors.some((m) => m.includes("未知聚合类型")));
  assert.ok(errors.some((m) => m.includes("occurred_at")));
});
