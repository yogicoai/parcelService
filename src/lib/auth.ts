import crypto from 'node:crypto';

/**
 * 로그인 — 비밀번호 하나.
 *
 * 매장과 물류팀을 계정으로 나누지 않는다. 대신 **주소를 나눠서 준다**:
 *   매장   → /        (조회)
 *   물류팀 → /upload  (엑셀 업로드)
 * 로그인 후엔 원래 가려던 주소로 돌려보내므로, 각자 받은 주소만 즐겨찾기하면 된다.
 *
 * 비밀번호는 환경변수로 둔다 — Vercel 대시보드에서 값만 바꾸고 재배포하면 끝이다.
 * DB 에 두면 비밀번호 변경 화면을 또 만들어야 하고, 그 화면 자체가 보호 대상이 된다.
 *
 * 세션은 DB 없이 서명된 쿠키로 유지한다: `만료시각.서명`
 */

export const SESSION_COOKIE = 'cdapi_session';
/** 매장 PC 에서 매일 다시 로그인하게 하면 결국 비밀번호를 모니터에 붙여둔다 */
export const SESSION_DAYS = 30;

function appPassword(): string {
  const v = process.env.APP_PASSWORD;
  return v && v.length > 0 ? v : '2026';
}

/**
 * 서명 키. 없으면 **실패한다** — 기본값으로 대체하지 않는다.
 * 소스에 박힌 기본 키로 서명하면 저장소를 본 사람 누구나 쿠키를 위조할 수 있다.
 */
function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error('AUTH_SECRET 이 설정되지 않았습니다 (16자 이상, .env.local / Vercel 환경변수)');
  }
  return s;
}

function hmac(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

/** 길이가 달라도 시간차로 정보가 새지 않게 비교한다 */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function checkPassword(password: string): boolean {
  return safeEqual(password, appPassword());
}

export function createSession(): { token: string; maxAge: number } {
  const maxAge = SESSION_DAYS * 86_400;
  const exp = String(Math.floor(Date.now() / 1000) + maxAge);
  return { token: `${exp}.${hmac(exp)}`, maxAge };
}

/** 쿠키가 유효한 로그인인지. 위조·만료·키 누락이면 false. */
export function isLoggedIn(token: string | undefined | null): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  try {
    return safeEqual(sig, hmac(expStr));
  } catch {
    return false;   // AUTH_SECRET 누락 — 로그인 불가 상태로 둔다(열어두지 않는다)
  }
}
