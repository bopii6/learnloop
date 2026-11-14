import type { Metadata } from "next";
import "@fontsource/instrument-serif/latin-400.css";
import "@fontsource/instrument-serif/latin-400-italic.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Superlearn · AI 白板讲师",
  description: "一句话生成一门系统课程：白板讲师逐句讲解配板书，先过关再拔高，学完交付作品",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
