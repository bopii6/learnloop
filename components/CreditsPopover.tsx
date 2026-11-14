"use client";

// 积分弹层：余额 + 计费规则 + 最近流水。
// 此前点「N 积分」直接弹兑换码框——花钱的入口有了，看钱的入口没有。
import { useEffect, useState } from "react";
import Link from "next/link";
import { RedeemModal } from "./RedeemModal";

interface CreditLogEntry {
  at: number;
  delta: number;
  reason: string;
  balanceAfter: number;
}

interface CreditsData {
  balance: number;
  granted: number;
  spent: number;
  rules: {
    courseGenerate: number;
    teachingSession: number;
    capstoneBrief: number;
    capstoneReview: number;
    unitQuiz: number;
    chatLimitPerLecture: number;
  };
  log: CreditLogEntry[];
}

const REASON_LABEL: Record<string, string> = {
  "注册赠送": "注册赠送",
  "生成课程": "生成课程",
  "首次听课": "首次听课",
  "兑换码兑换": "兑换码兑换",
  "结课任务书": "结课任务书",
  "作品验收": "作品验收",
  "单元测验": "单元测验",
  "管理补发": "管理补发",
};

function reasonLabel(reason: string): string {
  if (REASON_LABEL[reason]) return REASON_LABEL[reason];
  if (/退回/.test(reason)) return "生成失败退回";
  return reason || "其他";
}

export function CreditsPopover({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<CreditsData | null>(null);
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/credits")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setData)
      .catch(() => setError(true));
  }, []);

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl border border-[#e4e4e7] bg-white shadow-xl p-4 z-50" role="dialog" aria-label="积分明细">
      {!data && !error && <div className="py-4 text-center text-[12px] text-ink-faint">正在加载…</div>}
      {error && <div className="py-4 text-center text-[12px] text-red-600">加载失败，请稍后再试</div>}
      {data && (
        <>
          <div className="flex items-baseline justify-between mb-1">
            <div className="text-[12px] text-ink-soft">当前余额</div>
            <div className="text-[20px] font-bold text-accent leading-none">
              {data.balance} <span className="text-[11px] font-medium">积分</span>
            </div>
          </div>
          <div className="text-[11px] text-ink-faint mb-3">累计获得 {data.granted} · 累计消耗 {data.spent}</div>

          <div className="rounded-xl bg-[#faf9f4] border border-[#efede4] px-3 py-2.5 mb-3 text-[11.5px] text-ink-soft leading-relaxed">
            <div className="font-semibold text-ink mb-1">怎么扣积分</div>
            <div>生成一门课程 {data.rules.courseGenerate} 分 · 首次听一节课 {data.rules.teachingSession} 分（复习免费）</div>
            <div>课堂提问不收费（每节上限 {data.rules.chatLimitPerLecture} 条）· 结课工坊与测验每次 {data.rules.capstoneBrief} 分</div>
          </div>

          <div className="text-[11px] text-ink-faint font-medium tracking-wider mb-1.5">最近记录</div>
          <div className="max-h-40 overflow-y-auto space-y-1 mb-3">
            {data.log.length === 0 && <div className="text-[11.5px] text-ink-faint">还没有记录</div>}
            {data.log.map((e, i) => (
              <div key={`${e.at}-${i}`} className="flex items-center justify-between text-[11.5px]">
                <span className="text-ink-soft truncate">
                  {reasonLabel(e.reason)}
                  <span className="text-ink-faint ml-1.5">
                    {new Date(e.at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}
                  </span>
                </span>
                <span className={`shrink-0 font-semibold tabular-nums ${e.delta < 0 ? "text-ink-soft" : "text-accent"}`}>
                  {e.delta > 0 ? `+${e.delta}` : e.delta}
                </span>
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <Link
              href="/pricing"
              onClick={onClose}
              className="flex-1 rounded-xl bg-accent px-3 py-2 text-center text-[12px] font-medium text-white hover:opacity-90 transition-opacity"
            >
              购买积分
            </Link>
            <button
              onClick={() => setRedeemOpen(true)}
              className="flex-1 rounded-xl border border-[#e4e4e7] px-3 py-2 text-[12px] text-ink-soft hover:border-accent hover:text-accent transition-colors"
            >
              输入兑换码
            </button>
          </div>
        </>
      )}
      {redeemOpen && (
        <RedeemModal
          balance={data?.balance ?? null}
          onClose={() => setRedeemOpen(false)}
          onRedeemed={() => {
            setRedeemOpen(false);
            fetch("/api/credits").then((r) => (r.ok ? r.json() : null)).then((d) => d && setData(d)).catch(() => {});
            onChanged();
          }}
        />
      )}
    </div>
  );
}
