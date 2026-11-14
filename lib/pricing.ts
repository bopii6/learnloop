// 定价的唯一来源：各动作扣多少积分 + 售卖的积分包。纯常量，前后端都能 import（不得引入 Node 依赖）。
// 设计原则：只有一种货币（积分），按"成功交付的东西"计费——失败自动退回，复习免费，提问不收费。

/** 注册赠送：够生成 1 门课 + 上 10 节新课，完整体验一遍"出课 → 上课 → 小测" */
export const NEW_USER_GRANT = 20;
/** 生成一门课程（搜索 + 澄清 + 蓝图 + 大纲） */
export const COST_COURSE_GENERATE = 10;
/** 第一次上一节课（讲稿生成后缓存，复习免费） */
export const COST_TEACHING_SESSION = 1;
/** 结课工坊：任务书生成一次（缓存后免费重看） */
export const COST_CAPSTONE_BRIEF = 1;
/** 结课工坊：作品验收每次（逐条对照做成标准的严格审稿） */
export const COST_CAPSTONE_REVIEW = 1;
/** 单元测验：出题一次（题目缓存，重考免费） */
export const COST_UNIT_QUIZ = 1;
/** 每节课的课堂提问上限（提问不扣分，靠上限防滥用） */
export const CHAT_LIMIT_PER_LECTURE = 30;

/** 完整学完一门典型课（生成 + 约 20 节新课 + 4 次单元测验 + 任务书 + 1 次验收）大约要多少积分 */
export const CREDITS_PER_FULL_COURSE =
  COST_COURSE_GENERATE + 20 * COST_TEACHING_SESSION + 4 * COST_UNIT_QUIZ + COST_CAPSTONE_BRIEF + COST_CAPSTONE_REVIEW;

export interface CreditPack {
  id: string;
  credits: number;
  /** 售价（元） */
  price: number;
  name: string;
  /** 这包积分够干什么——用学员听得懂的话说 */
  pitch: string;
  popular?: boolean;
}

/** 售卖面额：1 积分 ≈ ¥1，大额多赠（与运营后台造码面额一致） */
export const CREDIT_PACKS: CreditPack[] = [
  { id: "taste", credits: 10, price: 9.9, name: "尝鲜", pitch: "再生成一门新课，先看看课程设计合不合你意" },
  { id: "one", credits: 32, price: 29.9, name: "学一门", pitch: "一门课的主体课节全部听完" },
  { id: "full", credits: 55, price: 49.9, name: "学透一门", pitch: "新开一门课并完整学完：课节 + 单元测验 + 结课验收", popular: true },
  { id: "more", credits: 115, price: 99, name: "多门进阶", pitch: "两到三门课一起推进，单价最低" },
];

export function pricePerCredit(p: CreditPack): number {
  return Math.round((p.price / p.credits) * 100) / 100;
}

export function fmtYuan(n: number): string {
  return `¥${Number.isInteger(n) ? n : n.toFixed(1)}`;
}

/** 线下收款通道（未接支付接口前）：收款码图片地址 + 联系方式，未配置则页面只保留兑换入口 */
export const PURCHASE_QR_URL = process.env.NEXT_PUBLIC_PURCHASE_QR_URL || "";
export const PURCHASE_CONTACT = process.env.NEXT_PUBLIC_PURCHASE_CONTACT || "";
