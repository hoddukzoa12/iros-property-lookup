// 법정동코드 캐시 갱신 — 행정안전부 실시간 행정표준코드 API 전량 수집 → KV 저장
// 런타임 per-lookup 아님. Cron/부트스트랩/TTL/수동 갱신 시에만 호출.

const SOURCE = 'MOIS StanReginCd realtime';
const BASE = 'https://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList';
const PER_PAGE = 1000;
const PAGE_DELAY_MS = 150;
const MIN_EXPECTED_CODES = 15_000;

const REQUIRED_CODES: Record<string, string> = {
  '서울특별시 종로구 청운동': '1111010100',
  '전남광주통합특별시 광산구 송정동': '1233010100',
};

export const KV_MAP = 'ldong:map';
export const KV_META = 'ldong:meta';

export interface LdongMeta {
  builtAt: number;
  count: number;
  source: string;
  uddi?: string;
}

interface RegionCodeRow {
  region_cd?: string | number;
  locatadd_nm?: string;
}

interface RegionCodePage {
  total: number;
  rows: RegionCodeRow[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decodeServiceKey(key: string) {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

function parsePage(data: any, page: number): RegionCodePage {
  const sections = data?.StanReginCd;
  if (!Array.isArray(sections)) throw new Error(`행정표준코드 응답 형식 오류 (page ${page})`);

  const head = sections.find((section: any) => Array.isArray(section?.head))?.head?.[0] ?? {};
  const result = head.RESULT ?? head.result ?? {};
  const resultCode = String(result.resultCode ?? '').trim();
  if (resultCode && resultCode !== 'INFO-0') {
    throw new Error(`행정표준코드 ${resultCode}: ${result.resultMsg ?? '조회 실패'}`);
  }

  const rows = sections.find((section: any) => Array.isArray(section?.row))?.row ?? [];
  return { total: Number(head.totalCount ?? 0), rows };
}

async function fetchPage(key: string, page: number): Promise<RegionCodePage> {
  const url = new URL(BASE);
  url.searchParams.set('ServiceKey', decodeServiceKey(key));
  url.searchParams.set('pageNo', String(page));
  url.searchParams.set('numOfRows', String(PER_PAGE));
  url.searchParams.set('type', 'json');
  url.searchParams.set('flag', 'Y');

  // 이 API는 type=json이어도 Content-Type을 text/html로 반환하며,
  // Accept: application/json을 보내면 HTTP 500을 반환한다.
  const res = await fetch(url.toString());
  const text = await res.text();
  if (!res.ok) {
    const detail = text.replace(/\s+/g, ' ').trim().slice(0, 240);
    throw new Error(`행정표준코드 HTTP ${res.status} (page ${page})${detail ? `: ${detail}` : ''}`);
  }
  try {
    return parsePage(JSON.parse(text), page);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`행정표준코드 JSON 파싱 실패 (page ${page})`);
    throw error;
  }
}

/** 전량 수집 → { 법정동명: 10자리코드 } 맵 빌드 후 검증된 경우에만 KV 교체 */
export async function refreshLdong(env: { LDONG: KVNamespace; ODCLOUD_API_KEY: string }): Promise<LdongMeta> {
  const key = env.ODCLOUD_API_KEY;
  if (!key) throw new Error('ODCLOUD_API_KEY 없음');

  const first = await fetchPage(key, 1);
  const total = first.total;
  const pages = Math.ceil(total / PER_PAGE);
  if (!total || !pages) throw new Error('행정표준코드 전체 건수가 0건입니다.');

  const map: Record<string, string> = {};
  const ingest = (rows: RegionCodeRow[]) => {
    for (const row of rows ?? []) {
      const name = String(row.locatadd_nm ?? '').replace(/\s+/g, ' ').trim();
      const code = String(row.region_cd ?? '').padStart(10, '0');
      if (name && /^\d{10}$/.test(code)) map[name] = code;
    }
  };
  ingest(first.rows);

  for (let page = 2; page <= pages; page++) {
    await sleep(PAGE_DELAY_MS);
    ingest((await fetchPage(key, page)).rows);
  }

  const count = Object.keys(map).length;
  if (count < MIN_EXPECTED_CODES) throw new Error(`행정표준코드 건수 검증 실패: ${count}건`);
  for (const [name, expected] of Object.entries(REQUIRED_CODES)) {
    if (map[name] !== expected) throw new Error(`행정표준코드 필수값 검증 실패: ${name}`);
  }

  const meta: LdongMeta = { builtAt: Date.now(), count, source: SOURCE };
  await env.LDONG.put(KV_MAP, JSON.stringify(map));
  await env.LDONG.put(KV_META, JSON.stringify(meta));
  return meta;
}
