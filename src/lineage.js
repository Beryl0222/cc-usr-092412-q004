import { validateEvent } from "./validator.js";

/**
 * 口径谱系服务：管理指标口径版本、地域边界版本、跨边界换算方案。
 *
 * 不变量：
 * - 口径/边界/方案一经追加即不可变；修订产生新版本（谱系 predecessor_version）。
 * - 换算方案对每个来源区划的流出权重之和必须为 1（守恒）；
 *   实际换算时无法按整数计数分摊的部分必须显式记为残差，不得静默丢弃。
 */
export class LineageService {
  /**
   * @param {import("./event-store.js").EventStore} store
   * @param {import("./clock.js").ControlledClock} clock
   */
  constructor(store, clock) {
    this.store = store;
    this.clock = clock;
  }

  #append(event) {
    const errors = validateEvent(event);
    if (errors.length) throw new Error(`事件不合法：${errors.join("；")}`);
    return this.store.append(event);
  }

  // -- 指标口径版本 -------------------------------------------------------

  /**
   * 批准新口径版本。
   * @param {object} v 见 domain.ts IndicatorDefinitionVersion
   */
  approveDefinition(v) {
    const expected = this.#nextVersion(v.definition_id);
    if (v.definition_version !== expected) {
      throw new Error(`口径 ${v.definition_id} 下一版本应为 ${expected}，收到 ${v.definition_version}`);
    }
    if (v.predecessor_version !== (expected === 1 ? null : expected - 1)) {
      throw new Error("predecessor_version 必须指向上一版本，首版必须为 null");
    }
    return this.#append({
      event_id: `def-${v.definition_id}-v${v.definition_version}`,
      event_type: "DEFINITION_APPROVED",
      aggregate_type: "indicator_definition",
      aggregate_id: v.definition_id,
      occurred_at: this.clock.now(),
      version: expected,
      summary: `口径 ${v.definition_id} v${v.definition_version}：${v.change_note}`,
      payload: { ...v }
    });
  }

  deprecateDefinition(definitionId, reason) {
    const current = this.#nextVersion(definitionId) - 1;
    if (current < 1) throw new Error(`口径 ${definitionId} 不存在，无法停用`);
    return this.#append({
      event_id: `def-${definitionId}-deprecate-v${current + 1}`,
      event_type: "DEFINITION_DEPRECATED",
      aggregate_type: "indicator_definition",
      aggregate_id: definitionId,
      occurred_at: this.clock.now(),
      version: current + 1,
      summary: `口径 ${definitionId} 停用：${reason}`,
      payload: { definition_id: definitionId, reason }
    });
  }

  /** @returns {object[]} 该指标全部已批准版本（按版本升序） */
  definitionVersions(definitionId) {
    return this.store
      .forAggregate(definitionId)
      .filter((e) => e.event_type === "DEFINITION_APPROVED")
      .map((e) => e.payload);
  }

  getDefinition(definitionId, version) {
    const found = this.definitionVersions(definitionId).find((d) => d.definition_version === version);
    if (!found) throw new Error(`口径 ${definitionId} v${version} 不存在`);
    return found;
  }

  /** 某时点有效的口径版本（effective_from 不晚于该时点的最大版本）。 */
  effectiveDefinition(definitionId, atIso) {
    const t = new Date(atIso).getTime();
    const candidates = this.definitionVersions(definitionId).filter(
      (d) => new Date(d.effective_from).getTime() <= t
    );
    if (!candidates.length) return null;
    return candidates[candidates.length - 1];
  }

  // -- 地域边界版本 -------------------------------------------------------

  approveBoundary(b) {
    const expected = this.#nextVersion(b.geography_id);
    if (b.boundary_version !== expected) {
      throw new Error(`边界 ${b.geography_id} 下一版本应为 ${expected}，收到 ${b.boundary_version}`);
    }
    return this.#append({
      event_id: `geo-${b.geography_id}-v${b.boundary_version}`,
      event_type: "GEOGRAPHY_BOUNDARY_APPROVED",
      aggregate_type: "geography_boundary",
      aggregate_id: b.geography_id,
      occurred_at: this.clock.now(),
      version: expected,
      summary: `边界 ${b.geography_id} v${b.boundary_version}：${b.change_note}`,
      payload: { ...b }
    });
  }

  boundaryVersions(geographyId) {
    return this.store
      .forAggregate(geographyId)
      .filter((e) => e.event_type === "GEOGRAPHY_BOUNDARY_APPROVED")
      .map((e) => e.payload);
  }

  getBoundary(geographyId, version) {
    const found = this.boundaryVersions(geographyId).find((b) => b.boundary_version === version);
    if (!found) throw new Error(`边界 ${geographyId} v${version} 不存在`);
    return found;
  }

  // -- 跨边界换算方案 -----------------------------------------------------

  /**
   * 批准换算方案。
   * 守恒规则：对每个 source_geography_id，流出权重之和必须满足 0 < sum ≤ 1；
   * 与 1 的缺口即“有依据但无法归属到任何目标”的份额，换算时进入残差桶。
   * @param {object} scheme 见 domain.ts ConversionScheme
   */
  approveConversionScheme(scheme) {
    if (this.store.forAggregate(scheme.scheme_id).length) {
      throw new Error(`换算方案 ${scheme.scheme_id} 已存在（不可变）`);
    }
    const outflows = new Map();
    const seenPairs = new Set();
    for (const m of scheme.mappings) {
      if (!(m.weight >= 0 && m.weight <= 1)) {
        throw new Error(`权重必须在 [0,1]：${m.source_geography_id}->${m.target_geography_id}=${m.weight}`);
      }
      const pair = `${m.source_geography_id}>${m.target_geography_id}`;
      if (seenPairs.has(pair)) throw new Error(`重复映射：${pair}`);
      seenPairs.add(pair);
      outflows.set(m.source_geography_id, (outflows.get(m.source_geography_id) ?? 0) + m.weight);
    }
    for (const [source, sum] of outflows) {
      if (sum <= 0 || sum > 1 + 1e-9) {
        throw new Error(`换算不守恒：来源 ${source} 流出权重之和=${sum}，必须满足 0 < sum ≤ 1`);
      }
    }
    if (!scheme.basis || !scheme.basis.trim()) throw new Error("换算方案必须给出依据 basis");
    return this.#append({
      event_id: `scheme-${scheme.scheme_id}`,
      event_type: "CONVERSION_SCHEME_APPROVED",
      aggregate_type: "conversion_scheme",
      aggregate_id: scheme.scheme_id,
      occurred_at: this.clock.now(),
      version: 1,
      summary: `换算方案 ${scheme.scheme_id}（${scheme.from_boundary_version}→${scheme.to_boundary_version}，${scheme.component}）依据：${scheme.basis}`,
      payload: { ...scheme }
    });
  }

  getConversionScheme(schemeId) {
    const event = this.store.forAggregate(schemeId).find((e) => e.event_type === "CONVERSION_SCHEME_APPROVED");
    if (!event) throw new Error(`换算方案 ${schemeId} 不存在`);
    return event.payload;
  }

  /** 适用某指标、且起止边界版本匹配的换算方案（按追加顺序取最新）。 */
  findConversionScheme(indicatorId, fromBoundaryVersion, toBoundaryVersion, component) {
    return (
      this.store
        .ofType("CONVERSION_SCHEME_APPROVED")
        .map((e) => e.payload)
        .filter(
          (s) =>
            s.indicator_id === indicatorId &&
            s.from_boundary_version === fromBoundaryVersion &&
            s.to_boundary_version === toBoundaryVersion &&
            s.component === component
        )
        .at(-1) ?? null
    );
  }

  /**
   * 按方案把计数从来源区划分摊到目标区划（最大余数法）。
   *
   * 守恒保证：对每个来源，Σ allocated + residual ≡ 输入计数。
   * 残差来源：流出权重之和 < 1 时，缺口份额（如划到报告范围外、无归属依据的人口）
   * 与整数取整尾差一并进入残差桶，并按来源登记，绝不静默丢弃。
   *
   * @param {object} scheme ConversionScheme
   * @param {Record<string, number>} counts 来源区划计数
   * @returns {{allocated: Record<string, number>, residual: number, perSourceResidual: Record<string, number>, detail: object[]}}
   */
  applyConversion(scheme, counts) {
    const allocated = new Map();
    let residual = 0;
    const perSourceResidual = {};
    const detail = [];
    for (const [source, total] of Object.entries(counts)) {
      const flows = scheme.mappings.filter((m) => m.source_geography_id === source);
      if (!flows.length) {
        // 没有任何映射：整额无法分摊
        residual += total;
        perSourceResidual[source] = total;
        detail.push({ source, total, allocated: {}, residual: total, reason: "无换算映射" });
        continue;
      }
      const weightSum = flows.reduce((s, m) => s + m.weight, 0);
      const gap = 1 - weightSum; // 无法归属份额（可能为极小浮点误差，按 0 处理）

      // Hamilton 最大余数法：目标桶 + 残差桶同权参与，先整额后按小数部分补余，
      // 保证 Σ目标分摊 + 残差 ≡ 输入计数。
      const buckets = flows.map((m) => ({ kind: "target", key: m.target_geography_id, exact: total * m.weight, floor: Math.floor(total * m.weight) }));
      buckets.push({ kind: "residual", key: "__residual__", exact: total * gap, floor: Math.floor(total * gap + 1e-9) });
      let assigned = buckets.reduce((s, x) => s + x.floor, 0);
      let remainder = total - assigned;
      buckets.sort((a, b) => b.exact - b.floor - (a.exact - a.floor));
      for (const bucket of buckets) {
        if (remainder <= 0) break;
        bucket.floor += 1;
        remainder -= 1;
      }

      const sourceAllocated = {};
      let sourceResidual = 0;
      for (const bucket of buckets) {
        if (bucket.kind === "residual") {
          sourceResidual = bucket.floor;
          continue;
        }
        allocated.set(bucket.key, (allocated.get(bucket.key) ?? 0) + bucket.floor);
        sourceAllocated[bucket.key] = bucket.floor;
      }
      residual += sourceResidual;
      if (sourceResidual > 0) perSourceResidual[source] = sourceResidual;
      detail.push({
        source,
        total,
        allocated: sourceAllocated,
        residual: sourceResidual,
        reason: gap > 1e-9 ? `权重缺口份额 ${gap.toFixed(4)} 无归属依据` : "整数取整尾差"
      });
    }
    return { allocated: Object.fromEntries(allocated), residual, perSourceResidual, detail };
  }

  #nextVersion(aggregateId) {
    return this.store.forAggregate(aggregateId).length + 1;
  }
}
