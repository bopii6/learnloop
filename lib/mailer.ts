// 验证码邮件发送：
// 1) Brevo HTTP API（优先）——纯 fetch，本地 Node 与 Cloudflare Workers 都能真发信；
// 2) SMTP（备选）——nodemailer 走 TCP，仅本地 Node 可用，Workers 上动态导入失败自然跳过；
// 3) 都未配置 → 调用方走 devCode 兜底（验证码直接显示在登录弹窗，仅限开发）。
// 环境变量：BREVO_API_KEY + MAIL_FROM（Brevo 已验证的发件人邮箱）。

export function brevoConfigured(): boolean {
  return Boolean(process.env.BREVO_API_KEY && process.env.MAIL_FROM);
}

export function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export async function sendCodeEmail(email: string, code: string): Promise<{ sent: boolean; error?: string }> {
  // ---- 路径 1：Brevo HTTP API ----
  if (brevoConfigured()) {
    try {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": process.env.BREVO_API_KEY!,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          sender: { name: "Superlearn", email: process.env.MAIL_FROM },
          to: [{ email }],
          subject: `【Superlearn】登录验证码：${code}`,
          textContent: `你的登录验证码是 ${code}，10 分钟内有效。不是你在操作请忽略这封邮件。`,
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) return { sent: true };
      return { sent: false, error: `Brevo ${res.status}: ${(await res.text()).slice(0, 150)}` };
    } catch (e) {
      return { sent: false, error: "Brevo 请求失败：" + (e instanceof Error ? e.message : String(e)) };
    }
  }

  // ---- 路径 2：SMTP（仅本地 Node 可用）----
  if (smtpConfigured()) {
    let nodemailer: typeof import("nodemailer");
    try {
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
        subject: `【Superlearn】登录验证码：${code}`,
        text: `你的登录验证码是 ${code}，10 分钟内有效。不是你在操作请忽略这封邮件。`,
      });
      return { sent: true };
    } catch (e) {
      return { sent: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return { sent: false };
}
