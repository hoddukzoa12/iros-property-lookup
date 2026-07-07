// 법정동코드 캐시 갱신 — odcloud(data.go.kr 15123287) 전량 수집 → KV 저장
// 런타임 per-lookup 아님. Cron/부트스트랩/TTL/수동 갱신 시에만 호출.

const UDDI = 'uddi:b68902fa-d058-4a17-b188-ff46b7eaaac7'; // 2025-08-05판. 신규 연간판 나오면 교체.
const BASE = `https://api.odcloud.kr/api/15123287/v1/${UDDI}`;
const PER_PAGE = 1000;
const PAGE_DELAY_MS = 150;

export const KV_MAP = 'ldong:map';
export const KV_META = 'ldong:meta';

export interface LdongMeta {
  builtAt: number;
  count: number;
  uddi: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(key: string, page: number): Promise<any> {
  const url = `${BASE}?page=${page}&perPage=${PER_PAGE}&returnType=JSON&serviceKey=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`odcloud HTTP ${res.status} (page ${page})`);
  return res.json();
}

/** odcloud 전량 수집 → { 법정동명: 10자리코드 } 맵 (현존만) 빌드 후 KV 기록 */
export async function refreshLdong(env: { LDONG: KVNamespace; ODCLOUD_API_KEY: string }): Promise<LdongMeta> {
  const key = env.ODCLOUD_API_KEY;
  if (!key) throw new Error('ODCLOUD_API_KEY 없음');

  const first = await fetchPage(key, 1);
  const total: number = first.totalCount ?? 0;
  const pages = Math.ceil(total / PER_PAGE);

  const map: Record<string, string> = {};
  const ingest = (rows: any[]) => {
    for (const r of rows ?? []) {
      if (r['폐지여부'] !== '존재') continue;
      map[r['법정동명']] = String(r['법정동코드']).padStart(10, '0');
    }
  };
  ingest(first.data);

  for (let p = 2; p <= pages; p++) {
    await sleep(PAGE_DELAY_MS);
    ingest((await fetchPage(key, p)).data);
  }

  const meta: LdongMeta = { builtAt: Date.now(), count: Object.keys(map).length, uddi: UDDI };
  await env.LDONG.put(KV_MAP, JSON.stringify(map));
  await env.LDONG.put(KV_META, JSON.stringify(meta));
  return meta;
}
