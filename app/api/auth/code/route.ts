// POST /api/auth/code —— 发送邮箱验证码
// SMTP 未配置（本地开发）时直接把验证码返回给前端（devCode），生产配好 SMTP 后自动消失。
import { NextRequest, NextResponse } from "next/server";
import { issueCode, isValidEmail, normalizeEmail } from "@/lib/auth";
import { sendCodeEmail, smtpConfigured } from "@/lib/mailer";

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

  if (smtpConfigured()) {
    const r = await sendCodeEmail(email, code);
    if (!r.sent) {
      return NextResponse.json(
        { error: `验证码邮件发送失败：${r.error || "未知原因"}（请检查 .env 的 SMTP 配置）` },
        { status: 500 }
      );
    }
    return NextResponse.json({ sent: true });
  }

  // 本地开发兜底：没配 SMTP，直接把验证码还给页面，登录流程不被卡死
  return NextResponse.json({ sent: true, devCode: code, dev: true });
}
