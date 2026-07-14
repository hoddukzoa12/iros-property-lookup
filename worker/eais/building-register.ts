import { PDFDocument } from 'pdf-lib';
import type {
  BuildingRegisterAvailability,
  BuildingRegisterDocumentType,
  BuildingRegisterDownloadRequest,
  BuildingRegisterRequestItem,
} from '../../shared/types';
import { addressToPnu } from '../ldong/lookup';
import {
  buildEaisExclusiveListPayload,
  buildEaisLotSearchPayload,
  type EaisRegisterType,
  resolveEaisRegisterType,
} from './building-register-config';

const EAIS_ORIGIN = 'https://m.eais.go.kr';
const ACTION_ID = 'BCIAAA04L01';
const DOCUMENT_TTL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ITEMS_PER_DOWNLOAD = 50;
const EAIS_GET_RETRY_DELAYS_MS = [1_500];
const EAIS_GET_RETRY_STATUSES = new Set([502, 503, 504, 520, 522, 524]);
const STATUS_LOOKUP_CONCURRENCY = 5;

export interface BuildingRegisterEnv {
  LDONG: KVNamespace;
  ODCLOUD_API_KEY: string;
  EAIS_ID?: string;
  EAIS_PASS?: string;
  BUILDING_REGISTER_DB?: D1Database;
  BUILDING_REGISTER_PDFS?: R2Bucket;
}

interface ParsedPnu {
  sigunguCd: string;
  bjdongCd: string;
  platGbCd: string;
  mnnm: string;
  slno: string;
}

interface EaisSession {
  session: Record<string, any>;
  user: Record<string, any>;
  userId: string;
}

interface InternalAvailability extends BuildingRegisterAvailability {
  item: BuildingRegisterRequestItem;
  pnu: string | null;
  candidate?: Record<string, any>;
}

interface ReadyDocument {
  id: string;
  recordKey: string;
  documentType: BuildingRegisterDocumentType;
  r2Key: string;
  pageCount: number;
  byteSize: number;
}

interface AvailabilityLookupCache {
  mainRows: Map<string, Promise<Record<string, any>[]>>;
  exclusiveRows: Map<string, Promise<Record<string, any>[]>>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createAvailabilityLookupCache(): AvailabilityLookupCache {
  return {
    mainRows: new Map(),
    exclusiveRows: new Map(),
  };
}


class CookieJar {
  private values = new Map<string, string>();

  store(headers: Headers) {
    const setCookies = typeof (headers as any).getSetCookie === 'function'
      ? (headers as any).getSetCookie()
      : splitSetCookie(headers.get('set-cookie'));
    for (const cookie of setCookies) {
      const pair = cookie.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.values.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }

  header() {
    return Array.from(this.values).map(([key, value]) => `${key}=${value}`).join('; ');
  }
}

class EaisClient {
  private jar = new CookieJar();
  private sessionPromise: Promise<EaisSession> | null = null;

  constructor(private env: BuildingRegisterEnv) {}

  async request(path: string, options: RequestInit = {}, redirects = 5): Promise<Response> {
    const url = path.startsWith('http') ? path : `${EAIS_ORIGIN}${path}`;
    const headers = new Headers(options.headers || {});
    headers.set('User-Agent', 'Mozilla/5.0 iros-property-lookup');
    headers.set('Accept', headers.get('Accept') || 'application/json, text/plain, */*');
    headers.set('Origin', EAIS_ORIGIN);
    headers.set('Referer', headers.get('Referer') || `${EAIS_ORIGIN}/moct/bci/aaa02/BCIAAA02L01`);
    headers.set('UntClsfCd', headers.get('UntClsfCd') || '1000');
    const cookie = this.jar.header();
    if (cookie) headers.set('Cookie', cookie);

    const response = await fetch(url, { ...options, headers, redirect: 'manual' });
    this.jar.store(response.headers);
    if ([301, 302, 303, 307, 308].includes(response.status) && redirects > 0) {
      const location = response.headers.get('location');
      if (location) return this.request(new URL(location, url).toString(), options, redirects - 1);
    }
    return response;
  }

  async getText(path: string, headers: HeadersInit = {}) {
    const maxAttempts = EAIS_GET_RETRY_DELAYS_MS.length + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response | null = null;
      let failure: unknown;

      try {
        response = await this.request(path, { headers });
      } catch (error) {
        failure = error;
      }

      if (response?.ok) return response.text();

      const retryable = response
        ? EAIS_GET_RETRY_STATUSES.has(response.status)
        : true;
      if (!retryable || attempt === maxAttempts) {
        if (response) throw new Error(`${path} HTTP ${response.status}`);
        const reason = failure instanceof Error ? failure.message : '알 수 없는 오류';
        throw new Error(`${path} 연결 실패: ${reason}`);
      }

      if (response?.body) await response.body.cancel().catch(() => {});
      const reason = response ? `HTTP ${response.status}` : failure instanceof Error ? failure.message : '연결 실패';
      const delay = EAIS_GET_RETRY_DELAYS_MS[attempt - 1] + Math.floor(Math.random() * 250);
      console.warn(`[EAIS] GET 재시도 ${attempt + 1}/${maxAttempts}: ${path} (${reason}, ${delay}ms 후)`);
      await sleep(delay);
    }

