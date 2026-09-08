// 积分账本冒烟测试（npx tsx scripts/smoke-credits.ts，跑完自清理）
import { getOrCreateAccount, trySpend, refundCredits, grantCredits, getBalance } from "../lib/credits";
import { removeKey } from "../lib/storage";

async function main() {
  const uid = "u-smoketest0001";
  const out: string[] = [];
  const acc0 = await getOrCreateAccount(uid);
  out.push("new=" + acc0.balance);
  const r1 = await trySpend(uid, 10, "smoke");
  out.push("spend=" + r1.balance + "/" + r1.ok);
  const r2 = await trySpend(uid, 15, "smoke-over");
  out.push("overspend=" + r2.balance + "/" + r2.ok);
  await refundCredits(uid, 10, "smoke-refund");
  out.push("refund=" + (await getBalance(uid)));
  const acc1 = await grantCredits(uid, 5, "smoke-grant");
  out.push("grant=" + acc1.balance + " granted=" + acc1.granted + " log=" + acc1.log.length);
  await removeKey("credits/" + uid + ".json");
  const acc2 = await getOrCreateAccount(uid);
  out.push("recreate=" + acc2.balance);
  await removeKey("credits/" + uid + ".json");
  console.log(out.join(" | "));
  process.exit(0);
}

void main();
