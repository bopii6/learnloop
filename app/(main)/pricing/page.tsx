"use client";

// /pricing —— 积分与价格：一种货币、按交付计费、四档积分包、怎么买、常见问题。
import { useState } from "react";
import { RedeemModal } from "@/components/RedeemModal";
import {
  CHAT_LIMIT_PER_LECTURE,
  COST_CAPSTONE_BRIEF,
  COST_CAPSTONE_REVIEW,
  COST_COURSE_GENERATE,
  COST_TEACHING_SESSION,
  COST_UNIT_QUIZ,
  CREDITS_PER_FULL_COURSE,
  CREDIT_PACKS,
  NEW_USER_GRANT,
  PURCHASE_CONTACT,
  PURCHASE_QR_URL,
  fmtYuan,
  pricePerCredit,
  type CreditPack,
} from "@/lib/pricing";

const USES = [
  { label: "生成一门课程", cost: `${COST_COURSE_GENERATE} 积分`, note: "搜资料、问清需求、出蓝图和完整大纲" },
  { label: "第一次上一节课", cost: `${COST_TEACHING_SESSION} 积分`, note: "讲师边讲边写板书，中途小测" },
  { label: "单元测验", cost: `${COST_UNIT_QUIZ} 积分`, note: "按单元内容现出题，重考免费" },
  { label: "结课任务书 / 作品验收", cost: `${COST_CAPSTONE_BRIEF} / ${COST_CAPSTONE_REVIEW} 积分`, note: "把作品拆成步骤，逐条对照验收" },
  { label: "复习听过的课", cost: "免费", note: "讲稿已存好，随时重听" },
  { label: "课堂提问、「没听懂」", cost: "免费", note: `每节课最多 ${CHAT_LIMIT_PER_LECTURE} 条` },
];

const FAQ = [
  { q: "生成失败了会扣分吗？", a: "不会。课程生成、开讲、出题、验收任何一步失败，积分都会自动退回。" },
  { q: "积分会过期吗？", a: "不会，没有有效期，跟着账号走，换设备也在。" },
  { q: "复习要再花积分吗？", a: "不用。每节课第一次上的时候生成讲稿，之后复习、分享回放都不再扣分。" },
  { q: "先试试再决定可以吗？", a: `可以。注册就送 ${NEW_USER_GRANT} 积分，够生成一门课并上 10 节，完整走一遍"出课 → 上课 → 小测"。` },
];

