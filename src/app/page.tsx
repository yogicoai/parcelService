'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * 매장용 조회 화면.
 *
 * 링크 처리에 한 가지 규칙이 있다 — **검색 결과를 그릴 때 a href 를 미리 박아둔다.**
 * "검색 → await → window.open()" 으로 짜면 async 경계에서 user gesture 가 사라져
 * 브라우저가 팝업으로 차단한다. 직원이 버튼을 눌렀는데 아무 일도 안 일어나는 상황이 된다.
 */

type Shipment = {
  invoice: string;
  invoiceDigits: string;
  carrierLabel: string;
  carrierTel: string;
  carrierNotice: string;
  productName: string;
  orderNo: string;
  trackingUrl: string | null;
  blockedReason: string | null;
  fallbackUrl: string | null;
  isStatusNote: boolean;
};

type Group = {
  customerName: string;
  phoneTail: string;
  phoneType: string;
  store: string;
  shippedAtStr: string;
  address: string;
  shipments: Shipment[];
};

/**
 * 연락처 표기.
 * 예전엔 전부 '010-****-'로 그렸는데, 050 안심번호나 유선번호까지 010 으로 위조됐다.
 * 동명이인이 많은 데이터에서 직원이 그 번호로 사람을 특정하면 엉뚱한 사람 건을 안내하게 된다.
 * 확신할 수 없는 접두는 아예 쓰지 않는다.
 */
function maskPhone(type: string, tail: string): string {
  if (type === 'mobile') return `010-****-${tail}`;
  if (type === 'safe') return `안심번호 ****-${tail}`;
  return `****-${tail}`;
}

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * 업로드 이후 **빠진 영업일**을 센다 — 업로드 다음 날부터 어제까지의 평일 수.
 *
 * 주말엔 배송이 없어서 금요일 데이터가 월요일 아침까지 그대로 최신이다.
 * 달력 시간으로 세면 매주 월요일 아침마다 "3일 전 데이터"가 빨갛게 떠서
 * 매장이 고장으로 오해한다. 그래서 평일만 센다.
 *   금 업로드 → 월 조회: 사이에 토·일뿐 → 0 → 정상
 *   금 업로드 → 화 조회: 월요일이 비었음 → 1 → 경고
 */
