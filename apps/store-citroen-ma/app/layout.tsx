import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "NARA — Jeep Maroc",
  description: "Assistante virtuelle pour le e-commerce de Jeep Maroc.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
