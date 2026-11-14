import type { Config } from "tailwindcss";

// 视觉系统「私教的红笔」：暖纸底 + 墨黑 + 一支朱红笔。所有颜色走 CSS 变量（app/globals.css :root），
// 带 <alpha-value> 让 accent/25、ink/60 这类透明度写法照常可用。
const v = (name: string) => `rgb(var(--${name}-rgb) / <alpha-value>)`;

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 朱红笔：圈重点、打勾、主操作。课堂作用域（.classroom-sunny）内沿用墨纸主题的深墨蓝
        accent: { DEFAULT: v("accent"), soft: v("accent-soft"), border: v("accent-border") },
        ink: { DEFAULT: v("ink"), soft: v("ink-soft"), faint: v("ink-faint") },
        paper: v("paper"), // 页面底色（暖纸）
        surface: v("surface"), // 卡片底色
        sunken: v("sunken"), // 凹陷底：输入槽、次级块、悬停
        line: { DEFAULT: v("line"), strong: v("line-strong") }, // 细线
        pass: v("pass"), // 过关 / 免费 / 成功（墨绿）
      },
      fontFamily: {
        sans: ["system-ui", "-apple-system", "PingFang SC", "Microsoft YaHei", "sans-serif"],
        // 衬线数字与英文：进度、价格、积分、编号——让数字像"批改分数"一样有分量
        display: ['"Instrument Serif"', "Georgia", "Songti SC", "serif"],
      },
      boxShadow: {
        card: "0 1px 0 rgb(var(--line-rgb)), 0 8px 24px -12px rgb(var(--ink-rgb) / 0.12)",
        lift: "0 1px 0 rgb(var(--line-rgb)), 0 18px 40px -18px rgb(var(--ink-rgb) / 0.25)",
      },
    },
  },
  plugins: [],
};

export default config;
