import crypto from "node:crypto";

/**
 * 仅追加事件存储。
 *
 * - append 幂等：同一 event_id 重复追加直接返回既有事件（故障恢复时安全重放）。
 * - 同一聚合内 version 必须严格递增，防止乱序覆盖。
 * - 快照可序列化，进程崩溃后用 fromSnapshot 恢复全部未完成计算，
 *   已完成步骤不会重复执行，也不会重复发布。
 */
export class EventStore {
  #events = [];
  #byId = new Map();
  #aggregateVersion = new Map();

  /**
   * @param {object} event 完整领域事件（event_id/event_type/aggregate_type/aggregate_id/occurred_at/version/summary/payload?）
   * @returns {object} 实际存储中的事件
   */
  append(event) {
    const existing = this.#byId.get(event.event_id);
    if (existing) return existing; // 幂等：崩溃恢复重放同一事件

    const current = this.#aggregateVersion.get(event.aggregate_id) ?? 0;
    if (event.version !== current + 1) {
      throw new Error(
        `事件版本乱序：聚合 ${event.aggregate_id} 期望 version=${current + 1}，收到 ${event.version}（event_id=${event.event_id}）`
      );
    }
    const stored = deepFreeze({ ...event });
    this.#events.push(stored);
    this.#byId.set(stored.event_id, stored);
    this.#aggregateVersion.set(stored.aggregate_id, stored.version);
    return stored;
  }

  /** @param {(event: object) => void} fn 按追加顺序回放 */
  replay(fn) {
    for (const event of this.#events) fn(event);
  }

  /** @param {string} aggregateId */
  forAggregate(aggregateId) {
    return this.#events.filter((e) => e.aggregate_id === aggregateId);
  }

  /** @param {string} eventType */
  ofType(eventType) {
    return this.#events.filter((e) => e.event_type === eventType);
  }

  get all() {
    return [...this.#events];
  }

  /** @returns {{events: object[]}} 可持久化快照 */
  toJSON() {
    return { events: this.#events.map((e) => ({ ...e })) };
  }

  /**
   * 从快照恢复（例如故障恢复）。
   * @param {{events?: object[]}} snapshot
   * @returns {EventStore}
   */
  static fromSnapshot(snapshot = {}) {
    const store = new EventStore();
    for (const event of snapshot.events ?? []) store.append(event);
    return store;
  }
}

/**
 * 计算稳定指纹：用于候选序列输入指纹与冻结快照哈希。
 * @param {unknown} value
 * @returns {string}
 */
export function fingerprint(value) {
  return crypto.createHash("sha256").update(canonicalize(value)).digest("hex");
}

/** 确定性 JSON 规范序列化：对象键排序，避免键序差异导致指纹漂移。 */
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 递归冻结：已存储事件（含 payload）在运行时不可被任何代码原地改写。 */
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
