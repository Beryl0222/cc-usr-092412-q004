import { createClock } from "./clock.js";
import { createEventStore } from "./store.js";
import { emptyState, applyEvent, candidateKey } from "./state.js";
import { registerDefinition, approveDefinition } from "./definitions.js";
import { adoptConversionScheme, resolveConflict } from "./boundaries.js";
import { registerSource, submitObservation, sourceFulfilled } from "./observations.js";
import { openComputation, startComputation, resumeComputation, computeNextPeriod, computePeriod, recomputeWhere } from "./compute.js";
import { reviewQuality, approveUsage, freezeRelease, appendRevisionIfFrozen } from "./releases.js";
import { explainValue, comparePeriods } from "./lineage.js";

/**
 * 指标平台门面。
 *
 * 所有命令经过同一个 emit 落事件：版本号按聚合递增、发生时间取自可控制
 * 时钟、重复 event_id 幂等忽略。状态是日志的投影，传入同一 store 重建
 * 平台即完成故障恢复——未完成的计算继续补算，已冻结的发布不会重复产生。
 */
export function createPlatform({ clockStart = "2026-01-01T00:00:00+08:00", store = createEventStore() } = {}) {
  const clock = createClock(clockStart);
  const state = emptyState();
  for (const e of store.all()) applyEvent(state, e);

  function emit(eventType, aggregateType, aggregateId, summary, payload, idHint) {
    const countKey = `${aggregateType}:${aggregateId}`;
    const version = (state.eventCounts.get(countKey) ?? 0) + 1;
    const event = {
      event_id: idHint ?? `${eventType}:${aggregateId}:${version}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: clock.now(),
      version,
      summary,
      payload,
    };
    const result = store.append(event);
    if (!result.duplicate) applyEvent(state, result.event);
    return result;
  }

  const ctx = { state, clock, store, emit };

  /** 迟到补报联动：已有候选条目的期间先重算，再向受影响的冻结包追加修订影响。 */
  function afterObservation(sourceId) {
    const source = state.sources.get(sourceId);
    if (!source) return;
    if (state.candidates.has(candidateKey(source.indicator_id, source.period))) {
      computePeriod(ctx, source.indicator_id, source.period, null);
      appendRevisionIfFrozen(ctx, source.indicator_id, source.period);
    }
  }

  /** 时钟推进后扫描：数据源到期、复核期限已过，各落一条事件（幂等）。 */
  function scanDeadlines() {
    const nowMs = clock.nowMs();
    for (const s of state.sources.values()) {
      if (s.expired || Date.parse(s.expires_at) >= nowMs) continue;
      if (sourceFulfilled(state, s)) continue;
      emit(
        "SOURCE_EXPIRED",
        "data_source",
        s.source_id,
        `数据源到期未报齐：${s.source_id}（${s.indicator_id} ${s.period}）`,
        { source_id: s.source_id, indicator_id: s.indicator_id, period: s.period },
        `expire:${s.source_id}`,
      );
    }
    for (const job of state.jobs.values()) {
      if (job.deadline_passed || !job.review_due_at) continue;
      if (Date.parse(job.review_due_at) >= nowMs) continue;
      const hasPass = (state.reviews.get(job.indicator_id) ?? []).some((r) => r.decision === "pass");
      if (hasPass) continue;
      emit(
        "REVIEW_DEADLINE_PASSED",
        "candidate_series",
        job.job_id,
        `复核期限已过：${job.indicator_id}（任务 ${job.job_id}）`,
        { job_id: job.job_id, indicator_id: job.indicator_id, review_due_at: job.review_due_at },
        `deadline:${job.job_id}`,
      );
    }
  }

  return {
    clock,
    store,
    state,

    // 口径谱系
    registerDefinition: (input) => registerDefinition(ctx, input),
    approveDefinition: (input) => {
      const result = approveDefinition(ctx, input);
      // 此前因无口径而搁置的条目可以补算了。
      recomputeWhere(ctx, (e) => e.indicator_id === input.indicator_id && e.status === "no_definition");
      return result;
    },

    // 边界换算
    adoptConversionScheme: (input) => {
      const result = adoptConversionScheme(ctx, input);
      if (result.status === "adopted") unblockConversion(ctx, input.from_boundary, input.to_boundary);
      return result;
    },
    resolveConflict: (input) => {
      const result = resolveConflict(ctx, input);
      const scheme = state.schemes.get(result.winning_scheme_id);
      if (scheme?.status === "adopted") unblockConversion(ctx, scheme.from_boundary, scheme.to_boundary);
      return result;
    },

    // 数据源与批次
    registerSource: (input) => registerSource(ctx, input),
    submitObservation: (input) => {
      const result = submitObservation(ctx, input);
      afterObservation(input.source_id);
      return result;
    },

    // 候选计算（可断点续算）
    openComputation: (input) => openComputation(ctx, input),
    startComputation: (input) => startComputation(ctx, input),
    resumeComputation: (jobId) => resumeComputation(ctx, jobId),
    computeNextPeriod: (jobId) => computeNextPeriod(ctx, jobId),

    // 复核、批准与冻结
    reviewQuality: (input) => reviewQuality(ctx, input),
    approveUsage: (input) => approveUsage(ctx, input),
    freezeRelease: (input) => freezeRelease(ctx, input),

    // 时钟
    advanceClockTo: (iso) => {
      clock.advanceTo(iso);
      scanDeadlines();
      return clock.now();
    },

    // 谱系与可比性
    explainValue: (input) => explainValue(ctx, input),
    comparePeriods: (input) => comparePeriods(ctx, input),
  };
}

/** 换算方案落地后，补算此前因缺方案或冲突待决而搁置的条目。 */
function unblockConversion(ctx, fromBoundary, toBoundary) {
  recomputeWhere(
    ctx,
    (e) =>
      (e.status === "missing_conversion" || e.status === "pending_conflict") &&
      e.needed_conversion?.from === fromBoundary &&
      e.needed_conversion?.to === toBoundary,
  );
}
