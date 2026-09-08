// CI 专用补丁：Workers 构建前，把 @napi-rs/canvas 的原生绑定引用替换为空壳。
// 原因：unpdf 可选 peer 引用 @napi-rs/canvas，依赖追踪会把它复制进 server-functions 的
// node_modules，OpenNext 的 esbuild 阶段遇到 .node 文件直接报错。
// Workers 上 OCR 分支已被路由层守卫拦截（RUNTIME=workers），此包运行时永远不会被加载；
// 本地开发不跑此脚本，OCR 功能不受影响。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const target = join(process.cwd(), "node_modules", "@napi-rs", "canvas", "js-binding.js");

if (!existsSync(target)) {
  console.log("[patch] @napi-rs/canvas 未安装，跳过");
  process.exit(0);
}

const original = readFileSync(target, "utf8");
if (original.includes("[patched-for-opennext]")) {
  console.log("[patch] 已打过补丁，跳过");
  process.exit(0);
}

const stub = `// [patched-for-opennext] CI 构建补丁：剥离原生 .node 绑定（Workers 上不加载此包）
module.exports = {};
`;
writeFileSync(target, stub);
console.log("[patch] @napi-rs/canvas/js-binding.js 已替换为空壳");
