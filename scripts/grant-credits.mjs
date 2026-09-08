// 手动发放积分（运营工具）：node scripts/grant-credits.mjs <email> <amount>
// 例：node scripts/grant-credits.mjs someone@example.com 200
// 直接改桶里的 credits.json（所有账号集中一个文件）：读 → 改 → 写，尽量缩短窗口。
// 需 .env 已配置 CF_* 四个变量。流水记为「运营手动发放」，可审计。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AwsClient } from "aws4fetch";

const [, , emailArg, amountArg] = process.argv;
if (!emailArg || !amountArg || Number.isNaN(Number(amountArg))) {
  console.error('用法：node scripts/grant-credits.mjs <email> <amount>，如：node scripts/grant-credits.mjs a@b.com 200');
  process.exit(1);
}
const email = emailArg.trim().toLowerCase();
const amount = Number(amountArg);

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

async function getJson(key) {
  const res = await client.fetch(`${base}/${key}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${key} -> ${res.status}`);
  return res.json();
}
async function putJson(key, obj) {
  const res = await client.fetch(`${base}/${key}`, {
    method: "PUT",
    body: JSON.stringify(obj, null, 2),
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`PUT ${key} -> ${res.status}`);
}

// 1. 找 userId
const users = await getJson("users.json");
const user = users?.users?.find((u) => String(u.email).toLowerCase() === email);
if (!user) {
  console.error(`users.json 里找不到 ${email}`);
  process.exit(1);
}
console.log("用户：", user.id, user.email);

// 2. 改积分账本
const credits = (await getJson("credits.json")) || { accounts: {} };
credits.accounts = credits.accounts || {};
const acc = credits.accounts[user.id] || {
  balance: 0,
  granted: 0,
  spent: 0,
  updatedAt: Date.now(),
  log: [],
};
const before = acc.balance;
acc.balance += amount;
acc.granted += amount;
acc.updatedAt = Date.now();
acc.log.push({ at: Date.now(), delta: amount, reason: "运营手动发放", balanceAfter: acc.balance });
if (acc.log.length > 100) acc.log = acc.log.slice(-100);
credits.accounts[user.id] = acc;

// 3. 写回并回读校验
await putJson("credits.json", credits);
const verify = await getJson("credits.json");
const after = verify?.accounts?.[user.id];
console.log(`余额：${before} → ${after?.balance}（发放 +${amount}，最新流水：${JSON.stringify(after?.log?.at(-1))}）`);
if (after?.balance !== acc.balance) {
  console.error("回读不一致，请人工检查 credits.json！");
  process.exit(1);
}
