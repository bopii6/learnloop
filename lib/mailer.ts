// 验证码邮件：SMTP（.env 配置）可用则真发；未配置返回 null，调用方走 devCode 兜底。
// 国内常见：QQ/163 邮箱开 SMTP 后用"授权码"当密码。
import nodemailer from "nodemailer";

export function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export async function sendCodeEmail(email: string, code: string): Promise<{ sent: boolean; error?: string }> {
  if (!smtpConfigured()) return { sent: false };
  try {
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: (process.env.SMTP_SECURE || "true") === "true",
      auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
    });
    const from = process.env.SMTP_FROM || process.env.SMTP_USER!;
    await transport.sendMail({
      from,
      to: email,
      subject: `LearnLoop 登录验证码：${code}`,
      text: `你的登录验证码是 ${code}，10 分钟内有效。不是你在操作请忽略这封邮件。`,
    });
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e) };
  }
}
