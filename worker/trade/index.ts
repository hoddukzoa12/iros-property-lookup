import type {
  BuildingTradeInfo,
  BuildingTradeItem,
  BuildingTradeMatchLevel,
  BuildingTradeRequestItem,
  BuildingTradeSource,
} from '../../shared/types';
import { addressToPnu, parseAddress } from '../ldong/lookup';

interface TradeEnv {
  LDONG: KVNamespace;
  ODCLOUD_API_KEY: string;
}

interface TradeSourceDef {
  source: BuildingTradeSource;
  label: string;
  endpoint: string;
}

interface TradeTarget extends BuildingTradeRequestItem {
  pnu: string;
  lawdCd: string;
  dongShort: string;
  targetJibun: string;
  normalizedJibun: string;
}

interface DatasetTask {
  source: TradeSourceDef;
  lawdCd: string;
  dealYmd: string;
}

const SOURCES: TradeSourceDef[] = [
  {
    source: 'apt',
    label: '아파트',
    endpoint: 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade',
  },
  {
    source: 'rowhouse',
    label: '연립다세대',
    endpoint: 'https://apis.data.go.kr/1613000/RTMSDataSvcRHTrade/getRTMSDataSvcRHTrade',
  },
  {
    source: 'officetel',
    label: '오피스텔',
    endpoint: 'https://apis.data.go.kr/1613000/RTMSDataSvcOffiTrade/getRTMSDataSvcOffiTrade',
  },
];

const PAGE_SIZE = 1000;
const MAX_PAGES = 10;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function compact(value: string) {
  return value.replace(/\s+/g, '').trim();
}

function xmlDecode(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .trim();
}

function xmlTag(xml: string, tag: string) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
  return match ? xmlDecode(match[1]) : '';
}

function parseXmlItems(xml: string): Record<string, string>[] {
  const items: Record<string, string>[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let itemMatch: RegExpExecArray | null;

  while ((itemMatch = itemRe.exec(xml))) {
    const raw: Record<string, string> = {};
    const tagRe = /<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g;
    let tagMatch: RegExpExecArray | null;
    while ((tagMatch = tagRe.exec(itemMatch[1]))) {
      raw[tagMatch[1]] = xmlDecode(tagMatch[2]);
    }
    items.push(raw);
  }

  return items;
}

function first(raw: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = raw[key]?.trim();
    if (value) return value;
  }
  return '';
}

function dealDate(raw: Record<string, string>) {
  const year = first(raw, ['dealYear']);
  const month = first(raw, ['dealMonth']).padStart(2, '0');
  const day = first(raw, ['dealDay']).padStart(2, '0');
  if (!year || !month || !day) return '';
  return `${year}-${month}-${day}`;
}

