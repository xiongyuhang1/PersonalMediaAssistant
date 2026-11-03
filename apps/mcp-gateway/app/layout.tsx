import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Personal Media · 个人兴趣空间",
  description: "在同一处查看游戏、视频、音乐与动画的真实记录和同步状态。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
