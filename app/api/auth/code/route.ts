// POST /api/auth/code —— 发送邮箱验证码
// Brevo/SMTP 已配置 → 真发信；都没配置时：开发模式返回 devCode（仅本地），生产模式报错不泄露验证码。
// 防刷三闸：IP 发码日限频 / 临时邮箱域名拦截 / 邮箱别名归一（免费积分不能靠 +tag 无限薅）。
import { NextRequest, NextResponse } from "next/server";
import {
  issueCode,
  isValidEmail,
  normalizeEmail,
  canonicalEmail,
  findAliasConflict,
  isDisposableEmail,
} from "@/lib/auth";
import { brevoConfigured, sendCodeEmail, smtpConfigured } from "@/lib/mailer";
import { AUTH_CODE_IP_DAILY_LIMIT, consumeDailyQuota, ipSubject } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const email = normalizeEmail(body.email || "");
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "邮箱格式不对" }, { status: 400 });
  }
  if (isDisposableEmail(email)) {
    return NextResponse.json({ error: "请使用常用邮箱注册（不支持临时邮箱）" }, { status: 400 });
  }

  // 同一 IP 一天最多发 20 封验证码：挡批量造号刷免费积分，不影响真人（一人一天顶多错几次）
  const quota = await consumeDailyQuota(ipSubject(req), "codeRequests", 1, AUTH_CODE_IP_DAILY_LIMIT);
  if (!quota.ok) {
    return NextResponse.json(
      { error: "今天这个网络的验证码发送次数已达上限，请明天再试" },
      { status: 429 }
    );
  }

  // 别名变体：+tag / gmail 点号指向同一物理邮箱，引导回原邮箱登录，不给第二个 20 分
  const conflict = await findAliasConflict(email);
  if (conflict) {
    return NextResponse.json(
      { error: `这个地址与已有账号 ${conflict} 是同一个邮箱的别名写法，请直接用原邮箱登录` },
      { status: 400 }
    );
  }

  const issued = await issueCode(email);
  if (!issued.ok) {
    return NextResponse.json({ error: "发送太频繁，一分钟后再试" }, { status: 429 });
  }
  const code = issued.code!;

  if (brevoConfigured() || smtpConfigured()) {
    const r = await sendCodeEmail(email, code);
    if (!r.sent) {
      return NextResponse.json(
        { error: `验证码邮件发送失败：${r.error || "未知原因"}` },
        { status: 500 }
      );
    }
    return NextResponse.json({ sent: true });
  }

  // 开发兜底：没配任何邮件服务，直接把验证码还给页面，登录流程不被卡死。
  // 生产环境绝不返回验证码——否则部署忘配邮件服务时，任何人填任意邮箱即可登录。
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "邮件服务未配置（缺 BREVO_API_KEY/MAIL_FROM 或 SMTP_*），无法发送验证码" },
      { status: 500 }
    );
  }
  return NextResponse.json({ sent: true, devCode: code, dev: true });
}
