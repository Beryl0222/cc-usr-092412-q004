/**
 * 健康规划指标口径库 —— 领域事件词汇表
 *
 * 事件一旦追加即不可变：更正一律通过后继事件表达（新版本、追加修订），
 * 不允许原地改写任何已发布记录。
 */

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

export const AGGREGATE_TYPES = [
  "indicator_definition", // 指标口径（含版本谱系）
  "geography_boundary", // 行政区划边界（含版本）
  "conversion_scheme", // 跨边界换算方案（合并/拆分，含依据）
  "data_source", // 数据源（到期时间、复核期限）
  "observation_batch", // 上报批次（含迟到补报）
  "conflict", // 待决冲突
  "candidate_series", // 候选序列（自动计算产物，未批准前不得发布）
  "computation_job", // 计算作业（可故障恢复）
  "publication_release", // 面向某次规划评审的冻结数据包
  "report_reference", // 引用了冻结包的报告（只追加修订影响）
  "target_commitment" // 目标值（基线保留）
] as const;

export type AggregateType = (typeof AGGREGATE_TYPES)[number];

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  // 口径谱系
  "DEFINITION_APPROVED", // 指标口径新版本生效（公式/分子分母来源/适用人群/地域边界/质量规则）
  "DEFINITION_DEPRECATED", // 口径版本停用
  "GEOGRAPHY_BOUNDARY_APPROVED", // 地域边界新版本生效
  "CONVERSION_SCHEME_APPROVED", // 跨边界换算方案生效（含依据、权重、残差处理）
  // 数据源与上报
  "DATA_SOURCE_REGISTERED", // 登记数据源（含到期与复核期限）
  "DATA_SOURCE_RENEWED", // 到期后续期
  "OBSERVATION_SUBMITTED", // 上报一批观察值（is_late=true 表示迟到补报）
  "CONFLICT_RECORDED", // 相互冲突且无更正链的来源进入待决队列
  "CONFLICT_RESOLVED", // 冲突裁决（记录依据与胜出批次）
  // 自动计算
  "JOB_REGISTERED", // 计算作业登记（含全部输入批次指纹）
  "JOB_STEP_COMPLETED", // 作业步骤完成（崩溃恢复据此续跑）
  "JOB_COMPLETED", // 作业完成
  "JOB_FAILED", // 作业失败（记录断点）
  "CANDIDATE_SERIES_PROPOSED", // 产出候选序列（未确认，不可发布）
  "CANDIDATE_SERIES_SUPERSEDED", // 候选序列被重算结果取代
  "QUALITY_REVIEWED", // 质量规则自动评估结果
  // 批准与冻结发布
  "QUALITY_CONFIRMED", // 统计负责人确认质量
  "USE_APPROVED", // 业务负责人批准用途（面向某次规划评审）
  "RELEASE_PROPOSED", // 冻结数据包提案
  "RELEASE_FROZEN", // 数据包冻结发布（快照哈希，幂等）
  "RELEASE_REVISED", // 已发布包只追加修订影响，不改写原快照
  "REPORT_REFERENCE_RECORDED", // 登记报告对冻结包的引用
  "REPORT_REVISION_APPENDED", // 向已引用报告追加修订影响
  "TARGET_ASSIGNED" // 目标值下达（基线保留）
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** 领域事件信封。payload 携带各事件类型的具体内容。 */
export interface DomainEvent {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number; // 该聚合内的单调版本号
  summary: string;
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 口径谱系
// ---------------------------------------------------------------------------

/** 指标口径的一个不可变版本。 */
export interface IndicatorDefinitionVersion {
  definition_id: string;
  definition_version: number;
  predecessor_version: number | null;
  formula: string; // 计算公式，例如 "numerator / denominator * 1000"
  numerator_source: string; // 分子来源（数据源/台账标识与口径）
  denominator_source: string; // 分母来源与分母定义版本
  denominator_definition_version: string; // 分母定义修订版本号
  applicable_population: string; // 适用人群
  boundary_version: string; // 适用地域边界版本
  quality_rules: string[]; // 质量规则标识列表
  change_note: string; // 与上一版本差异（可比/不可比判定依据之一）
  effective_from: string;
}

export interface GeographyBoundaryVersion {
  geography_id: string; // 边界集标识，例如 geo-city（同一地域体系的版本序列）
  boundary_version: number;
  predecessor_version: number | null;
  name: string;
  members: string[]; // 该版本包含的基层区划标识
  effective_from: string;
  change_note: string; // 合并/拆分/隶属调整说明
}

/**
 * 跨边界换算方案。
 * mappings 描述 source -> target 的计数分摊权重；
 * 对每个来源，流出权重之和必须满足 0 < sum ≤ 1（守恒）：缺口份额即无法归属
 * 到任何目标区划的部分，换算时连同整数取整尾差一并记入残差，不得静默丢弃。
 */
export interface ConversionScheme {
  scheme_id: string;
  indicator_id: string;
  from_boundary_version: string;
  to_boundary_version: string;
  component: "numerator" | "denominator" | "both";
  mappings: ConversionMapping[];
  residual_policy: "report_only" | "hold_unallocated"; // 残差处理：仅披露 / 挂起不参与计算
  basis: string; // 换算依据（人口普查、台账、区划文件等）
  effective_from: string;
}

export interface ConversionMapping {
  source_geography_id: string;
  target_geography_id: string;
  weight: number; // 0..1；同一 source 流出权重之和 ≤ 1，缺口为无法归属份额
}

// ---------------------------------------------------------------------------
// 数据源与上报
// ---------------------------------------------------------------------------

export interface DataSource {
  source_id: string;
  name: string;
  expires_at: string; // 到期时间（由可控时钟判定）
  review_due_after_days: number; // 复核期限：数据上报后 N 天内须完成质量确认
}

export interface Observation {
  geography_id: string;
  period: string; // 统计期，例如 2022 年
  numerator: number;
  denominator: number;
}

// ---------------------------------------------------------------------------
// 候选序列与质量
// ---------------------------------------------------------------------------

export interface CandidatePoint {
  period: string;
  geography_id: string;
  value: number | null; // null 表示因残差/冲突/缺数无法计算
  numerator: number;
  denominator: number;
  unallocated_residual_numerator: number; // 无法分摊的残差（分子计数）
  unallocated_residual_denominator: number; // 无法分摊的残差（分母计数）
  input_batch_ids: string[];
  conversion_scheme_id: string | null; // 实际使用的换算方案（分子/分母可能不同，以 + 连接）
  source_boundary_version: string | null;
  target_boundary_version: string;
  quality_rule_results: Record<string, boolean>;
  notes: string[];
}

export interface CandidateSeries {
  series_id: string;
  indicator_id: string;
  definition_version: number;
  denominator_definition_version: string;
  boundary_version: string;
  applicable_population: string;
  formula: string;
  points: CandidatePoint[];
  input_fingerprint: string; // 全部输入批次的指纹（含期范围，重算幂等依据）
  superseded_by: string | null;
  quality_confirmed: boolean;
  use_approved: boolean;
  proposed_at: string;
}

// ---------------------------------------------------------------------------
// 冻结发布
// ---------------------------------------------------------------------------

export interface ReleaseRevision {
  revision_id: string;
  release_id: string;
  old_series_id: string;
  new_series_id: string;
  trigger: "late_report";
  impact: string; // 修订影响说明（数值差异、是否影响评审结论）
  confirmed_by: string;
  acknowledged_by: string;
  appended_at: string;
}

export interface FrozenPackage {
  release_id: string;
  planning_review_id: string;
  series_ids: string[];
  snapshot: Record<string, CandidateSeries>; // 深拷贝冻结，永不改写
  snapshot_hash: string;
  frozen_at: string;
  revisions: ReleaseRevision[]; // 读取时拼接的追加修订（不在快照内）
}
