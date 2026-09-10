// GET /api/credits —— 当前用户积分账本：余额 + 计费规则 + 最近流水（供侧栏余额弹层展示）。
// 计费透明化：此前用户只能在侧栏看到一个会变小的数字，钱怎么花的一概不知。
import { NextRequest, NextResponse } from "next/server";
import { userFromCookieHeader } from "@/lib/auth";
import { getOrCreateAccount, COST_COURSE_GENERATE, COST_TEACHING_SESSION, COST_CAPSTONE_BRIEF, COST_CAPSTONE_REVIEW, COST_UNIT_QUIZ, CHAT_LIMIT_PER_LECTURE } from "@/lib/credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await userFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const acc = await getOrCreateAccount(user.id);
  return NextResponse.json({
    balance: acc.balance,
    granted: acc.granted,
    spent: acc.spent,
    rules: {
      courseGenerate: COST_COURSE_GENERATE,
      teachingSession: COST_TEACHING_SESSION,
      capstoneBrief: COST_CAPSTONE_BRIEF,
      capstoneReview: COST_CAPSTONE_REVIEW,
      unitQuiz: COST_UNIT_QUIZ,
      chatLimitPerLecture: CHAT_LIMIT_PER_LECTURE,
    },
    log: (acc.log || []).slice(-12).reverse(),
  });
}
