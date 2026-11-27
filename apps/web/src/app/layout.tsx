import type { Metadata } from "next";
import "./globals.css";
import { SignOut } from "./sign-out";

export const metadata: Metadata = {
  title: "Cloud Deploy",
  description: "Deploy a Docker image and get a URL.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <SignOut />
        {children}
      </body>
    </html>
  );
}
