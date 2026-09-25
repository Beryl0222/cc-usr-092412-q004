import { IndicatorRegistry } from "../src/app.js";

/**
 * 构建一套带标准基线的测试夹具：
 * 指标 ind-htn（高血压规范管理率）、边界族 geo-city（v1 三区 / v2 两区合并）、
 * 两个数据源。各测试可在此基础上自行登记口径版本与换算方案。
 */
export function buildRegistry(clockIso = "2026-01-01T00:00:00+08:00") {
  const reg = new IndicatorRegistry({ clockIso });

  reg.ingestion.registerDataSource({
    source_id: "src-ledger",
    name: "慢病随访台账",
    expires_at: "2026-06-30T23:59:59+08:00",
    review_due_after_days: 30
  });
  reg.ingestion.registerDataSource({
    source_id: "src-archive",
    name: "居民电子健康档案",
    expires_at: "2026-06-30T23:59:59+08:00",
    review_due_after_days: 30
  });

  return reg;
}

export const INDICATOR = "ind-htn";

export function definitionV1(overrides = {}) {
  return {
    definition_id: INDICATOR,
    definition_version: 1,
    predecessor_version: null,
    formula: "RATE_PER_100",
    numerator_source: "慢病随访台账（年度合格随访人数）",
    denominator_source: "居民电子健康档案（年末在管人数）",
    denominator_definition_version: "DEN-2021",
    applicable_population: "辖区全部建档高血压患者",
    boundary_version: "geo-city:1",
    quality_rules: ["denominator_nonzero", "residual_within_5pct", "source_not_expired", "no_unresolved_conflict", "review_not_overdue"],
    change_note: "首次发布",
    effective_from: "2021-01-01T00:00:00+08:00",
    ...overrides
  };
}

/** 走完整双签闸门并冻结单个序列。 */
export function freezeSeries(reg, seriesId, planningReviewId, releaseId = `rel-${planningReviewId}`) {
  reg.publication.confirmQuality(seriesId, "统计负责人甲", "自动规则全部通过，同意确认");
  reg.publication.approveUse(seriesId, "业务负责人乙", planningReviewId, "五年规划评审趋势比较");
  return reg.publication.freezeRelease({
    releaseId,
    planningReviewId,
    seriesIds: [seriesId]
  });
}