function missedBusinessDays(from: Date, now: Date): number {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let n = 0;
  while (d < today) {
    const w = d.getDay();
    if (w !== 0 && w !== 6) n++;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

/**
 * 경과 시간이 아니라 **기준 시각**을 보여준다.
 * "3일 전"보다 "9/19(금) 17:30 기준"이 매장 직원에게 더 정직하다.
 */
function freshnessText(iso: string | null): { text: string; stale: boolean } {
  if (!iso) return { text: '업로드된 배송 데이터가 없습니다 — 물류팀 엑셀을 먼저 올려주세요', stale: true };
  const at = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `${at.getMonth() + 1}/${at.getDate()}(${DOW[at.getDay()]}) ${p(at.getHours())}:${p(at.getMinutes())} 기준`;
  const missed = missedBusinessDays(at, new Date());
  if (missed === 0) return { text: base, stale: false };
  return { text: `${base} — 영업일 ${missed}일째 갱신되지 않았습니다`, stale: true };
}

export default function SearchPage() {
  const [name, setName] = useState('');
  const [tail, setTail] = useState('');
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [lastUpload, setLastUpload] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [copied, setCopied] = useState('');
  const [copyFailed, setCopyFailed] = useState('');

  // 폰이면 택배사 모바일 페이지로 보낸다 — 롯데 PC 페이지는 viewport meta 가 없어 폰에서 깨진다.
  const [mobile, setMobile] = useState(false);
  useEffect(() => { setMobile(window.matchMedia('(max-width: 640px)').matches); }, []);

  useEffect(() => {
    fetch('/api/upload')
      .then((r) => r.json())
      .then((d) => { if (d.ok && d.uploads?.[0]) setLastUpload(d.uploads[0].uploadedAt); })
      .catch(() => { /* 배지는 못 떠도 조회는 되어야 한다 */ });
  }, []);

  const search = useCallback(async () => {
    if (!name.trim()) { setError('고객 이름을 입력해 주세요.'); return; }
    if (name.trim().length < 2) { setError('이름을 두 글자 이상 입력해 주세요.'); return; }
    setLoading(true); setError(''); setGroups(null);
    try {
      const qs = new URLSearchParams();
      if (name.trim()) qs.set('name', name.trim());
      if (tail.trim()) qs.set('tail', tail.trim());
      if (mobile) qs.set('mobile', '1');
      const r = await fetch(`/api/shipments?${qs}`);
      const d = await r.json();
      if (!d.ok) { setError(d.error || '조회에 실패했습니다.'); return; }
      setGroups(d.groups);
      setTruncated(!!d.truncated);
      if (d.lastUpload?.uploadedAt) setLastUpload(d.lastUpload.uploadedAt);
    } catch {
      setError('서버에 연결하지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [name, tail, mobile]);

  /*
   * navigator.clipboard 는 https 또는 localhost 에서만 동작한다.
   * 매장 PC 가 사내 IP(http)로 접속하면 이 API 자체가 없어서 조용히 아무 일도 안 일어난다.
   * 직원은 버튼을 누르고 붙여넣기를 시도하다 엉뚱한 번호를 읽게 된다 — 실패를 반드시 보여준다.
   */
  const copy = async (no: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(no);
      } else {
        const ta = document.createElement('textarea');
        ta.value = no;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('execCommand failed');
      }
      setCopied(no);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      setCopyFailed(no);
      setTimeout(() => setCopyFailed(''), 2500);
    }
  };

  const fresh = freshnessText(lastUpload);

  return (
    <main className="wrap">
      <div className={`freshness${fresh.stale ? ' stale' : ''}`}>
        <span>●</span><span>{fresh.text}</span>
      </div>

      <div className="searchbar">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
          placeholder="고객 이름"
          autoFocus
          enterKeyHint="search"
        />
        <input
          value={tail}
          onChange={(e) => setTail(e.target.value.replace(/\D/g, '').slice(0, 4))}
          onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
          placeholder="연락처 뒤 4자리"
          inputMode="numeric"
          style={{ flex: '0 1 150px' }}
        />
        <button onClick={search} disabled={loading}>{loading ? '조회 중…' : '조회'}</button>
      </div>
      <p className="hint">이름은 두 글자 이상. 동명이인이 있으면 연락처 뒤 4자리를 같이 넣으세요. 최근 60일 출고 건만 보관합니다.</p>

      {error && <div className="err">{error}</div>}

      {groups && groups.length === 0 && (
        <div className="empty">검색 결과가 없습니다.<br />이름 철자나 기간을 확인해 주세요.</div>
      )}

      {truncated && (
        <div className="err">결과가 많아 300건까지만 표시했습니다. 연락처 뒤 4자리를 함께 넣어 좁혀주세요.</div>
      )}

      {groups?.map((g, i) => (
        <div className="card" key={`${g.customerName}-${g.phoneTail}-${i}`}>
          <div className="who">
            <strong>{g.customerName}</strong>
            {g.phoneTail && <span>{maskPhone(g.phoneType, g.phoneTail)}</span>}
            {g.shippedAtStr && <span>{g.shippedAtStr} 출고</span>}
            {g.store && <span>{g.store}</span>}
          </div>
          {g.address && <div className="addr">{g.address}</div>}

          {g.shipments.map((s, j) => (
            <div className="ship" key={`${s.invoice}-${j}`}>
              <span className="tag">{s.carrierLabel}</span>
              {!s.isStatusNote && <span className="no">{s.invoice}</span>}
              <span className="prod">{s.productName}</span>

              {s.trackingUrl ? (
                /* 미리 박아두는 링크 — 클릭 시점에 만들면 팝업 차단에 걸린다 */
                <a className="btn-track" href={s.trackingUrl} target="_blank" rel="noopener noreferrer">
                  자세히 보기
                </a>
              ) : (
                <>
                  {/* 물류팀이 적어 보낸 상태값은 오류가 아니다 — 빨간 경고로 띄우면 직원이 고장으로 오해한다 */}
                  <span className={s.isStatusNote ? 'tag' : 'blocked'}>{s.blockedReason}</span>
                  {s.fallbackUrl && (
                    <a className="btn-copy" href={s.fallbackUrl} target="_blank" rel="noopener noreferrer">
                      네이버에서 조회
                    </a>
                  )}
                </>
              )}

              {!s.isStatusNote && (
              <button className="btn-copy" onClick={() => copy(s.invoiceDigits || s.invoice)}>
                {copied === (s.invoiceDigits || s.invoice) ? '복사됨'
                  : copyFailed === (s.invoiceDigits || s.invoice) ? '복사 실패 — 직접 선택하세요'
                  : '번호 복사'}
              </button>
              )}

              {s.carrierNotice && (
                <div className="notice">
                  {s.carrierNotice}
                  {s.carrierTel && ` · 고객센터 ${s.carrierTel}`}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </main>
  );
}