    throw new Error(`${path} 연결 실패`);
  }

  async getJson<T = any>(path: string, headers: HeadersInit = {}) {
    const response = await this.request(path, { headers });
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  async postJson<T = any>(path: string, body: unknown, headers: HeadersInit = {}) {
    const response = await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  async postForm(path: string, body: Record<string, string>, headers: HeadersInit = {}) {
    const response = await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', ...headers },
      body: new URLSearchParams(body),
    });
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
    return response;
  }

  async login(): Promise<EaisSession> {
    if (this.sessionPromise) return this.sessionPromise;
    this.sessionPromise = this.loginFresh();
    return this.sessionPromise;
  }

  private async loginFresh(): Promise<EaisSession> {
    if (!this.env.EAIS_ID || !this.env.EAIS_PASS) throw new Error('EAIS_ID/EAIS_PASS 설정이 필요합니다.');

    await this.getText('/mbi/mbi/adb02/MBIADB02V01');
    await this.getText('/mbi/mbi/abb01/MBIABB01F12?loginPage=%2Fmbi%2Fmbi%2Fabb01%2FMBIABB01F11');

    const login = await this.postJson('/awp/AWPMBB01R01', {
      loginId: this.env.EAIS_ID,
      loginPwd: this.env.EAIS_PASS,
    });
    const session = login.sessionRep || {};
    const userId = session.sessionUserId || session.membId || this.env.EAIS_ID;
    if (!userId) throw new Error('세움터 로그인 사용자 정보를 확인하지 못했습니다.');

    await this.getText('/cba/CBAAZA02R01');
    const userJson = await this.postJson('/awp/AWPACC01R03', { membId: userId });
    const user = userJson?.resultData?.results?.[0] || {};
    return { session, user, userId };
  }
}

function splitSetCookie(value: string | null) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=]+=[^;,]*)/g);
}

function parsePnu(pnu: string): ParsedPnu | null {
  const digits = pnu.replace(/\D/g, '');
  if (digits.length !== 19) return null;
  return {
    sigunguCd: digits.slice(0, 5),
    bjdongCd: digits.slice(5, 10),
    platGbCd: digits[10] === '2' ? '1' : '0',
    mnnm: String(Number(digits.slice(11, 15))),
    slno: String(Number(digits.slice(15, 19))),
  };
}

function normalizeNo(value: unknown) {
  return String(value ?? '')
    .replace(/제/g, '')
    .replace(/[동호층\s]/g, '')
    .replace(/^0+/, '')
    .trim();
}

function extractDongNo(item: BuildingRegisterRequestItem) {
  const text = [item.address, item.roadAddr, item.building].filter(Boolean).join(' ');
  const match = Array.from(text.matchAll(/(?:제\s*)?([A-Za-z]?\d+[A-Za-z]?)\s*동/g)).at(-1);
  return normalizeNo(match?.[1] || '');
}

function extractHoNo(item: BuildingRegisterRequestItem) {
  const direct = normalizeNo(item.room || '');
  if (direct) return direct;
  const text = [item.address, item.roadAddr].filter(Boolean).join(' ');
  const match = Array.from(text.matchAll(/(?:제\s*)?([A-Za-z]?\d+[A-Za-z]?)\s*호/g)).at(-1);
  return normalizeNo(match?.[1] || '');
}

function makeDetailAddress(row: Record<string, any>) {
  const main = String(Number(row.mnnm || row.locMnnm || '0'));
  const sub = String(Number(row.slno || row.locSlno || '0'));
  const lot = sub === '0' ? main : `${main}-${sub}`;
  return [row.sigunguNm, row.bjdongNm, lot, row.dongNm, row.hoNm].filter(Boolean).join(' ');
}

function documentLabel(type: BuildingRegisterDocumentType) {
  if (type === 'general') return '일반건축물';
  if (type === 'multiFamily') return '다가구';
  return '전유부';
}

function toDocumentType(type: EaisRegisterType): BuildingRegisterDocumentType {
  return type;
}

function stripInternal(result: InternalAvailability): BuildingRegisterAvailability {
  const { item: _item, candidate: _candidate, ...publicResult } = result;
  return publicResult;
}

async function getMainRows(
  client: EaisClient,
  parsed: ParsedPnu,
  pnu: string,
  cache: AvailabilityLookupCache,
) {
  let pending = cache.mainRows.get(pnu);
  if (!pending) {
    pending = client
      .postJson('/bci/BCIAAA02R01', buildEaisLotSearchPayload(parsed))
      .then((data) => (Array.isArray(data?.jibunAddr) ? data.jibunAddr : []));
    cache.mainRows.set(pnu, pending);
  }
  return pending;
}

