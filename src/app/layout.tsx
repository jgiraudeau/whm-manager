import type { Metadata } from "next";
import "./globals.css";
import AppShell from "@/components/app-shell";

export const metadata: Metadata = {
  title: "WHM Manager — o2switch",
  description: "Interface de gestion des comptes cPanel sur campus01.o2switch.net",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className="dark">
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
