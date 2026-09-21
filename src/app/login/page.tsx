'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';

function LoginForm() {
  const params = useSearchParams();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!password) { setError('비밀번호를 입력해 주세요.'); return; }
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || '로그인에 실패했습니다.'); return; }
      // 원래 가려던 주소로 돌려보낸다(물류팀은 /upload 로 들어왔다가 그대로 복귀).
      // 우리 사이트 안의 경로만 받는다 — 외부 주소로 튕겨나가는 걸 막는다.
      const next = params.get('next');
      window.location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
    } catch {
      setError('서버에 연결하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="wrap login">
      <h2>로그인</h2>
      <div className="searchbar">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="비밀번호"
          autoFocus
          autoComplete="current-password"
        />
        <button onClick={submit} disabled={busy}>{busy ? '확인 중…' : '로그인'}</button>
      </div>
      {error && <div className="err">{error}</div>}
    </main>
  );
}

export default function LoginPage() {
  // useSearchParams 는 Suspense 경계 안에서만 정적 빌드가 된다
  return <Suspense><LoginForm /></Suspense>;
}
