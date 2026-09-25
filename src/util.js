/** 小工具：字段校验与分组。 */

export function requireFields(input, fields) {
  const missing = fields.filter((name) => input[name] === undefined || input[name] === null || input[name] === "");
  if (missing.length > 0) throw new Error(`缺少必需字段：${missing.join("、")}`);
}

export function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}
