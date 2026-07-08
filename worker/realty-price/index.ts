import type {
  ApartmentOfficialPriceInfo,
  ApartmentOfficialPriceItem,
  IndividualHousePriceInfo,
  IndividualHousePriceItem,
  RealtyPriceInfo,
  RealtyPriceRequestItem,
} from '../../shared/types';
import { addressToPnu } from '../ldong/lookup';

interface RealtyPriceEnv {
  LDONG: KVNamespace;
  ODCLOUD_API_KEY: string;
}

interface ParsedPnu {
  lawCode: string;
  landKind: string;
  bun: string;
  ji: string;
  bunPadded: string;
  jiPadded: string;
}

interface NoticeDateOption {
  code: string;
  year: string;
  noticeDateYear: string;
}

type RealtyValue = string | number | null | undefined;
type RealtyRow = Record<string, RealtyValue>;

interface RealtyResponse {
  model?: {
    list?: RealtyRow[];
    totalCnt?: RealtyValue;
  };
  modelMap?: {
    list?: RealtyRow[];
    totalCnt?: RealtyValue;
  };
}

interface ApartmentSelection {
  aptCode: string;
  aptName: string;
  aptNoticeDate: string;
  dongCode: string;
  dongName: string;
  hoCode: string;
  hoName: string;
}

interface RealtyTarget extends RealtyPriceRequestItem {
  pnu: string;
  parsedPnu: ParsedPnu;
  buildingNorm: string;
  dongNorm: string;
  roomNorm: string;
}

const REALTY_BASE = 'https://www.realtyprice.kr';
const REALTY_CONCURRENCY = 1;
const REALTY_MIN_INTERVAL_MS = 260;
const REALTY_RETRY_DELAYS_MS = [450, 1000, 1800];
const REALTY_PAGE_REF = `${REALTY_BASE}/notice/town/nfSiteLink.htm`;
const REALTY_INDIVIDUAL_REF = `${REALTY_BASE}/notice/hpindividual/search.htm`;

let noticeDatePromise: Promise<NoticeDateOption> | null = null;
let lastRealtyFetchAt = 0;

function stripLeadingZeros(value: string) {
  const stripped = value.replace(/^0+/, '');
  return stripped || '0';
}

function compact(value: string) {
  return value.replace(/\s+/g, '').trim();
}