async function getExclusiveRows(
  client: EaisClient,
  sigunguCd: string,
  titleBldrgstSeqno: string,
  cache: AvailabilityLookupCache,
) {
  const key = `${sigunguCd}:${titleBldrgstSeqno}`;
  let pending = cache.exclusiveRows.get(key);
  if (!pending) {
    pending = client
      .postJson('/bci/BCIAAA02R04', buildEaisExclusiveListPayload(sigunguCd, titleBldrgstSeqno))
      .then((data) => (Array.isArray(data?.findExposList) ? data.findExposList : []));
    cache.exclusiveRows.set(key, pending);
  }
  return pending;
}

async function selectExclusiveCandidate(
  client: EaisClient,
  item: BuildingRegisterRequestItem,
  parsed: ParsedPnu,
  mainRows: Record<string, any>[],
  cache: AvailabilityLookupCache,
) {
  const wantedDong = extractDongNo(item);
  const wantedHo = extractHoNo(item);
  const direct = mainRows.find((row) => {
    if (String(row.regstrKindCd ?? '') !== '4') return false;
    const rowDong = normalizeNo(row.dongNm || row.locDongNm || '');
    const rowHo = normalizeNo(row.hoNm || row.locHoNm || '');
    return (!wantedDong || !rowDong || rowDong === wantedDong) && (!wantedHo || !rowHo || rowHo === wantedHo);
  });
  if (direct) return direct;

  const titleRows = mainRows.filter((row) => String(row.regstrKindCd ?? '') === '3');
  const sortedTitleRows = [...titleRows].sort((a, b) => {
    const aDong = normalizeNo(a.dongNm || '');
    const bDong = normalizeNo(b.dongNm || '');
    if (wantedDong && aDong === wantedDong && bDong !== wantedDong) return -1;
    if (wantedDong && bDong === wantedDong && aDong !== wantedDong) return 1;
    return 0;
  });

  for (const title of sortedTitleRows) {
    const rows = await getExclusiveRows(client, parsed.sigunguCd, String(title.bldrgstSeqno || ''), cache);
    const match = rows.find((row: Record<string, any>) => {
      const rowDong = normalizeNo(row.dongNm || row.locDongNm || title.dongNm || '');
      const rowHo = normalizeNo(row.hoNm || row.locHoNm || '');
      return (!wantedDong || !rowDong || rowDong === wantedDong) && (!wantedHo || !rowHo || rowHo === wantedHo);
    });
    if (match) return { ...match, sigunguCd: match.sigunguCd || title.sigunguCd, bjdongCd: match.bjdongCd || title.bjdongCd, platGbCd: match.platGbCd || title.platGbCd, mnnm: match.mnnm || title.mnnm, slno: match.slno || title.slno };
  }
  return null;
}

async function resolveOneAvailability(
  item: BuildingRegisterRequestItem,
  env: BuildingRegisterEnv,
  ctx: ExecutionContext | undefined,
  client: EaisClient,
  cache: AvailabilityLookupCache,
): Promise<InternalAvailability> {
  const pnu = await addressToPnu(item.address, env, ctx);
  if (!pnu) return { key: item.key, address: item.address, pnu: null, status: 'error', item, error: 'PNU 변환 실패' };
  const parsed = parsePnu(pnu);
  if (!parsed) return { key: item.key, address: item.address, pnu, status: 'error', item, error: 'PNU 형식 오류' };

  try {
    const rows = await getMainRows(client, parsed, pnu, cache);
    if (!rows.length) return { key: item.key, address: item.address, pnu, status: 'none', item };

    let candidate: Record<string, any> | null = null;
    if (item.type === '집합건물' || extractHoNo(item)) {
      candidate = await selectExclusiveCandidate(client, item, parsed, rows, cache);
    }
    if (!candidate) {
      candidate = rows.find((row) => String(row.regstrKindCd ?? '') === '2') || null;
    }
    if (!candidate) return { key: item.key, address: item.address, pnu, status: 'none', item };

    const resolved = resolveEaisRegisterType(candidate);
    if (!resolved) return { key: item.key, address: item.address, pnu, status: 'none', item };
    const documentType = toDocumentType(resolved);

    return {
      key: item.key,
      address: item.address,
      pnu,
      status: 'available',
      documentType,
      documentLabel: documentLabel(documentType),
      eaisRegisterKindCd: String(candidate.regstrKindCd ?? ''),
      eaisMjrfmlyYn: String(candidate.mjrfmlyYn ?? candidate.mjrfmlyIssueYn ?? 'N'),
      eaisBldrgstSeqno: String(candidate.bldrgstSeqno ?? ''),
      detailAddress: makeDetailAddress(candidate) || item.address,
      item,
      candidate,
    };
  } catch (e: any) {
    return { key: item.key, address: item.address, pnu, status: 'error', item, error: e?.message ?? '세움터 조회 실패' };
  }
}

