import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "HELIX QUANT — Institutional Alpha Research Terminal",
  description:
    "Multi-model algorithmic trading research platform: 13 alpha models, meta-labelling, walk-forward validation, CSCV overfitting audits and Monte Carlo risk analytics.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="text-slate-200 antialiased">
        {children}
      </body>
    </html>
  );
}
