import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        accent: {
          // 走 CSS 变量（空格分隔 RGB）：全站默认墨绿，课堂作用域（.classroom-sunny）内整体切换暖阳色，
          // 带 <alpha-value> 让 accent/25 这类透明度写法继续可用
          DEFAULT: "rgb(var(--accent-rgb) / <alpha-value>)",
          soft: "rgb(var(--accent-soft-rgb) / <alpha-value>)",
          border: "rgb(var(--accent-border-rgb) / <alpha-value>)",
        },
        ink: {
          DEFAULT: "#1a1a18",
          soft: "#5F5E5A",
          faint: "#888780",
        },
        paper: "#FAFAF7",
      },
      fontFamily: {
        sans: [
          "system-ui",
          "-apple-system",
          "PingFang SC",
          "Microsoft YaHei",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
