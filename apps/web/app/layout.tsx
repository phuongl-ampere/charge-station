import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppChrome } from "../components/AppChrome";
import "./globals.css";

export const metadata: Metadata = {
  title: "Charge Station",
  description: "Local EV charging checkout and live station status",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <AppChrome>{children}</AppChrome>
      </body>
    </html>
  );
}
