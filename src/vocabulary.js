/**
 * 与 src/domain.ts 保持同步的事件/聚合类型词汇（纯 JS 侧使用）。
 * domain.ts 是 TypeScript 类型；本文件供 Node 直接运行的服务与校验器引用。
 */
export const AGGREGATE_TYPES = [
  "indicator_definition",
  "geography_boundary",
  "conversion_scheme",
  "data_source",
  "observation_batch",
  "conflict",
  "candidate_series",
  "computation_job",
  "publication_release",
  "report_reference",
  "target_commitment"
];

export const EVENT_TYPES = [
  "DEFINITION_APPROVED",
  "DEFINITION_DEPRECATED",
  "GEOGRAPHY_BOUNDARY_APPROVED",
  "CONVERSION_SCHEME_APPROVED",
  "DATA_SOURCE_REGISTERED",
  "DATA_SOURCE_RENEWED",
  "OBSERVATION_SUBMITTED",
  "CONFLICT_RECORDED",
  "CONFLICT_RESOLVED",
  "JOB_REGISTERED",
  "JOB_STEP_COMPLETED",
  "JOB_COMPLETED",
  "JOB_FAILED",
  "CANDIDATE_SERIES_PROPOSED",
  "CANDIDATE_SERIES_SUPERSEDED",
  "QUALITY_REVIEWED",
  "QUALITY_CONFIRMED",
  "USE_APPROVED",
  "RELEASE_PROPOSED",
  "RELEASE_FROZEN",
  "RELEASE_REVISED",
  "REPORT_REFERENCE_RECORDED",
  "REPORT_REVISION_APPENDED",
  "TARGET_ASSIGNED"
];
