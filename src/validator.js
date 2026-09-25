import { AGGREGATE_TYPES, EVENT_TYPES } from "./vocabulary.js";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

/**
 * 校验领域事件信封及类型词汇。
 * 业务不变量（守恒、双签、幂等）由各领域服务负责；这里只保证结构合法。
 * @param {Record<string, unknown>} record
 * @returns {string[]} 错误信息列表，空数组表示通过
 */
export function validateEvent(record) {
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);

  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("event_type" in record && typeof record.event_type === "string" && !EVENT_TYPES.includes(record.event_type)) {
    errors.push(`未知事件类型：${record.event_type}`);
  }
  if (
    "aggregate_type" in record &&
    typeof record.aggregate_type === "string" &&
    !AGGREGATE_TYPES.includes(record.aggregate_type)
  ) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  }
  if (
    "occurred_at" in record &&
    typeof record.occurred_at === "string" &&
    Number.isNaN(new Date(record.occurred_at).getTime())
  ) {
    errors.push("occurred_at 必须是合法的日期时间");
  }
  if ("payload" in record && (record.payload === null || typeof record.payload !== "object" || Array.isArray(record.payload))) {
    errors.push("payload 必须是对象");
  }
  return errors;
}
