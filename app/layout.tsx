import type { Metadata } from "next";
import "./globals.css";
import "./semantics.css";
import { langDir } from "../lib/lang";
import { serverLang } from "./lang-server";

export const metadata: Metadata = {
  title: "Wasl AI — One API. Every possibility.",
  description: "Explore AI models, compare transparent pricing, and build with one unified API. Arabic and English experience with multi-currency estimates.",
};

// lang and dir come from the wasl_lang cookie, so the first paint already uses the visitor's language (no inline script).
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const lang = await serverLang();
  return <html lang={lang} dir={langDir(lang)}><body>{children}</body></html>;
}
