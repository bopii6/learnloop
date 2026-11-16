"use client";

// 运营后台（仅 ADMIN_EMAIL 可见，侧栏有入口）：经营快照（用户 / 课程 / 当日用量 / 举报）。
// 纯客户端拼装既有 admin 接口，不做权限系统——服务端每个接口各自验 isAdminUser。
import { useCallback, useEffect, useState } from "react";

export default function AdminPage() {
  const [me, setMe] = useState<{ email: string } | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null); // null = 校验中
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

  const loadOverview = useCallback(async () => {
    const res = await fetch("/api/admin/overview");
    if (res.ok) setOverview(await res.json());
  }, []);

  useEffect(() => {
    if (isAdmin) void loadOverview();
  }, [isAdmin, loadOverview]);

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

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[22px] font-bold">运营后台</h1>
            <div className="text-[12px] text-ink-faint mt-0.5">管理员 {me.email}</div>
          </div>
          <button
            onClick={() => void loadOverview()}
            className="rounded-full border border-[#d3d1c7] px-4 py-1.5 text-[12px] text-ink-soft hover:border-accent hover:text-accent transition-colors"
          >
            ⟳ 刷新
          </button>
        </div>

        <section className="rounded-2xl border border-[#e7e5dc] bg-white p-5 shadow-sm">
          <div className="text-[14px] font-semibold mb-3">经营快照</div>
          {!overview ? (
            <div className="text-[12px] text-ink-faint">加载中…</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {[
                { label: "注册用户", value: overview.users?.total ?? "-" },
                { label: "课程总数", value: overview.courses?.total ?? "-" },
                { label: "举报记录", value: overview.marketReports ?? "-" },
                { label: "今日 LLM 调用", value: overview.todayUsage?.llmCalls ?? "-" },
                {
                  label: "今日 LLM token",
                  value: overview.todayUsage
                    ? `${((overview.todayUsage.promptTokens || 0) / 1000).toFixed(1)}k / ${((overview.todayUsage.completionTokens || 0) / 1000).toFixed(1)}k`
                    : "-",
                },
                { label: "今日 TTS 字符", value: overview.todayUsage?.ttsChars ?? "-" },
              ].map((s) => (
                <div key={s.label} className="rounded-xl border border-[#f1efe8] bg-[#fafaf7] px-3 py-2.5">
                  <div className="text-[11px] text-ink-faint">{s.label}</div>
                  <div className="text-[16px] font-semibold text-ink mt-0.5">{s.value}</div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 text-[11px] text-ink-faint leading-relaxed">
            成本参考（当前牌价）：生成一门课 LLM 约 ¥0.15；首听一节约 ¥0.25（其中语音合成是大头）；复习命中缓存零成本。
          </div>
        </section>
      </div>
    </div>
  );
}
