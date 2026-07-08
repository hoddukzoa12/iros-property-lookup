import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import type {
  BuildingTradeInfo,
  BuildingTradeItem,
  BuildingTradeSource,
  PropertyRecord,
} from '../../shared/types';

const SOURCE_LABELS: Record<BuildingTradeSource, string> = {
  apt: '아파트',
  single: '단독다가구',
  rowhouse: '연립다세대',
  officetel: '오피스텔',
};

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const ITEM_HEADERS = [
  '계약년월',
  '계약일',
  '전용면적(㎡)',
  '해제여부',
  '해제사유발생일',
  '등기일자',
  '거래금액(만원)',
  '동',
  '층',
  '매수자',
  '매도자',
  '거래유형',
  '중개사소재지',
];

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function amountLabel(value: number | null) {
  return value == null ? '' : value;
}

function dash(value: string) {
  return value || '-';
}

function dealMonth(value: string) {
  return value ? value.slice(0, 7) : '';
}

function dealDay(value: string) {
  return value ? value.slice(8, 10) : '';
}

function tradeArea(item: BuildingTradeItem) {
  return item.area || item.totalFloorArea || item.plottageArea || item.landArea;
}

function tradeDong(item: BuildingTradeItem) {
  return item.raw.aptDong || item.raw.bldgDong || '';
}

function cancelType(item: BuildingTradeItem) {
  return item.raw.cdealType === 'O' ? '해제' : '-';
}

function safeFilename(value: string, fallback: string) {
  const safe = value
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
  return safe || fallback;
}

function uniqueFilename(filename: string, used: Set<string>) {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  let next = filename;
  let count = 2;

  while (used.has(next)) {
    next = `${stem} (${count})${ext}`;
    count += 1;
  }

  used.add(next);
  return next;
}

export function tradeWorkbookFilename(record: PropertyRecord) {
  return `${safeFilename(record.address, record.pinFmt || record.pin || '실거래가')}.xlsx`;
}

function itemRows(
  source: BuildingTradeSource,
  records: PropertyRecord[],
  tradeInfoByPin: Record<string, BuildingTradeInfo>,
) {
  const rows: Record<string, unknown>[] = [];

  for (const record of records) {
    const info = tradeInfoByPin[record.pin];
    const items = (info?.items ?? []).filter((item) => item.source === source);

    for (const item of items) {
      rows.push({
        계약년월: dealMonth(item.dealDate),
        계약일: dealDay(item.dealDate),
        '전용면적(㎡)': tradeArea(item),
        해제여부: cancelType(item),
        해제사유발생일: dash(item.raw.cdealDay),
        등기일자: dash(item.rgstDate),
        '거래금액(만원)': amountLabel(item.dealAmountManwon),
        동: dash(tradeDong(item)),
        층: dash(item.floor),
        매수자: dash(item.buyerGbn),
        매도자: dash(item.sellerGbn),
        거래유형: dash(item.dealingGbn),
        중개사소재지: dash(item.estateAgentSggNm),
      });
    }
  }

  return rows;
}

function buildSheet(rows: Record<string, unknown>[], headers: string[]) {
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  ws['!cols'] = headers.map((header) => {
    if (/주소/.test(header)) return { wch: 34 };
    if (/고유번호|거래금액|건물명|중개사/.test(header)) return { wch: 18 };
    if (/PNU/.test(header)) return { wch: 22 };
    return { wch: 12 };
  });
  return ws;
}

function buildTradeWorkbookBuffer(
  records: PropertyRecord[],
  tradeInfoByPin: Record<string, BuildingTradeInfo>,
): ArrayBuffer | null {
  if (!records.length) return null;

  const wb = XLSX.utils.book_new();

  (Object.keys(SOURCE_LABELS) as BuildingTradeSource[]).forEach((source) => {
    const rows = itemRows(source, records, tradeInfoByPin);
    if (!rows.length) return;

    XLSX.utils.book_append_sheet(
      wb,
      buildSheet(rows, ITEM_HEADERS),
      SOURCE_LABELS[source],
    );
  });

  if (!wb.SheetNames.length) return null;

  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}

export function downloadTradeWorkbook(
  records: PropertyRecord[],
  tradeInfoByPin: Record<string, BuildingTradeInfo>,
  filename = records.length === 1 ? tradeWorkbookFilename(records[0]) : '실거래가_조회결과.xlsx',
): boolean {
  const buf = buildTradeWorkbookBuffer(records, tradeInfoByPin);
  if (!buf) return false;

  triggerDownload(
    new Blob([buf], { type: XLSX_MIME }),
    filename,
  );
  return true;
}

export async function downloadTradeZip(
  records: PropertyRecord[],
  tradeInfoByPin: Record<string, BuildingTradeInfo>,
  filename = '실거래가_조회결과.zip',
): Promise<boolean> {
  const zip = new JSZip();
  const used = new Set<string>();
  let fileCount = 0;

  for (const record of records) {
    const buf = buildTradeWorkbookBuffer([record], tradeInfoByPin);
    if (!buf) continue;
    zip.file(uniqueFilename(tradeWorkbookFilename(record), used), buf);
    fileCount += 1;
  }

  if (!fileCount) return false;

  const blob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(blob, filename);
  return true;
}
