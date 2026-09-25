/**
 * 可控制时钟。
 *
 * 平台内所有"到期"与"期限"（数据源到期、复核期限）以及全部事件的发生时间
 * 都由这只时钟推进。演练、补算和故障恢复测试可以显式拨动它，
 * 生产环境只需按真实时间推进，行为完全一致。
 */
export function createClock(startIso = "2026-01-01T00:00:00+08:00") {
  let currentMs = Date.parse(startIso);
  if (Number.isNaN(currentMs)) throw new Error(`非法起始时间：${startIso}`);

  return {
    /** 当前时刻（UTC ISO 字符串）。 */
    now: () => new Date(currentMs).toISOString(),
    /** 当前时刻（毫秒）。 */
    nowMs: () => currentMs,
    /** 推进到指定时刻，只允许向前。 */
    advanceTo(iso) {
      const t = Date.parse(iso);
      if (Number.isNaN(t)) throw new Error(`非法时间：${iso}`);
      if (t < currentMs) throw new Error("时钟只能向前推进");
      currentMs = t;
      return this.now();
    },
    /** 向前推进指定毫秒数。 */
    advanceMs(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new Error("时钟只能向前推进");
      currentMs += ms;
      return this.now();
    },
  };
}
