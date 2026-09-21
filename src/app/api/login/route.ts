import { NextResponse } from 'next/server';
import { checkPassword, createSession, SESSION_COOKIE } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 로그인 — { password } */
export async function POST(req: Request) {
  let body: { password?: unknown };
  try { body = await req.json(); } catch { body = {}; }
  const password = typeof body.password === 'string' ? body.password : '';

  if (!checkPassword(password)) {
    return NextResponse.json({ ok: false, error: '비밀번호가 맞지 않습니다.' }, { status: 401 });
  }

  let session;
  try {
    session = createSession();
  } catch {
    // AUTH_SECRET 누락 — 배포 설정 문제이므로 사용자에게는 원인을 짧게만 알린다
    return NextResponse.json({ ok: false, error: '서버 설정이 완료되지 않았습니다. 관리자에게 문의하세요.' }, { status: 500 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, session.token, {
    httpOnly: true,                                   // 스크립트로 못 읽게
    secure: process.env.NODE_ENV === 'production',    // 로컬(http)에서도 로그인되게
    sameSite: 'lax',
    path: '/',
    maxAge: session.maxAge,
  });
  return res;
}

/** 로그아웃 */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
