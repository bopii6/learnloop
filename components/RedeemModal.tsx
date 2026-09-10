"use client";

// 兑换积分弹窗：学员收款码兑换的唯一入口。
// 旧版是侧栏里 240px 宽的小面板，手打 17 位码体验很差；现在：
// - 输入自动大写 + 自动补连字符（SL-XXXXX-XXXXX），粘贴带空格/小写/横线都能认
// - 凑满完整码自动提交，不用再点按钮
// - 登录态/价目/结果都在弹窗里说清楚，成功后刷新侧栏余额
import { useEffect, useState } from "react";

function formatCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  if (s.length <= 2) return s;
  const head = s.slice(0, 2);
  const rest = s.slice(2);
  if (rest.length === 0) return `${head}-`;
  return `${head}-${rest.slice(0, 5)}${rest.length > 5 ? `-${rest.slice(5)}` : ""}`;
}

export function RedeemModal({
  balance,
  onClose,
  onRedeemed,
}: {
  balance: number | null;
  onClose: () => void;
  onRedeemed: (newBalance: number) => void;
}) {
  const [code, setCode] = useState("");
  const [state, setState] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [newBalance, setNewBalance] = useState<number | null>(null);

  const submit = async (value: string) => {
    if (!value.trim() || state === "submitting") return;
    setState("submitting");
    setMsg(null);
    try {
      const res = await fetch("/api/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: value.trim() }),
      });
      const d = await res.json();
      if (!res.ok) {
        setMsg(d?.error || "兑换失败，稍后再试");
        setState("error");
        return;
      }
      setState("done");
      setNewBalance(d.balance);
      setMsg(`✓ 兑换成功，+${d.credits} 积分`);
      onRedeemed(d.balance);
      setTimeout(onClose, 2000);
    } catch {
      setMsg("网络异常，稍后再试");
      setState("error");
    }
  };

  // 完整码（XX-XXXXX-XXXXX 共 14 位）自动提交
  useEffect(() => {
    if (state === "idle" && code.length === 14 && !code.endsWith("-")) {
      void submit(code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[#2b2a26]/45 backdrop-blur-[2px]">
      <div className="w-[400px] max-w-[90%] rounded-3xl border border-[#e7e5dc] bg-white shadow-2xl p-7 fade-up">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[11px] text-accent font-semibold tracking-[.1em]">Superlearn</div>
          <button onClick={onClose} className="text-ink-faint hover:text-ink text-[16px]" aria-label="关闭">
            ×
          </button>
        </div>
        <div className="text-[19px] font-bold mb-1">兑换积分</div>
        <div className="text-[12.5px] text-ink-soft mb-4">
          当前余额 <span className="font-semibold text-accent">⚡ {balance ?? "—"}</span> 积分
          <span className="mx-1.5 text-[#d9d6ca]">·</span>1 积分 = ¥1
        </div>

        <div className="rounded-2xl bg-[#fafaf7] border border-[#e7e5dc] p-4 space-y-3">
          <div>
            <div className="text-[12px] text-ink-soft mb-1.5">输入管理员发给你的兑换码（支持直接粘贴）</div>
            <input
              value={code}
              onChange={(e) => {
                setCode(formatCode(e.target.value));
                if (state === "error") setState("idle");
              }}
              onKeyDown={(e) => e.key === "Enter" && void submit(code)}
              placeholder="SL-XXXXX-XXXXX"
              autoFocus
              spellCheck={false}
              className="w-full rounded-xl border border-[#e0ded3] bg-white px-3.5 py-2.5 font-mono text-[15px] tracking-wider text-ink outline-none focus:border-accent transition-colors"
            />
          </div>
          <button
            onClick={() => void submit(code)}
            disabled={state === "submitting" || code.trim().length < 5}
            className="w-full rounded-full bg-accent px-5 py-2.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {state === "submitting" ? "兑换中…" : state === "done" ? "✓ 已到账" : "立即兑换"}
          </button>
          {state === "done" && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-[12.5px] text-emerald-700">
              {msg}
              {newBalance !== null && (
                <div className="mt-0.5 text-[12px]">最新余额 <span className="font-semibold">⚡ {newBalance} 积分</span>，去开一门新课吧</div>
              )}
            </div>
          )}
          {state === "error" && msg && <div className="text-[12px] text-red-600">{msg}</div>}
        </div>

        <div className="mt-4 text-[11px] text-ink-faint leading-relaxed">
          没有兑换码？联系管理员私下转账后获取（¥9.9 → 10 积分起）。
          <br />
          生成一门课 10 积分 · 首次听一节课 1 积分 · 复习和追问免费
        </div>
      </div>
    </div>
  );
}
