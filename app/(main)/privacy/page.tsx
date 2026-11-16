import type { Metadata } from "next";

export const metadata: Metadata = { title: "隐私政策 · Superlearn" };

const SECTIONS: { h: string; ps: string[] }[] = [
  {
    h: "1. 我们收集的信息",
    ps: [
      "账号信息：您的邮箱地址（仅用于登录验证码发送与账号识别，不做营销推送）。",
      "学习数据：您生成课程的主题、澄清问答、课程记录、学习进度，以及由此形成的「学习者画像」（用于个性化您的后续学习）。",
      "上传内容：您上传的教材/文档，仅用于为您生成课程。",
      "技术信息：为保障服务安全，我们记录匿名化的 IP 哈希（用于发送频率限制）与接口用量统计。",
    ],
  },
  {
    h: "2. 我们如何使用信息",
    ps: [
      "仅用于提供和改进本服务：登录验证、课程生成与讲解、画像个性化、计费与防滥用、故障排查。",
      "我们不会将您的个人信息出售给任何第三方。课程生成依赖的 AI 服务商（大模型/语音合成供应商）会在处理过程中按其隐私政策处理必要的输入内容，我们持续把传给第三方的数据限定在完成任务所需的最小范围。",
    ],
  },
  {
    h: "3. 存储与安全",
    ps: [
      "您的数据存储于加密的云存储服务中，传输全程使用 HTTPS。",
      "课程公开提示：只有您主动上架到「精品课程」的课程才会公开；您上传的教材原文不会随课程公开。",
    ],
  },
  {
    h: "4. 您的权利",
    ps: [
      "您可以随时在产品内查看、修改您的学习画像；可以下架您发布的课程。",
      "如需导出或彻底删除您的账号与全部数据，请通过页面公示的邮箱联系我们，我们将在 15 个工作日内处理。",
    ],
  },
  {
    h: "5. 未成年人保护",
    ps: ["若您是未满 14 周岁的未成年人，请在监护人陪同下使用本服务，并由监护人代为同意本政策。"],
  },
  {
    h: "6. 联系方式",
    ps: ["关于本政策或个人信息保护的任何问题，请通过产品内公示的邮箱与我们联系。"],
  },
];

export default function PrivacyPage() {
  return (
    <div className="max-w-[720px] mx-auto px-6 py-12">
      <div className="text-[11px] text-accent font-semibold tracking-[.1em] mb-1">Superlearn</div>
      <h1 className="text-[24px] font-bold mb-1">隐私政策</h1>
      <div className="text-[12px] text-ink-faint mb-8">更新日期：2026-09-08</div>
      <div className="space-y-7">
        {SECTIONS.map((s) => (
          <section key={s.h}>
            <h2 className="text-[15px] font-bold mb-2">{s.h}</h2>
            {s.ps.map((p, i) => (
              <p key={i} className="text-[13px] text-ink-soft leading-relaxed mb-2">
                {p}
              </p>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