export default function PricingPage() {
  const [picked, setPicked] = useState<CreditPack | null>(CREDIT_PACKS.find((p) => p.popular) ?? CREDIT_PACKS[0]);
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [redeemed, setRedeemed] = useState<number | null>(null);
  const purchasable = Boolean(PURCHASE_QR_URL || PURCHASE_CONTACT);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 pt-12 pb-20">
        <div className="text-center mb-10">
          <h1 className="text-[28px] font-bold tracking-tight mb-2">按学到的东西付费</h1>
          <p className="text-[14px] text-ink-soft leading-relaxed max-w-xl mx-auto">
            只有一种货币：积分。只为成功交付的内容扣分——失败自动退回，复习和提问免费，不订阅、不过期。
            新用户注册送 {NEW_USER_GRANT} 积分。
          </p>
        </div>

        {/* 积分包 */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-12">
          {CREDIT_PACKS.map((p) => {
            const active = picked?.id === p.id;
            return (
              <button
                key={p.id}
                onClick={() => setPicked(p)}
                aria-pressed={active}
                className={`relative text-left rounded-2xl border bg-white p-4 transition-colors ${
                  active ? "border-accent ring-2 ring-accent/20" : "border-line hover:border-accent/60"
                }`}
              >
                {p.popular && (
                  <span className="absolute -top-2.5 left-4 rounded-full bg-accent px-2 py-0.5 text-[11.5px] font-semibold text-white">最多人选</span>
                )}
                <div className="text-[13.5px] text-ink-soft mb-1">{p.name}</div>
                <div className="flex items-baseline gap-1.5 mb-1">
                  <span className="text-[26px] font-bold leading-none">{fmtYuan(p.price)}</span>
                </div>
                <div className="text-[14px] font-semibold text-accent mb-2">{p.credits} 积分</div>
                <div className="text-[13px] text-ink-soft leading-relaxed min-h-[54px]">{p.pitch}</div>
                <div className="mt-2 text-[12px] text-ink-faint">约 {fmtYuan(pricePerCredit(p))} / 积分</div>
              </button>
            );
          })}
        </div>

        {/* 怎么买 */}
        <section className="rounded-2xl border border-line bg-white p-6 mb-12" aria-labelledby="how-to-buy">
          <h2 id="how-to-buy" className="text-[16px] font-semibold mb-1">怎么买</h2>
          {purchasable && picked ? (
            <div className="flex flex-col sm:flex-row gap-6 mt-3">
              {PURCHASE_QR_URL && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={PURCHASE_QR_URL} alt="收款码" className="w-40 h-40 rounded-xl border border-line object-contain shrink-0" />
              )}
              <ol className="text-[14px] text-ink-soft leading-relaxed space-y-2 list-decimal pl-5">
                <li>
                  {PURCHASE_QR_URL ? "扫码" : `联系 ${PURCHASE_CONTACT} `}支付 <b className="text-ink">{fmtYuan(picked.price)}</b>（「{picked.name}」{picked.credits} 积分），付款备注里写上你的登录邮箱。
                </li>
                <li>我们核对后把兑换码发给你{PURCHASE_CONTACT && PURCHASE_QR_URL ? `（也可以联系 ${PURCHASE_CONTACT}）` : ""}。</li>
                <li>点下面的「输入兑换码」，积分立刻到账。</li>
              </ol>
            </div>
          ) : (
            <p className="text-[14px] text-ink-soft leading-relaxed mt-2">在线购买即将开放。已经拿到兑换码的话，直接在下面兑换。</p>
          )}
          <div className="mt-5 flex items-center gap-3">
            <button onClick={() => setRedeemOpen(true)} className="rounded-full bg-accent px-5 py-2 text-[14px] font-medium text-white hover:opacity-90">
              输入兑换码
            </button>
            {redeemed != null && <span className="text-[13.5px] text-pass">✓ 已到账，当前余额 {redeemed} 积分</span>}
          </div>
        </section>

        {/* 积分能换什么 */}
        <section className="mb-12" aria-labelledby="what-credits-buy">
          <h2 id="what-credits-buy" className="text-[16px] font-semibold mb-1">积分花在哪</h2>
          <p className="text-[13.5px] text-ink-faint mb-3">完整学完一门 20 节左右的课（含测验和结课验收），大约 {CREDITS_PER_FULL_COURSE} 积分。</p>
          <div className="rounded-2xl border border-line bg-white divide-y divide-line">
            {USES.map((u) => (
              <div key={u.label} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <div className="text-[14px] font-medium">{u.label}</div>
                  <div className="text-[12.5px] text-ink-faint">{u.note}</div>
                </div>
                <div className={`shrink-0 text-[14px] font-semibold ${u.cost === "免费" ? "text-pass" : "text-ink"}`}>{u.cost}</div>
              </div>
            ))}
          </div>
        </section>

        {/* 常见问题 */}
        <section aria-labelledby="faq">
          <h2 id="faq" className="text-[16px] font-semibold mb-3">常见问题</h2>
          <div className="space-y-3">
            {FAQ.map((f) => (
              <div key={f.q} className="rounded-2xl border border-line bg-white px-4 py-3">
                <div className="text-[14px] font-medium mb-1">{f.q}</div>
                <div className="text-[13.5px] text-ink-soft leading-relaxed">{f.a}</div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {redeemOpen && (
        <RedeemModal
          balance={null}
          onClose={() => setRedeemOpen(false)}
          onRedeemed={(b) => {
            setRedeemed(b);
            window.dispatchEvent(new CustomEvent("ll:credits-changed"));
          }}
        />
      )}
    </div>
  );
}
