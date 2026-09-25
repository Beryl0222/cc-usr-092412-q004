"use strict";

/**
 * 受支持的指标公式。formula 字段保存公式标识；真实计算只允许走本表，
 * 不接受任意表达式，保证口径可审计。
 */
export const FORMULAS = {
  RATE_PER_100: { label: "百分率（%）", fn: (n, d) => (n / d) * 100 },
  RATE_PER_1000: { label: "千分率（‰）", fn: (n, d) => (n / d) * 1000 },
  RATIO: { label: "比值", fn: (n, d) => n / d }
};

/**
 * @param {string} formula 公式标识
 * @param {number} numerator
 * @param {number} denominator
 * @returns {number|null}
 */
export function computeValue(formula, numerator, denominator) {
  const entry = FORMULAS[formula];
  if (!entry) throw new Error(`未知公式标识：${formula}`);
  if (!Number.isFinite(denominator) || denominator === 0) return null;
  return entry.fn(numerator, denominator);
}