export async function fetchBuildingRegisterStatuses(
  items: BuildingRegisterRequestItem[],
  env: BuildingRegisterEnv,
  ctx?: ExecutionContext,
): Promise<BuildingRegisterAvailability[]> {
  if (!items.length) return [];
  const client = new EaisClient(env);
  await client.login();
  const cache = createAvailabilityLookupCache();
  const results = new Array<BuildingRegisterAvailability>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      const result = await resolveOneAvailability(items[index], env, ctx, client, cache);
      results[index] = stripInternal(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(STATUS_LOOKUP_CONCURRENCY, items.length) }, worker));
  return results;
}

function requireStorage(env: BuildingRegisterEnv) {
  if (!env.BUILDING_REGISTER_DB) throw new Error('BUILDING_REGISTER_DB D1 바인딩이 필요합니다.');
  if (!env.BUILDING_REGISTER_PDFS) throw new Error('BUILDING_REGISTER_PDFS R2 바인딩이 필요합니다.');
  return { db: env.BUILDING_REGISTER_DB, bucket: env.BUILDING_REGISTER_PDFS };
}

function isoNow() {
  return new Date().toISOString();
}

function isoAfter(ms: number) {
  return new Date(Date.now() + ms).toISOString();
}

function recordKey(item: BuildingRegisterRequestItem, documentType: BuildingRegisterDocumentType) {
  return `v2:${item.key}:${documentType}`;
}

function safeFilename(value: string, fallback: string) {
  const safe = value.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return safe || fallback;
}

function reportNameFor(documentType: BuildingRegisterDocumentType) {
  if (documentType === 'multiFamily') return 'djrMjrFmlyHoArea';
  if (documentType === 'exclusive') return 'djrBldexpos';
  return 'djrBldrgstGnrl';
}

function xmlEscape(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}

function field(name: string, value: unknown) {
  return `<field name='${xmlEscape(name)}' trim='true'>${xmlEscape(value)}</field>`;
}

function buildDwgOof(payload: Record<string, any>, serverInfo: Record<string, any>) {
  const fields: string[] = [];
  let issueReadAppDate = '';
  let pbsvcRecpNo = '';

  for (const [key, value] of Object.entries(payload)) {
    if (key === 'FileName' || key === 'markAnyYn' || key === 'actionIdParam') continue;
    if (key === 'issueReadAppDate') {
      issueReadAppDate = String(value || '');
      continue;
    }
    if (key === 'pbsvcRecpNo') {
      pbsvcRecpNo = String(value || '');
      continue;
    }
    if (key === 'mgmNo' || key === 'bldrgstCurdiGbCd' || key === 'timestamp' || key === 'preview') continue;
    fields.push(field(key, value));
  }

  fields.push(field('SVR_GB', serverInfo.key || ''));
  fields.push(field('SVR_HOST', serverInfo.host || ''));

  const issuePath = issueReadAppDate && pbsvcRecpNo
    ? `/cais_data/issue/${issueReadAppDate.slice(0, 4)}/${issueReadAppDate.slice(4, 6)}/${issueReadAppDate.slice(6, 8)}/${pbsvcRecpNo}/${pbsvcRecpNo}`
    : '';
  if (issuePath) fields.push(field('FILE_PATH', `${issuePath}.png`));

  return [
    "<?xml version='1.0' encoding='utf-8'?>",
    "<oof version='3.0'>",
    "<document title='' enable-thread='0'>",
    '<file-list>',
    `<file type='crf.root' path='%root%/crf${xmlEscape(payload.FileName)}.crf'></file>`,
    '</file-list>',
    issuePath
      ? `<connection-list><connection type='file' namespace='XML1'><config-param-list><config-param name='path'>${xmlEscape(issuePath)}.xml</config-param></config-param-list><content content-type='xml' namespace='*'><content-param name='encoding'>euc-kr</content-param><content-param name='root'>{%dataset.xml.root%}</content-param></content></connection></connection-list>`
      : '',
    '<field-list type="name">',
    fields.join(''),
    '</field-list>',
    '</document>',
    '</oof>',
  ].join('');
}

function parseClipJson(text: string) {
  const trimmed = text.trim();
  const body = trimmed.startsWith('(') && trimmed.endsWith(')') ? trimmed.slice(1, -1) : trimmed;
  return JSON.parse(body.replace(/'/g, '"'));
}

function base64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary);
}

async function history(client: EaisClient) {
  const today = new Date();
  const start = new Date(today.getTime() - 3 * 86400000);
  const ymd = (date: Date) => date.toISOString().slice(0, 10);
  const data = await client.postJson('/bci/BCIAAA06R01', {
    membNo: '',
    pbsvcGbCd: '',
    progStateFlagArr: ['01'],
    pbsvcProcessGbCd: '',
    firstSaveStartDate: ymd(start),
    firstSaveEndDate: ymd(today),
    pageNo: 0,
    recordSize: 20,
    pageYn: 'N',
  });
  return (data.IssueReadHistList || []) as Record<string, any>[];
}

function receiptNo(row: Record<string, any>) {
  return String(row.pbsvcRecpNo || row.pbsvcReceptNo || row.recpNo || '').trim();
}

