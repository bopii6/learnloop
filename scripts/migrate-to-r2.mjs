// 一次性迁移：把本地 data/ 的业务数据上传到 Cloudflare R2（业务数据在桶里与本地同名同路径）。
// 跑法：node scripts/migrate-to-r2.mjs   （需 .env 已配置 CF_* 四个变量）
// 本地文件保留不动，作为备份；不迁移：ocr-cache（语言包）、classrooms（课堂快照）、.auth-secret。
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AwsClient } from "aws4fetch";

// ---- 手动解析 .env（脚本不经 Next，没有自动 env 加载） ----
const envText = readFileSync(join(process.cwd(), ".env"), "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const { CF_ACCOUNT_ID, CF_R2_BUCKET, CF_R2_ACCESS_KEY_ID, CF_R2_SECRET_ACCESS_KEY } = process.env;
if (!CF_ACCOUNT_ID || !CF_R2_BUCKET || !CF_R2_ACCESS_KEY_ID || !CF_R2_SECRET_ACCESS_KEY) {
  console.error("缺 CF_* 配置，先填 .env");
  process.exit(1);
}

const client = new AwsClient({
  accessKeyId: CF_R2_ACCESS_KEY_ID,
  secretAccessKey: CF_R2_SECRET_ACCESS_KEY,
  service: "s3",
  region: "auto",
});
const base = `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${CF_R2_BUCKET}`;

async function put(key, body) {
  const url = `${base}/${key}`;
  const res = await client.fetch(url, { method: "PUT", body: body, headers: { "Content-Type": "application/octet-stream" } });
  if (!res.ok) throw new Error(`PUT ${key} -> ${res.status}`);
}

const DATA = join(process.cwd(), "data");
const single = ["marketplace.json", "users.json", "auth-codes.json", "profile.json"];
const dirs = ["courses", "conversations", "textbooks"];

let uploaded = 0;
for (const f of single) {
  if (!existsSync(join(DATA, f))) continue;
  await put(f, readFileSync(join(DATA, f)));
  uploaded += 1;
  console.log("↑", f);
}
for (const dir of dirs) {
  const d = join(DATA, dir);
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) {
    const full = join(d, f);
    if (!statSync(full).isFile() || !f.endsWith(".json")) continue;
    await put(`${dir}/${f}`, readFileSync(full));
    uploaded += 1;
    console.log("↑", `${dir}/${f}`);
  }
}

// 顺手清掉自检残留
try {
  const listRes = await client.fetch(`${base}?list-type=2&prefix=__storage-check/`);
  const xml = await listRes.text();
  for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
    const delRes = await client.fetch(`${base}/${m[1]}`, { method: "DELETE" });
    if (delRes.ok) console.log("× 清理自检残留", m[1]);
  }
} catch {
  // 清理失败不影响迁移
}

console.log(`完成：共上传 ${uploaded} 个文件到桶 ${CF_R2_BUCKET}`);
