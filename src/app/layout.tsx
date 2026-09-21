import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { isLoggedIn, SESSION_COOKIE } from '@/lib/auth';
import LogoutButton from '@/components/LogoutButton';
import './globals.css';

export const metadata: Metadata = {
  title: '요기보 배송조회',
  description: '매장용 고객 배송 진행상황 조회',
  // 고객 정보를 다루는 사내 도구 — 검색엔진에 잡히면 안 된다
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#3fa6d3',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const loggedIn = isLoggedIn((await cookies()).get(SESSION_COOKIE)?.value);

  return (
    <html lang="ko">
      <body>
        <header className="top">
          <h1>요기보 배송조회</h1>
          {/*
            업로드 메뉴는 두지 않는다 — 매장과 물류팀은 받은 주소로 나뉜다(매장 /, 물류팀 /upload).
            메뉴에 올려두면 매장에서 궁금해서 눌러보다 파일을 올리게 된다.
          */}
          {loggedIn && <nav><LogoutButton /></nav>}
        </header>
        {children}
      </body>
    </html>
  );
}
