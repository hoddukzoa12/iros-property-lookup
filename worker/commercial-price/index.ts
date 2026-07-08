import type {
  CommercialPriceInfo,
  CommercialPriceItem,
  CommercialPriceRequestItem,
} from '../../shared/types';
import { addressToPnu } from '../ldong/lookup';

interface CommercialPriceEnv {
  LDONG: KVNamespace;
  ODCLOUD_API_KEY: string;
}

interface ParsedPnu {
  lawCode: string;
  bun: string;
  ji: string;
}

interface CommercialPriceTarget extends CommercialPriceRequestItem {
  pnu: string;
  parsedPnu: ParsedPnu;
  roomNorm: string;
  floorNorm: string;
}

type HometaxAction =
  | 'ATESFAAA023R01'
  | 'ATESFAAA023R02'
  | 'ATESFAAA023R03'
  | 'ATESFAAA023R04'
  | 'ATESFAAA023R05'
  | 'ATESFAAA023R06';

type HometaxValue = string | number | null | undefined;
type HometaxRow = Record<string, HometaxValue>;
type HometaxBody = Record<string, HometaxValue>;

interface HometaxResponse {
  cmrcTsvCmchInqrDVOList?: HometaxRow[];
  roadNmAdrAdmDVOList?: HometaxRow[];
  pageInfoVO?: { totalCount?: HometaxValue };
  map?: HometaxResponse;
}

const HOMETAX_URL = 'https://teht.hometax.go.kr/wqAction.do';
const HOMETAX_SCREEN_ID = 'UTESFAAM13';
const HOMETAX_CONCURRENCY = 10;
const HOMETAX_PAGE_SIZE = 100;
const HOMETAX_MAX_PAGES = 5;
const MAX_BUILDING_CANDIDATES = 5;
const MAX_COMPONENT_CANDIDATES = 3;
const MAX_UNFILTERED_ITEMS = 80;

const HOMETAX_HMAC_KEYS = [
  'fjaS3kdHQsdfvnm359WxzmWMV8xm5qmrcRXxolOqm4',
  'qns5HuJxhT3QM8cIOSxqYw92xOpv7oMETetLjO3Zog',
  'Zomr4yL5NpOcj4EfBxdDsweUxOvGWugbJ7c9xhwm',
  'tOpenmvLO8XhwmY2Nxpi2eP3xcmniJj2e4xc8FamH0',
  'qyVMuRUwZO93CGhkWtJFFrmEKMAg9z3FBLcKAyMxxA',
  'RF413bvdLE31OL3dnmeC7r7EbMVo1oh4OrOVMMysR',
  'OINbDScmre3r8ckDpIoKAyO5B6wwKulnDJkxwFBvRX',
];

const hmacKeyCache = new Map<number, CryptoKey>();
const textEncoder = new TextEncoder();

function compact(value: string) {
  return value.replace(/\s+/g, '').trim();
}

function stripLeadingZeros(value: string) {
  const stripped = value.replace(/^0+/, '');
  return stripped || '0';
}

function toText(value: HometaxValue) {
  return value == null ? '' : String(value).replace(/\u00ad/g, '-').trim();
}

