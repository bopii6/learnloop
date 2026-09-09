"use client";

// 运营后台（仅 ADMIN_EMAIL 可见，侧栏有入口）：收款后造兑换码、看码记录、按邮箱补分、当日用量总览。
// 纯客户端拼装既有 admin 接口（mint-codes/grant/overview），不做权限系统——服务端每个接口各自验 isAdminUser。
import { useCallback, useEffect, useState } from "react";

interface RedeemCode {
  code: string;
  credits: number;
  note?: string;
  createdAt: number;
  redeemedBy?: string;
  redeemedAt?: number;
}

const CREDIT_PRESETS = [
  { credits: 10, price: "¥9.9" },
  { credits: 32, price: "¥29.9" },
  { credits: 55, price: "¥49.9" },
  { credits: 115, price: "¥99" },
]; // 1 积分 = ¥1，四档售卖面额（大额多赠 2-16 分）

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function AdminPage() {
  const [me, setMe] = useState<{ email: string } | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null); // null = 校验中

  // 造码
  const [credits, setCredits] = useState(32);
  const [count, setCount] = useState(1);
  const [note, setNote] = useState("");
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<RedeemCode[] | null>(null);
  const [mintErr, setMintErr] = useState<string | null>(null);

  // 码记录
  const [codes, setCodes] = useState<RedeemCode[]>([]);
  const [codesSummary, setCodesSummary] = useState<{ total: number; unused: number; unusedCredits: number } | null>(null);
  const [codesLoading, setCodesLoading] = useState(false);

  // 补分
  const [email, setEmail] = useState("");
  const [amount, setAmount] = useState(10);
  const [reason, setReason] = useState("");
  const [grantMsg, setGrantMsg] = useState<string | null>(null);
  const [grantErr, setGrantErr] = useState<string | null>(null);

  // 总览
  const [overview, setOverview] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        setMe(d?.user || null);
        setIsAdmin(Boolean(d?.isAdmin));
      })
      .catch(() => setIsAdmin(false));
  }, []);

  const loadCodes = useCallback(async () => {
    setCodesLoading(true);
    try {
      const res = await fetch("/api/admin/mint-codes");
      const d = await res.json();
      if (res.ok) {
        setCodes(d.codes || []);
        setCodesSummary(d.summary || null);
      }
    } finally {
      setCodesLoading(false);
    }
  }, []);

  const loadOverview = useCallback(async () => {
    const res = await fetch("/api/admin/overview");
    if (res.ok) setOverview(await res.json());
  }, []);

  useEffect(() => {
    if (isAdmin) {
      void loadCodes();
      void loadOverview();
    }
  }, [isAdmin, loadCodes, loadOverview]);

  const mint = async () => {
    setMinting(true);
    setMintErr(null);
    setMinted(null);
    try {
      const res = await fetch("/api/admin/mint-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count, credits, note: note || undefined }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || "造码失败");
      setMinted(d.codes || []);
      void loadCodes();
    } catch (e) {
      setMintErr(e instanceof Error ? e.message : String(e));
    } finally {
      setMinting(false);
    }
  };

  const grant = async () => {
    setGrantMsg(null);
    setGrantErr(null);
    try {
      const res = await fetch("/api/admin/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, amount, reason }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || "发放失败");
      setGrantMsg(`✓ 已调整，该用户余额 ${d.balance} 积分`);
    } catch (e) {
      setGrantErr(e instanceof Error ? e.message : String(e));
    }
  };

  const copyAll = (list: RedeemCode[]) => {
    void navigator.clipboard.writeText(list.map((c) => c.code).join("\n"));
  };

  if (isAdmin === null) {
    return <div className="flex-1 flex items-center justify-center text-[13px] text-ink-faint">校验权限中…</div>;
  }
  if (!isAdmin || !me) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="rounded-2xl border border-[#e7e5dc] bg-white px-8 py-7 text-center shadow-sm">
          <div className="text-[15px] font-semibold mb-1.5">无权限</div>
          <div className="text-[12.5px] text-ink-soft">这个页面只对运营管理员开放（ADMIN_EMAIL 白名单）。</div>
        </div>
      </div>
    );
  }

  const unusedCodes = codes.filter((c) => !c.redeemedBy);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[22px] font-bold">运营后台</h1>
            <div className="text-[12px] text-ink-faint mt-0.5">
              管理员 {me.email} · 1 积分 = ¥1 · 生成一门课 10 积分、首次听课 1 积分
            </div>
          </div>
          <button
            onClick={() => {
              void loadCodes();
              void loadOverview();
            }}
            className="rounded-full border border-[#d3d1c7] px-4 py-1.5 text-[12px] text-ink-soft hover:border-accent hover:text-accent transition-colors"
          >
            ⟳ 刷新
          </button>
        </div>

        {/* 造兑换码 */}
        <section className="rounded-2xl border border-[#e7e5dc] bg-white p-5 shadow-sm">
          <div className="text-[14px] font-semibold mb-3">发兑换码（先收款，再造码发给学员）</div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-[12px] text-ink-soft">
              面额（积分）
              <select
                value={credits}
                onChange={(e) => setCredits(Number(e.target.value))}
                className="mt-1 block rounded-lg border border-[#e0ded3] bg-white px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
              >
                {CREDIT_PRESETS.map((p) => (
                  <option key={p.credits} value={p.credits}>
                    {p.credits} 分（{p.price} 档）
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[12px] text-ink-soft">
              张数
              <input
                type="number"
                min={1}
                max={50}
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                className="mt-1 block w-20 rounded-lg border border-[#e0ded3] bg-white px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
              />
            </label>
            <label className="text-[12px] text-ink-soft flex-1 min-w-[160px]">
              备注（谁付的钱）
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="如：0910 微信收款 ¥29.9"
                className="mt-1 block w-full rounded-lg border border-[#e0ded3] bg-white px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
              />
            </label>
            <button
              onClick={() => void mint()}
              disabled={minting}
              className="rounded-full bg-accent px-5 py-2 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {minting ? "造码中…" : "生成兑换码"}
            </button>
          </div>
          {mintErr && <div className="mt-2.5 text-[12px] text-red-600">{mintErr}</div>}
          {minted && (
            <div className="mt-3 rounded-xl border border-accent/30 bg-accent-soft/40 p-3.5">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[12px] font-medium text-accent">新码已生成（每张 {credits} 积分），复制发给学员：</span>
                <button
                  onClick={() => copyAll(minted)}
                  className="text-[11.5px] text-accent hover:underline"
                >
                  复制全部
                </button>
              </div>
              <div className="font-mono text-[13px] leading-relaxed text-ink select-all">
                {minted.map((c) => (
                  <div key={c.code}>{c.code}</div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* 兑换码记录 */}
        <section className="rounded-2xl border border-[#e7e5dc] bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[14px] font-semibold">
              兑换码记录
              {codesSummary && (
                <span className="ml-2 text-[11.5px] font-normal text-ink-faint">
                  共 {codesSummary.total} 张 · 未用 {codesSummary.unused} 张（{codesSummary.unusedCredits} 积分未兑出）
                </span>
              )}
            </div>
            {unusedCodes.length > 0 && (
              <button onClick={() => copyAll(unusedCodes)} className="text-[11.5px] text-accent hover:underline">
                复制全部未用码
              </button>
            )}
          </div>
          {codesLoading ? (
            <div className="text-[12px] text-ink-faint">加载中…</div>
          ) : codes.length === 0 ? (
            <div className="text-[12px] text-ink-faint">还没有生成过兑换码。</div>
          ) : (
            <div className="space-y-1">
              {codes.slice(0, 30).map((c) => (
                <div key={c.code} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-[#fafaf7]">
                  <span className="font-mono text-[12.5px] text-ink select-all">{c.code}</span>
                  <span className="text-[11.5px] text-ink-soft">{c.credits} 分</span>
                  {c.redeemedBy ? (
                    <span className="text-[11px] text-ink-faint truncate" title={c.redeemedBy}>
                      ✓ {c.redeemedBy} · {fmtTime(c.redeemedAt || c.createdAt)}
                    </span>
                  ) : (
                    <span className="text-[11px] text-accent">未兑换{c.note ? ` · ${c.note}` : ""}</span>
                  )}
                </div>
              ))}
              {codes.length > 30 && (
                <div className="text-[11.5px] text-ink-faint px-2 pt-1">⋯ 还有 {codes.length - 30} 条更早的记录</div>
              )}
            </div>
          )}
        </section>

        {/* 按邮箱补分 */}
        <section className="rounded-2xl border border-[#e7e5dc] bg-white p-5 shadow-sm">
          <div className="text-[14px] font-semibold mb-3">按邮箱调整积分（客诉补偿 / 手动冲正）</div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-[12px] text-ink-soft">
              用户邮箱
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="user@example.com"
                className="mt-1 block w-52 rounded-lg border border-[#e0ded3] bg-white px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
              />
            </label>
            <label className="text-[12px] text-ink-soft">
              积分变动（正发负扣）
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(Math.trunc(Number(e.target.value) || 0))}
                className="mt-1 block w-28 rounded-lg border border-[#e0ded3] bg-white px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
              />
            </label>
            <label className="text-[12px] text-ink-soft flex-1 min-w-[160px]">
              理由（必填，进流水）
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="如：生成失败未退分"
                className="mt-1 block w-full rounded-lg border border-[#e0ded3] bg-white px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
              />
            </label>
            <button
              onClick={() => void grant()}
              disabled={!email.trim() || !amount || reason.trim().length < 2}
              className="rounded-full bg-accent px-5 py-2 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              执行
            </button>
          </div>
          {grantMsg && <div className="mt-2.5 text-[12px] text-emerald-700">{grantMsg}</div>}
          {grantErr && <div className="mt-2.5 text-[12px] text-red-600">{grantErr}</div>}
        </section>

        {/* 当日总览 */}
        <section className="rounded-2xl border border-[#e7e5dc] bg-white p-5 shadow-sm">
          <div className="text-[14px] font-semibold mb-3">经营快照</div>
          {!overview ? (
            <div className="text-[12px] text-ink-faint">加载中…</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: "注册用户", value: overview.users?.total ?? "-" },
                { label: "课程总数", value: overview.courses?.total ?? "-" },
                { label: "积分余额合计", value: overview.credits?.balance ?? "-" },
                { label: "累计消耗积分", value: overview.credits?.spent ?? "-" },
                { label: "今日 LLM 调用", value: overview.todayUsage?.llmCalls ?? "-" },
                {
                  label: "今日 LLM token",
                  value:
                    overview.todayUsage
                      ? `${((overview.todayUsage.promptTokens || 0) / 1000).toFixed(1)}k / ${((overview.todayUsage.completionTokens || 0) / 1000).toFixed(1)}k`
                      : "-",
                },
                { label: "今日 TTS 字符", value: overview.todayUsage?.ttsChars ?? "-" },
                { label: "举报记录", value: overview.marketReports ?? "-" },
              ].map((s) => (
                <div key={s.label} className="rounded-xl border border-[#f1efe8] bg-[#fafaf7] px-3 py-2.5">
                  <div className="text-[11px] text-ink-faint">{s.label}</div>
                  <div className="text-[16px] font-semibold text-ink mt-0.5">{s.value}</div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 text-[11px] text-ink-faint leading-relaxed">
            成本参考（当前牌价）：生成一门课 LLM 约 ¥0.2–0.4；首听一节约 ¥0.5（其中语音合成约 ¥0.4，是大头）；复习命中缓存零成本。
          </div>
        </section>
      </div>
    </div>
  );
}
