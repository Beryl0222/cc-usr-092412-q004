"use strict";

/**
 * 可控时钟：领域内所有“到期 / 复核期限 / 事件发生时间”的判定都经由此时钟，
 * 测试可以显式推进时间，故障恢复演练也可在确定时间下重复。
 */
export class ControlledClock {
  #now;

  /** @param {string} [iso] 初始时间，默认固定基线时间 */
  constructor(iso = "2026-01-01T00:00:00+08:00") {
    this.#now = new Date(iso);
  }

  /** @returns {string} 当前时间 ISO 字符串 */
  now() {
    return this.#now.toISOString();
  }

  /**
   * 推进时钟。
   * @param {{days?: number, hours?: number, minutes?: number}} delta
   */
  advance({ days = 0, hours = 0, minutes = 0 } = {}) {
    const ms = days * 86400_000 + hours * 3600_000 + minutes * 60_000;
    this.#now = new Date(this.#now.getTime() + ms);
    return this.now();
  }

  /**
   * @param {string} iso
   * @returns {boolean} 给定时间点是否已到期（含相等）
   */
  isDue(iso) {
    return new Date(iso).getTime() <= this.#now.getTime();
  }

  /**
   * 上报时间加上复核期限天数后的截止时间。
   * @param {string} submittedAt
   * @param {number} days
   * @returns {string}
   */
  reviewDeadline(submittedAt, days) {
    return new Date(new Date(submittedAt).getTime() + days * 86400_000).toISOString();
  }
}
