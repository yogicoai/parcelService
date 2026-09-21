/**
 * 택배사 배송조회 딥링크 어댑터.
 *
 * 우리는 택배사 API 를 쓰지 않는다. 운송장번호를 URL 에 실어 택배사 공식 조회 페이지를
 * 새 탭으로 여는 것이 전부다. 그래서 키·요금·호출제한·약관 문제가 없다.
 *
 * 이 선택의 근거 —
 *   경동택배는 공식 API 가 아예 없다(개발용 서브도메인 전무, 문서 경로 404, 전산 창구 없음).
 *   홈페이지 내부 AJAX 는 열리지만 Spring 내부 객체가 그대로 직렬화돼 나오는 비공개 경로이고,
 *   2025-03-04 에 응답 필드가 공지 없이 바뀐 전력이 있다(regDt → scanDt).
 *   그걸 파싱해서 만들었으면 어느 날 조용히 죽었을 것이다.
 *
 * URL 을 코드 곳곳에 박지 않고 여기 한 곳에 모아둔 이유도 같다 —
 *   경동은 이미 한 번 조회 URL 을 통째로 갈아엎었다(newDeliverySearch.kd 는 지금 403).
 */

export type CarrierKey = 'lotte' | 'kdexp';

export type Carrier = {
  key: CarrierKey;
  label: string;
  /** 엑셀 '택배사' 칸에 실제로 적혀 오는 표기들 */
  aliases: string[];
  tel: string;
  /** 조회 결과가 안 나올 수 있는 기간 — 지나면 버튼을 비활성화한다 */
  lookupDays: number;
  /** 운송장으로 인정할 최소 자릿수 — 아래 minDigits 주석 참고 */
  minDigits: number;
  /** 화면에 같이 띄울 주의 문구 */
  notice: string;
};

export const CARRIERS: Record<CarrierKey, Carrier> = {
  lotte: {
    key: 'lotte',
    label: '롯데택배',
    aliases: ['롯데택배', '롯데', '롯데글로벌로지스', 'LOTTE', 'lotte'],
    tel: '1588-2121',
    lookupDays: 90,
    minDigits: 12,   // 실데이터 4,134건 중 4,131건이 12자리
    notice: '번호가 틀려도 「발송 준비중」 화면이 뜹니다. 화면의 운송장번호가 아래 번호와 같은지 확인하세요.',
  },
  kdexp: {
    key: 'kdexp',
    label: '경동택배',
    aliases: ['경동택배', '경동', 'KDEXP', 'kdexp', '경동물류'],
    tel: '1899-5368',
    lookupDays: 120,
    minDigits: 10,   // 실데이터 5,013건 중 5,008건이 13자리. 10자리 미만은 전부 오입력이었다
    notice: '조회 실패 시 경고창이 뜹니다. 4개월 이전 건은 조회되지 않습니다.',
  },
};

/**
 * 엑셀의 택배사 칸으로 택배사를 정한다.
 *
 * 운송장 자릿수로 추측하지 않는다 — 경동 입력란은 maxlength 21 에 자릿수 검증이 아예 없어서
 * "13자리면 경동" 같은 규칙에 근거가 없다. 엑셀이 알려준 값만 믿는다.
 *
 * 선착순으로 고르지 않는 이유: 한 칸에 "롯데/경동" 처럼 둘이 같이 적혀 오면
 * 객체 선언 순서 때문에 항상 롯데가 이긴다. 그렇게 고른 택배사가 틀리면
 * 직원은 멀쩡히 열린 조회 페이지에서 "정보 없음"을 보고 잘못 판단한다.
 * 모호하면 고르지 않고 직원에게 넘기는 편이 낫다.
 */
export type CarrierMatch =
  | { carrier: Carrier; ambiguous: false }
  | { carrier: null; ambiguous: true; candidates: string[] }
  | { carrier: null; ambiguous: false; candidates: [] };

