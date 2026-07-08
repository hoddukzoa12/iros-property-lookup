import * as XLSX from 'xlsx';
import type { CommercialPriceInfo, CommercialPriceItem, PropertyRecord } from '../../shared/types';

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

function priceLabel(value: number | null) {
  return value == null ? '' : value;
}

function areaLabel(item: CommercialPriceItem) {
  return item.buildingArea ?? '';
}

export function commercialPriceFilename(record: PropertyRecord) {
  return `${safeFilename(record.address, record.pinFmt || record.pin || '상가오피스_기준시가')}_상가오피스_기준시가.xlsx`;
}

function buildCommercialPriceWorkbookBuffer(record: PropertyRecord, info: CommercialPriceInfo): ArrayBuffer | null {
  if (!info.items.length) return null;

  const rows: (string | number)[][] = [
    ['기준시가(상업용 건물/오피스텔)', '', '', ''],
    ['상세주소', '', '', ''],
    ['입력주소', info.address || record.address, '', ''],
    ['상세주소', info.detailAddress || '', '', ''],
    ['기준시가', '', '', ''],
    ['고시일자', '', '단위면적당(㎡) 기준시가(원)', '건물면적(㎡)'],
    ...info.items.map((item) => [
      item.noticeDate,
      '',
      priceLabel(item.unitPrice),
      areaLabel(item),
    ]),
    [
      '※ 상가 등의 호별기준시가 = 단위면적(㎡) 기준시가 * 건물면적(전유면적 + 공용면적)\n※ 상가 호실의 분할, 합병 등 상세한 정보는 건축물대장으로 확인하시기 바랍니다.',
      '',
      '',
      '',
    ],
  ];

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const lastDataRow = 6 + info.items.length;
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
    { s: { r: 2, c: 1 }, e: { r: 2, c: 3 } },
    { s: { r: 3, c: 1 }, e: { r: 3, c: 3 } },
    { s: { r: 4, c: 1 }, e: { r: 4, c: 3 } },
    { s: { r: 5, c: 0 }, e: { r: 5, c: 1 } },
    ...info.items.map((_, idx) => ({ s: { r: 6 + idx, c: 0 }, e: { r: 6 + idx, c: 1 } })),
    { s: { r: lastDataRow, c: 0 }, e: { r: lastDataRow, c: 3 } },
  ];
  ws['!cols'] = [{ wch: 16 }, { wch: 8 }, { wch: 28 }, { wch: 16 }];

  for (let i = 0; i < info.items.length; i++) {
    const priceCell = ws[`C${i + 7}`];
    const areaCell = ws[`D${i + 7}`];
    if (priceCell && typeof priceCell.v === 'number') priceCell.z = '#,##0';
    if (areaCell && typeof areaCell.v === 'number') areaCell.z = '#,##0.###';
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Page 1');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}

export function downloadCommercialPriceWorkbook(
  record: PropertyRecord,
  infoByPin: Record<string, CommercialPriceInfo>,
  filename = commercialPriceFilename(record),
): boolean {
  const info = infoByPin[record.pin];
  if (!info) return false;

  const buf = buildCommercialPriceWorkbookBuffer(record, info);
  if (!buf) return false;

  triggerDownload(new Blob([buf], { type: XLSX_MIME }), filename);
  return true;
}
