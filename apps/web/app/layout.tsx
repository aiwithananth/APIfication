import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";

import type { Metadata } from "next";

import { AppProvider } from "@/components/AppContext";
import { Shell } from "@/components/Shell";
import { ToastProvider } from "@/components/ui";

export const metadata: Metadata = {
  title: "APIfication",
  description: "Governed REST, GraphQL and MCP capabilities from one specification.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ToastProvider>
          <AppProvider>
            <Shell>{children}</Shell>
          </AppProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
