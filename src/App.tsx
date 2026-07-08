import { useMemo, useState } from 'react';
import { collect, fetchBuildingTrades, fetchCommercialPrices, fetchEumPrintHtml, fetchLandInfo } from './api';
import { downloadBatches, batchCount } from './lib/excel';
import { printLandPdf } from './lib/landpdf';
import { downloadTradeWorkbook, downloadTradeZip } from './lib/tradeExcel';
import { printTradePdf } from './lib/tradePdf';
import { downloadCommercialPriceWorkbook } from './lib/commercialPriceExcel';
import { printCommercialPricePdf } from './lib/commercialPricePdf';
import type {
  BuildingTradeInfo,
  BuildingTradeRequestItem,
  CommercialPriceInfo,
  CommercialPriceRequestItem,
  EumPrintItem,
  LandInfo,
  PropertyRecord,
} from '../shared/types';

const won = (n: string) => (n ? Number(n).toLocaleString('ko-KR') : '');
const manwon = (n: number | null) => (n == null ? '' : `${n.toLocaleString('ko-KR')}만원`);
const wonPerM2 = (n: number | null) => (n == null ? '' : `${n.toLocaleString('ko-KR')}원/㎡`);
const areaM2 = (n: number | null) => (n == null ? '' : `${n.toLocaleString('ko-KR', { maximumFractionDigits: 3 })}㎡`);

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function writeWindowMessage(w: Window, title: string, message: string) {
  w.document.open();
  w.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
    <style>
      body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f7f8fb;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif; color:#111827; }
      main { width:min(520px, calc(100vw - 40px)); padding:28px; border:1px solid #e5e7eb; border-radius:12px; background:#fff; }
      h1 { margin:0 0 10px; font-size:18px; }
      p { margin:0; color:#6b7280; font-size:14px; line-height:1.6; white-space:pre-wrap; }
    </style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`);
  w.document.close();
  w.focus();
}

function waitForPrintableAssets(w: Window, timeoutMs = 8000) {
  const images = Array.from(w.document.images);
  const pending = images
    .filter((img) => !img.complete)
    .map((img) => new Promise<void>((resolve) => {
      const done = () => resolve();
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    }));

  return Promise.race([
    Promise.all(pending).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function writeAndPrintWindow(w: Window, html: string) {
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();

  const trigger = () => {
    waitForPrintableAssets(w).then(() => setTimeout(() => w.print(), 400));
  };

  if (w.document.readyState === 'complete') trigger();
  else w.addEventListener('load', trigger, { once: true });
}

type Row = {
  address: string;
  status: 'pending' | 'loading' | 'done' | 'error';
  records: PropertyRecord[];
  selectedPins: string[];
  total: number;
  error?: string;
};

// IROS 검색 백엔드는 동시 요청 시 불안정하게 0을 반환한다(false "결과 없음" 유발).
// → 직렬 처리 + 주소 간 페이싱으로 신뢰성 확보 (실측: 직렬은 100% 정확, 동시성은 누락 발생).
const CONCURRENCY = 1;
const PACE_MS = 800;                      // 주소 간 간격
type MatchKind = 'exact' | 'related' | 'caution' | 'review';

const MATCH_LABELS: Record<MatchKind, string> = {
  exact: '정확',
  related: '관련',
  caution: '주의',
  review: '검토',
};
const MATCH_ORDER: MatchKind[] = ['exact', 'related', 'caution', 'review'];
type ResultFilter = 'all' | 'selected' | MatchKind;
const FILTER_OPTIONS: { value: ResultFilter; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: 'selected', label: '선택' },
  { value: 'exact', label: '정확' },
  { value: 'related', label: '관련' },
  { value: 'caution', label: '주의' },
  { value: 'review', label: '검토' },
];

// 유형 필터 (부동산구분)
type TypeFilter = 'all' | '집합건물' | '건물' | '토지';
const TYPE_FILTER_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: '집합건물', label: '집합건물' },
  { value: '건물', label: '건물' },
  { value: '토지', label: '토지' },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isBuildingRecord(rec: PropertyRecord) {
  return rec.type !== '토지';
}

type ParsedLot = {
  dong?: string;
  mountain: boolean;
  bun: string;
  ji: string;
  tail?: string;
};

type ParsedRoad = {
  roadName: string;
  mainNo: string;
  subNo: string;
  buildingNo?: string;
  roomNo?: string;
};

function normalizeAddress(value: string) {
  return value
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactAddress(value: string) {
  return normalizeAddress(value).replace(/\s+/g, '');
}

function extractDong(value: string): string | undefined {
  const matches = Array.from(normalizeAddress(value).matchAll(/([가-힣0-9]+(?:읍|면|동|리|가))/g));
  return matches.length ? matches[matches.length - 1][1] : undefined;
}

function extractRoadAddress(value: string): ParsedRoad | null {
  const normalized = normalizeAddress(value);
  const match = /([가-힣0-9]+?(?:로(?:\d+길)?|길))\s*(\d+)(?:-(\d+))?/.exec(normalized);
  if (!match) return null;

  const tail = normalized.slice(match.index + match[0].length);
  const buildingNo = /(?:제\s*)?(\d+)\s*동/.exec(tail)?.[1];
  const roomNo = /(?:제\s*)?(\d+)\s*호/.exec(tail)?.[1];
  const looseNumbers = Array.from(tail.matchAll(/\d+/g)).map((m) => m[0]);

  return {
    roadName: match[1],
    mainNo: match[2],
    subNo: match[3] ?? '',
    buildingNo: buildingNo ?? (looseNumbers.length >= 2 ? looseNumbers[0] : undefined),
    roomNo: roomNo ?? (looseNumbers.length >= 2 ? looseNumbers[looseNumbers.length - 1] : undefined),
  };
}

function extractQueryLot(value: string): ParsedLot | null {
  const normalized = normalizeAddress(value);
  const compactMatches = Array.from(
    normalized.matchAll(/([가-힣0-9]+?(?:읍|면|동|리|가))\s*(산\s*)?(\d+)(?:-(\d+))?/g),
  );
  const compactMatch = compactMatches.length ? compactMatches[compactMatches.length - 1] : undefined;
  if (compactMatch) {
    return {
      dong: compactMatch[1],
      mountain: Boolean(compactMatch[2]),
      bun: compactMatch[3],
      ji: compactMatch[4] ?? '',
    };
  }

  const matches = Array.from(normalized.matchAll(/(?:^|\s)(산\s*)?(\d+)(?:-(\d+))?(?=$|\s|번지|호|,|\))/g));
  const dong = extractDong(normalized);
  let match = matches.length ? matches[matches.length - 1] : undefined;

  if (!match && dong) {
    const afterDong = normalized.slice(normalized.lastIndexOf(dong) + dong.length).trim();
    match = /^(산\s*)?(\d+)(?:-(\d+))?/.exec(afterDong) ?? undefined;
  }

  if (!match) return null;
  return {
    dong,
    mountain: Boolean(match[1]),
    bun: match[2],
    ji: match[3] ?? '',
  };
}

function extractPrimaryLot(address: string, queryDong?: string): ParsedLot | null {
  const normalized = normalizeAddress(address);
  let source = normalized;
  if (queryDong) {
    const dongIndex = normalized.lastIndexOf(queryDong);
    if (dongIndex >= 0) source = normalized.slice(dongIndex + queryDong.length).trim();
  }

  const match = /(?:^|\s)(산\s*)?(\d+)(?:-(\d+))?/.exec(source);
  if (!match) return null;

  return {
    mountain: Boolean(match[1]),
    bun: match[2],
    ji: match[3] ?? '',
    tail: source.slice(match.index + match[0].length).trim(),
  };
}

function classifyRoadRecord(queryAddress: string, record: PropertyRecord): MatchKind | null {
  const queryRoad = extractRoadAddress(queryAddress);
  if (!queryRoad) return null;

  const recordRoad = extractRoadAddress(record.roadAddr);
  if (!recordRoad) return 'caution';

  const sameRoad =
    compactAddress(recordRoad.roadName) === compactAddress(queryRoad.roadName) &&
    recordRoad.mainNo === queryRoad.mainNo &&
    recordRoad.subNo === queryRoad.subNo;
  if (!sameRoad) return 'caution';

  if (queryRoad.buildingNo && recordRoad.buildingNo !== queryRoad.buildingNo) return 'caution';
  if (queryRoad.roomNo && recordRoad.roomNo !== queryRoad.roomNo) return 'caution';

  return queryRoad.buildingNo || queryRoad.roomNo ? 'exact' : 'related';
}

function classifyRecord(queryAddress: string, record: PropertyRecord): MatchKind {
  const roadKind = classifyRoadRecord(queryAddress, record);
  if (roadKind) return roadKind;

  const queryLot = extractQueryLot(queryAddress);
  if (!queryLot) return 'review';

  if (queryLot.dong && !normalizeAddress(record.address).includes(queryLot.dong)) return 'caution';

  const primaryLot = extractPrimaryLot(record.address, queryLot.dong);
  if (!primaryLot) return 'review';

  const sameLot = primaryLot.bun === queryLot.bun && primaryLot.ji === queryLot.ji;
  if (!sameLot || primaryLot.mountain !== queryLot.mountain) return 'caution';

  return primaryLot.tail ? 'related' : 'exact';
}

function shouldSelectByDefault(kind: MatchKind) {
  return kind === 'exact' || kind === 'related';
}

function countMatches(kinds: MatchKind[]) {
  return kinds.reduce<Record<MatchKind, number>>(
    (acc, kind) => ({ ...acc, [kind]: acc[kind] + 1 }),
    { exact: 0, related: 0, caution: 0, review: 0 },
  );
}

function shouldExpandByDefault(kinds: MatchKind[], selectedCount: number) {
  const counts = countMatches(kinds);
  return selectedCount === 0 || counts.caution > 0 || counts.review > 0;
}

function searchText(value: string) {
  const normalized = normalizeAddress(value).toLowerCase();
  return `${normalized} ${normalized.replace(/\s+/g, '')}`;
}

function matchesSearch(value: string, query: string) {
  if (!query) return true;
  const needle = searchText(query);
  return searchText(value).includes(needle);
}

function recordSearchText(rowAddress: string, record: PropertyRecord, kind: MatchKind) {
  return [
    rowAddress,
    record.pin,
    record.pinFmt,
    record.type,
    record.address,
    record.roadAddr,
    record.building,
    record.floor,
    record.room,
    record.useCls,
    MATCH_LABELS[kind],
  ].join(' ');
}

function matchesResultFilter(kind: MatchKind, selected: boolean, filter: ResultFilter) {
  if (filter === 'all') return true;
  if (filter === 'selected') return selected;
  return kind === filter;
}

export default function App() {
  const [input, setInput] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});
  const [searchTerm, setSearchTerm] = useState('');
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [running, setRunning] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [landInfo, setLandInfo] = useState<Record<string, LandInfo>>({}); // pin → 공시지가·토지등급
  const [landLoading, setLandLoading] = useState(false);
  const [landDownloading, setLandDownloading] = useState(false);
  const [tradeInfo, setTradeInfo] = useState<Record<string, BuildingTradeInfo>>({}); // pin → 최근 1년 실거래가
  const [tradeLoading, setTradeLoading] = useState(false);
  const [tradeDownloading, setTradeDownloading] = useState(false);
  const [tradeDownloadingKey, setTradeDownloadingKey] = useState<string | null>(null);
  const [tradePdfPrintingKey, setTradePdfPrintingKey] = useState<string | null>(null);
  const [commercialPriceInfo, setCommercialPriceInfo] = useState<Record<string, CommercialPriceInfo>>({});
  const [commercialPriceLoading, setCommercialPriceLoading] = useState(false);
  const [commercialPriceDownloadingKey, setCommercialPriceDownloadingKey] = useState<string | null>(null);
  const [commercialPricePdfPrintingKey, setCommercialPricePdfPrintingKey] = useState<string | null>(null);
  const [eumPrintingKey, setEumPrintingKey] = useState<string | null>(null);

  // 전체 주소 통합 레코드 (고유번호 기준 중복 제거) — 다운로드용
  const exportRecords = useMemo(() => {
    const seen = new Set<string>();
    const records: PropertyRecord[] = [];
    for (const r of rows) {
      const selected = new Set(r.selectedPins);
      for (const rec of r.records)
        if (selected.has(rec.pin) && !seen.has(rec.pin)) { seen.add(rec.pin); records.push(rec); }
    }
    return records;
  }, [rows]);

  const done = rows.filter((r) => r.status === 'done' || r.status === 'error').length;

  async function onCollect() {
    const addresses = input.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!addresses.length) return;
    setRunning(true);
    setExpandedRows({});
    setLandInfo({});
    setTradeInfo({});
    setCommercialPriceInfo({});
    setRows(addresses.map((a) => ({ address: a, status: 'pending', records: [], selectedPins: [], total: 0 })));

    const update = (i: number, patch: Partial<Row>) =>
      setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

    const landItems: { key: string; address: string }[] = [];
    const buildingRecords: PropertyRecord[] = [];

    let next = 0;
    const worker = async () => {
      while (next < addresses.length) {
        const i = next++;
        update(i, { status: 'loading' });
        try {
          const res = await collect({ address: addresses[i] });
          if (res.ok) {
            const kinds = res.records.map((rec) => classifyRecord(addresses[i], rec));
            const selectedPins = res.records
              .filter((_, idx) => shouldSelectByDefault(kinds[idx]))
              .map((rec) => rec.pin);
            setExpandedRows((prev) => ({ ...prev, [i]: shouldExpandByDefault(kinds, selectedPins.length) }));
            update(i, { status: 'done', records: res.records, selectedPins, total: res.total });
            // 토지만 공시지가·토지등급 대상으로 수집
            for (const rec of res.records) {
              if (rec.type === '토지') landItems.push({ key: rec.pin, address: rec.address });
              else buildingRecords.push(rec);
            }
          }
          else {
            setExpandedRows((prev) => ({ ...prev, [i]: true }));
            update(i, { status: 'error', error: res.error });
          }
        } catch (e: any) {
          setExpandedRows((prev) => ({ ...prev, [i]: true }));
          update(i, { status: 'error', error: e?.message ?? '오류' });
        }
        if (next < addresses.length) await sleep(PACE_MS); // 주소 간 페이싱
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, addresses.length) }, worker));
    setRunning(false);

    await Promise.all([
      loadLandInfo(landItems),
      loadBuildingTrades(buildingRecords),
      loadCommercialPrices(buildingRecords),
    ]);
  }

  async function loadLandInfo(items: { key: string; address: string }[]) {
    if (!items.length) return;
    setLandLoading(true);
    try {
      const res = await fetchLandInfo({ items });
      if (res.ok) {
        setLandInfo((prev) => ({ ...prev, ...Object.fromEntries(res.results.map((r) => [r.key, r])) }));
      }
    } finally {
      setLandLoading(false);
    }
  }

  function toBuildingTradeItem(rec: PropertyRecord): BuildingTradeRequestItem {
    return {
      key: rec.pin,
      address: rec.address,
      roadAddr: rec.roadAddr,
      building: rec.building,
      floor: rec.floor,
      room: rec.room,
      type: rec.type,
    };
  }

  async function loadBuildingTrades(records: PropertyRecord[]) {
    const seen = new Set<string>();
    const items = records
      .filter(isBuildingRecord)
      .filter((rec) => {
        if (seen.has(rec.pin)) return false;
        seen.add(rec.pin);
        return true;
      })
      .map(toBuildingTradeItem);

    if (!items.length) return {};

    setTradeLoading(true);
    try {
      const res = await fetchBuildingTrades({ items });
      if (!res.ok) {
        alert(res.error ?? '실거래가 조회에 실패했습니다.');
        return {};
      }
      const next = Object.fromEntries(res.results.map((r) => [r.key, r]));
      setTradeInfo((prev) => ({ ...prev, ...next }));
      return next;
    } finally {
      setTradeLoading(false);
    }
  }

  function toCommercialPriceItem(rec: PropertyRecord): CommercialPriceRequestItem {
    return {
      key: rec.pin,
      address: rec.address,
      roadAddr: rec.roadAddr,
      building: rec.building,
      floor: rec.floor,
      room: rec.room,
      type: rec.type,
    };
  }

  async function loadCommercialPrices(records: PropertyRecord[]) {
    const seen = new Set<string>();
    const items = records
      .filter(isBuildingRecord)
      .filter((rec) => {
        if (seen.has(rec.pin)) return false;
        seen.add(rec.pin);
        return true;
      })
      .map(toCommercialPriceItem);

    if (!items.length) return {};

    setCommercialPriceLoading(true);
    try {
      const res = await fetchCommercialPrices({ items });
      if (!res.ok) {
        alert(res.error ?? '상가/오피스 기준시가 조회에 실패했습니다.');
        return {};
      }
      const next = Object.fromEntries(res.results.map((r) => [r.key, r]));
      setCommercialPriceInfo((prev) => ({ ...prev, ...next }));
      return next;
    } finally {
      setCommercialPriceLoading(false);
    }
  }

  // 선택된 토지 레코드
  const selectedLandRecords = useMemo(
    () => exportRecords.filter((rec) => rec.type === '토지'),
    [exportRecords],
  );

  const allBuildingRecords = useMemo(() => {
    const seen = new Set<string>();
    const records: PropertyRecord[] = [];
    for (const r of rows) {
      for (const rec of r.records) {
        if (!isBuildingRecord(rec) || seen.has(rec.pin)) continue;
        seen.add(rec.pin);
        records.push(rec);
      }
    }
    return records;
  }, [rows]);

  // 선택된 토지 중 공시지가/토지등급 데이터가 있는 것
  const selectedLands = useMemo(
    () => selectedLandRecords.filter((rec) => landInfo[rec.pin]).map((rec) => landInfo[rec.pin]),
    [selectedLandRecords, landInfo],
  );

  async function onLandDownload() {
    if (!selectedLands.length) return;
    setLandDownloading(true);
    try {
      printLandPdf(selectedLands);
    } finally {
      setLandDownloading(false);
    }
  }

  function toEumPrintItem(rec: PropertyRecord): EumPrintItem {
    const jiga = landInfo[rec.pin]?.jiga?.[0];
    return {
      key: rec.pin,
      label: rec.pinFmt,
      address: rec.address,
      jigaText: jiga ? `${won(jiga.price)}원 (${jiga.year}/${jiga.month})` : undefined,
    };
  }

  async function printEumRecords(records: PropertyRecord[], busyKey: string) {
    if (!records.length || eumPrintingKey || running) return;

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('팝업이 차단되었습니다. 팝업 허용 후 다시 시도해 주세요.');
      return;
    }

    writeWindowMessage(printWindow, '토지이용계획 생성 중', '토지이용계획 인쇄 문서를 만들고 있습니다.');
    setEumPrintingKey(busyKey);

    try {
      const html = await fetchEumPrintHtml({
        items: records.map(toEumPrintItem),
      });
      writeAndPrintWindow(printWindow, html);
    } catch (e: any) {
      writeWindowMessage(printWindow, '토지이용계획 생성 실패', e?.message ?? '토지이용계획 인쇄 HTML 생성에 실패했습니다.');
    } finally {
      setEumPrintingKey(null);
    }
  }

  async function onEumPrint() {
    await printEumRecords(selectedLandRecords, 'bulk');
  }

  async function onEumPrintOne(rec: PropertyRecord) {
    await printEumRecords([rec], rec.pin);
  }

  function renderEumAction(rec: PropertyRecord) {
    return (
      <button
        type="button"
        className="row-action"
        onClick={() => onEumPrintOne(rec)}
        disabled={running || Boolean(eumPrintingKey) || landLoading}
        title={running ? '전체 조회가 끝난 뒤 PDF 저장을 사용할 수 있습니다.' : '이 필지의 토지이용계획을 PDF로 저장합니다.'}
      >
        {eumPrintingKey === rec.pin ? '생성 중…' : 'PDF 저장'}
      </button>
    );
  }

  function renderTradeCell(rec: PropertyRecord) {
    const info = tradeInfo[rec.pin];
    const busy = tradeDownloadingKey === rec.pin;
    let summary = <span>{tradeLoading ? '조회 중…' : '-'}</span>;

    if (info && !info.items.length) {
      summary = (
        <span>
          {info.error ? '오류' : '없음'}
          {info.error && <span className="trade-sub">{info.error}</span>}
        </span>
      );
    }

    if (info?.items.length) {
      const latest = info.items[0];
      const candidateCount = info.items.filter((item) => item.matchLevel === 'candidate').length;
      const sourceSummary = ['아파트', '단독다가구', '연립다세대', '오피스텔']
        .map((label) => {
          const count = info.items.filter((item) => item.sourceLabel === label).length;
          return count ? `${label} ${count}` : '';
        })
        .filter(Boolean)
        .join(' · ');

      summary = (
        <span>
          <strong>{info.items.length}건</strong>
          <span className="trade-sub">
            {latest.sourceLabel} {latest.dealDate} {manwon(latest.dealAmountManwon)}
          </span>
          <span className="trade-sub">{sourceSummary}{candidateCount ? ` · 후보 ${candidateCount}` : ''}</span>
        </span>
      );
    }

    return (
      <span>
        {summary}
        <button
          type="button"
          className="row-action trade-download"
          onClick={() => onTradeDownloadOne(rec)}
          disabled={running || tradeLoading || tradeDownloading || Boolean(tradeDownloadingKey) || Boolean(tradePdfPrintingKey)}
          title="이 건물의 실거래가만 엑셀로 저장합니다."
        >
          {busy ? '생성 중…' : '엑셀'}
        </button>
        <button
          type="button"
          className="row-action trade-download"
          onClick={() => onTradePdfOne(rec)}
          disabled={running || tradeLoading || tradeDownloading || Boolean(tradeDownloadingKey) || Boolean(tradePdfPrintingKey)}
          title="이 건물의 실거래가만 PDF로 저장합니다."
        >
          {tradePdfPrintingKey === rec.pin ? '출력 중…' : 'PDF'}
        </button>
      </span>
    );
  }

  function renderCommercialPriceCell(rec: PropertyRecord) {
    const info = commercialPriceInfo[rec.pin];
    const busy = commercialPriceDownloadingKey === rec.pin;
    let summary = <span>{commercialPriceLoading ? '조회 중…' : '-'}</span>;

    if (info && !info.items.length) {
      summary = (
        <span>
          {info.error ? '오류' : '없음'}
          {info.error && <span className="commercial-sub">{info.error}</span>}
        </span>
      );
    }

    if (info?.items.length) {
      const latest = info.items[0];
      const yearCount = new Set(info.items.map((item) => item.noticeDate.slice(0, 4))).size;
      summary = (
        <span>
          <strong>{latest.noticeDate}</strong>
          <span className="commercial-sub">{wonPerM2(latest.unitPrice)} · {areaM2(latest.buildingArea)}</span>
          <span className="commercial-sub">{latest.kind}{yearCount > 1 ? ` · ${yearCount}개년` : ''}</span>
        </span>
      );
    }

    return (
      <span>
        {summary}
        <button
          type="button"
          className="row-action commercial-download"
          onClick={() => onCommercialPriceDownloadOne(rec)}
          disabled={running || commercialPriceLoading || Boolean(commercialPriceDownloadingKey) || Boolean(commercialPricePdfPrintingKey)}
          title="이 건물의 상가/오피스 기준시가를 엑셀로 저장합니다."
        >
          {busy ? '생성 중…' : '엑셀'}
        </button>
        <button
          type="button"
          className="row-action commercial-download"
          onClick={() => onCommercialPricePdfOne(rec)}
          disabled={running || commercialPriceLoading || Boolean(commercialPriceDownloadingKey) || Boolean(commercialPricePdfPrintingKey)}
          title="이 건물의 상가/오피스 기준시가를 PDF로 저장합니다."
        >
          {commercialPricePdfPrintingKey === rec.pin ? '출력 중…' : 'PDF'}
        </button>
      </span>
    );
  }

  function setSelectedPins(rowIndex: number, selectedPins: string[]) {
    setRows((prev) => prev.map((r, idx) => (idx === rowIndex ? { ...r, selectedPins } : r)));
  }

  function toggleExpanded(rowIndex: number) {
    setExpandedRows((prev) => ({ ...prev, [rowIndex]: !prev[rowIndex] }));
  }

  function togglePin(rowIndex: number, pin: string) {
    const row = rows[rowIndex];
    if (!row) return;
    const selected = new Set(row.selectedPins);
    if (selected.has(pin)) selected.delete(pin);
    else selected.add(pin);
    setSelectedPins(rowIndex, Array.from(selected));
  }

  function selectSuggested(rowIndex: number) {
    const row = rows[rowIndex];
    if (!row) return;
    setSelectedPins(
      rowIndex,
      row.records
        .filter((rec) => shouldSelectByDefault(classifyRecord(row.address, rec)))
        .map((rec) => rec.pin),
    );
  }

  function selectAll(rowIndex: number) {
    const row = rows[rowIndex];
    if (!row) return;
    setSelectedPins(rowIndex, row.records.map((rec) => rec.pin));
  }

  function clearSelection(rowIndex: number) {
    setSelectedPins(rowIndex, []);
  }

  async function onDownload() {
    if (!exportRecords.length || running) return;
    setDownloading(true);
    try {
      await downloadBatches(exportRecords);
    } finally {
      setDownloading(false);
    }
  }

  async function onTradeDownload() {
    if (!allBuildingRecords.length || running || tradePdfPrintingKey) return;

    setTradeDownloading(true);
    try {
      const missing = allBuildingRecords.filter((rec) => !tradeInfo[rec.pin]);
      const loaded = missing.length ? await loadBuildingTrades(missing) : {};
      const downloaded = await downloadTradeZip(allBuildingRecords, { ...tradeInfo, ...loaded });
      if (!downloaded) alert('조회된 건물의 실거래가 데이터가 없습니다.');
    } finally {
      setTradeDownloading(false);
    }
  }

  async function onTradeDownloadOne(rec: PropertyRecord) {
    if (running || tradeLoading || tradeDownloading || tradeDownloadingKey || tradePdfPrintingKey) return;

    setTradeDownloadingKey(rec.pin);
    try {
      const loaded = tradeInfo[rec.pin] ? {} : await loadBuildingTrades([rec]);
      const downloaded = downloadTradeWorkbook(
        [rec],
        { ...tradeInfo, ...loaded },
      );
      if (!downloaded) alert('이 건물의 실거래가 데이터가 없습니다.');
    } finally {
      setTradeDownloadingKey(null);
    }
  }

  async function onTradePdf() {
    if (!allBuildingRecords.length || running || tradeDownloading || tradeDownloadingKey || tradePdfPrintingKey) return;

    setTradePdfPrintingKey('bulk');
    try {
      const missing = allBuildingRecords.filter((rec) => !tradeInfo[rec.pin]);
      const loaded = missing.length ? await loadBuildingTrades(missing) : {};
      const printed = printTradePdf(allBuildingRecords, { ...tradeInfo, ...loaded });
      if (!printed) alert('조회된 건물의 실거래가 데이터가 없습니다.');
    } finally {
      setTradePdfPrintingKey(null);
    }
  }

  async function onTradePdfOne(rec: PropertyRecord) {
    if (running || tradeLoading || tradeDownloading || tradeDownloadingKey || tradePdfPrintingKey) return;

    setTradePdfPrintingKey(rec.pin);
    try {
      const loaded = tradeInfo[rec.pin] ? {} : await loadBuildingTrades([rec]);
      const printed = printTradePdf([rec], { ...tradeInfo, ...loaded });
      if (!printed) alert('이 건물의 실거래가 데이터가 없습니다.');
    } finally {
      setTradePdfPrintingKey(null);
    }
  }

  async function onCommercialPriceDownloadOne(rec: PropertyRecord) {
    if (running || commercialPriceLoading || commercialPriceDownloadingKey || commercialPricePdfPrintingKey) return;

    setCommercialPriceDownloadingKey(rec.pin);
    try {
      const loaded = commercialPriceInfo[rec.pin] ? {} : await loadCommercialPrices([rec]);
      const downloaded = downloadCommercialPriceWorkbook(
        rec,
        { ...commercialPriceInfo, ...loaded },
      );
      if (!downloaded) alert('이 건물의 상가/오피스 기준시가 데이터가 없습니다.');
    } finally {
      setCommercialPriceDownloadingKey(null);
    }
  }

  async function onCommercialPricePdfOne(rec: PropertyRecord) {
    if (running || commercialPriceLoading || commercialPriceDownloadingKey || commercialPricePdfPrintingKey) return;

    setCommercialPricePdfPrintingKey(rec.pin);
    try {
      const loaded = commercialPriceInfo[rec.pin] ? {} : await loadCommercialPrices([rec]);
      const printed = printCommercialPricePdf([rec], { ...commercialPriceInfo, ...loaded });
      if (!printed) alert('이 건물의 상가/오피스 기준시가 데이터가 없습니다.');
    } finally {
      setCommercialPricePdfPrintingKey(null);
    }
  }

  const nBatch = batchCount(exportRecords.length);
  const query = searchTerm.trim();
  const filtersActive = Boolean(query) || resultFilter !== 'all' || typeFilter !== 'all';
  const visibleRows = rows
    .map((r, i) => {
      const selected = new Set(r.selectedPins);
      const selectedCount = r.records.filter((rec) => selected.has(rec.pin)).length;
      const classifiedRecords = r.records.map((rec) => ({ rec, kind: classifyRecord(r.address, rec) }));
      const visibleClassifiedRecords = classifiedRecords.filter(({ rec, kind }) =>
        matchesResultFilter(kind, selected.has(rec.pin), resultFilter) &&
        (typeFilter === 'all' || rec.type === typeFilter) &&
        matchesSearch(recordSearchText(r.address, rec, kind), query),
      );
      const matchCounts = countMatches(classifiedRecords.map((x) => x.kind));
      const noFilterActive = resultFilter === 'all' && typeFilter === 'all';
      const rowMatches = r.status === 'done'
        ? (r.records.length === 0
          ? noFilterActive && matchesSearch(`${r.address} 결과 없음`, query)
          : visibleClassifiedRecords.length > 0)
        : noFilterActive && matchesSearch(`${r.address} ${r.error ?? ''} ${r.status}`, query);
      const expanded = filtersActive || (expandedRows[i] ?? false);

      return {
        row: r,
        index: i,
        selected,
        selectedCount,
        classifiedRecords,
        visibleClassifiedRecords,
        matchCounts,
        expanded,
        visible: rowMatches,
      };
    })
    .filter((item) => item.visible);

  function clearFilters() {
    setSearchTerm('');
    setResultFilter('all');
    setTypeFilter('all');
  }

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <div className="title-row">
            <h1>부동산고유번호 조회</h1>
            <a
              className="guide-link"
              href="https://merciful-situation-70f.notion.site/4-39632a11691780318f21f3303af62f52"
              target="_blank"
              rel="noreferrer"
            >
              4종세트 일괄다운로드 방법
            </a>
          </div>
          <p className="sub">주소를 줄바꿈으로 여러 건 입력하세요. 시·도 없이 주소만 넣어도 됩니다.</p>
        </div>
        <div className="top-actions">
          <button
            className="dl"
            onClick={onDownload}
            disabled={!exportRecords.length || running || downloading}
            title={running ? '전체 조회가 끝난 뒤 엑셀 다운로드를 사용할 수 있습니다.' : undefined}
          >
            {running
              ? '조회 완료 후 다운로드'
              : downloading
                ? '생성 중…'
                : `엑셀 다운로드 (${exportRecords.length}건 · ${nBatch}개 batch${nBatch > 1 ? ' zip' : ''})`}
          </button>
          <button
            className="dl trade"
            onClick={onTradeDownload}
            disabled={!allBuildingRecords.length || running || tradeLoading || tradeDownloading || Boolean(tradeDownloadingKey) || Boolean(tradePdfPrintingKey)}
            title={running ? '전체 조회가 끝난 뒤 실거래가 엑셀을 사용할 수 있습니다.' : '조회된 전체 건물의 실거래가 엑셀을 건별로 만들어 ZIP으로 저장합니다.'}
          >
            {running
              ? '조회 완료 후 다운로드'
              : tradeLoading
                ? '실거래가 조회 중…'
                : tradeDownloading
                  ? '생성 중…'
                  : `실거래가 ZIP (${allBuildingRecords.length}건)`}
          </button>
          <button
            className="dl trade-pdf"
            onClick={onTradePdf}
            disabled={!allBuildingRecords.length || running || tradeLoading || tradeDownloading || Boolean(tradeDownloadingKey) || Boolean(tradePdfPrintingKey)}
            title="조회된 전체 건물의 실거래가를 PDF 출력 문서로 엽니다."
          >
            {tradePdfPrintingKey === 'bulk' ? 'PDF 생성 중…' : `실거래가 PDF (${allBuildingRecords.length}건)`}
          </button>
          <button
            className="dl eum"
            onClick={onEumPrint}
            disabled={!selectedLandRecords.length || selectedLandRecords.length > 50 || running || Boolean(eumPrintingKey) || landLoading}
            title={
              selectedLandRecords.length > 50
                ? '한 번에 최대 50필지까지 인쇄할 수 있습니다.'
                : running
                  ? '전체 조회가 끝난 뒤 토지이용계획 인쇄를 사용할 수 있습니다.'
                : '체크된 토지의 토지이용계획 부분인쇄 문서를 하나로 합칩니다.'
            }
          >
            {running
              ? '조회 완료 후 인쇄'
              : landLoading
              ? '토지정보 조회 중…'
              : eumPrintingKey === 'bulk'
                ? '생성 중…'
                : `토지이용계획 인쇄 (${selectedLandRecords.length}필지)`}
          </button>
          <button
            className="dl land"
            onClick={onLandDownload}
            disabled={!selectedLands.length || landDownloading || landLoading}
            title="선택한 토지의 공시지가+토지등급을 하나의 PDF로"
          >
            {landLoading ? '토지정보 조회 중…' : landDownloading ? '생성 중…' : `토지 다운로드 (${selectedLands.length}필지 PDF)`}
          </button>
        </div>
      </header>

      <div className="form">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={'서울특별시 송파구 석촌동 265-5\n서울특별시 서초구 반포동 20-1\n...'}
          rows={5}
        />
        <button className="go" onClick={onCollect} disabled={running}>
          {running ? `조회 중… (${done}/${rows.length})` : '조회'}
        </button>
      </div>

      {rows.length > 0 && (
        <div className="filters">
          <input
            className="filter-search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="주소, 도로명, 고유번호, 동/호"
          />
          <div className="filter-segments" role="group" aria-label="유형 필터">
            {TYPE_FILTER_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={typeFilter === option.value ? 'active' : undefined}
                onClick={() => setTypeFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="filter-segments" role="group" aria-label="결과 필터">
            {FILTER_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={resultFilter === option.value ? 'active' : undefined}
                onClick={() => setResultFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button type="button" className="filter-reset" onClick={clearFilters} disabled={!filtersActive}>
            초기화
          </button>
        </div>
      )}

      <div className="results">
        {visibleRows.length === 0 && rows.length > 0 && (
          <div className="empty-filter">조건에 맞는 결과가 없습니다.</div>
        )}

        {visibleRows.map(({ row: r, index: i, selected, selectedCount, visibleClassifiedRecords, matchCounts, expanded }) => {
          return (
            <section key={i} className={`card ${r.status} ${expanded ? 'expanded' : 'collapsed'}`}>
              <button
                type="button"
                className="card-head"
                onClick={() => toggleExpanded(i)}
                aria-expanded={expanded}
                aria-controls={`result-panel-${i}`}
              >
                <div className="head-main">
                  <span className="addr">{r.address}</span>
                  {r.status === 'done' && r.records.length > 0 && (
                    <span className="select-summary">선택 {selectedCount}/{r.records.length}건</span>
                  )}
                  {r.status === 'done' && r.records.length > 0 && (
                    <span className="match-counts">
                      {MATCH_ORDER.filter((kind) => matchCounts[kind] > 0).map((kind) => (
                        <span key={kind} className={`match-count ${kind}`}>
                          {MATCH_LABELS[kind]} {matchCounts[kind]}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <span className="head-side">
                  <span className={`badge ${r.status}`}>
                    {r.status === 'pending' && '대기'}
                    {r.status === 'loading' && '조회 중…'}
                    {r.status === 'done' && `${r.records.length}건`}
                    {r.status === 'error' && '실패'}
                  </span>
                  <span className="chevron" aria-hidden="true" />
                </span>
              </button>

              {expanded && (
                <div id={`result-panel-${i}`} className="card-panel">
                  {r.status === 'error' && <div className="err-msg">{r.error}</div>}

                  {r.status === 'done' && r.records.length === 0 && <div className="err-msg">결과 없음</div>}

                  {r.status === 'done' && r.records.length > 0 && (
                    <>
                      <div className="record-toolbar">
                        <span>정확·관련 결과가 기본 선택됩니다.</span>
                        <div className="record-actions">
                          <button type="button" onClick={() => selectSuggested(i)}>정확·관련 선택</button>
                          <button type="button" onClick={() => selectAll(i)}>전체선택</button>
                          <button type="button" onClick={() => clearSelection(i)}>전체해제</button>
                        </div>
                      </div>

                      <div className="table-wrap">
                        <table className="records-table">
                          <thead>
                            <tr>
                              <th className="check-col">선택</th>
                              <th>매칭</th>
                              <th>고유번호</th>
                              <th>유형</th>
                              <th>부동산표시</th>
                              <th>공시지가</th>
                              <th>토지등급</th>
                              <th>토지이용계획</th>
                              <th>상가/오피스 기준시가</th>
                              <th>실거래가</th>
                            </tr>
                          </thead>
                          <tbody>
                            {visibleClassifiedRecords.map(({ rec, kind }) => {
                              const checked = selected.has(rec.pin);
                              return (
                                <tr key={rec.pin} className={checked ? 'selected-row' : undefined}>
                                  <td className="check-col">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => togglePin(i, rec.pin)}
                                      aria-label={`${rec.pinFmt} 선택`}
                                    />
                                  </td>
                                  <td><span className={`match ${kind}`}>{MATCH_LABELS[kind]}</span></td>
                                  <td className="pin">{rec.pinFmt}</td>
                                  <td>{rec.type}</td>
                                  <td className="addr-cell">
                                    <div>{rec.address}</div>
                                    {(rec.roadAddr || rec.floor || rec.room) && (
                                      <div className="record-meta">
                                        {[rec.roadAddr, rec.floor && `${rec.floor}층`, rec.room && `${rec.room}호`]
                                          .filter(Boolean)
                                          .join(' · ')}
                                      </div>
                                    )}
                                  </td>
                                  {(() => {
                                    if (rec.type !== '토지') {
                                      return (
                                        <>
                                          <td className="land-cell">-</td>
                                          <td className="land-cell">-</td>
                                          <td className="eum-cell">-</td>
                                          <td className="commercial-price-cell">{renderCommercialPriceCell(rec)}</td>
                                          <td className="trade-cell">{renderTradeCell(rec)}</td>
                                        </>
                                      );
                                    }
                                    const li = landInfo[rec.pin];
                                    if (!li) return (
                                      <>
                                        <td className="land-cell">{landLoading ? '조회 중…' : '-'}</td>
                                        <td className="land-cell">{landLoading ? '조회 중…' : '-'}</td>
                                        <td className="eum-cell">{renderEumAction(rec)}</td>
                                        <td className="commercial-price-cell">-</td>
                                        <td className="trade-cell">-</td>
                                      </>
                                    );
                                    const jiga = li.jiga[0];
                                    const grade = li.grade[0];
                                    return (
                                      <>
                                        <td className="land-cell num">
                                          {jiga ? <><strong>{won(jiga.price)}</strong><span className="land-sub">{jiga.year}년</span></> : '없음'}
                                        </td>
                                        <td className="land-cell">
                                          {grade ? <><strong>{grade.grade}</strong><span className="land-sub">{grade.changeDate}</span></> : '없음'}
                                        </td>
                                        <td className="eum-cell">{renderEumAction(rec)}</td>
                                        <td className="commercial-price-cell">-</td>
                                        <td className="trade-cell">-</td>
                                      </>
                                    );
                                  })()}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}