function findReceiptNo(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const stack = [value as Record<string, any>];
  const seen = new Set<object>();

  while (stack.length) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);

    for (const [key, raw] of Object.entries(next)) {
      if (/pbsvc.*recp.*no/i.test(key) || /recp.*no/i.test(key)) {
        const found = String(raw || '').trim();
        if (found) return found;
      }
      if (raw && typeof raw === 'object') stack.push(raw as Record<string, any>);
    }
  }

  return '';
}

async function waitForCreatedApplication(client: EaisClient, beforeSet: Set<string>, expectedReceiptNo = '') {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 750));

    const rows = await history(client);
    if (expectedReceiptNo) {
      const exact = rows.find((row: Record<string, any>) => receiptNo(row) === expectedReceiptNo);
      if (exact) return exact;
    }

    const createdRows = rows.filter((row: Record<string, any>) => {
      const no = receiptNo(row);
      return no && !beforeSet.has(no);
    });
    if (createdRows.length === 1) return createdRows[0];
    if (createdRows.length > 1) {
      throw new Error('세움터 신청내역이 여러 건 생성되어 대상 문서를 안전하게 특정하지 못했습니다.');
    }
  }

  throw new Error('세움터 신청내역에서 새 열람 신청 건을 확인하지 못했습니다.');
}

function basketItemFromAvailability(result: InternalAvailability, session: EaisSession) {
  const row = result.candidate || {};
  return {
    bldrgstSeqno: row.bldrgstSeqno,
    regstrGbCd: row.regstrKindCd,
    regstrKindCd: row.regstrKindCd,
    mjrfmlyIssueYn: row.mjrfmlyYn || row.mjrfmlyIssueYn || 'N',
    locSigunguCd: row.sigunguCd,
    locBjdongCd: row.bjdongCd,
    locPlatGbCd: row.platGbCd,
    locDetlAddr: makeDetailAddress(row) || result.item.address,
    locMnnm: row.mnnm,
    locSlno: row.slno,
    locDongNm: row.dongNm || '',
    locFlrNm: row.blprtNm || row.flrNm || '',
    locHoNm: row.hoNm || '',
    locBldNm: row.bldNm || result.item.building || '',
    ownrYn: row.ownrYn || 'N',
    multiUseBildYn: row.multiUseBldYn || 'N',
    bldrgstCurdiGbCd: '0',
    firstWrtrId: session.userId,
    lastUpdusrId: session.userId,
  };
}

function applicantInfo(session: EaisSession) {
  const { user, session: s } = session;
  return {
    appntGbCd: user.membGbCd || s.membGbCd || '',
    appntJmno1: '',
    appntJmno2: '',
    appntJmno: '',
    appntBizno: user.bizno || '',
    appntNm: user.nm || s.sessionUserNm || '',
    appntMtelno: user.mtelno || user.telno || '',
    appntSigunguCd: user.naLocSigunguCd || '',
    naAppntBjdongCd: user.naLocBjdongCd || '',
    naAppntRoadCd: user.naLocRoadCd || '',
    naAppntMnnm: user.naLocMnnm || '',
    naAppntSlno: user.naLocSlno || '',
    naAppntGrndUgrndGbCd: user.naGrndUgrndGbCd || '',
    naAppntDetlAddr: user.naLocDetlAddr || '',
    appntCorpno: '',
    appntCoprNm: '',
  };
}

async function createReadApplication(client: EaisClient, session: EaisSession, result: InternalAvailability) {
  const before = await history(client);
  const beforeSet = new Set<string>(before.map((row) => receiptNo(row)).filter(Boolean));

  await clearReservedApplications(client, session);

  try {
    const addResult = await client.postJson('/bci/BCIAAA02C01', basketItemFromAvailability(result, session));
    if (addResult.caisMessage?.resultCode && addResult.caisMessage.resultCode !== 'S00000') {
      throw new Error(addResult.caisMessage.resultMessage || '세움터 장바구니 추가 실패');
    }

    const basketResult = await client.postJson('/bci/BCIAAA02R05', { lastUpdusrId: session.userId });
    const basket = (basketResult.findPbsvcResveDtls || []).map((row: Record<string, any>) => ({ ...row, ownrExprsYn: 'N' }));
    if (!basket.length) throw new Error('세움터 장바구니가 비어 있습니다.');

    const submitResult = await client.postJson('/bci/BCIAZA02S01', {
      pbsvcResveDtls: basket,
      ownrExprsYn: 'N',
      bldrgstGbCd: '1',
      pbsvcRecpInfo: {
        pbsvcGbCd: '01',
        issueReadGbCd: '1',
        certDn: null,
        pbsvcResveDtlsCnt: basket.length,
      },
      appntInfo: applicantInfo(session),
      indvGbCd: session.session.indvGbCd || session.user.indvGbCd || '',
    });
    if (submitResult.caisMessage?.resultCode && submitResult.caisMessage.resultCode !== 'S00000') {
      throw new Error(submitResult.caisMessage.resultMessage || '세움터 열람 신청 실패');
    }

    return await waitForCreatedApplication(client, beforeSet, findReceiptNo(submitResult));
  } finally {
    await clearReservedApplications(client, session);
  }
}

