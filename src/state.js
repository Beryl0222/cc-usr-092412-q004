/**
 * 读模型投影。
 *
 * 状态完全由事件日志推导：任何时候都可以清空后按序重放重建，
 * 这是故障恢复"继续未完成计算而不重复发布"的基础。
 * 本模块只做纯状态迁移，不产生新事件。
 */

export function emptyState() {
  return {
    eventCounts: new Map(), // "aggregate_type:aggregate_id" -> 已接收事件数（即版本号来源）
    definitions: new Map(), // indicator_id -> [口径版本]
    schemes: new Map(), // scheme_id -> 换算方案
    conflicts: new Map(), // conflict_id -> 待决冲突
    sources: new Map(), // source_id -> 数据源
    batches: new Map(), // batch_id -> 观测批次
    jobs: new Map(), // job_id -> 计算任务
    candidates: new Map(), // "indicator_id|period" -> 最新候选条目
    candidateSeqs: new Map(), // "indicator_id|period" -> 已计算次数
    reviews: new Map(), // indicator_id -> [质量复核]
    approvals: new Map(), // "indicator_id|review_id" -> 用途批准
    releases: new Map(), // release_id -> 冻结发布包
    revisions: new Map(), // release_id -> [修订影响]
  };
}

export function candidateKey(indicatorId, period) {
  return `${indicatorId}|${period}`;
}

export function applyEvent(state, event) {
  const countKey = `${event.aggregate_type}:${event.aggregate_id}`;
  state.eventCounts.set(countKey, (state.eventCounts.get(countKey) ?? 0) + 1);
  const p = event.payload ?? {};

  switch (event.event_type) {
    case "DEFINITION_REGISTERED": {
      const list = state.definitions.get(event.aggregate_id) ?? [];
      list.push({
        ...p,
        indicator_id: event.aggregate_id,
        status: "draft",
        registered_at: event.occurred_at,
      });
      state.definitions.set(event.aggregate_id, list);
      break;
    }

    case "DEFINITION_APPROVED": {
      const list = state.definitions.get(event.aggregate_id) ?? [];
      const target = list.find((v) => v.version === p.version);
      if (target) {
        target.status = "approved";
        target.approved_by = p.approved_by;
        target.approved_at = event.occurred_at;
        for (const v of list) {
          if (v.version < p.version && v.status === "approved") v.status = "superseded";
        }
      }
      break;
    }

    case "CONVERSION_SCHEME_ADOPTED": {
      state.schemes.set(event.aggregate_id, {
        ...p,
        scheme_id: event.aggregate_id,
        status: "adopted",
        adopted_at: event.occurred_at,
      });
      break;
    }

    case "CONVERSION_CONFLICT_QUEUED": {
      const pending = { ...p.pending_scheme, status: "pending" };
      state.schemes.set(pending.scheme_id, pending);
      state.conflicts.set(event.aggregate_id, {
        conflict_id: event.aggregate_id,
        pending_scheme_id: pending.scheme_id,
        existing_scheme_id: p.existing_scheme_id,
        status: "pending",
        queued_at: event.occurred_at,
      });
      break;
    }

    case "CONVERSION_CONFLICT_RESOLVED": {
      const conflict = state.conflicts.get(p.conflict_id);
      if (conflict) {
        conflict.status = "resolved";
        conflict.winning_scheme_id = p.winning_scheme_id;
        conflict.resolved_by = p.resolved_by;
        conflict.resolved_at = event.occurred_at;
        conflict.note = p.note;
        const pending = state.schemes.get(conflict.pending_scheme_id);
        const existing = state.schemes.get(conflict.existing_scheme_id);
        if (p.winning_scheme_id === conflict.pending_scheme_id) {
          if (pending) {
            pending.status = "adopted";
            pending.adopted_at = event.occurred_at;
          }
          if (existing) existing.status = "rejected";
        } else {
          if (pending) pending.status = "rejected";
        }
      }
      break;
    }

    case "SOURCE_REGISTERED": {
      state.sources.set(event.aggregate_id, {
        ...p,
        source_id: event.aggregate_id,
        expired: false,
        registered_at: event.occurred_at,
      });
      break;
    }

    case "SOURCE_EXPIRED": {
      const source = state.sources.get(event.aggregate_id);
      if (source) {
        source.expired = true;
        source.expired_at = event.occurred_at;
      }
      break;
    }

    case "OBSERVATION_SUBMITTED": {
      // 同一数据源同一地区的后继批次取代先前批次，但历史批次全部保留在日志中。
      for (const old of state.batches.values()) {
        if (
          old.source_id === p.source_id &&
          old.region_id === p.region_id &&
          old.period === p.period &&
          !old.superseded_by
        ) {
          old.superseded_by = event.aggregate_id;
        }
      }
      state.batches.set(event.aggregate_id, {
        ...p,
        batch_id: event.aggregate_id,
        submitted_at: event.occurred_at,
      });
      break;
    }

    case "COMPUTATION_JOB_STARTED": {
      state.jobs.set(event.aggregate_id, {
        ...p,
        job_id: event.aggregate_id,
        started_at: event.occurred_at,
        deadline_passed: false,
      });
      break;
    }

    case "CANDIDATE_COMPUTED": {
      const key = candidateKey(p.entry.indicator_id, p.entry.period);
      state.candidates.set(key, { ...p.entry, computed_at: event.occurred_at });
      state.candidateSeqs.set(key, (state.candidateSeqs.get(key) ?? 0) + 1);
      break;
    }

    case "QUALITY_REVIEWED": {
      const list = state.reviews.get(p.indicator_id) ?? [];
      list.push({ ...p, reviewed_at: event.occurred_at });
      state.reviews.set(p.indicator_id, list);
      break;
    }

    case "USAGE_APPROVED": {
      state.approvals.set(`${p.indicator_id}|${p.review_id}`, {
        ...p,
        approved_at: event.occurred_at,
      });
      break;
    }

    case "REVIEW_DEADLINE_PASSED": {
      const job = state.jobs.get(p.job_id);
      if (job) job.deadline_passed = true;
      break;
    }

    case "RELEASE_FROZEN": {
      state.releases.set(event.aggregate_id, {
        ...p,
        release_id: event.aggregate_id,
        frozen_at: event.occurred_at,
      });
      break;
    }

    case "RELEASE_REVISED": {
      const list = state.revisions.get(event.aggregate_id) ?? [];
      list.push({ ...p, revised_at: event.occurred_at });
      state.revisions.set(event.aggregate_id, list);
      break;
    }

    default:
      // TARGET_ASSIGNED 等其余事件不影响本读模型。
      break;
  }
}