function toNumber(value: HometaxValue) {
  const text = toText(value);
  if (!text) return null;
  const parsed = Number(text.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePnu(pnu: string): ParsedPnu | null {
  const digits = pnu.replace(/\D/g, '');
  if (digits.length !== 19) return null;
  return {
    lawCode: digits.slice(0, 10),
    bun: stripLeadingZeros(digits.slice(11, 15)),
    ji: stripLeadingZeros(digits.slice(15, 19)),
  };
}

function normalizeBuilding(value: string) {
  return compact(value)
    .replace(/[()（）\[\]{}]/g, '')
    .replace(/[·ㆍ.,]/g, '')
    .replace(/주건축물/g, '')
    .toUpperCase();
}

function normalizeRoom(value: string) {
  return compact(value)
    .replace(/^제/i, '')
    .replace(/호$/i, '')
    .toUpperCase();
}

function normalizeFloor(value: string) {
  let text = compact(value)
    .replace(/^제/i, '')
    .replace(/층$/i, '')
    .toUpperCase();

  text = text.replace(/^지상층?/, '');
  text = text.replace(/^지하층?/, 'B');
  text = text.replace(/^地下?/, 'B');
  return text;
}

function extractRoom(value: string) {
  const matches = Array.from(value.matchAll(/제?\s*([A-Z]?\d+[A-Z]?)\s*호/gi));
  return matches.at(-1)?.[1] ?? '';
}

function extractFloor(value: string) {
  const match = /제?\s*(지하|지상)?\s*([B]?\d+)\s*층/i.exec(value);
  if (!match) return '';
  const prefix = match[1] === '지하' ? 'B' : '';
  return `${prefix}${match[2].replace(/^B/i, '')}`;
}

function formatNoticeDate(value: string) {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 8) return `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6, 8)}`;
  return value;
}

function formatRoom(value: string) {
  const room = value.trim();
  if (!room) return '';
  return /호$/.test(room) ? room : `${room}호`;
}

function floorText(item: CommercialPriceItem) {
  if (item.floorKind && item.floor) return `${item.floorKind}${item.floor}`;
  return item.floorKind || (item.floor ? `${item.floor}층` : '');
}

function detailAddress(item: CommercialPriceItem | undefined, fallback: CommercialPriceRequestItem) {
  if (!item) {
    return [fallback.building, fallback.floor && `${fallback.floor}층`, fallback.room && formatRoom(fallback.room)]
      .filter(Boolean)
      .join(' ');
  }

  const dong = item.buildingDong
    ? (item.buildingDong.endsWith('동') ? item.buildingDong : `${item.buildingDong}동`)
    : item.buildingName;
  return [dong, floorText(item), formatRoom(item.room)].filter(Boolean).join(' ');
}

function sortItems(a: CommercialPriceItem, b: CommercialPriceItem) {
  return b.noticeDate.localeCompare(a.noticeDate) ||
    a.kind.localeCompare(b.kind, 'ko-KR') ||
    a.room.localeCompare(b.room, 'ko-KR', { numeric: true });
}

function dedupeItems(items: CommercialPriceRequestItem[]) {
  const map = new Map<string, CommercialPriceRequestItem>();
  for (const item of items) {
    if (!item.key || !item.address || map.has(item.key)) continue;
    map.set(item.key, item);
  }
  return Array.from(map.values());
}

function dedupePriceItems(items: CommercialPriceItem[]) {
  const seen = new Set<string>();
  const deduped: CommercialPriceItem[] = [];
  for (const item of items) {
    const key = [
      item.noticeDate,
      item.kind,
      item.buildingName,
      item.buildingDong,
      item.floorKind,
      item.floor,
      item.room,
      item.unitPrice ?? '',
      item.buildingArea ?? '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function getHmacKey(index: number) {
  const cached = hmacKeyCache.get(index);
  if (cached) return cached;

  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(HOMETAX_HMAC_KEYS[index]),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  hmacKeyCache.set(index, key);
  return key;
}

async function signedHometaxPayload(body: HometaxBody) {
  const requestData = JSON.stringify(body);
  const az = String(new Date().getSeconds()).padStart(2, '0');
  const key = await getHmacKey(Number(az) % HOMETAX_HMAC_KEYS.length);
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(requestData));
  const mac = arrayBufferToBase64(signature).replace(/[^A-Za-z0-9]/g, '');
  return `${requestData}<nts<nts>nts>${Number(az) + 11}${mac}${az}`;
}

async function fetchHometax(actionId: HometaxAction, body: HometaxBody): Promise<HometaxResponse> {
  const url = new URL(HOMETAX_URL);
  url.searchParams.set('actionId', actionId);
  url.searchParams.set('screenId', HOMETAX_SCREEN_ID);
  url.searchParams.set('popupYn', 'false');
  url.searchParams.set('realScreenId', '');

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json; charset=UTF-8',
      origin: 'https://hometax.go.kr',
      referer: 'https://hometax.go.kr/',
      'user-agent': 'Mozilla/5.0 iros-property-lookup',
    },
    body: await signedHometaxPayload(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`${actionId} HTTP ${res.status}`);

  try {
    return JSON.parse(text) as HometaxResponse;
  } catch {
    throw new Error(`${actionId} 응답을 JSON으로 해석하지 못했습니다.`);
  }
}

function responseRows(data: HometaxResponse) {
  const source = data.map ?? data;
  return source.cmrcTsvCmchInqrDVOList ?? source.roadNmAdrAdmDVOList ?? [];
}

function responseTotal(data: HometaxResponse, fallback: number) {
  const value = (data.map ?? data).pageInfoVO?.totalCount;
  const total = Number(value);
  return Number.isFinite(total) && total >= 0 ? total : fallback;
}

async function fetchPagedRows(actionId: HometaxAction, baseBody: HometaxBody) {
  const rows: HometaxRow[] = [];
  let pageNum = 1;
  let totalCount = 0;

  do {
    const data = await fetchHometax(actionId, {
      ...baseBody,
      pageNum: String(pageNum),
      pageSize: String(HOMETAX_PAGE_SIZE),
      totalCount: pageNum === 1 ? '' : String(totalCount),
    });
    const pageRows = responseRows(data);
    rows.push(...pageRows);
    totalCount = responseTotal(data, rows.length);
    pageNum += 1;
  } while (rows.length < totalCount && pageNum <= HOMETAX_MAX_PAGES);

  return rows;
}

function buildingSearchBody(parsed: ParsedPnu): HometaxBody {
  return {
    bunj: parsed.bun,
    ho: parsed.ji,
    inqrCl: '1',
    kabSctrBldBlckAdr: '',
    ldCd: parsed.lawCode,
    roadNm: '',
    roadNmCd: '',
  };
}

function detailSearchBody(inqrCl: '1' | '2' | '3' | '4', bldNo: HometaxValue): HometaxBody {
  return {
    dplcYn: '',
    inqrCl,
    kabSctrBldFlorNo: '',
    kabSctrBldHoAdr: '',
    kabSctrBldHoNo: '',
    kabSctrBldNo: bldNo,
    notcDt: '',
  };
}

function targetText(target: CommercialPriceRequestItem) {
  return normalizeBuilding([target.address, target.roadAddr, target.building].filter(Boolean).join(' '));
}

function rowBuildingName(row: HometaxRow) {
  return toText(row.kabSctrBldBlckAdr) || toText(row.kabSctrBldDnadr);
}

function buildingScore(row: HometaxRow, target: CommercialPriceRequestItem) {
  const source = normalizeBuilding(rowBuildingName(row));
  if (!source) return 1;

  const targetBuilding = normalizeBuilding(target.building ?? '');
  const fullTarget = targetText(target);

  if (targetBuilding && (source.includes(targetBuilding) || targetBuilding.includes(source))) return 100 + source.length;
  if (fullTarget.includes(source)) return 80 + source.length;
  return 0;
}

function pickBuildingCandidates(rows: HometaxRow[], target: CommercialPriceRequestItem) {
  const scored = rows
    .map((row, index) => ({ row, index, score: buildingScore(row, target) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ row }) => row);

  if (scored.length) return scored.slice(0, MAX_BUILDING_CANDIDATES);
  if (!normalizeBuilding(target.building ?? '') && rows.length === 1) return rows;
  return [];
}

function componentScore(row: HometaxRow, target: CommercialPriceRequestItem) {
  const source = normalizeBuilding(toText(row.kabSctrBldDnadr));
  if (!source) return 1;
  const fullTarget = targetText(target);
  return fullTarget.includes(source) ? 50 + source.length : 1;
}

function pickComponentCandidates(rows: HometaxRow[], target: CommercialPriceRequestItem, fallbackBldNo: HometaxValue) {
  const source = rows.length ? rows : [{ kabSctrBldNo: fallbackBldNo }];
  return source
    .map((row, index) => ({ row, index, score: componentScore(row, target) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_COMPONENT_CANDIDATES)
    .map(({ row }) => row);
}

function pickFloor(rows: HometaxRow[], target: CommercialPriceTarget) {
  if (!rows.length) return null;
  if (!target.floorNorm) return rows.length === 1 ? rows[0] : null;
  return rows.find((row) => normalizeFloor(toText(row.kabSctrBldFlorAdr)) === target.floorNorm) ?? null;
}

function pickHo(rows: HometaxRow[], target: CommercialPriceTarget) {
  if (!rows.length) return null;
  if (!target.roomNorm) return rows.length === 1 ? rows[0] : null;
  return rows.find((row) => normalizeRoom(toText(row.kabSctrBldHoAdr)) === target.roomNorm) ?? null;
}

function normalizePriceRows(
  rows: HometaxRow[],
  building: HometaxRow,
  component: HometaxRow,
  floor: HometaxRow,
  ho: HometaxRow,
) {
  const buildingName = rowBuildingName(building);
  const componentName = toText(component.kabSctrBldDnadr);
  const floorLabel = toText(floor.kabSctrBldFlorAdr);
  const roomLabel = toText(ho.kabSctrBldHoAdr);

  return rows
    .map<CommercialPriceItem>((row) => ({
      noticeDate: formatNoticeDate(toText(row.notcDt)),
      kind: '상가/오피스텔',
      buildingName,
      buildingDong: componentName && componentName !== buildingName ? componentName : '',
      floorKind: floorLabel,
      floor: '',
      room: roomLabel,
      unitPrice: toNumber(row.notcPrc),
      exclusiveArea: null,
      sharedArea: null,
      buildingArea: toNumber(row.bldTotaSfl),
    }))
    .filter((item) => item.noticeDate && item.unitPrice != null);
}

async function queryTarget(target: CommercialPriceTarget): Promise<CommercialPriceInfo> {
  const buildingRows = await fetchPagedRows('ATESFAAA023R01', buildingSearchBody(target.parsedPnu));
  const buildingCandidates = pickBuildingCandidates(buildingRows, target);
  if (!buildingCandidates.length) return emptyResult(target, target.pnu);

  for (const building of buildingCandidates) {
    const bldNo = building.kabSctrBldNo;
    if (bldNo == null || bldNo === '') continue;

    const componentRows = responseRows(await fetchHometax('ATESFAAA023R02', detailSearchBody('1', bldNo)));
    const components = pickComponentCandidates(componentRows, target, bldNo);

    for (const component of components) {
      const componentBldNo = component.kabSctrBldNo ?? bldNo;
      const floorRows = responseRows(await fetchHometax('ATESFAAA023R03', detailSearchBody('2', componentBldNo)));
      const floor = pickFloor(floorRows, target);
      if (!floor) continue;

      const hoRows = responseRows(await fetchHometax('ATESFAAA023R04', {
        ...detailSearchBody('3', componentBldNo),
        kabSctrBldFlorNo: floor.kabSctrBldFlorNo,
      }));
      const ho = pickHo(hoRows, target);
      if (!ho) continue;

      const priceRows = responseRows(await fetchHometax('ATESFAAA023R05', {
        ...detailSearchBody('4', componentBldNo),
        dplcYn: ho.dplcYn ?? '',
        kabSctrBldFlorNo: floor.kabSctrBldFlorNo,
        kabSctrBldHoAdr: ho.kabSctrBldHoAdr ?? '',
        kabSctrBldHoNo: ho.kabSctrBldHoNo,
      }));

      const items = dedupePriceItems(normalizePriceRows(priceRows, building, component, floor, ho)).sort(sortItems);
      if (!items.length) continue;

      const trimmed = target.roomNorm ? items : items.slice(0, MAX_UNFILTERED_ITEMS);
      return {
        key: target.key,
        address: target.address,
        pnu: target.pnu,
        detailAddress: detailAddress(trimmed[0], target),
        items: trimmed,
        error: !target.roomNorm && items.length > MAX_UNFILTERED_ITEMS
          ? `호실 정보가 없어 ${items.length}건 중 ${MAX_UNFILTERED_ITEMS}건만 표시합니다.`
          : undefined,
      };
    }
  }

  return emptyResult(target, target.pnu);
}

function emptyResult(item: CommercialPriceRequestItem, pnu: string | null, error?: string): CommercialPriceInfo {
  return {
    key: item.key,
    address: item.address,
    pnu,
    detailAddress: detailAddress(undefined, item),
    items: [],
    error,
  };
}

function makeTarget(item: CommercialPriceRequestItem, pnu: string): CommercialPriceTarget | null {
  const parsedPnu = parsePnu(pnu);
  if (!parsedPnu) return null;

  const text = [item.address, item.roadAddr, item.building, item.floor, item.room].filter(Boolean).join(' ');
  return {
    ...item,
    pnu,
    parsedPnu,
    roomNorm: normalizeRoom(item.room || extractRoom(text)),
    floorNorm: normalizeFloor(item.floor || extractFloor(text)),
  };
}

export async function fetchCommercialPrices(
  items: CommercialPriceRequestItem[],
  env: CommercialPriceEnv,
  ctx?: ExecutionContext,
): Promise<CommercialPriceInfo[]> {
  const uniqueItems = dedupeItems(items);
  const targets: CommercialPriceTarget[] = [];
  const preResults: CommercialPriceInfo[] = [];

  for (const item of uniqueItems) {
    const pnu = await addressToPnu(item.address, env, ctx);
    if (!pnu) {
      preResults.push(emptyResult(item, null, '주소를 PNU로 변환하지 못했습니다.'));
      continue;
    }

    const target = makeTarget(item, pnu);
    if (!target) {
      preResults.push(emptyResult(item, pnu, 'PNU 형식이 올바르지 않습니다.'));
      continue;
    }
    targets.push(target);
  }

  const results = await mapLimit(targets, HOMETAX_CONCURRENCY, async (target) => {
    try {
      return await queryTarget(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      return emptyResult(target, target.pnu, `Hometax 기준시가 조회 실패: ${message}`);
    }
  });

  return [...preResults, ...results];
}