async function clearReservedApplications(client: EaisClient, session: EaisSession) {
  await client.postJson('/bci/BCIAAA02D02', { lastUpdusrId: session.userId }).catch(() => undefined);

  const basket = await client.postJson('/bci/BCIAAA02R05', { lastUpdusrId: session.userId }).catch(() => null);
  const rows: Record<string, any>[] = basket?.findPbsvcResveDtls || [];
  for (const row of rows) {
    const seqNo = String(row.pbsvcResveDtlsSeqno || row.pbsvcResveSeqno || row.resveDtlsSeqno || '').trim();
    if (!seqNo) continue;
    await client.postJson('/bci/BCIAAA02D01', { pbsvcResveDtlsSeqno: seqNo }).catch(() => undefined);
  }
}

async function waitReport(client: EaisClient, uid: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await client.postForm('/report/RPTCAA02R01', {
      ClipID: 'R03',
      uid,
      clipUID: uid,
      s_time: `t${new Date().getMilliseconds()}`,
    }, { Referer: `${EAIS_ORIGIN}/report/BCIAAA04V01` });
    const data = parseClipJson(await response.text());
    if (data.status && data.endReport && Number(data.count) > 0) return data;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error('세움터 PDF 생성 대기 시간이 초과되었습니다.');
}

async function createPdf(client: EaisClient, result: InternalAvailability, application: Record<string, any>) {
  const documentType = result.documentType!;
  const reportName = reportNameFor(documentType);
  const recpDay = String(application.recpDate || '').replace(/-/g, '');
  const fileResult = await client.postJson('/cba/CBAAZD04R01', { sysLocGbCd: '3', reptNm: reportName, recpDay, jobGbCd: 'BC' });
  const fileName = `/bci/${fileResult.reportFileName || reportName}`;
  const reportMetaBody = {
    issueReadAppDate: String(application.firstCrtnDt || '').slice(0, 8),
    pbsvcRecpNo: application.pbsvcRecpNo,
  };
  const [reportCount, bciCount, serverInfo] = await Promise.all([
    client.postJson('/report/BCIAAA06R03', reportMetaBody),
    client.postJson('/bci/BCIAAA06R03', reportMetaBody),
    client.getJson('/report/RPTCAA02R06', { Referer: `${EAIS_ORIGIN}/report/BCIAAA04V01` }),
  ]);

  const payload = {
    FileName: fileName,
    markAnyYn: 'N',
    actionIdParam: ACTION_ID,
    bldrgstCurdiGbCd: '0',
    timestamp: new Date(),
    issueReadAppDate: reportMetaBody.issueReadAppDate,
    pbsvcRecpNo: application.pbsvcRecpNo,
    mgmNo: application.mgmNo,
    ISSUE_READ_GB_CD: String(application.issueReadGbCd ?? '1'),
    BLDRGST_GB_CD: '1',
    ...(bciCount?.count || {}),
    ...(reportCount?.count || {}),
  };
  const oof = buildDwgOof(payload, serverInfo || {});
  const createResponse = await client.postForm('/report/RPTCAA02R01', {
    isEncoding: 'false',
    isBigData: 'false',
    isMemoryDump: 'false',
    ClipID: 'R01',
    oof,
  }, { Referer: `${EAIS_ORIGIN}/report/BCIAAA04V01` });
  const createJson = parseClipJson(await createResponse.text());
  if (!createJson.status || !createJson.uid) throw new Error('세움터 리포트 키 발급 실패');
  const ready = await waitReport(client, createJson.uid);

  const exportName = base64Utf8(encodeURIComponent(safeFilename(result.item.address, result.item.key)));
  const option = {
    exportType: 2,
    name: exportName,
    pageType: 1,
    startNum: 1,
    endNum: Number(ready.count),
    option: {
      isSplite: false,
      spliteValue: 1,
      fileNames: [],
      userpw: '',
      textToImage: false,
      importOriginImage: false,
      removeHyperlink: false,
    },
  };
  const pdfResponse = await client.postForm('/report/RPTCAA02R01', {
    ClipID: 'R09',
    uid: createJson.uid,
    clipUID: createJson.uid,
    path: '/report',
    optionValue: JSON.stringify(option),
    exportN: option.name,
    exportType: String(option.exportType),
    is_ie: 'false',
  }, { Referer: `${EAIS_ORIGIN}/report/BCIAAA04V01` });
  const bytes = new Uint8Array(await pdfResponse.arrayBuffer());
  if (bytes.length < 1024 || String.fromCharCode(...bytes.slice(0, 4)) !== '%PDF') {
    throw new Error('세움터 PDF 응답이 올바르지 않습니다.');
  }
  return { bytes, pageCount: Number(ready.count), reportName };
}

