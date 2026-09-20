import type { Metadata } from "next";
import "../globals.css";

export const metadata: Metadata = {
  title: "IT Support",
  description: "Raise a ticket and check its status",
};

/**
 * The requester-facing root layout.
 *
 * A separate root from the console on purpose: no sidebar, no tenant switcher,
 * no autonomy banner. None of that is the requester's business, and a shared
 * shell is how operator detail leaks into a customer-facing page.
 */
export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
