/** 健康规划指标口径库使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
}

/** 口径版本：公式、分子分母来源、适用人群、地域边界与质量规则的完整快照。 */
export interface DefinitionPayload {
  indicator_id: string;
  version: number;
  formula: string;
  numerator_source: Record<string, string>;
  denominator_source: Record<string, string>;
  population: string;
  boundary_basis: string;
  quality_rules: QualityRule[];
  effective_from: string;
  supersedes?: { version: number; comparable: boolean; note: string };
  registered_by: string;
}

export interface QualityRule {
  rule_id: string;
  kind: "min_denominator" | "max_residual_ratio" | "min_coverage";
  threshold: number;
  description?: string;
}

/** 边界换算方案：合并、拆分或重划；权重必须守恒，残差必须说明。 */
export interface ConversionSchemePayload {
  scheme_id: string;
  kind: "merge" | "split" | "redistrict";
  from_boundary: string;
  to_boundary: string;
  mappings: Array<{ from_region: string; to_region: string; weight: number }>;
  residuals?: Array<{ from_region: string; residual: number; explanation: string }>;
  evidence: string;
}

/** 候选条目：自动计算的唯一产物，未经双批准不得发布。 */
export interface CandidateEntry {
  indicator_id: string;
  period: string;
  status: "candidate" | "no_definition" | "no_data" | "missing_conversion" | "pending_conflict";
  value: number | null;
  definition_version?: number;
  boundary_basis?: string;
  schemes_used?: Array<{ scheme_id: string; from_boundary: string; to_boundary: string }>;
  batch_ids?: string[];
  quality_flags?: Array<{ kind: string; message: string }>;
}