export function matchCarrier(raw: string | null | undefined): CarrierMatch {
  const s = String(raw ?? '').replace(/\s+/g, '').toLowerCase();
  if (!s) return { carrier: null, ambiguous: false, candidates: [] };
  const hits = Object.values(CARRIERS).filter((c) =>
    c.aliases.some((a) => s.includes(a.replace(/\s+/g, '').toLowerCase())),
  );
  if (hits.length === 1) return { carrier: hits[0], ambiguous: false };
  if (hits.length > 1) return { carrier: null, ambiguous: true, candidates: hits.map((c) => c.label) };
  return { carrier: null, ambiguous: false, candidates: [] };
}

/** 단일 택배사로 확정될 때만 돌려준다. 모호하거나 못 찾으면 null. */
export function resolveCarrier(raw: string | null | undefined): Carrier | null {
  return matchCarrier(raw).carrier;
}

/** 운송장번호에서 숫자만 남긴다. 이 정규화는 선택이 아니라 필수다 — 아래 buildTrackingUrl 참고. */
export function normalizeInvoice(raw: string | null | undefined): string {
  return String(raw ?? '').replace(/\D/g, '');
}

/**
 * 롯데 운송장 체크디지트 검증.
 *
 * 롯데 조회 페이지는 **틀린 번호에 에러를 내지 않는다.** 번호를 아예 빼도, 엉터리를 넣어도
 * 응답이 완전히 동일하고 화면엔 "상품 발송 준비중입니다"가 뜬다.
 * 그래서 엑셀 오타가 매장 직원 눈에는 "아직 발송 준비중이래요"로 보이고, 고객에게 그대로 잘못 안내된다.
 * 링크를 만들기 전에 여기서 걸러내야 한다.
 *
 * 규칙(롯데 조회 폼 JS 에서 추출): 12자리 숫자, 앞 11자리를 정수로 본 값 % 7 === 12번째 자리.
 */
export function isValidLotteInvoice(digits: string): boolean {
  if (!/^\d{12}$/.test(digits)) return false;
  const head = Number(digits.slice(0, 11));
  if (!Number.isSafeInteger(head)) return false;
  return head % 7 === Number(digits[11]);
}

export type TrackingLink =
  | { ok: true; url: string; carrier: Carrier }
  | { ok: false; reason: string; carrier: Carrier | null; invoice: string };

/**
 * 조회 딥링크를 만든다. 만들 수 없으면 이유를 돌려준다(빈 링크를 주지 않는다).
 *
 * @param mobile 폰에서 열 링크인지. 롯데 PC 페이지에는 viewport meta 가 아예 없어서
 *               폰에서 데스크톱 폭으로 렌더되어 글자가 깨알만 해진다. 경로만 다르고 동작은 같다.
 */
