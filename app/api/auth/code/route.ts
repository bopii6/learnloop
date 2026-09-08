// POST /api/auth/code —— 发送邮箱验证码
// Brevo/SMTP 已配置 → 真发信；都没配置时：开发模式返回 devCode（仅本地），生产模式报错不泄露验证码。
import { NextRequest, NextResponse } from "next/server";
import { issueCode, isValidEmail, normalizeEmail } from "@/lib/auth";
import { brevoConfigured, sendCodeEmail, smtpConfigured } from "@/lib/mailer";

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
