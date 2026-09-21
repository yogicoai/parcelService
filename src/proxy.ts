import { NextResponse, type NextRequest } from 'next/server';
import { isLoggedIn, SESSION_COOKIE } from '@/lib/auth';

/**
 * 모든 요청 앞단의 접근 제어. (Next 16 에서 middleware 가 proxy 로 이름이 바뀌었다)
 *
 * 이 앱은 고객 실명·연락처 뒤 4자리·주소를 검색하는 화면이라 URL 만 알면
 * 누구나 들어오는 상태로 둘 수 없다. 로그인하지 않으면 화면은 /login 으로, API 는 401.
 *
 * 매장과 물류팀은 계정이 아니라 **받은 주소**로 나뉜다(매장 /, 물류팀 /upload).
 * 로그인 화면으로 보낼 때 원래 주소를 next 에 실어서, 로그인 후 그 자리로 돌려보낸다.
 */

/** 로그인 없이 열리는 경로 */
const PUBLIC = ['/login', '/api/login'];

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  if (isLoggedIn(req.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ ok: false, error: '로그인이 필요합니다.' }, { status: 401 });
  }
  const url = new URL('/login', req.url);
  if (pathname !== '/') url.searchParams.set('next', pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  // 정적 파일까지 막으면 로그인 화면의 CSS·폰트도 안 뜬다
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
