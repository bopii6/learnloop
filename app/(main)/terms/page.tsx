import type { Metadata } from "next";

export const metadata: Metadata = { title: "用户协议 · Superlearn" };

const SECTIONS: { h: string; ps: string[] }[] = [
  {
    h: "1. 服务说明",
    ps: [
      "Superlearn（下称「本服务」）是一款 AI 学习工具：根据您输入的主题或上传的文档，自动生成结构化课程，并以白板课堂的形式讲解。",
      "本服务提供的全部课程内容、讲解语音、板书均由人工智能自动生成，仅供学习参考，不构成专业建议（医疗、法律、金融等尤其如此）。AI 生成的内容可能存在错误、遗漏或过时信息，请自行甄别并以权威来源为准。",
    ],
  },
  {
    h: "2. 账号与积分",
    ps: [
      "您使用邮箱验证码登录，无需密码。请保管好您的邮箱安全，通过您邮箱发起的登录均视为您本人操作。",
      "积分用于支付课程生成与课堂开讲等资源消耗。赠送积分不可转让、不可兑现；具体计费规则以产品内说明为准。生成失败未产出课程时，对应积分自动退回。",
    ],
  },
  {
    h: "3. 用户行为规范",
    ps: [
      "您上传的文档与发布到精品课程的内容，应为您有权使用的材料，不得侵犯他人知识产权、不得包含违法违规内容。",
      "您将课程上架到精品课程即视为同意将其公开展示给其他用户；您可随时下架自己发布的课程。",
      "若您发布的内容被投诉且经查实违规，我们有权不经通知下架相关内容，并视情节限制您的账号。",
    ],
  },
  {
    h: "4. 服务的变更与终止",
    ps: [
      "我们可能因技术升级、成本结构变化调整功能与积分规则，重大变更会在产品内公告。",
      "您可以随时停止使用本服务；如需删除账号及全部数据，可通过页面公示的联系方式申请。",
    ],
  },
  {
    h: "5. 联系方式",
    ps: ["关于本协议或本服务的任何问题，请通过产品内公示的邮箱与我们联系。"],
  },
];

export default function TermsPage() {
  return (
    <div className="max-w-[720px] mx-auto px-6 py-12">
      <div className="text-[12px] text-accent font-semibold tracking-[.1em] mb-1">Superlearn</div>
      <h1 className="text-[24px] font-bold mb-1">用户协议</h1>
      <div className="text-[13px] text-ink-faint mb-8">更新日期：2026-09-08</div>
      <div className="space-y-7">
        {SECTIONS.map((s) => (
          <section key={s.h}>
            <h2 className="text-[15px] font-bold mb-2">{s.h}</h2>
            {s.ps.map((p, i) => (
              <p key={i} className="text-[14px] text-ink-soft leading-relaxed mb-2">
                {p}
              </p>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
