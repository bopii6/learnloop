// 全站共享的格式化工具。

/**
 * 时长人性化："约 8.6 小时" 这种小数小时制没人念得出口。
 * 规则：不足 1 小时 → "约 N 分钟"；否则 → "约 X 小时"（有余数带 "Y 分"，整点不带）。
 */
export function fmtDuration(min: number): string {
  if (!min || min <= 0) return "—";
  if (min < 60) return `约 ${Math.round(min)} 分钟`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? `约 ${h} 小时 ${m} 分` : `约 ${h} 小时`;
}
