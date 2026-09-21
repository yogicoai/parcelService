'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 물류팀 엑셀 업로드 + 등록 게시판.
 *
 * 이 화면의 존재 이유는 "파일을 받는 것"이 아니라 **올린 사람에게 결과를 돌려주는 것**이다.
 * 컬럼명이 바뀌었거나 운송장이 빠졌으면 올린 사람이 즉시 알아야 하고,
 * 나중에 다시 와서 "내가 어제 올린 게 제대로 들어갔나"를 확인할 수 있어야 한다.
 * 그래서 업로드 결과를 이력으로 남기고 등록일 기준으로 보여준다.
 */

type Stats = {
  totalRows: number; kept: number;
  skippedNoInvoice: number; skippedNoName: number;
  unknownCarrier: number; badDate: number; duplicateDropped: number;
};

type Upload = {
  uploadedAt: string;
  fileName: string;
  sheetName: string;
  headerRow: number;
  inserted: number;
  updated: number;
  retentionDays?: number;
  purged?: number;
  replacedSameDay?: number;
  stats: Stats;
  warnings: string[];
};

/** 확인이 필요한 항목만 골라낸다. 0 건은 굳이 보여주지 않는다. */
function issuesOf(u: Upload): string[] {
  const s = u.stats;
  const out = [...(u.warnings ?? [])];
  if (s.skippedNoInvoice > 0) out.push(`운송장번호가 없어 건너뛴 행 ${s.skippedNoInvoice}건`);
  if (s.skippedNoName > 0) out.push(`이름이 없어 건너뛴 행 ${s.skippedNoName}건`);
  if (s.unknownCarrier > 0) out.push(`택배사를 알 수 없는 행 ${s.unknownCarrier}건 — 조회 버튼이 안 생깁니다`);
  if (s.badDate > 0) out.push(`출하일자를 읽지 못한 행 ${s.badDate}건 — 기간 검색에서 빠집니다`);
  if (s.duplicateDropped > 0) out.push(`앞선 행과 같은 건으로 판정돼 버린 행 ${s.duplicateDropped}건 — 품목 구분 컬럼을 확인해 주세요`);
  return out;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function UploadPage() {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Upload[]>([]);
  const [justUploaded, setJustUploaded] = useState('');
  const [open, setOpen] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    fetch('/api/upload')
      .then((r) => r.json())
      .then((d) => { if (d.ok) setHistory(d.uploads ?? []); })
      .catch(() => { /* 이력을 못 불러와도 업로드는 되어야 한다 */ });
  }, []);

  useEffect(() => { load(); }, [load]);

  const send = useCallback(async (file: File) => {
    if (busy) return;                     // 연타로 같은 파일이 두 번 올라가지 않게
    // 서버(Vercel)는 4.5MB 를 넘는 요청을 우리 코드에 닿기도 전에 거절한다.
    // 그러면 물류팀은 이유 모를 오류만 보게 되니, 올리기 전에 알아듣게 막는다.
    if (file.size > 4 * 1024 * 1024) {
      setError(`파일이 너무 큽니다(${(file.size / 1048576).toFixed(1)}MB). 4MB 이하로 올려주세요 — 최근 60일치만 남기면 충분합니다.`);
      return;
    }
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      const d = await r.json();
      if (!d.ok) { setError(d.error || '업로드에 실패했습니다.'); return; }
      setJustUploaded(d.uploadedAt);
      setOpen(d.uploadedAt);               // 방금 올린 건은 펼쳐서 결과를 바로 보여준다
      load();
    } catch {
      setError('서버에 연결하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }, [busy, load]);

  return (
    <main className="wrap">
      <div
        className={`drop${dragging ? ' on' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault(); setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) send(f);
        }}
        onClick={() => { if (!busy) inputRef.current?.click(); }}
        style={{ cursor: busy ? 'default' : 'pointer' }}
      >
        {busy ? '읽는 중입니다…' : '배송현황 엑셀을 여기로 끌어다 놓거나 클릭해서 선택하세요'}
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls"
          hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) send(f); e.target.value = ''; }}
        />
      </div>

      <p className="hint">
        파일은 가공하지 않으셔도 됩니다. 컬럼 순서가 달라도 「운송장번호」와 「이름」만 있으면 읽습니다.
        같은 날 여러 번 올리면 <b>마지막 파일 기준</b>으로 정리됩니다 — 잘못 올렸으면 고쳐서 다시 올리시면 됩니다.
        등록 이력은 하루 한 건씩 최근 7일치만 보입니다.
        출하 후 60일이 지난 건은 자동으로 삭제됩니다(아직 출고되지 않은 건은 남습니다).
      </p>

      {error && <div className="err">{error}</div>}

      <h2 className="board-title">등록 이력 <small>최근 7일</small></h2>

      {history.length === 0 && <div className="empty">아직 등록된 파일이 없습니다.</div>}

      {history.map((u) => {
        const issues = issuesOf(u);
        const expanded = open === u.uploadedAt;
        return (
          <div className={`board-row${u.uploadedAt === justUploaded ? ' fresh' : ''}`} key={u.uploadedAt}>
            <button className="board-head" onClick={() => setOpen(expanded ? '' : u.uploadedAt)}>
              <span className="date">{fmtDate(u.uploadedAt)}</span>
              <span className="fname">{u.fileName}</span>
              {/* 하루 한 건 구조라 신규/갱신 구분은 헷갈리기만 한다 — 그날 들어간 수만 보여준다 */}
              <span className="cnt">등록 {u.stats.kept.toLocaleString()}건</span>
              {issues.length > 0
                ? <span className="badge warn">확인 {issues.length}</span>
                : <span className="badge ok">정상</span>}
              <span className="chev">{expanded ? '▲' : '▼'}</span>
            </button>

            {expanded && (
              <div className="board-body">
                <dl>
                  <dt>시트</dt><dd>{u.sheetName} ({u.headerRow}행이 헤더)</dd>
                  <dt>읽은 행</dt><dd>{u.stats.totalRows.toLocaleString()}행 → 등록 {u.stats.kept.toLocaleString()}건</dd>
                  <dt>변경</dt>
                  <dd>
                    {u.inserted > 0 || u.updated > 0
                      ? `새로 들어옴 ${u.inserted.toLocaleString()} · 덮어씀 ${u.updated.toLocaleString()}`
                      : '변경 없음'}
                  </dd>
                  {!!u.replacedSameDay && (
                    <>
                      <dt>같은 날 정리</dt>
                      <dd>이전 업로드에만 있던 {u.replacedSameDay.toLocaleString()}건 삭제</dd>
                    </>
                  )}
                  {u.purged !== undefined && (
                    <>
                      <dt>보관 정리</dt>
                      <dd>{u.purged > 0
                        ? `${u.purged.toLocaleString()}건 삭제 (${u.retentionDays}일 경과)`
                        : `삭제 없음 (${u.retentionDays ?? 60}일 보관)`}</dd>
                    </>
                  )}
                </dl>
                {issues.length > 0
                  ? <div className="warn">{issues.map((t, i) => <div key={i}>⚠ {t}</div>)}</div>
                  : <p className="allgood">문제 없이 전부 등록됐습니다.</p>}
              </div>
            )}
          </div>
        );
      })}

      <p style={{ marginTop: 24 }}>
        <a className="btn-track" href="/">조회 화면으로</a>
      </p>
    </main>
  );
}