export function buildTrackingUrl(
  carrierRaw: string | null | undefined,
  invoiceRaw: string | null | undefined,
  mobile = false,
): TrackingLink {
  const carrier = resolveCarrier(carrierRaw);
  const invoice = normalizeInvoice(invoiceRaw);

  /*
   * 운송장 칸에 숫자가 아니라 **상태**가 적혀 오는 경우가 많다.
   * 실데이터(2026-09-18 출고내역 3,554건)에서 81건:
   *   차량배차 33 · 재고소진 30 · 안전재고 11 · 직접수령 7
   * 이건 오류가 아니라 물류팀이 적어 보내는 진짜 답이다.
   * "운송장번호가 없습니다"로 뭉개면 직원이 고객에게 아무것도 설명하지 못한다.
   * 택배사보다 먼저 확인하는 이유: 상태가 적힌 건은 애초에 택배로 안 나간다.
   */
  const rawText = String(invoiceRaw ?? '').trim();
  if (!invoice && rawText) {
    return { ok: false, reason: rawText, carrier: carrier ?? null, invoice: '' };
  }

  if (!carrier) {
    return { ok: false, reason: '택배사를 알 수 없습니다', carrier: null, invoice };
  }
  if (!invoice) {
    return { ok: false, reason: '운송장번호가 없습니다', carrier, invoice };
  }

  if (carrier.key === 'lotte') {
    // 체크디지트가 안 맞으면 링크를 만들지 않는다 — 열어봐야 "발송 준비중"만 나온다.
    if (!isValidLotteInvoice(invoice)) {
      return { ok: false, reason: '운송장번호 형식이 맞지 않습니다', carrier, invoice };
    }
    const path = mobile ? 'mobile' : 'home';
    // 파라미터명은 대소문자를 가린다. 소문자 invno 로 쓰면 에러 없이 빈 화면이 뜬다.
    return { ok: true, carrier, url: `https://www.lotteglogis.com/${path}/reservation/tracking/linkView?InvNo=${invoice}` };
  }

  /*
   * 운송장 칸에 메모가 들어온 행이 실데이터에 99건 있었다.
   *   "인테리어후출고" → ""   (링크 안 만들어짐, 정상)
   *   "오전10시상차"   → "10" (숫자만 남기니 의미 없는 번호가 만들어진다)
   * 경동은 자릿수 검증이 아예 없어서(입력란 maxlength 21, 검사 없음) 이런 번호도 그대로 조회한다.
   * 자릿수로 '택배사를 추측'하는 건 근거가 없지만, 엑셀이 지정해준 택배사의
   * 최소 자릿수를 '유효성 검사'로 쓰는 것은 별개이고 필요하다.
   */
  if (invoice.length < carrier.minDigits) {
    return { ok: false, reason: '운송장번호가 아닌 값이 들어있습니다', carrier, invoice };
  }

  /*
   * 경동은 barcode 를 따옴표 없이 JS 리터럴에 그대로 박는다.
   *   `3102273-430319` → `let barcode = 3102273-430319;` → 산술식으로 평가되어 3101843 을 조회한다.
   * 에러도 경고도 없이 **엉뚱한 남의 배송정보**가 뜬다. 위 normalizeInvoice 가 이걸 막는 유일한 방어선이다.
   *
   * www. 를 붙이면 301 로 http:// 로 프로토콜이 내려가고 HSTS 도 없다. apex + https 로 고정한다.
   * ajax_basic_qr.do 는 이름과 달리 JSON API 가 아니라 HTML 페이지다 — fetch().json() 금지, 새 창 전용.
   */
  const kdPath = mobile ? 'service/delivery/ajax_basic_qr.do' : 'service/delivery/etc/delivery.do';
  return { ok: true, carrier, url: `https://kdexp.com/${kdPath}?barcode=${invoice}` };
}

/**
 * 직링크가 막혔을 때의 폴백 — 네이버 통합검색.
 * 네이버가 쿼리를 파싱해 택배조회 모듈에 택배사코드와 운송장번호를 서버사이드로 채워준다.
 * 택배사명을 반드시 붙여야 한다. 번호만 넣으면 직원이 택배사를 직접 골라야 한다.
 */
export function buildNaverFallbackUrl(carrier: Carrier, invoice: string, mobile = false): string {
  const host = mobile ? 'm.search.naver.com' : 'search.naver.com';
  return `https://${host}/search.naver?query=${encodeURIComponent(`${carrier.label} ${invoice}`)}`;
}

/**
 * 출하일로부터 조회 가능 기간이 지났는지 — 지난 건 링크를 눌러도 헛수고다.
 *
 * 출하일을 못 읽은 건(실데이터 13건)은 '만료'로 접는다.
 * 예전엔 false 를 돌려줘서 날짜 불명인 건이 영원히 활성 링크로 남았는데,
 * 그 링크를 누르면 롯데는 "발송 준비중"만 띄운다 — 직원은 그걸 보고
 * "아직 안 갔대요"라고 안내하게 된다. 모르면 모른다고 하는 편이 낫다.
 */
export function isLookupExpired(carrier: Carrier | null, shippedAt: Date | null): boolean {
  if (!carrier) return false;
  if (!shippedAt) return true;
  const days = (Date.now() - shippedAt.getTime()) / 86_400_000;
  return days > carrier.lookupDays;
}
