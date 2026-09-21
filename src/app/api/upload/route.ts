import { NextResponse } from 'next/server';
import { getDb, ensureIndexes } from '@/lib/db';
import { parseShipmentWorkbook } from '@/lib/excel';

/**
 * 물류팀 배송현황 엑셀 업로드.
 *
 * 드롭박스 자동수집 대신 여기로 올리게 한 이유 —
 *   Dropbox App folder 앱은 기존 팀 공유폴더를 원천적으로 못 읽고, 읽으려면 회사 드롭박스
 *   전체 읽기 권한이 강제된다. 고객 이름·연락처·주소가 든 파일 하나 때문에 그 토큰을 서버에
 *   상주시킬 수는 없다. 게다가 Dropbox API 에는 파일 코멘트·알림 엔드포인트가 없어서
 *   "몇 건 등록됐고 무엇이 틀렸는지"를 올린 사람에게 돌려줄 방법이 아예 없다.
 *   업로드 화면은 그 피드백을 그 자리에서 준다 — 이게 이 방식의 핵심 가치다.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel 무료 플랜 상한이 60초다. 물류팀 파일(3,600행)은 5초 안팎이라 충분하다.
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: '파일이 없습니다.' }, { status: 400 });
    }
    if (!/\.xlsx?$/i.test(file.name)) {
      return NextResponse.json({ ok: false, error: '엑셀 파일(.xlsx)만 올릴 수 있습니다.' }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const parsed = await parseShipmentWorkbook(buf);

    if (!parsed.rows.length) {
      return NextResponse.json({
        ok: false,
        error: '읽을 수 있는 행이 없습니다. 시트와 헤더를 확인해 주세요.',
        stats: parsed.stats,
        warnings: parsed.warnings,
      }, { status: 400 });
    }

    await ensureIndexes();
    const db = await getDb();
    const col = db.collection('shipments');

    const uploadedAt = new Date();
    const uploadId = `${uploadedAt.toISOString().slice(0, 19)}-${file.name}`;

    // rowHash 기준 멱등 upsert — 같은 파일을 두 번 올려도 늘어나지 않는다.
    let inserted = 0;
    let updated = 0;
    const CHUNK = 500;
    for (let i = 0; i < parsed.rows.length; i += CHUNK) {
      const ops = parsed.rows.slice(i, i + CHUNK).map((r) => ({
        updateOne: {
          filter: { rowHash: r.rowHash },
          update: {
            $set: { ...r, uploadId, updatedAt: uploadedAt },
            $setOnInsert: { firstSeenAt: uploadedAt },
          },
          upsert: true,
        },
      }));
      const res = await col.bulkWrite(ops, { ordered: false });
      inserted += res.upsertedCount || 0;
      updated += res.modifiedCount || 0;
    }

    /*
     * 보관 기간 정리 — 업로드할 때마다 오래된 건을 지운다.
     * 물류팀이 매일 올리면 매일 정리되므로 별도 스케줄러가 필요 없다.
     *
     * 기준이 두 개다.
     *
     * ① 출하일이 있는 건 — 출하 후 N일이 지나면 삭제.
     * ② 출하일이 없는 건(재고소진·차량배차 등 미출고) — 삭제하되 기준이 다르다.
     *    '미출고니까 무조건 보존' 으로 두면 2022년 "인테리어후출고" 같은 유령 행이
     *    영원히 남는다(실데이터에서 확인). 4년 전 주문이 아직 안 나갔을 리 없고,
     *    이미 처리됐거나 취소된 건이다.
     *    그래서 updatedAt 을 쓴다 — 물류팀 파일에 계속 실려 오면 매 업로드마다 갱신되므로
     *    '살아있는 미출고 건'은 안 지워지고, 파일에서 사라진 지 N일 된 건만 정리된다.
     */
    const retentionDays = Number(process.env.RETENTION_DAYS) || 60;
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    const purged = await col.deleteMany({
      $or: [
        { shippedAt: { $ne: null, $lt: cutoff } },
        { shippedAt: null, updatedAt: { $lt: cutoff } },
      ],
    });

    const result = {
      uploadId,
      uploadedAt,
      retentionDays,
      purged: purged.deletedCount || 0,
      fileName: file.name,
      fileSize: file.size,
      sheetName: parsed.sheetName,
      headerRow: parsed.headerRow,
      inserted,
      updated,
      stats: parsed.stats,
      warnings: parsed.warnings,
    };
    await db.collection('uploads').insertOne(result);

    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/**
 * 업로드 이력.
 * 조회 화면의 "마지막 갱신" 배지와, 업로드 화면의 등록 게시판이 같이 쓴다.
 * 물류팀이 "내가 올린 게 제대로 들어갔나"를 나중에도 확인할 수 있어야 해서 이력을 남긴다.
 */
export async function GET() {
  try {
    const db = await getDb();
    const rows = await db.collection('uploads')
      .find({}, { projection: { _id: 0 } })
      .sort({ uploadedAt: -1 })
      .limit(30)
      .toArray();
    return NextResponse.json({ ok: true, uploads: rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
