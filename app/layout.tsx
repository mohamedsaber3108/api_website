import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wasl AI — One API. Every possibility.",
  description: "Explore AI models, compare transparent pricing, and build with one unified API. Arabic and English experience with multi-currency estimates.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ar" dir="rtl"><body>{children}</body></html>;
}
