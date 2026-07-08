import * as XLSX from 'xlsx';
import type {
  ApartmentOfficialPriceInfo,
  ApartmentOfficialPriceItem,
  IndividualHousePriceInfo,
  IndividualHousePriceItem,
  PropertyRecord,
  RealtyPriceInfo,
} from '../../shared/types';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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

function safeFilename(value: string, fallback: string) {
  const safe = value
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
  return safe || fallback;
}

function priceValue(value: number | null) {
  return value == null ? '' : value;
}

function areaValue(value: number | null) {
  return value == null ? '' : value;
}

function formatNumberCells(ws: XLSX.WorkSheet, range: string[]) {
  for (const addr of range) {
    const cell = ws[addr];
    if (cell && typeof cell.v === 'number') cell.z = '#,##0';
  }
}

function formatAreaCells(ws: XLSX.WorkSheet, range: string[]) {
  for (const addr of range) {
    const cell = ws[addr];
    if (cell && typeof cell.v === 'number') cell.z = '#,##0.###';
  }
}

export function apartmentPriceFilename(record: PropertyRecord) {
  return `${safeFilename(record.address, record.pinFmt || record.pin || '공동주택가격')}_공동주택가격.xlsx`;
}

export function individualPriceFilename(record: PropertyRecord) {
  return `${safeFilename(record.address, record.pinFmt || record.pin || '개별주택가격')}_개별주택가격.xlsx`;
}

function buildApartmentRows(record: PropertyRecord, info: ApartmentOfficialPriceInfo) {
  return [
    ['공동주택 공시가격', '', '', '', '', ''],
    [`물건소재지: ${info.detailAddress || record.address}`, '', '', '', '', ''],
    ['공시기준', '단지명', '동명', '호명', '전용면적(㎡)', '공동주택가격(원)'],
    ...info.items.map((item: ApartmentOfficialPriceItem) => [
      item.baseDate,
      item.complexName,
      item.dongName,
      item.roomName,
      areaValue(item.exclusiveArea),
      priceValue(item.price),
    ]),
  ];
}

function buildApartmentWorkbookBuffer(record: PropertyRecord, info: ApartmentOfficialPriceInfo): ArrayBuffer | null {
  if (!info.items.length) return null;
  const rows = buildApartmentRows(record, info);
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 5 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 5 } },
  ];
  ws['!cols'] = [
    { wch: 13 },
    { wch: 28 },
    { wch: 10 },
    { wch: 10 },
    { wch: 14 },
    { wch: 18 },
  ];
  formatAreaCells(ws, info.items.map((_, idx) => `E${idx + 4}`));
  formatNumberCells(ws, info.items.map((_, idx) => `F${idx + 4}`));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '공동주택가격');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}

function buildIndividualRows(info: IndividualHousePriceInfo) {
  return [
    ['개별주택가격', '', '', '', '', '', ''],
    [`열람지역 : ${info.items[0]?.address || info.address}`, '', '', '', '', '', ''],
    ['가격기준연도(기준일)', '주택소재지', '대지면적 전체(㎡)', '대지면적 산정(㎡)', '건물연면적 전체(㎡)', '건물연면적 산정(㎡)', '개별주택가격(원)'],
    ...info.items.map((item: IndividualHousePriceItem) => [
      item.baseDate,
      item.address,
      areaValue(item.landAreaTotal),
      areaValue(item.landAreaCalculated),
      areaValue(item.buildingAreaTotal),
      areaValue(item.buildingAreaCalculated),
      priceValue(item.price),
    ]),
  ];
}

function buildIndividualWorkbookBuffer(info: IndividualHousePriceInfo): ArrayBuffer | null {
  if (!info.items.length) return null;
  const rows = buildIndividualRows(info);
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 6 } },
  ];
  ws['!cols'] = [
    { wch: 18 },
    { wch: 34 },
    { wch: 16 },
    { wch: 16 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
  ];
  formatAreaCells(ws, info.items.flatMap((_, idx) => [`C${idx + 4}`, `D${idx + 4}`, `E${idx + 4}`, `F${idx + 4}`]));
  formatNumberCells(ws, info.items.map((_, idx) => `G${idx + 4}`));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '개별주택가격');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}

export function downloadApartmentPriceWorkbook(
  record: PropertyRecord,
  infoByPin: Record<string, RealtyPriceInfo>,
  filename = apartmentPriceFilename(record),
): boolean {
  const info = infoByPin[record.pin]?.apartment;
  if (!info) return false;

  const buf = buildApartmentWorkbookBuffer(record, info);
  if (!buf) return false;

  triggerDownload(new Blob([buf], { type: XLSX_MIME }), filename);
  return true;
}

export function downloadIndividualPriceWorkbook(
  record: PropertyRecord,
  infoByPin: Record<string, RealtyPriceInfo>,
  filename = individualPriceFilename(record),
): boolean {
  const info = infoByPin[record.pin]?.individual;
  if (!info) return false;

  const buf = buildIndividualWorkbookBuffer(info);
  if (!buf) return false;

  triggerDownload(new Blob([buf], { type: XLSX_MIME }), filename);
  return true;
}
