import { MongoClient, Db } from 'mongodb';

/**
 * 광고대시보드와 같은 클러스터를 쓰되 DB 는 cdapi 로 나눈다.
 * 개발 중 핫리로드마다 새 커넥션을 열면 Atlas 연결 한도를 금방 태우므로 전역에 붙여 재사용한다.
 */
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'cdapi';

declare global {
  // eslint-disable-next-line no-var
  var _cdapiMongo: Promise<MongoClient> | undefined;
}

function client(): Promise<MongoClient> {
  if (!uri) throw new Error('MONGODB_URI 가 설정되지 않았습니다 (.env.local 확인)');
  if (!global._cdapiMongo) global._cdapiMongo = new MongoClient(uri).connect();
  return global._cdapiMongo;
}

export async function getDb(): Promise<Db> {
  return (await client()).db(dbName);
}

/**
 * 조회가 느려지는 지점이 정해져 있어서 인덱스도 정해져 있다 —
 * 이름으로 찾고(customerName), 기간으로 자르고(shippedAt), 같은 파일을 다시 올려도 안 늘어나야 한다(rowHash).
 */
export async function ensureIndexes(): Promise<void> {
  const db = await getDb();
  const col = db.collection('shipments');
  await Promise.all([
    col.createIndex({ rowHash: 1 }, { unique: true }),
    col.createIndex({ customerName: 1, shippedAt: -1 }),
    col.createIndex({ phoneTail: 1 }),
    col.createIndex({ shippedAt: -1 }),
    col.createIndex({ invoiceDigits: 1 }),
    // 보관 기간 정리(shippedAt 경과 / 미출고인데 파일에서 사라진 건)가 인덱스를 타게 한다
    col.createIndex({ updatedAt: 1 }),
  ]);
  const uploads = db.collection('uploads');
  await uploads.createIndex({ uploadedAt: -1 });
  // 등록 이력은 하루 한 건 — day 가 같으면 덮어쓴다
  await uploads.createIndex({ day: 1 }, { unique: true, partialFilterExpression: { day: { $type: 'string' } } });
  // 같은 날 먼저 들어왔다가 마지막 파일엔 없는 행을 찾는 조건
  await col.createIndex({ firstSeenAt: 1, updatedAt: 1 });
}
