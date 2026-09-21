import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { buildTrackingUrl, buildNaverFallbackUrl, isLookupExpired, CARRIERS, type CarrierKey } from '@/lib/carriers';

/**
 * 고객 이름으로 배송 건을 찾는다.
 *
 * 택배사 API 는 운송장번호를 넣어야만 답한다 — 이름으로는 아무것도 못 찾는다.
 * 그래서 이름→운송장 매핑은 우리가 적재한 엑셀에서만 나온다. 이 라우트가 그 역할이다.
 *
 * 결과는 운송장 단위가 아니라 **고객 단위로 묶어서** 돌려준다.
 * 실제 데이터에서 한 주문이 품목별로 쪼개져 서로 다른 운송장을 받는다(...164, ...165).
 * 운송장을 평평하게 나열하면 매장에서 "왜 같은 사람이 세 줄이죠?" 가 된다.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Doc = {
  store?: string; invoice?: string; invoiceDigits?: string;
  carrierRaw?: string; carrierKey?: CarrierKey | null;
  orderNo?: string; shippedAt?: Date | string | null; shippedAtStr?: string;
  customerName?: string; phone?: string; phoneTail?: string; phoneType?: string;
  address?: string; productName?: string; productCode?: string; note?: string;
};

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const name = (url.searchParams.get('name') || '').trim();
    const tail = (url.searchParams.get('tail') || '').replace(/\D/g, '');
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    const mobile = url.searchParams.get('mobile') === '1';

    // 이름 없이 뒤 4자리만으로는 조회하지 않는다. 이 앱은 '이름으로 찾는' 도구이고,
    // 뒤 4자리 단독 조회는 0000~9999 를 훑으면 전 고객이 나온다.
    if (!name) {
      return NextResponse.json({ ok: false, error: '고객 이름을 입력해 주세요.' }, { status: 400 });
    }
    // 성 한 글자('김')로 검색하면 수천 건이 걸려 매장 모니터에 남의 고객 정보가 깔린다.
    if (name.length < 2) {
      return NextResponse.json({ ok: false, error: '이름을 두 글자 이상 입력해 주세요.' }, { status: 400 });
    }

    const q: Record<string, unknown> = {};
    if (name) {
      // 부분일치 — 매장에서 "김민"만 기억하는 경우가 흔하다. 정규식 특수문자는 막는다.
      q.customerName = { $regex: name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
    }
    if (tail) q.phoneTail = tail;
    if (from || to) {
      const range: Record<string, Date> = {};
      if (from) range.$gte = new Date(`${from}T00:00:00+09:00`);
      if (to) range.$lte = new Date(`${to}T23:59:59+09:00`);
      q.shippedAt = range;
    }

    const db = await getDb();
    const docs = await db.collection<Doc>('shipments')
      .find(q, { projection: { _id: 0 } })
      .sort({ shippedAt: -1 })
      .limit(300)
      .toArray();

    // 고객 + 연락처 + 출하일 단위로 묶는다
    const groups = new Map<string, {
      customerName: string; phoneTail: string; phoneType: string; store: string;
      shippedAtStr: string; address: string;
      shipments: unknown[];
    }>();

    for (const d of docs) {
      /*
       * 연락처가 비어 있으면 절대 묶지 않는다.
       * 예전엔 `이름|뒤4자리|출고일` 로 묶었는데, 연락처가 빈 행끼리는 뒤 4자리가 둘 다 ''
       * 이라서 **같은 날 출고된 동명이인이 한 카드로 합쳐졌다.** 주소는 첫 행 것만 보이므로
       * 직원은 A 의 주소 아래 B 의 운송장을 보고 그대로 안내하게 된다.
       * 뒤 4자리도 겹칠 수 있으니 전체 번호로 묶는다.
       */
      const key = d.phone
        ? `${d.customerName}|${d.phone}|${d.shippedAtStr ?? ''}`
        : `solo|${d.invoiceDigits ?? ''}|${d.productCode ?? ''}`;
      if (!groups.has(key)) {
        groups.set(key, {
          customerName: d.customerName ?? '',
          phoneTail: d.phoneTail ?? '',
          phoneType: d.phoneType ?? 'empty',
          store: d.store ?? '',
          shippedAtStr: d.shippedAtStr ?? '',
          address: d.address ?? '',
          shipments: [],
        });
      }
      const shippedAt = d.shippedAt ? new Date(d.shippedAt) : null;
      const link = buildTrackingUrl(d.carrierRaw, d.invoice, mobile);
      const carrier = link.ok ? link.carrier : (d.carrierKey ? CARRIERS[d.carrierKey] : null);
      const expired = isLookupExpired(carrier, shippedAt);

      groups.get(key)!.shipments.push({
        invoice: d.invoice ?? '',
        invoiceDigits: d.invoiceDigits ?? '',
        carrierLabel: carrier?.label ?? (d.carrierRaw || '알 수 없음'),
        carrierTel: carrier?.tel ?? '',
        carrierNotice: carrier?.notice ?? '',
        productName: d.productName ?? '',
        orderNo: d.orderNo ?? '',
        // 링크를 못 만들면 url 을 주지 않고 이유를 준다 — 빈 링크를 누르게 하지 않는다.
        trackingUrl: link.ok && !expired ? link.url : null,
        /*
         * 순서가 중요하다. 링크를 못 만든 이유가 만료 안내보다 구체적이다.
         * 특히 운송장 칸에 '재고소진'·'차량배차' 가 적힌 건은 출하일도 비어 있어서
         * 만료 판정을 먼저 태우면 "출하일자를 읽지 못했습니다"로 덮여버린다.
         * 직원이 필요한 답은 "재고소진이라 아직 안 나갔습니다" 쪽이다.
         */
        blockedReason: !link.ok
          ? link.reason
          : expired
            ? (shippedAt
              ? `출하 후 ${carrier?.lookupDays}일이 지나 조회되지 않습니다`
              : '출하일자를 읽지 못해 조회 가능 여부를 확인할 수 없습니다 — 번호를 복사해 직접 조회하세요')
            : null,
        /** 운송장이 아니라 물류팀이 적어 보낸 상태값인지 (화면에서 오류처럼 안 보이게) */
        isStatusNote: !link.ok && !d.invoiceDigits && !!(d.invoice || '').trim(),
        /*
         * 폴백은 '번호는 멀쩡한데 택배사 페이지가 안 열릴 때'의 대안이다.
         * 번호 자체가 검증에 실패한 건(체크디지트 불일치·메모·자릿수 미달)에 폴백을 주면
         * 애써 막아놓은 검증을 직원이 한 번 더 클릭해서 우회하게 된다.
         */
        fallbackUrl: link.ok && carrier && d.invoiceDigits
          ? buildNaverFallbackUrl(carrier, d.invoiceDigits, mobile) : null,
      });
    }

    const last = await db.collection('uploads')
      .find({}, { projection: { _id: 0, uploadedAt: 1, fileName: 1 } })
      .sort({ uploadedAt: -1 }).limit(1).toArray();

    return NextResponse.json({
      ok: true,
      total: docs.length,
      truncated: docs.length >= 300,
      groups: [...groups.values()],
      lastUpload: last[0] ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
