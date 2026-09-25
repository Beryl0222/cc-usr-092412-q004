"use strict";

/**
 * 质量规则集。规则只做自动评估并产出证据；是否接受例外由统计负责人确认。
 * 每条规则返回 {passed, evidence}，证据进入候选序列血缘，供评审追溯。
 */
export const QUALITY_RULES = {
  denominator_nonzero: {
    label: "分母非零",
    evaluate: ({ denominator }) => ({
      passed: denominator > 0,
      evidence: `分母=${denominator}`
    })
  },

  residual_within_5pct: {
    label: "无法分摊残差占比 ≤ 5%（分子/分母分别考核取大者）",
    evaluate: ({ residualNumerator, residualDenominator, numerator, denominator }) => {
      const rateN = numerator + residualNumerator > 0 ? residualNumerator / (numerator + residualNumerator) : 0;
      const rateD = denominator + residualDenominator > 0 ? residualDenominator / (denominator + residualDenominator) : 0;
      const rate = Math.max(rateN, rateD);
      return {
        passed: rate <= 0.05,
        evidence: `残差率：分子 ${(rateN * 100).toFixed(2)}%、分母 ${(rateD * 100).toFixed(2)}%，取大 ${(rate * 100).toFixed(2)}%`
      };
    }
  },

  source_not_expired: {
    label: "计算时点数据源未到期",
    evaluate: ({ expiredSources }) => ({
      passed: expiredSources.length === 0,
      evidence: expiredSources.length ? `已到期来源：${expiredSources.join("、")}` : "全部来源在有效期内"
    })
  },

  no_unresolved_conflict: {
    label: "无未决来源冲突",
    evaluate: ({ conflictCellKeys, conflicts }) => {
      const hit = conflicts.filter((c) => conflictCellKeys.includes(`${c.indicator_id}|${c.period}`));
      return {
        passed: hit.length === 0,
        evidence: hit.length ? `未决冲突：${hit.map((c) => c.conflict_id).join("、")}` : "无未决冲突"
      };
    }
  },

  review_not_overdue: {
    label: "未超过复核期限",
    evaluate: ({ overdueBatches, nowIso }) => ({
      passed: overdueBatches.length === 0,
      evidence: overdueBatches.length
        ? `超复核期限批次：${overdueBatches.join("、")}（当前 ${nowIso}）`
        : `全部批次在复核期限内（当前 ${nowIso}）`
    })
  }
};

/**
 * 评估一个数据点的全部适用规则。
 * @param {string[]} ruleIds 口径版本声明的质量规则
 * @param {object} ctx 规则证据上下文
 * @returns {Record<string, {passed: boolean, evidence: string}>}
 */
export function evaluateRules(ruleIds, ctx) {
  const results = {};
  for (const id of ruleIds) {
    const rule = QUALITY_RULES[id];
    if (!rule) throw new Error(`未知质量规则：${id}`);
    results[id] = rule.evaluate(ctx);
  }
  return results;
}

/** @returns {boolean} 规则结果是否全部通过（缺失规则按未通过处理） */
export function allRulesPassed(ruleIds, resultMap) {
  return ruleIds.every((id) => resultMap[id]?.passed === true);
}