function normalizeName(value: string) {
  return compact(value)
    .replace(/[()（）\[\]{}'".,·ㆍ]/g, '')
    .replace(/제/g, '')
    .toUpperCase();
}

function toText(value: RealtyValue) {
  return value == null ? '' : String(value).replace(/\u00ad/g, '-').trim();
}

function toNumber(value: RealtyValue) {
  const text = toText(value);
  if (!text) return null;
  const parsed = Number(text.replace(/,/g, '').replace(/\s+/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePnu(pnu: string): ParsedPnu | null {
  const digits = pnu.replace(/\D/g, '');
  if (digits.length !== 19) return null;
  const bunPadded = digits.slice(11, 15);
  const jiPadded = digits.slice(15, 19);
  return {
    lawCode: digits.slice(0, 10),
    landKind: digits.slice(10, 11),
    bun: stripLeadingZeros(bunPadded),
    ji: stripLeadingZeros(jiPadded),
    bunPadded,
    jiPadded,
  };
}

function extractDong(value: string) {
  const matches = Array.from(value.matchAll(/(?:제\s*)?([A-Z]?\d+[A-Z]?)\s*동/gi));
  return matches.at(-1)?.[1] ?? '';
}

function extractRoom(value: string) {
  const matches = Array.from(value.matchAll(/(?:제\s*)?([A-Z]?\d+[A-Z]?)\s*호/gi));
  return matches.at(-1)?.[1] ?? '';
}

function normalizeRoom(value: string) {
  return normalizeName(value.replace(/호$/i, ''));
}

function normalizeDong(value: string) {
  return normalizeName(value.replace(/동$/i, ''));
}

function formatDongLabel(value: string) {
  const text = value.trim();
  if (!text) return '';
  return text.endsWith('동') ? text : `${text}동`;
}

function responseList(data: RealtyResponse) {
  return data.model?.list ?? data.modelMap?.list ?? [];
}

function responseTotal(data: RealtyResponse) {
  return Number(data.model?.totalCnt ?? data.modelMap?.totalCnt ?? responseList(data).length);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paceRealtyFetch() {
  const elapsed = Date.now() - lastRealtyFetchAt;
  if (elapsed < REALTY_MIN_INTERVAL_MS) {
    await sleep(REALTY_MIN_INTERVAL_MS - elapsed);
  }
  lastRealtyFetchAt = Date.now();
}

async function fetchRealtyJson(
  path: string,
  params: Record<string, string>,
  referer = REALTY_PAGE_REF,
): Promise<RealtyResponse> {
  const url = new URL(path, REALTY_BASE);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  for (let attempt = 0; attempt <= REALTY_RETRY_DELAYS_MS.length; attempt += 1) {
    await paceRealtyFetch();
    const res = await fetch(url.toString(), {
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        referer,
        'user-agent': 'Mozilla/5.0 iros-property-lookup',
        'x-requested-with': 'XMLHttpRequest',
      },
    });
    if (res.ok) return (await res.json()) as RealtyResponse;

    const retryable = res.status === 400 || res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= REALTY_RETRY_DELAYS_MS.length) {
      throw new Error(`${path} HTTP ${res.status}`);
    }
    await sleep(REALTY_RETRY_DELAYS_MS[attempt]);
  }

  throw new Error(`${path} 요청 실패`);
}

function noticeDateYearFromName(name: string, fallback: string) {
  const match = /공시일자\s*:\s*(\d{4})\.(\d{2})\.(\d{2})/.exec(name);
  if (!match) return fallback;
  return `${match[1]}${match[2]}${match[3]}`;
}

async function latestNoticeDate() {
  if (!noticeDatePromise) {
    noticeDatePromise = (async () => {
      const year = String(new Date().getFullYear());
      const data = await fetchRealtyJson('/notice/town/searchNoticeDate.search', { year });
      const list = responseList(data);
      const first = list[0];
      const code = toText(first?.code);
      const name = toText(first?.name);
      if (!code) throw new Error('공동주택 고시일자를 확인하지 못했습니다.');
      return {
        code,
        year: /(\d{4})년/.exec(name)?.[1] ?? code.slice(0, 4),
        noticeDateYear: noticeDateYearFromName(name, code),
      };
    })();
  }
  return noticeDatePromise;
}

function commonApartmentParams(target: RealtyTarget, notice: NoticeDateOption): Record<string, string> {
  return {
    page_no: '1',
    reg_name: '',
    sreg: '',
    seub: '',
    old_reg: '',
    old_eub: '',
    gbn: '1',
    year: notice.year,
    notice_date: '',
    notice_date_year: notice.noticeDateYear,
    reg: target.parsedPnu.lawCode.slice(0, 5),
    eub: target.parsedPnu.lawCode.slice(5),
    apt_name: '',
    bun1: target.parsedPnu.bun,
    bun2: target.parsedPnu.ji,
    road_code: '',
    initialword: '',
    build_bun1: '',
    build_bun2: '',
    gbnApt: '',
    apt_code: '',
    dong_code: '',
    ho_code: '',
    tabGbn: 'Text',
    full_addr_name: '',
    dong_name: '',
    ho_name: '',
    notice_amt: '',
    ktown_ho_seq: '',
    print_yn: '0',
    past_yn: '1',
    searchGbnRoad: '',
    searchGbnBunji: '1',
    searchGbnBunjiYear: '',
    capcha: '',
    capcha_chk_yn: '',
    recaptcha_token: '',
    init_gbn: 'N',
  };
}

function pickApartment(rows: RealtyRow[], target: RealtyTarget) {
  if (!rows.length) return null;

  const scored = rows
    .map((row, index) => {
      const name = toText(row.name);
      const source = normalizeName(name);
      let score = rows.length === 1 ? 10 : 0;
      if (target.buildingNorm && (source.includes(target.buildingNorm) || target.buildingNorm.includes(source))) {
        score += 100 + source.length;
      }
      return { row, index, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return scored[0]?.row ?? null;
}

function pickNamedRow(
  rows: RealtyRow[],
  targetNorm: string,
  field = 'name',
  normalizer: (value: string) => string = normalizeName,
) {
  if (!rows.length) return null;
  if (!targetNorm) return rows.length === 1 ? rows[0] : null;
  return rows.find((row) => normalizer(toText(row[field])) === targetNorm) ?? null;
}

function formatApartmentDetail(row: RealtyRow | undefined, fallback: RealtyTarget) {
  if (row) {
    return [
      toText(row.full_addr_name).replace(/\s+/g, ' '),
      toText(row.apt_name),
      formatDongLabel(toText(row.dong_name)),
      toText(row.ho_name) && `${toText(row.ho_name)}호`,
    ].filter(Boolean).join(' ');
  }
  return [
    fallback.address,
    fallback.building,
    fallback.dongNorm && `${fallback.dongNorm}동`,
    fallback.roomNorm && `${fallback.roomNorm}호`,
  ].filter(Boolean).join(' ');
}

function normalizeApartmentItems(rows: RealtyRow[]) {
  return rows
    .map<ApartmentOfficialPriceItem>((row) => ({
      baseDate: toText(row.notice_date_name),
      complexName: toText(row.apt_name),
      dongName: toText(row.dong_name),
      roomName: toText(row.ho_name),
      exclusiveArea: toNumber(row.priv_area),
      price: toNumber(row.notice_amt),
    }))
    .filter((item) => item.baseDate && item.price != null)
    .sort((a, b) => b.baseDate.localeCompare(a.baseDate));
}

async function fetchApartmentPrice(target: RealtyTarget): Promise<ApartmentOfficialPriceInfo> {
  if (!target.roomNorm) {
    return emptyApartment(target, target.pnu);
  }

  const notice = await latestNoticeDate();
  const aptRows = responseList(await fetchRealtyJson(
    '/notice/search/searchApt.search',
    commonApartmentParams(target, notice),
  ));
  const apt = pickApartment(aptRows, target);
  if (!apt) return emptyApartment(target, target.pnu);

  const aptCode = toText(apt.code);
  const aptName = toText(apt.name).replace(/^\([^)]*\)\s*/, '');
  const aptNoticeDate = toText(apt.notice_date) || notice.code;
  if (!aptCode) return emptyApartment(target, target.pnu);

  const dongRows = responseList(await fetchRealtyJson('/notice/search/searchApt.search', {
    ...commonApartmentParams(target, notice),
    notice_date: aptNoticeDate,
    gbnApt: 'DONG',
    apt_code: aptCode,
  }));
  const dong = pickNamedRow(dongRows, target.dongNorm, 'name', normalizeDong);
  if (!dong) return emptyApartment(target, target.pnu, '동 정보를 찾지 못했습니다.');

  const dongCode = toText(dong.code);
  const dongName = toText(dong.name);
  const hoRows = responseList(await fetchRealtyJson('/notice/search/searchApt.search', {
    ...commonApartmentParams(target, notice),
    notice_date: aptNoticeDate,
    gbnApt: 'HO',
    apt_code: aptCode,
    dong_code: dongCode,
    dong_name: dongName,
  }));
  const ho = pickNamedRow(hoRows, target.roomNorm, 'name', normalizeRoom);
  if (!ho) return emptyApartment(target, target.pnu, '호 정보를 찾지 못했습니다.');

  const selection: ApartmentSelection = {
    aptCode,
    aptName,
    aptNoticeDate,
    dongCode,
    dongName,
    hoCode: toText(ho.code),
    hoName: toText(ho.name),
  };

  const priceRows = responseList(await fetchRealtyJson('/notice/search/townPriceListPastYearMap.search', {
    ...commonApartmentParams(target, notice),
    notice_date: selection.aptNoticeDate,
    gbnApt: 'HO',
    apt_code: selection.aptCode,
    dong_code: selection.dongCode,
    ho_code: selection.hoCode,
    dong_name: selection.dongName,
    ho_name: selection.hoName,
  }));
  const items = normalizeApartmentItems(priceRows);
  return {
    key: target.key,
    address: target.address,
    pnu: target.pnu,
    detailAddress: formatApartmentDetail(priceRows[0], target),
    items,
  };
}

function individualParams(target: RealtyTarget): Record<string, string> {
  return {
    page_no: '1',
    gbn: '1',
    year: '',
    reg: target.parsedPnu.lawCode.slice(0, 5),
    eub: target.parsedPnu.lawCode.slice(5),
    san: target.parsedPnu.landKind === '2' ? '2' : '1',
    bun1: target.parsedPnu.bunPadded,
    bun2: target.parsedPnu.jiPadded,
    road_code: '',
    p_initialword: '',
    build_bun1: '',
    build_bun2: '',
    from_year: '',
    to_year: '',
    dong_gbn: '',
    tabGbn: 'Text',
  };
}

function normalizeIndividualItems(rows: RealtyRow[]) {
  return rows
    .map<IndividualHousePriceItem>((row) => ({
      baseDate: toText(row.base_ymd),
      address: toText(row.full_addr_name) || toText(row.addr),
      landAreaTotal: toNumber(row.tbook_area),
      landAreaCalculated: toNumber(row.calc_larea),
      buildingAreaTotal: toNumber(row.bldg_garea),
      buildingAreaCalculated: toNumber(row.res_area),
      price: toNumber(row.hprice_w),
    }))
    .filter((item) => item.baseDate && item.price != null)
    .sort((a, b) => b.baseDate.localeCompare(a.baseDate));
}

async function fetchIndividualPrice(target: RealtyTarget): Promise<IndividualHousePriceInfo> {
  const data = await fetchRealtyJson(
    '/notice/search/hpiSearchListApi.search',
    individualParams(target),
    REALTY_INDIVIDUAL_REF,
  );
  const items = normalizeIndividualItems(responseList(data));
  return {
    key: target.key,
    address: target.address,
    pnu: target.pnu,
    items: responseTotal(data) > 0 ? items : [],
  };
}

function emptyApartment(item: RealtyPriceRequestItem, pnu: string | null, error?: string): ApartmentOfficialPriceInfo {
  return {
    key: item.key,
    address: item.address,
    pnu,
    detailAddress: [item.address, item.building, item.room && `${item.room}호`].filter(Boolean).join(' '),
    items: [],
    error,
  };
}

function emptyIndividual(item: RealtyPriceRequestItem, pnu: string | null, error?: string): IndividualHousePriceInfo {
  return {
    key: item.key,
    address: item.address,
    pnu,
    items: [],
    error,
  };
}

function dedupeItems(items: RealtyPriceRequestItem[]) {
  const map = new Map<string, RealtyPriceRequestItem>();
  for (const item of items) {
    if (!item.key || !item.address || map.has(item.key)) continue;
    map.set(item.key, item);
  }
  return Array.from(map.values());
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

function makeTarget(item: RealtyPriceRequestItem, pnu: string): RealtyTarget | null {
  const parsedPnu = parsePnu(pnu);
  if (!parsedPnu) return null;

  const text = [item.address, item.roadAddr, item.building, item.floor, item.room].filter(Boolean).join(' ');
  return {
    ...item,
    pnu,
    parsedPnu,
    buildingNorm: normalizeName(item.building ?? ''),
    dongNorm: normalizeDong(extractDong(text)),
    roomNorm: normalizeRoom(item.room || extractRoom(text)),
  };
}

async function queryTarget(target: RealtyTarget): Promise<RealtyPriceInfo> {
  const shouldQueryApartment = target.type !== '토지' && Boolean(target.roomNorm);
  const shouldQueryIndividual = target.type !== '집합건물';

  const [apartment, individual] = await Promise.all([
    shouldQueryApartment
      ? fetchApartmentPrice(target).catch((error) => {
        const message = error instanceof Error ? error.message : String(error ?? '');
        return emptyApartment(target, target.pnu, `공동주택가격 조회 실패: ${message}`);
      })
      : Promise.resolve(emptyApartment(target, target.pnu)),
    shouldQueryIndividual
      ? fetchIndividualPrice(target).catch((error) => {
        const message = error instanceof Error ? error.message : String(error ?? '');
        return emptyIndividual(target, target.pnu, `개별주택가격 조회 실패: ${message}`);
      })
      : Promise.resolve(emptyIndividual(target, target.pnu)),
  ]);

  return {
    key: target.key,
    address: target.address,
    pnu: target.pnu,
    apartment,
    individual,
  };
}

function emptyResult(item: RealtyPriceRequestItem, pnu: string | null, error?: string): RealtyPriceInfo {
  return {
    key: item.key,
    address: item.address,
    pnu,
    apartment: emptyApartment(item, pnu, error),
    individual: emptyIndividual(item, pnu, error),
  };
}

export async function fetchRealtyPrices(
  items: RealtyPriceRequestItem[],
  env: RealtyPriceEnv,
  ctx?: ExecutionContext,
): Promise<RealtyPriceInfo[]> {
  const uniqueItems = dedupeItems(items);
  const targets: RealtyTarget[] = [];
  const preResults: RealtyPriceInfo[] = [];

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

  const results = await mapLimit(targets, REALTY_CONCURRENCY, queryTarget);
  return [...preResults, ...results];
}
