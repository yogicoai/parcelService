import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '요기보 배송조회',
  description: '매장용 고객 배송 진행상황 조회',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#3fa6d3',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <header className="top">
          <h1>요기보 배송조회</h1>
          <nav>
            <a href="/">조회</a>
            <a href="/upload">엑셀 업로드</a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
