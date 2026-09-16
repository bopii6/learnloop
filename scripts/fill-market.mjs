// 批量上架：把 data/courses/ 下所有已成课（有 outline.units 的）登记进集市货架。
// 等价于逐门课点「上架到精品课程」，用于把存量课一次铺满 data/marketplace.json。
// 用法：node scripts/fill-market.mjs
// 说明：本地模式直接写 data/marketplace.json；要同步到线上 R2 用 scripts/migrate-to-r2.mjs 推送该文件。
import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const COURSES_DIR = path.join(ROOT, "data", "courses");
const MARKET_FILE = path.join(ROOT, "data", "marketplace.json");

const existing = existsSync(MARKET_FILE)
  ? JSON.parse(readFileSync(MARKET_FILE, "utf8")).entries || []
  : [];
const byId = new Map(existing.map((e) => [e.courseId, e]));

let added = 0;
for (const f of existsSync(COURSES_DIR) ? readdirSync(COURSES_DIR) : []) {
  if (!f.startsWith("course-") || !f.endsWith(".json")) continue;
  let d;
  try {
    d = JSON.parse(readFileSync(path.join(COURSES_DIR, f), "utf8"));
  } catch {
    continue;
  }
  const outline = d.outline;
  if (!outline || !Array.isArray(outline.units) || outline.units.length === 0) continue;
  const courseId = f.replace(/\.json$/, "");
  const title = d.title || outline.title || courseId;
  const prev = byId.get(courseId);
  byId.set(courseId, {
    ...(prev || {}),
    courseId,
    title,
    author: prev?.author === "official" ? "official" : prev?.author || "self",
    price: prev?.price ?? 0,
    note: prev?.note,
    addedAt: prev?.addedAt || Date.now(),
    ownerId: d.ownerId || prev?.ownerId,
    isPublic: true, // 上架 = 公开发布
  });
  added++;
}

const entries = [...byId.values()];
writeFileSync(MARKET_FILE, JSON.stringify({ entries }, null, 2));
console.log(`已登记 ${added} 门课，货架空共 ${entries.length} 条 → ${path.relative(ROOT, MARKET_FILE)}`);
