"use client";

// 积分不够时的统一提示：说清这一步要多少、还剩多少，并给出两条路——去买积分包 / 输入兑换码。
// 课程生成、课堂开讲、单元测验、结课工坊都用它，不再各自写一句"联系我们"然后把人晾在那。
import Link from "next/link";
import { useState } from "react";
import { RedeemModal } from "./RedeemModal";

export function OutOfCredits({
  what,
  need,
  balance,
  onRecharged,
  compact,
}: {
  /** 这一步在做什么，如"开启这节课" */
  what: string;
  need: number;
  balance: number;
  /** 兑换成功后回调（调用方可直接重试刚才的动作） */
  onRecharged?: () => void;
  compact?: boolean;
}) {
  const [redeemOpen, setRedeemOpen] = useState(false);
  return (
    <div className={`rounded-2xl border border-accent-border bg-accent-soft/40 ${compact ? "px-3.5 py-3" : "px-5 py-4"}`} role="alert">
      <div className="text-[14.5px] font-semibold text-ink mb-1">积分不够了</div>
      <div className="text-[13.5px] text-ink-soft leading-relaxed mb-3">
        {what}需要 {need} 积分，你现在还有 {balance} 积分。只为成功交付的内容扣分：生成失败自动退回，复习和课堂提问都免费。
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href="/pricing" className="rounded-full bg-accent px-4 py-1.5 text-[13.5px] font-medium text-white hover:opacity-90">
          查看积分包
        </Link>
        <button
          onClick={() => setRedeemOpen(true)}
          className="rounded-full border border-line bg-white px-4 py-1.5 text-[13.5px] text-ink-soft hover:border-accent hover:text-accent"
        >
          我有兑换码
        </button>
      </div>
      {redeemOpen && (
        <RedeemModal
          balance={balance}
          onClose={() => setRedeemOpen(false)}
          onRedeemed={() => {
            window.dispatchEvent(new CustomEvent("ll:credits-changed"));
            onRecharged?.();
          }}
        />
      )}
    </div>
  );
}
