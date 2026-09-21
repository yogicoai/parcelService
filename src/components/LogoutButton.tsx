'use client';

export default function LogoutButton() {
  return (
    <button
      className="nav-btn"
      onClick={async () => {
        await fetch('/api/login', { method: 'DELETE' }).catch(() => {});
        window.location.href = '/login';
      }}
    >
      로그아웃
    </button>
  );
}
