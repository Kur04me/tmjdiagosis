import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TMJ Diagnosis Prototype",
  description: "2D image viewer prototype with Rust Wasm integration.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