function amountToNumber(value: string) {
  const n = Number(value.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizeTrade(source: TradeSourceDef, raw: Record<string, string>): BuildingTradeItem {
  const dealAmount = first(raw, ['dealAmount']);
  return {
    source: source.source,
    sourceLabel: source.label,
    matchLevel: 'lot',
    dealDate: dealDate(raw),
    dealAmount,
    dealAmountManwon: amountToNumber(dealAmount),
    umdNm: first(raw, ['umdNm']),
    jibun: first(raw, ['jibun']),
    buildingName: first(raw, ['aptNm', 'mhouseNm', 'offiNm']),
    houseType: first(raw, ['houseType']),
    floor: first(raw, ['floor']),
    area: first(raw, ['excluUseAr']),
    landArea: first(raw, ['landAr']),
    plottageArea: first(raw, ['plottageAr']),
    totalFloorArea: first(raw, ['totalFloorAr']),
    buildYear: first(raw, ['buildYear']),
    dealingGbn: first(raw, ['dealingGbn']),
    estateAgentSggNm: first(raw, ['estateAgentSggNm']),
    rgstDate: first(raw, ['rgstDate']),
    sellerGbn: first(raw, ['slerGbn', 'sellerGbn']),
    buyerGbn: first(raw, ['buyerGbn']),
    raw,
  };
}

function encodedServiceKey(key: string) {
  return key.includes('%') ? key : encodeURIComponent(key);
}

function buildApiUrl(source: TradeSourceDef, env: TradeEnv, lawdCd: string, dealYmd: string, pageNo: number) {
  const params = [
    `serviceKey=${encodedServiceKey(env.ODCLOUD_API_KEY)}`,
    `LAWD_CD=${encodeURIComponent(lawdCd)}`,
    `DEAL_YMD=${encodeURIComponent(dealYmd)}`,
    `pageNo=${pageNo}`,
    `numOfRows=${PAGE_SIZE}`,
  ];
  return `${source.endpoint}?${params.join('&')}`;
}

async function fetchTradePage(source: TradeSourceDef, env: TradeEnv, lawdCd: string, dealYmd: string, pageNo: number) {
  const res = await fetch(buildApiUrl(source, env, lawdCd, dealYmd, pageNo), {
    headers: {
      Accept: 'application/xml,text/xml,*/*',
      'User-Agent': 'Mozilla/5.0',
    },
  });
  const xml = await res.text();
  if (!res.ok) throw new Error(`${source.label} API HTTP ${res.status}`);

  const code = xmlTag(xml, 'resultCode');
  const message = xmlTag(xml, 'resultMsg') || xmlTag(xml, 'returnAuthMsg');
  if (code && code !== '000' && code !== '00') {
    if (code === '03' || /NO_DATA|NODATA|데이터.*없/i.test(message)) {
      return { items: [] as BuildingTradeItem[], totalCount: 0 };
    }
    throw new Error(`${source.label} API 오류 ${code}${message ? `: ${message}` : ''}`);
  }

  return {
    items: parseXmlItems(xml).map((raw) => normalizeTrade(source, raw)),
    totalCount: Number(xmlTag(xml, 'totalCount')) || 0,
  };
}

async function fetchTradeMonth(source: TradeSourceDef, env: TradeEnv, lawdCd: string, dealYmd: string) {
  const firstPage = await fetchTradePage(source, env, lawdCd, dealYmd, 1);
  const items = [...firstPage.items];
  const pageCount = Math.min(Math.ceil(firstPage.totalCount / PAGE_SIZE), MAX_PAGES);

  for (let pageNo = 2; pageNo <= pageCount; pageNo++) {
    const page = await fetchTradePage(source, env, lawdCd, dealYmd, pageNo);
    items.push(...page.items);
  }

  return items;
}

function recentDealMonths(now = new Date()) {
  const months: string[] = [];
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;

  for (let offset = 0; offset <= 12; offset++) {
    let year = currentYear;
    let month = currentMonth - offset;
    while (month <= 0) {
      month += 12;
      year -= 1;
    }
    months.push(`${year}${String(month).padStart(2, '0')}`);
  }

  return months;
}

function isWithinLastYear(dateText: string, now = new Date()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!match) return false;
  const date = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = today - 365 * ONE_DAY_MS;
  return date >= start && date <= today + ONE_DAY_MS;
}

function normalizeJibun(value: string) {
  const normalized = value
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/번지/g, '')
    .replace(/\s+/g, '')
    .trim();
  const san = normalized.startsWith('산');
  const body = san ? normalized.slice(1) : normalized;
  const match = /^(\d+)(?:-(\d+))?/.exec(body);
  if (!match) return normalized;
  return `${san ? '산' : ''}${Number(match[1])}${match[2] ? `-${Number(match[2])}` : ''}`;
}

function targetFromPnu(item: BuildingTradeRequestItem, pnu: string): TradeTarget {
  const parsed = parseAddress(item.address);
  const mountain = pnu[10] === '2';
  const bobn = String(Number(pnu.slice(11, 15)));
  const bubnNo = Number(pnu.slice(15, 19));
  const targetJibun = `${mountain ? '산' : ''}${bobn}${bubnNo ? `-${bubnNo}` : ''}`;
  const dongShort = parsed?.dongName.split(/\s+/).pop() ?? '';

  return {
    ...item,
    pnu,
    lawdCd: pnu.slice(0, 5),
    dongShort,
    targetJibun,
    normalizedJibun: normalizeJibun(targetJibun),
  };
}

function matchesDong(trade: BuildingTradeItem, target: TradeTarget) {
  if (!trade.umdNm || !target.dongShort) return true;
  return compact(trade.umdNm) === compact(target.dongShort);
}

function matchTrade(trade: BuildingTradeItem, target: TradeTarget): BuildingTradeMatchLevel | null {
  if (!matchesDong(trade, target)) return null;
  if (!trade.jibun) return null;

  return normalizeJibun(trade.jibun) === target.normalizedJibun ? 'lot' : null;
}

