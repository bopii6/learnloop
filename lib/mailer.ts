// 验证码邮件：SMTP（.env 配置）可用则真发；未配置/运行时不支持则返回兜底标记。
// 注意：nodemailer 走 TCP 套接字，本地 Node 可用；Cloudflare Workers 上不支持出站 TCP，
// 因此这里用动态导入 + 运行时探测，Workers 上自然回退到 devCode（前端有明确提示）。
// 生产环境若在 Workers 上需要真发信，应换 HTTP API 类邮件服务（Resend / Brevo 等）。

export function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export async function sendCodeEmail(email: string, code: string): Promise<{ sent: boolean; error?: string }> {
  if (!smtpConfigured()) return { sent: false };
  let nodemailer: typeof import("nodemailer");
  try {
    // 动态导入：Workers 打包时不加载 net/tls，运行时也只在 SMTP 配置齐全时才触达
    const mod = await import("nodemailer");
    nodemailer = (mod.default ?? mod) as typeof import("nodemailer");
  } catch (e) {
    return { sent: false, error: "SMTP 运行时不可用：" + (e instanceof Error ? e.message : String(e)) };
  }
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
