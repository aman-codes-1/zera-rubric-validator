import type { Metadata } from 'next';
import { PRODUCT_TITLE } from '@/lib/constants.mjs';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://zera-rubric-validator.vercel.app'),
  title: PRODUCT_TITLE,
  description:
    'Validate rubric batches, tags, reproduction steps, grammar, and product-documentation alignment.',
  openGraph: {
    title: PRODUCT_TITLE,
    description: 'Validate rubric batches against product documentation',
    images: [{ url: '/og.png', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: PRODUCT_TITLE,
    description: 'Validate rubric batches against product documentation',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
