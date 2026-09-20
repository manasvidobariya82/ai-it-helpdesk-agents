import type { Metadata } from "next";
import "../globals.css";

export const metadata: Metadata = {
  title: "Sign in — Helpdesk agent console",
};

export const dynamic = "force-dynamic";

/**
 * The unauthenticated shell.
 *
 * Separate from the console layout because that one calls `requireConsole()`,
 * and a login page inside it would redirect to itself.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="auth-shell">{children}</div>
      </body>
    </html>
  );
}