async function existingReadyDocument(db: D1Database, bucket: R2Bucket, key: string, documentType: BuildingRegisterDocumentType): Promise<ReadyDocument | null> {
  const row = await db.prepare(
    `SELECT id, record_key, document_type, r2_key, page_count, byte_size
     FROM building_register_documents
     WHERE record_key = ? AND document_type = ? AND status = 'ready' AND expires_at > ? AND r2_key IS NOT NULL`,
  ).bind(key, documentType, isoNow()).first<any>();
  if (!row?.r2_key) return null;
  const head = await bucket.head(row.r2_key);
  if (!head) return null;
  return {
    id: row.id,
    recordKey: row.record_key,
    documentType: row.document_type,
    r2Key: row.r2_key,
    pageCount: Number(row.page_count || 0),
    byteSize: Number(row.byte_size || head.size || 0),
  };
}

async function markDocumentError(db: D1Database, result: InternalAvailability, error: string) {
  const documentType = result.documentType!;
  const key = recordKey(result.item, documentType);
  const now = isoNow();
  await db.prepare(
    `INSERT INTO building_register_documents
      (id, record_key, pin, pin_fmt, record_type, address, road_addr, building, floor, room, document_type, status, error_message, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'error', ?, ?, ?, ?)
     ON CONFLICT(record_key, document_type) DO UPDATE SET
      status = 'error', error_message = excluded.error_message, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
  ).bind(
    crypto.randomUUID(),
    key,
    result.item.key,
    result.item.pinFmt || '',
    result.item.type || '',
    result.item.address,
    result.item.roadAddr || '',
    result.item.building || '',
    result.item.floor || '',
    result.item.room || '',
    documentType,
    error,
    now,
    now,
    isoAfter(DOCUMENT_TTL_MS),
  ).run();
}

async function createReadyDocument(db: D1Database, bucket: R2Bucket, client: EaisClient, session: EaisSession, result: InternalAvailability): Promise<ReadyDocument> {
  const documentType = result.documentType!;
  const key = recordKey(result.item, documentType);
  const existing = await existingReadyDocument(db, bucket, key, documentType);
  if (existing) return existing;

  const id = crypto.randomUUID();
  const now = isoNow();
  const expiresAt = isoAfter(DOCUMENT_TTL_MS);
  await db.prepare(
    `INSERT INTO building_register_documents
      (id, record_key, pin, pin_fmt, record_type, address, road_addr, building, floor, room, document_type, status, eais_register_kind_cd, eais_mjrfmly_yn, eais_bldrgst_seqno, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(record_key, document_type) DO UPDATE SET
      status = 'processing', error_message = NULL, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
  ).bind(
    id,
    key,
    result.item.key,
    result.item.pinFmt || '',
    result.item.type || '',
    result.item.address,
    result.item.roadAddr || '',
    result.item.building || '',
    result.item.floor || '',
    result.item.room || '',
    documentType,
    result.eaisRegisterKindCd || '',
    result.eaisMjrfmlyYn || '',
    result.eaisBldrgstSeqno || '',
    now,
    now,
    expiresAt,
  ).run();

  try {
    const application = await createReadApplication(client, session, result);
    const pdf = await createPdf(client, result, application);
    const r2Key = `building-register/documents/${key}/${crypto.randomUUID()}.pdf`;
    await bucket.put(r2Key, pdf.bytes, {
      httpMetadata: { contentType: 'application/pdf' },
      customMetadata: { pin: result.item.key, documentType },
    });
    await db.prepare(
      `UPDATE building_register_documents
       SET status = 'ready', eais_receipt_no = ?, eais_mgm_no = ?, eais_application_date = ?,
           eais_report_name = ?, r2_key = ?, content_type = 'application/pdf', byte_size = ?,
           page_count = ?, error_message = NULL, updated_at = ?, expires_at = ?
       WHERE record_key = ? AND document_type = ?`,
    ).bind(
      application.pbsvcRecpNo || '',
      application.mgmNo || '',
      String(application.firstCrtnDt || '').slice(0, 8),
      pdf.reportName,
      r2Key,
      pdf.bytes.byteLength,
      pdf.pageCount,
      isoNow(),
      expiresAt,
      key,
      documentType,
    ).run();
    const row = await existingReadyDocument(db, bucket, key, documentType);
    if (!row) throw new Error('저장된 PDF를 확인하지 못했습니다.');
    return row;
  } catch (e: any) {
    await markDocumentError(db, result, e?.message ?? '건축물대장 PDF 생성 실패');
    throw e;
  }
}

async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function mergePdfDocuments(bucket: R2Bucket, docs: ReadyDocument[]) {
  const merged = await PDFDocument.create();
  for (const doc of docs) {
    const object = await bucket.get(doc.r2Key);
    if (!object) throw new Error('R2에 저장된 건축물대장 PDF를 찾지 못했습니다.');
    const source = await PDFDocument.load(await object.arrayBuffer());
    const pages = await merged.copyPages(source, source.getPageIndices());
    pages.forEach((page) => merged.addPage(page));
  }
  return merged.save();
}

async function existingDownload(db: D1Database, bucket: R2Bucket, selectionHash: string) {
  const row = await db.prepare(
    `SELECT id, merged_r2_key, file_name, byte_size
     FROM building_register_downloads
     WHERE selection_hash = ? AND format = 'pdf' AND status = 'ready' AND expires_at > ? AND merged_r2_key IS NOT NULL`,
  ).bind(selectionHash, isoNow()).first<any>();
  if (!row?.merged_r2_key) return null;
  const object = await bucket.get(row.merged_r2_key);
  if (!object) return null;
  return { row, bytes: new Uint8Array(await object.arrayBuffer()) };
}

function pdfResponse(bytes: Uint8Array, filename: string) {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function downloadBuildingRegisterPdf(
  request: BuildingRegisterDownloadRequest,
  env: BuildingRegisterEnv,
  ctx?: ExecutionContext,
) {
  const items = request.items.filter((item) => item.key && item.address).slice(0, MAX_ITEMS_PER_DOWNLOAD);
  if (!items.length) throw new Error('items 배열 필수');

  const { db, bucket } = requireStorage(env);
  const client = new EaisClient(env);
  const session = await client.login();
  await clearReservedApplications(client, session);

  try {
    const availability: InternalAvailability[] = [];
    const cache = createAvailabilityLookupCache();
    for (const item of items) {
      availability.push(await resolveOneAvailability(item, env, ctx, client, cache));
    }
    const available = availability.filter((result) => result.status === 'available' && result.documentType && result.candidate);
    if (!available.length) throw new Error('다운로드 가능한 건축물대장이 없습니다.');

    const docs: ReadyDocument[] = [];
    for (const result of available) {
      docs.push(await createReadyDocument(db, bucket, client, session, result));
    }

    const selectionHash = await sha256Hex([
      'building-register-only-v1',
      ...docs.map((doc) => doc.recordKey).sort(),
    ].join('\n'));
    const cached = await existingDownload(db, bucket, selectionHash);
    const filename = docs.length === 1
      ? `${safeFilename(available[0].item.address, available[0].item.key)}_건축물대장.pdf`
      : `건축물대장_${docs.length}건.pdf`;
    if (cached) {
      await db.prepare('UPDATE building_register_downloads SET downloaded_at = ?, updated_at = ? WHERE id = ?')
        .bind(isoNow(), isoNow(), cached.row.id)
        .run();
      return pdfResponse(cached.bytes, cached.row.file_name || filename);
    }

    const bytes = await mergePdfDocuments(bucket, docs);
    const downloadId = crypto.randomUUID();
    const r2Key = `building-register/downloads/${selectionHash}/${downloadId}.pdf`;
    await bucket.put(r2Key, bytes, {
      httpMetadata: { contentType: 'application/pdf' },
      customMetadata: { selectionHash },
    });

    const now = isoNow();
    await db.prepare(
      `INSERT INTO building_register_downloads
        (id, selection_hash, format, status, merged_r2_key, file_name, source_document_ids, byte_size, created_at, updated_at, expires_at, downloaded_at)
       VALUES (?, ?, 'pdf', 'ready', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(selection_hash, format) DO UPDATE SET
        status = 'ready', merged_r2_key = excluded.merged_r2_key, file_name = excluded.file_name,
        source_document_ids = excluded.source_document_ids, byte_size = excluded.byte_size,
        updated_at = excluded.updated_at, expires_at = excluded.expires_at, downloaded_at = excluded.downloaded_at,
        error_message = NULL`,
    ).bind(
      downloadId,
      selectionHash,
      r2Key,
      filename,
      JSON.stringify(docs.map((doc) => doc.id)),
      bytes.byteLength,
      now,
      now,
      isoAfter(DOWNLOAD_TTL_MS),
      now,
    ).run();

    return pdfResponse(bytes, filename);
  } finally {
    await clearReservedApplications(client, session);
  }
}

export async function cleanupBuildingRegisterArtifacts(env: BuildingRegisterEnv) {
  if (!env.BUILDING_REGISTER_DB || !env.BUILDING_REGISTER_PDFS) return;
  const { db, bucket } = requireStorage(env);
  const now = isoNow();
  const [documents, downloads] = await Promise.all([
    db.prepare('SELECT r2_key FROM building_register_documents WHERE expires_at <= ? AND r2_key IS NOT NULL').bind(now).all<any>(),
    db.prepare('SELECT merged_r2_key FROM building_register_downloads WHERE expires_at <= ? AND merged_r2_key IS NOT NULL').bind(now).all<any>(),
  ]);

  for (const row of documents.results || []) {
    if (row.r2_key) await bucket.delete(row.r2_key).catch(() => undefined);
  }
  for (const row of downloads.results || []) {
    if (row.merged_r2_key) await bucket.delete(row.merged_r2_key).catch(() => undefined);
  }

  await Promise.all([
    db.prepare('DELETE FROM building_register_documents WHERE expires_at <= ?').bind(now).run(),
    db.prepare('DELETE FROM building_register_downloads WHERE expires_at <= ?').bind(now).run(),
  ]);
}
