import type { Metadata } from "next";
import ProTerminal from "@/components/ProTerminal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "HELIX QUANT · PRO DESK (XAUUSD)",
  description: "Institutionelles Execution-Desk für XAUUSD-Bots: Flotten-Manager, Risk-Controller, Live-Feed.",
};

export default function ProPage() {
  return <ProTerminal />;
}