function cancellationKey(trade: BuildingTradeItem) {
  return [
    trade.source,
    compact(trade.umdNm),
    normalizeJibun(trade.jibun),
    compact(trade.buildingName),
    compact(trade.houseType),
    trade.floor,
    trade.area,
    trade.plottageArea,
    trade.totalFloorArea,
    trade.dealDate,
    trade.dealAmountManwon ?? trade.dealAmount,
  ].join('|');
}

function removeCanceled(trades: BuildingTradeItem[]) {
  const canceled = new Set(
    trades
      .filter((trade) => trade.raw.cdealType === 'O' || trade.raw.cdealDay)
      .map(cancellationKey),
  );
  return trades.filter((trade) =>
    trade.raw.cdealType !== 'O' &&
    !trade.raw.cdealDay &&
    !canceled.has(cancellationKey(trade)),
  );
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function loadTradesByLawd(lawdCds: string[], env: TradeEnv) {
  const months = recentDealMonths();
  const tasks: DatasetTask[] = [];
  for (const lawdCd of lawdCds) {
    for (const dealYmd of months) {
      for (const source of SOURCES) tasks.push({ source, lawdCd, dealYmd });
    }
  }

  const grouped = new Map<string, BuildingTradeItem[]>();
  const errors: string[] = [];

  await runPool(tasks, 6, async ({ source, lawdCd, dealYmd }) => {
    try {
      const items = await fetchTradeMonth(source, env, lawdCd, dealYmd);
      const prev = grouped.get(lawdCd) ?? [];
      prev.push(...items);
      grouped.set(lawdCd, prev);
    } catch (e: any) {
      errors.push(`${source.label} ${lawdCd} ${dealYmd}: ${e?.message ?? '조회 실패'}`);
    }
  });

  for (const [lawdCd, trades] of grouped.entries()) {
    grouped.set(lawdCd, removeCanceled(trades));
  }

  return {
    grouped,
    fatalError: tasks.length > 0 && errors.length === tasks.length ? errors[0] : undefined,
  };
}

function sortTrades(a: BuildingTradeItem, b: BuildingTradeItem) {
  return b.dealDate.localeCompare(a.dealDate) ||
    a.sourceLabel.localeCompare(b.sourceLabel, 'ko-KR') ||
    (b.dealAmountManwon ?? 0) - (a.dealAmountManwon ?? 0);
}

function dedupeItems(items: BuildingTradeRequestItem[]) {
  const map = new Map<string, BuildingTradeRequestItem>();
  for (const item of items) {
    if (!item.key || !item.address || map.has(item.key)) continue;
    map.set(item.key, item);
  }
  return Array.from(map.values());
}

export async function fetchBuildingTrades(
  items: BuildingTradeRequestItem[],
  env: TradeEnv,
  ctx?: ExecutionContext,
): Promise<BuildingTradeInfo[]> {
  if (!env.ODCLOUD_API_KEY) throw new Error('ODCLOUD_API_KEY 없음');

  const uniqueItems = dedupeItems(items);
  const targets: TradeTarget[] = [];
  const preResults: BuildingTradeInfo[] = [];

  for (const item of uniqueItems) {
    const pnu = await addressToPnu(item.address, env, ctx);
    if (!pnu) {
      preResults.push({
        key: item.key,
        address: item.address,
        pnu: null,
        items: [],
        error: '주소를 PNU로 변환하지 못했습니다.',
      });
      continue;
    }
    targets.push(targetFromPnu(item, pnu));
  }

  const lawdCds = Array.from(new Set(targets.map((target) => target.lawdCd)));
  const { grouped, fatalError } = await loadTradesByLawd(lawdCds, env);
  const now = new Date();

  const results = targets.map<BuildingTradeInfo>((target) => {
    const matchedItems = (grouped.get(target.lawdCd) ?? [])
      .map((trade) => {
        const matchLevel = matchTrade(trade, target);
        return matchLevel ? { ...trade, matchLevel } : null;
      })
      .filter((trade): trade is BuildingTradeItem => Boolean(trade))
      .filter((trade) => isWithinLastYear(trade.dealDate, now));
    const items = matchedItems
      .filter((item) => item.source !== 'single')
      .sort(sortTrades);

    return {
      key: target.key,
      address: target.address,
      pnu: target.pnu,
      lawdCd: target.lawdCd,
      targetJibun: target.targetJibun,
      items,
      error: fatalError,
    };
  });

  return [...preResults, ...results];
}
