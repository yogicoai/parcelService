import ExcelJS from 'exceljs';
import crypto from 'node:crypto';
import { normalizeInvoice, resolveCarrier } from './carriers';

/**
 * 물류팀 배송현황 엑셀 파서.
 *
 * adminChat/server/erp.js 에서 검증된 부분을 배송용으로 옮겼다 —
 * 셀 값 정리, 휴대폰 정규화, 이카운트 일자 포맷, rowHash 멱등 처리.
 *
 * 헤더를 좌표가 아니라 이름으로 찾는 이유:
 *   물류팀이 컬럼 순서를 바꾸거나 앞에 빈 행을 넣어도 안 깨져야 한다.
 *   실제 샘플의 헤더에는 줄바꿈까지 섞여 있다("마케팅팀 정보\n수신동의") — squash 가 흡수한다.
 */

export type ShipmentRow = {
  rowHash: string;
  store: string;
  origin: string;
  invoice: string;
  invoiceDigits: string;
  carrierRaw: string;
  carrierKey: string | null;
  orderNo: string;
  shippedAt: Date | null;
  shippedAtStr: string;
  customerName: string;
  phone: string;
  phoneTail: string;
  phoneType: 'mobile' | 'safe' | 'other' | 'empty';
  address: string;
  productCode: string;
  productName: string;
  note: string;
};

export type ParseResult = {
  rows: ShipmentRow[];
  headerRow: number;
  sheetName: string;
  stats: {
    totalRows: number;
    kept: number;
    skippedNoInvoice: number;
    skippedNoName: number;
    unknownCarrier: number;
    badDate: number;
    /** 앞선 행과 같은 건으로 판정돼 버린 행 — 0 이 아니면 양식을 의심해야 한다 */
    duplicateDropped: number;
  };
  warnings: string[];
};

/** 헤더명 → 표준 필드. 같은 뜻으로 쓰이는 표기를 모두 받아준다. */
const HEADER_MAP: Record<string, keyof ShipmentRow | 'skip'> = {
  매장: 'store',
  출고지: 'origin',
  운송장번호: 'invoice',
  운송장: 'invoice',
  송장번호: 'invoice',
  택배사: 'carrierRaw',
  배송사: 'carrierRaw',
  주문번호: 'orderNo',
  출하일자: 'shippedAtStr',
  출고일: 'shippedAtStr',
  출고일자: 'shippedAtStr',
  이름: 'customerName',
  고객명: 'customerName',
  수취인: 'customerName',
  받는분: 'customerName',
  연락처: 'phone',
  고객연락처: 'phone',
  휴대폰: 'phone',
  주소: 'address',
  고객주소: 'address',
  품목코드: 'productCode',
  품명: 'productName',
  품목명: 'productName',
  비고: 'note',
  특이사항: 'note',
};

const squash = (s: unknown) => cellText(s).replace(/\s+/g, '');

/** 수식·리치텍스트 객체를 문자열로 편다 (erp.js 와 동일한 처리) */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (v instanceof Date) return v.toISOString();
    if (o.result !== undefined) return cellText(o.result);
    if (o.text !== undefined) return cellText(o.text);
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join('');
    if (o.hyperlink !== undefined) return cellText(o.hyperlink);
  }
  return String(v).trim();
}

/** 010 정규화 + 안심번호(050) 판별. 동명이인은 뒤 4자리로 가른다. */
export function normalizePhone(raw: unknown): { digits: string; tail: string; type: ShipmentRow['phoneType'] } {
  let digits = cellText(raw).replace(/[^0-9]/g, '');
  if (/^82(10\d{8})$/.test(digits)) digits = '0' + digits.slice(2);
  let type: ShipmentRow['phoneType'] = 'empty';
  if (!digits) type = 'empty';
  else if (/^010\d{8}$/.test(digits)) type = 'mobile';
  else if (/^050/.test(digits)) type = 'safe';
  else type = 'other';
  return { digits, tail: digits.slice(-4), type };
}

/**
 * 날짜 파싱. 엑셀이 진짜 날짜로 주기도 하고 `2022/07/30 -153` 같은 이카운트 문자열로 주기도 한다.
 * 시간대 때문에 하루가 밀리지 않도록 KST 자정으로 고정한다.
 */
