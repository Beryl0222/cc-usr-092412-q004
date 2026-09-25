import { validateEvent } from "./validator.js";

/**
 * 追加式事件日志。
 *
 * 事件一旦被接收，其标识、发生时间和版本不得原地改写；业务更正只能产生
 * 后继事件。相同 event_id 的重复提交被幂等忽略——这是故障恢复后
 * "继续计算而不重复发布"的底层保证之一。
 */
export function createEventStore() {
  const events = [];
  const ids = new Set();

  return {
    /**
     * 追加事件。返回 { duplicate, event }：
     * duplicate 为 true 表示该 event_id 已被接收，本次为幂等重放。
     */
    append(event) {
      const errors = validateEvent(event);
      if (errors.length > 0) throw new Error(`事件不符合约定：${errors.join("；")}`);
      if (ids.has(event.event_id)) {
        return { duplicate: true, event: events.find((e) => e.event_id === event.event_id) };
      }
      ids.add(event.event_id);
      const stored = Object.freeze({ ...event, seq: events.length + 1 });
      events.push(stored);
      return { duplicate: false, event: stored };
    },
    all: () => [...events],
    byAggregate: (aggregateType, aggregateId) =>
      events.filter((e) => e.aggregate_type === aggregateType && e.aggregate_id === aggregateId),
    count: () => events.length,
  };
}
