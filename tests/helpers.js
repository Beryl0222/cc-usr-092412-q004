import { createPlatform } from "../src/platform.js";

/** 统一场景：高血压规范管理率，2021–2025 五年，2024 年区划调整。 */

export const INDICATOR = "HTN-MGMT";
export const BOUNDARY_OLD = "区划2020";
export const BOUNDARY_NEW = "区划2025";

export function makePlatform(clockStart = "2026-01-05T08:00:00+08:00", store) {
  return createPlatform(store ? { clockStart, store } : { clockStart });
}

export function registerDefV1(p, overrides = {}) {
  p.registerDefinition({
    indicator_id: INDICATOR,
    formula: "num/den*100",
    numerator_source: { system: "慢病随访系统", description: "规范管理人数" },
    denominator_source: { system: "基本公卫年报", description: "在管患者数" },
    population: "辖区内35岁及以上原发性高血压患者",
    boundary_basis: BOUNDARY_OLD,
    quality_rules: [{ rule_id: "q-den", kind: "min_denominator", threshold: 100 }],
    effective_from: "2021",
    registered_by: "统计科-李某",
    ...overrides,
  });
  p.approveDefinition({ indicator_id: INDICATOR, version: 1, approved_by: "统计负责人-王某" });
}

/** 登记并批准 v2：分母口径修订，声明与 v1 不可比。 */
export function registerDefV2(p, { comparable = false, boundary = BOUNDARY_NEW } = {}) {
  p.registerDefinition({
    indicator_id: INDICATOR,
    formula: "num/den*100",
    numerator_source: { system: "慢病随访系统", description: "规范管理人数" },
    denominator_source: { system: "公卫年报+门诊随访", description: "估算患者数（口径修订）" },
    population: "辖区内35岁及以上原发性高血压患者",
    boundary_basis: boundary,
    quality_rules: [{ rule_id: "q-den", kind: "min_denominator", threshold: 100 }],
    effective_from: "2024",
    supersedes: { version: 1, comparable, note: "分母定义修订：由在管患者数改为纳入门诊随访的估算患者数" },
    registered_by: "统计科-李某",
  });
  p.approveDefinition({ indicator_id: INDICATOR, version: 2, approved_by: "统计负责人-王某" });
}

/** 采纳合并方案：东城、西城并入城中，南湖保留。 */
export function adoptMergeScheme(p, schemeId = "SCH-MERGE-1") {
  return p.adoptConversionScheme({
    scheme_id: schemeId,
    kind: "merge",
    from_boundary: BOUNDARY_OLD,
    to_boundary: BOUNDARY_NEW,
    mappings: [
      { from_region: "东城", to_region: "城中", weight: 1 },
      { from_region: "西城", to_region: "城中", weight: 1 },
      { from_region: "南湖", to_region: "南湖", weight: 1 },
    ],
    evidence: "市民政局《关于东城西城街道合并的批复》（民发〔2023〕12号）",
  });
}

/** 登记某期间数据源并提交各地区的分子分母批次。 */
export function feedPeriod(p, { period, boundary = BOUNDARY_OLD, values, sourceId = `SRC-${period}` }) {
  p.registerSource({
    source_id: sourceId,
    indicator_id: INDICATOR,
    period,
    regions: Object.keys(values),
    due_at: "2026-02-01T00:00:00+08:00",
    expires_at: "2026-04-01T00:00:00+08:00",
  });
  for (const [region, v] of Object.entries(values)) {
    p.submitObservation({
      batch_id: `B-${period}-${region}`,
      source_id: sourceId,
      region_id: region,
      num: v.num,
      den: v.den,
      boundary_basis: boundary,
    });
  }
}

export function oldBoundaryValues() {
  return {
    东城: { num: 800, den: 1000 },
    西城: { num: 600, den: 800 },
    南湖: { num: 450, den: 500 },
  };
}

export function newBoundaryValues() {
  return {
    城中: { num: 1500, den: 1900 },
    南湖: { num: 480, den: 520 },
  };
}
