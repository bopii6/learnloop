// 冒烟测试：对一个正在运行的站点把主要页面和只读接口过一遍（不调大模型、不花钱）。
// 用法：node scripts/smoke.mjs [baseUrl]      默认 http://localhost:3000
// 部署后跑一次：node scripts/smoke.mjs https://你的域名
const base = (process.argv[2] || "http://localhost:3000").replace(/\/+$/, "");

const checks = [
  // [路径, 期望状态码, 说明]
  ["/", 200, "首页"],
  ["/records", 200, "课程记录"],
  ["/market", 200, "精品课程"],
  ["/pricing", 200, "积分与价格"],
  ["/privacy", 200, "隐私政策"],
  ["/terms", 200, "服务条款"],
  ["/api/auth/me", 200, "登录态接口"],
  ["/api/market", 200, "精品课程接口"],
  ["/api/courses", 200, "课程列表接口"],
  ["/api/replay?id=does-not-exist", 404, "回放：不存在的 id 返回 404"],
  ["/api/textbook?id=does-not-exist", 404, "教材：不存在的 id 返回 404"],
  ["/comic", 404, "已下线的漫画课堂"],
];

let failed = 0;
for (const [path, want, label] of checks) {
  const t0 = Date.now();
  let got;
  try {
    const res = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
    got = res.status;
  } catch (e) {
    got = `ERR ${e instanceof Error ? e.message : e}`;
  }
  const ok = got === want;
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${String(got).padEnd(4)} ${path.padEnd(34)} ${label}${ok ? "" : `（期望 ${want}）`}  ${Date.now() - t0}ms`);
}

// 旧课节链接要 307 到新课堂
try {
  const res = await fetch(`${base}/learn/c/l`, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
  const loc = res.headers.get("location") || "";
  const ok = (res.status === 307 || res.status === 308) && loc.includes("/classroom/c/l");
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${String(res.status).padEnd(4)} /learn/c/l → ${loc || "(无跳转)"}  旧链接重定向`);
} catch (e) {
  failed += 1;
  console.log(`✗ ERR  /learn/c/l  ${e instanceof Error ? e.message : e}`);
}

console.log(failed === 0 ? `\n全部通过（${checks.length + 1} 项）` : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