export function parseDate(raw: unknown): { date: Date | null; str: string } {
  if (raw instanceof Date) {
    const iso = raw.toISOString().slice(0, 10);
    return { date: new Date(`${iso}T00:00:00+09:00`), str: iso };
  }
  const s = cellText(raw);
  const m = s.match(/(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  if (!m) return { date: null, str: '' };
  const str = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(`${str}T00:00:00+09:00`);
  // 13월 40일 같은 값은 Invalid Date 이거나 조용히 다음 달로 굴러간다.
  // 그대로 두면 badDate 에 안 잡히고 엉뚱한 날짜로 저장돼 링크가 '기간 만료'로 막힌다.
  if (Number.isNaN(d.getTime())) return { date: null, str: '' };
  const kst = new Date(d.getTime() + 9 * 3_600_000);
  if (kst.getUTCFullYear() !== Number(m[1]) || kst.getUTCMonth() + 1 !== Number(m[2]) || kst.getUTCDate() !== Number(m[3])) {
    return { date: null, str: '' };
  }
  return { date: d, str };
}

/**
 * 한 행을 무엇으로 식별할 것인가 —
 * 운송장번호만으로는 부족하다. 한 운송장에 품목이 여러 줄로 붙는 경우가 있고,
 * 반대로 한 고객이 품목별로 서로 다른 운송장을 받기도 한다(실제 샘플에서 확인).
 * 그래서 운송장 + 품목 + 출하일 + 이름을 묶어 한 줄을 특정한다.
 */
function makeRowHash(r: Omit<ShipmentRow, 'rowHash'>): string {
  // 이름·연락처를 넣으면 안 된다 — 물류팀이 수취인명 오타를 고쳐 재업로드하는 순간
  // 해시가 바뀌어 '홍길똥' 행과 '홍길동' 행이 DB 에 둘 다 남는다. 지우는 코드는 없다.
  // 그러면 매장 화면에 카드가 두 장 뜨고 직원은 어느 운송장이 유효한지 알 방법이 없다.
  // 바뀌지 않는 값만 쓰고, 이름·연락처는 $set 으로 제자리 갱신되게 둔다.
  //
  // 품목코드가 없는 양식이 오면 품명으로 대신한다. 둘 다 없으면 같은 운송장의
  // 품목 줄들이 한 해시로 뭉쳐 조용히 사라지므로 아래 duplicateDropped 로 센다.
  const item = r.productCode || r.productName;
  const key = [r.invoiceDigits, item, r.shippedAtStr].join('|');
  return crypto.createHash('sha1').update(key).digest('hex');
}

export async function parseShipmentWorkbook(buffer: Buffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  // 운송장번호와 이름이 같이 있는 시트를 찾는다. 헤더는 위에서 6행까지 훑는다.
  let ws: ExcelJS.Worksheet | null = null;
  let headerRow = -1;
  let colOf: Partial<Record<string, number>> = {};

  wb.eachSheet((sheet) => {
    if (ws) return;
    for (let r = 1; r <= Math.min(6, sheet.rowCount); r++) {
      const map: Record<string, number> = {};
      for (let c = 1; c <= sheet.columnCount; c++) {
        const key = HEADER_MAP[squash(sheet.getRow(r).getCell(c).value)];
        if (key && key !== 'skip' && map[key] === undefined) map[key] = c;
      }
      if (map.invoice && map.customerName) { ws = sheet; headerRow = r; colOf = map; return; }
    }
  });

  if (!ws) {
    throw new Error('헤더를 찾지 못했습니다. 「운송장번호」와 「이름」 컬럼이 있는지 확인해 주세요.');
  }
  const sheet: ExcelJS.Worksheet = ws;

  const warnings: string[] = [];
  if (colOf.productCode === undefined && colOf.productName === undefined) {
    warnings.push('「품목코드」와 「품명」이 모두 없어 같은 운송장의 여러 품목 줄을 구분하지 못합니다.');
  }
  for (const need of ['carrierRaw', 'shippedAtStr', 'phone'] as const) {
    if (colOf[need] === undefined) {
      const label = need === 'carrierRaw' ? '택배사' : need === 'shippedAtStr' ? '출하일자' : '연락처';
      warnings.push(`「${label}」 컬럼을 찾지 못했습니다 — 관련 기능이 제한됩니다.`);
    }
  }

  const get = (row: ExcelJS.Row, key: string) =>
    (colOf[key] ? row.getCell(colOf[key]!).value : '');

  const stats = { totalRows: 0, kept: 0, skippedNoInvoice: 0, skippedNoName: 0, unknownCarrier: 0, badDate: 0, duplicateDropped: 0 };
  const rows: ShipmentRow[] = [];
  const seen = new Set<string>();

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const customerName = cellText(get(row, 'customerName'));
    const invoiceRaw = cellText(get(row, 'invoice'));

    // 합계행·빈행 스킵
    if (!customerName && !invoiceRaw) continue;
    stats.totalRows++;

    if (!invoiceRaw) { stats.skippedNoInvoice++; continue; }
    if (!customerName) { stats.skippedNoName++; continue; }

    const carrierRaw = cellText(get(row, 'carrierRaw'));
    const carrier = resolveCarrier(carrierRaw);
    if (!carrier) stats.unknownCarrier++;

    const { date, str } = parseDate(get(row, 'shippedAtStr'));
    if (!date) stats.badDate++;

    const { digits: phone, tail: phoneTail, type: phoneType } = normalizePhone(get(row, 'phone'));

    const base: Omit<ShipmentRow, 'rowHash'> = {
      store: cellText(get(row, 'store')),
      origin: cellText(get(row, 'origin')),
      invoice: invoiceRaw,
      invoiceDigits: normalizeInvoice(invoiceRaw),
      carrierRaw,
      carrierKey: carrier?.key ?? null,
      orderNo: cellText(get(row, 'orderNo')),
      shippedAt: date,
      shippedAtStr: str,
      customerName,
      phone,
      phoneTail,
      phoneType,
      address: cellText(get(row, 'address')),
      productCode: cellText(get(row, 'productCode')),
      productName: cellText(get(row, 'productName')),
      note: cellText(get(row, 'note')),
    };

    const rowHash = makeRowHash(base);
    // 버리는 행은 반드시 숫자로 남긴다 — 조용히 사라지면 '배송 안 갔나 봐요'가 된다
    if (seen.has(rowHash)) { stats.duplicateDropped++; continue; }
    seen.add(rowHash);
    rows.push({ ...base, rowHash });
    stats.kept++;
  }

  return { rows, headerRow, sheetName: sheet.name, stats, warnings };
}
