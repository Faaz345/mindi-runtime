import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MINDIGENOUS — One Runtime. Any Model. Unified Capabilities.",
  description:
    "The provider-agnostic agentic coding terminal. You choose the model; the runtime gives it the capabilities it's missing — vision, web, filesystem, git, terminal — without ever switching your assistant.",
  keywords: [
    "agentic coding terminal",
    "AI CLI",
    "provider-agnostic",
    "LLM runtime",
    "mindi",
    "mindigenous",
  ],
  openGraph: {
    title: "MINDIGENOUS — Agentic Coding Terminal",
    description:
      "One Runtime. Any Model. Unified Capabilities. Install with one command.",
    url: "https://mindigenous.online",
    siteName: "MINDIGENOUS",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
