import { requireFields } from "./util.js";

/**
 * 数据源与观测批次。
 *
 * 数据源登记时声明应报地区、截止时间与到期时间；批次按实际到达时间
 * 与截止时间比较标记迟到（is_late）。迟到与更正批次只产生后继记录，
 * 是否触发重算由平台层决定。
 */

export function registerSource(ctx, input) {
  requireFields(input, ["source_id", "indicator_id", "period", "regions", "due_at", "expires_at"]);
  if (!Array.isArray(input.regions) || input.regions.length === 0) {
    throw new Error("数据源必须声明应报地区列表");
  }
  ctx.emit(
    "SOURCE_REGISTERED",
    "data_source",
    input.source_id,
    `登记数据源 ${input.source_id}（${input.indicator_id} ${input.period}）`,
    { ...input },
  );
  return { source_id: input.source_id };
}

export function submitObservation(ctx, input) {
  requireFields(input, ["batch_id", "source_id", "region_id", "num", "den", "boundary_basis"]);
  const source = ctx.state.sources.get(input.source_id);
  if (!source) throw new Error(`未知数据源：${input.source_id}`);
  if (!source.regions.includes(input.region_id)) {
    throw new Error(`地区 ${input.region_id} 不在数据源 ${input.source_id} 的应报范围内`);
  }
  const isLate = ctx.clock.nowMs() > Date.parse(source.due_at);
  ctx.emit(
    "OBSERVATION_SUBMITTED",
    "regional_observation",
    input.batch_id,
    `接收观测批次 ${input.batch_id}（${source.indicator_id} ${source.period} ${input.region_id}${isLate ? "，迟到" : ""}）`,
    {
      ...input,
      indicator_id: source.indicator_id,
      period: source.period,
      is_late: isLate,
    },
  );
  return { batch_id: input.batch_id, is_late: isLate };
}

/** 某指标某期间当前有效的批次（未被后继批次取代）。 */
export function activeBatches(state, indicatorId, period) {
  return [...state.batches.values()].filter(
    (b) => b.indicator_id === indicatorId && b.period === period && !b.superseded_by,
  );
}

/** 数据源是否已齐（全部应报地区都有有效批次）。 */
export function sourceFulfilled(state, source) {
  return source.regions.every((region) =>
    [...state.batches.values()].some((b) => b.source_id === source.source_id && b.region_id === region && !b.superseded_by),
  );
}
