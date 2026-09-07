"use client";

// 登录弹窗：邮箱 + 6 位验证码，无密码。SMTP 未配置时后端直接返回 devCode（本地开发）。
import { useEffect, useRef, useState } from "react";

interface AuthModalProps {
  onClose: () => void;
  onLoggedIn: (user: { id: string; email: string }) => void;
}

export function AuthModal({ onClose, onLoggedIn }: AuthModalProps) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => window.clearInterval(t);
  }, [cooldown]);

  const requestCode = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "发送失败");
      setDevCode(d.devCode || null);
      setStep("code");
      setCooldown(60);
      window.setTimeout(() => codeRef.current?.focus(), 100);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const login = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "登录失败");
      onLoggedIn(d.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-white/70 backdrop-blur-[2px]">
      <div className="w-[400px] max-w-[90%] rounded-3xl border border-[#e7e5dc] bg-white shadow-2xl p-7 fade-up">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[11px] text-accent font-semibold tracking-[.1em]">LearnLoop</div>
          <button onClick={onClose} className="text-ink-faint hover:text-ink text-[16px]" aria-label="关闭">
            ×
          </button>
        </div>
        <div className="text-[19px] font-bold mb-1">
          {step === "email" ? "登录 / 注册" : "输入验证码"}
        </div>
        <div className="text-[12.5px] text-ink-soft mb-5 leading-relaxed">
          {step === "email"
            ? "邮箱验证码登录，没有账号会自动创建。课程记录、上传的教材都跟着账号走。"
            : `验证码已发到 ${email}，10 分钟内有效。`}
        </div>

        {step === "email" ? (
          <div className="space-y-3">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && email.includes("@")) void requestCode();
              }}
              placeholder="you@example.com"
              autoFocus
              className="w-full rounded-xl border border-[#d3d1c7] px-4 py-2.5 text-[14px] outline-none focus:border-accent"
            />
            <button
              onClick={() => void requestCode()}
              disabled={!email.includes("@") || busy}
              className="w-full rounded-xl bg-accent py-2.5 text-[13.5px] text-white font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {busy ? "发送中…" : "发送验证码"}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {devCode && (
              <div className="rounded-xl bg-[#fff7d6] border border-[#f1e2ab] px-3.5 py-2.5 text-[12.5px] text-ink leading-relaxed">
                本地开发模式（未配置 SMTP），验证码直接给你：<b className="tracking-widest">{devCode}</b>
                <div className="text-[11px] text-ink-faint mt-0.5">配好 .env 的 SMTP_* 后会改为真实发信</div>
              </div>
            )}
            <input
              ref={codeRef}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && code.length === 6) void login();
              }}
              placeholder="6 位验证码"
              inputMode="numeric"
              className="w-full rounded-xl border border-[#d3d1c7] px-4 py-2.5 text-[16px] tracking-[.4em] outline-none focus:border-accent text-center"
            />
            <button
              onClick={() => void login()}
              disabled={code.length !== 6 || busy}
              className="w-full rounded-xl bg-accent py-2.5 text-[13.5px] text-white font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {busy ? "登录中…" : "登录"}
            </button>
            <div className="flex items-center justify-between text-[11.5px] text-ink-faint">
              <button onClick={() => setStep("email")} className="hover:text-accent">
                ← 换个邮箱
              </button>
              <button onClick={() => void requestCode()} disabled={cooldown > 0 || busy} className="hover:text-accent disabled:opacity-50">
                {cooldown > 0 ? `重新发送（${cooldown}s）` : "重新发送"}
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</div>
        )}
      </div>
    </div>
  );
}
