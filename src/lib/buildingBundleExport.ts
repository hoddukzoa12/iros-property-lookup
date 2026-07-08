import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import type {
  ApartmentOfficialPriceInfo,
  BuildingTradeInfo,
  BuildingTradeItem,
  CommercialPriceInfo,
  CommercialPriceItem,
  IndividualHousePriceInfo,
  PropertyRecord,
  RealtyPriceInfo,
} from '../../shared/types';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface BuildingBundleSources {
  realtyPriceInfo: Record<string, RealtyPriceInfo>;
  commercialPriceInfo: Record<string, CommercialPriceInfo>;
  tradeInfo: Record<string, BuildingTradeInfo>;
}

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

function safeFilename(value: string, fallback: string) {
  const safe = value
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
  return safe || fallback;
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function numberValue(value: number | null) {
  return value == null ? '' : value;
}

function numberLabel(value: number | null, maximumFractionDigits = 0) {
  return value == null ? '' : value.toLocaleString('ko-KR', { maximumFractionDigits });
}

function tradeArea(item: BuildingTradeItem) {
  return item.area || item.totalFloorArea || item.plottageArea || item.landArea;
}

function tradeDong(item: BuildingTradeItem) {
  return item.raw.aptDong || item.raw.bldgDong || '';
}

function dealMonth(value: string) {
  return value ? value.slice(0, 7) : '';
}

function dealDay(value: string) {
  return value ? value.slice(8, 10) : '';
}

function cancelType(item: BuildingTradeItem) {
  return item.raw.cdealType === 'O' ? '해제' : '-';
}

function dash(value: string) {
  return value || '-';
}

function setCols(ws: XLSX.WorkSheet, widths: number[]) {
  ws['!cols'] = widths.map((wch) => ({ wch }));
}

function formatCells(ws: XLSX.WorkSheet, cells: string[], format: string) {
  for (const addr of cells) {
    const cell = ws[addr];
    if (cell && typeof cell.v === 'number') cell.z = format;
  }
}

function appendAoaSheet(wb: XLSX.WorkBook, name: string, rows: unknown[][], widths: number[]) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  setCols(ws, widths);
  XLSX.utils.book_append_sheet(wb, ws, name);
  return ws;
}

function apartmentRows(record: PropertyRecord, info: ApartmentOfficialPriceInfo) {
  return [
    ['공동주택 공시가격', '', '', '', '', ''],
    [`물건소재지: ${info.detailAddress || record.address}`, '', '', '', '', ''],
    ['공시기준', '단지명', '동명', '호명', '전용면적(㎡)', '공동주택가격(원)'],
    ...info.items.map((item) => [
      item.baseDate,
      item.complexName,
      item.dongName,
      item.roomName,
      numberValue(item.exclusiveArea),
      numberValue(item.price),
    ]),
  ];
}

function individualRows(info: IndividualHousePriceInfo) {
  return [
    ['개별주택가격', '', '', '', '', '', ''],
    [`열람지역 : ${info.items[0]?.address || info.address}`, '', '', '', '', '', ''],
    ['가격기준연도(기준일)', '주택소재지', '대지면적 전체(㎡)', '대지면적 산정(㎡)', '건물연면적 전체(㎡)', '건물연면적 산정(㎡)', '개별주택가격(원)'],
    ...info.items.map((item) => [
      item.baseDate,
      item.address,
      numberValue(item.landAreaTotal),
      numberValue(item.landAreaCalculated),
      numberValue(item.buildingAreaTotal),
      numberValue(item.buildingAreaCalculated),
      numberValue(item.price),
    ]),
  ];
}

function commercialRows(record: PropertyRecord, info: CommercialPriceInfo) {
  return [
    ['기준시가(상업용 건물/오피스텔)', '', '', ''],
    ['입력주소', info.address || record.address, '', ''],
    ['상세주소', info.detailAddress || '', '', ''],
    ['고시일자', '구분', '단위면적당(㎡) 기준시가(원)', '건물면적(㎡)'],
    ...info.items.map((item: CommercialPriceItem) => [
      item.noticeDate,
      item.kind,
      numberValue(item.unitPrice),
      numberValue(item.buildingArea),
    ]),
  ];
}

function tradeRows(info: BuildingTradeInfo) {
  return [
    ['유형', '계약년월', '계약일', '전용면적(㎡)', '해제여부', '해제사유발생일', '등기일자', '거래금액(만원)', '동', '층', '매수자', '매도자', '거래유형', '중개사소재지'],
    ...info.items.map((item) => [
      item.sourceLabel,
      dealMonth(item.dealDate),
      dealDay(item.dealDate),
      tradeArea(item),
      cancelType(item),
      dash(item.raw.cdealDay),
      dash(item.rgstDate),
      numberValue(item.dealAmountManwon),
      dash(tradeDong(item)),
      dash(item.floor),
      dash(item.buyerGbn),
      dash(item.sellerGbn),
      dash(item.dealingGbn),
      dash(item.estateAgentSggNm),
    ]),
  ];
}

export function hasBuildingBundleData(record: PropertyRecord, sources: BuildingBundleSources) {
  const realty = sources.realtyPriceInfo[record.pin];
  return Boolean(
    realty?.apartment.items.length ||
    realty?.individual.items.length ||
    sources.commercialPriceInfo[record.pin]?.items.length ||
    sources.tradeInfo[record.pin]?.items.length,
  );
}

export function buildingBundleFilename(record: PropertyRecord, ext: 'xlsx' | 'pdf') {
  return `${safeFilename(record.address, record.pinFmt || record.pin || '건물자료')}_통합자료.${ext}`;
}

function buildBuildingBundleWorkbookBuffer(record: PropertyRecord, sources: BuildingBundleSources) {
  const realty = sources.realtyPriceInfo[record.pin];
  const commercial = sources.commercialPriceInfo[record.pin];
  const trade = sources.tradeInfo[record.pin];
  const wb = XLSX.utils.book_new();

  if (realty?.apartment.items.length) {
    const ws = appendAoaSheet(wb, '공동주택가격', apartmentRows(record, realty.apartment), [13, 28, 10, 10, 14, 18]);
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 5 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 5 } },
    ];
    formatCells(ws, realty.apartment.items.map((_, idx) => `E${idx + 4}`), '#,##0.###');
    formatCells(ws, realty.apartment.items.map((_, idx) => `F${idx + 4}`), '#,##0');
  }

  if (realty?.individual.items.length) {
    const ws = appendAoaSheet(wb, '개별주택가격', individualRows(realty.individual), [18, 34, 16, 16, 18, 18, 18]);
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 6 } },
    ];
    formatCells(ws, realty.individual.items.flatMap((_, idx) => [`C${idx + 4}`, `D${idx + 4}`, `E${idx + 4}`, `F${idx + 4}`]), '#,##0.###');
    formatCells(ws, realty.individual.items.map((_, idx) => `G${idx + 4}`), '#,##0');
  }

  if (commercial?.items.length) {
    const ws = appendAoaSheet(wb, '상가오피스 기준시가', commercialRows(record, commercial), [16, 14, 28, 16]);
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
      { s: { r: 1, c: 1 }, e: { r: 1, c: 3 } },
      { s: { r: 2, c: 1 }, e: { r: 2, c: 3 } },
    ];
    formatCells(ws, commercial.items.map((_, idx) => `C${idx + 5}`), '#,##0');
    formatCells(ws, commercial.items.map((_, idx) => `D${idx + 5}`), '#,##0.###');
  }

  if (trade?.items.length) {
    const ws = appendAoaSheet(wb, '실거래가', tradeRows(trade), [12, 12, 8, 14, 10, 14, 12, 16, 10, 8, 10, 10, 12, 18]);
    formatCells(ws, trade.items.map((_, idx) => `H${idx + 2}`), '#,##0');
  }

  if (!wb.SheetNames.length) return null;

  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}

export function downloadBuildingBundleWorkbook(
  record: PropertyRecord,
  sources: BuildingBundleSources,
  filename = buildingBundleFilename(record, 'xlsx'),
) {
  const buf = buildBuildingBundleWorkbookBuffer(record, sources);
  if (!buf) return false;

  triggerDownload(new Blob([buf], { type: XLSX_MIME }), filename);
  return true;
}

export async function downloadBuildingBundleZip(
  records: PropertyRecord[],
  sources: BuildingBundleSources,
  filename = '건물_통합자료.zip',
) {
  const zip = new JSZip();
  const used = new Set<string>();
  let fileCount = 0;

  for (const record of records) {
    const buf = buildBuildingBundleWorkbookBuffer(record, sources);
    if (!buf) continue;
    zip.file(uniqueFilename(buildingBundleFilename(record, 'xlsx'), used), buf);
    fileCount += 1;
  }

  if (!fileCount) return false;

  const blob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(blob, filename);
  return true;
}

function apartmentPage(record: PropertyRecord, info: ApartmentOfficialPriceInfo) {
  if (!info.items.length) return '';
  return `<article class="bundle-page apartment">
    <h1>공동주택 공시가격</h1>
    <p class="subject">물건소재지: ${escapeHtml(info.detailAddress || record.address)}</p>
    <table><thead><tr>
      <th>공시기준</th><th>단지명</th><th>동명</th><th>호명</th><th>전용면적(㎡)</th><th>공동주택가격(원)</th>
    </tr></thead><tbody>
      ${info.items.map((item) => `<tr>
        <td>${escapeHtml(item.baseDate)}</td>
        <td>${escapeHtml(item.complexName)}</td>
        <td>${escapeHtml(item.dongName)}</td>
        <td>${escapeHtml(item.roomName)}</td>
        <td class="num">${escapeHtml(numberLabel(item.exclusiveArea, 3))}</td>
        <td class="num">${escapeHtml(numberLabel(item.price))}</td>
      </tr>`).join('')}
    </tbody></table>
  </article>`;
}

function individualPage(record: PropertyRecord, info: IndividualHousePriceInfo) {
  if (!info.items.length) return '';
  const region = info.items[0]?.address || record.address;
  return `<article class="bundle-page individual">
    <h1>개별주택가격</h1>
    <p class="subject">열람지역 : ${escapeHtml(region)}</p>
    <table><thead><tr>
      <th>가격기준연도<br>(기준일)</th><th>주택소재지</th><th>대지면적(㎡)<br>전체</th><th>대지면적(㎡)<br>산정</th><th>건물연면적(㎡)<br>전체</th><th>건물연면적(㎡)<br>산정</th><th>개별주택가격<br>(원)</th>
    </tr></thead><tbody>
      ${info.items.map((item) => `<tr>
        <td>${escapeHtml(item.baseDate)}</td>
        <td class="addr">${escapeHtml(item.address)}</td>
        <td class="num">${escapeHtml(numberLabel(item.landAreaTotal, 3))}</td>
        <td class="num">${escapeHtml(numberLabel(item.landAreaCalculated, 3))}</td>
        <td class="num">${escapeHtml(numberLabel(item.buildingAreaTotal, 3))}</td>
        <td class="num">${escapeHtml(numberLabel(item.buildingAreaCalculated, 3))}</td>
        <td class="num">${escapeHtml(numberLabel(item.price))}</td>
      </tr>`).join('')}
    </tbody></table>
  </article>`;
}

function commercialPage(record: PropertyRecord, info: CommercialPriceInfo) {
  if (!info.items.length) return '';
  return `<article class="bundle-page commercial">
    <h1>기준시가(상업용 건물/오피스텔)</h1>
    <p class="subject">입력주소: ${escapeHtml(info.address || record.address)}<br>상세주소: ${escapeHtml(info.detailAddress)}</p>
    <table><thead><tr><th>고시일자</th><th>구분</th><th>단위면적당(㎡) 기준시가(원)</th><th>건물면적(㎡)</th></tr></thead><tbody>
      ${info.items.map((item) => `<tr>
        <td>${escapeHtml(item.noticeDate)}</td>
        <td>${escapeHtml(item.kind)}</td>
        <td class="num">${escapeHtml(numberLabel(item.unitPrice))}</td>
        <td class="num">${escapeHtml(numberLabel(item.buildingArea, 3))}</td>
      </tr>`).join('')}
    </tbody></table>
  </article>`;
}

function tradePage(record: PropertyRecord, info: BuildingTradeInfo) {
  if (!info.items.length) return '';
  return `<article class="bundle-page trade">
    <h1>실거래가 공개시스템</h1>
    <p class="subject">${escapeHtml(record.address)} · 최근 1년</p>
    <table><thead><tr>
      <th>유형</th><th>계약년월</th><th>계약일</th><th>전용면적<br>(㎡)</th><th>해제</th><th>등기일자</th><th>거래금액<br>(만원)</th><th>동</th><th>층</th><th>거래유형<br>중개사</th>
    </tr></thead><tbody>
      ${info.items.map((item) => `<tr>
        <td>${escapeHtml(item.sourceLabel)}</td>
        <td>${escapeHtml(dealMonth(item.dealDate))}</td>
        <td>${escapeHtml(dealDay(item.dealDate))}</td>
        <td class="num">${escapeHtml(tradeArea(item))}</td>
        <td>${escapeHtml(cancelType(item))}</td>
        <td>${escapeHtml(dash(item.rgstDate))}</td>
        <td class="num">${escapeHtml(numberLabel(item.dealAmountManwon))}</td>
        <td>${escapeHtml(dash(tradeDong(item)))}</td>
        <td>${escapeHtml(dash(item.floor))}</td>
        <td>${escapeHtml(dash(item.dealingGbn))}<br>${escapeHtml(dash(item.estateAgentSggNm))}</td>
      </tr>`).join('')}
    </tbody></table>
  </article>`;
}

function buildPdfPages(record: PropertyRecord, sources: BuildingBundleSources) {
  const realty = sources.realtyPriceInfo[record.pin];
  return [
    realty ? apartmentPage(record, realty.apartment) : '',
    realty ? individualPage(record, realty.individual) : '',
    sources.commercialPriceInfo[record.pin] ? commercialPage(record, sources.commercialPriceInfo[record.pin]) : '',
    sources.tradeInfo[record.pin] ? tradePage(record, sources.tradeInfo[record.pin]) : '',
  ].filter(Boolean).join('');
}

function buildPdfHtml(records: PropertyRecord[], sources: BuildingBundleSources) {
  const body = records.map((record) => buildPdfPages(record, sources)).filter(Boolean).join('');

  if (!body) return '';

  const title = records.length === 1 ? buildingBundleFilename(records[0], 'pdf') : '건물_통합자료.pdf';

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #fff; color: #111827; font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; }
    @page { size: A4; margin: 13mm; }
    .bundle-page { break-after: page; page-break-after: always; }
    .bundle-page:last-child { break-after: auto; page-break-after: auto; }
    h1 { margin: 0 0 18px; text-align: center; font-size: 18px; font-weight: 900; }
    .subject { margin: 0 0 12px; font-size: 12px; font-weight: 700; line-height: 1.45; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; border-top: 2px solid #111827; }
    th, td { border: 1px solid #d7dce5; padding: 5px 4px; text-align: center; vertical-align: middle; font-size: 9.5px; line-height: 1.35; word-break: keep-all; }
    th { background: #f8fafc; font-weight: 900; color: #111827; }
    td.addr { text-align: left; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    @media screen {
      body { background: #f3f4f6; padding: 24px 0; }
      .bundle-page { width: 794px; min-height: 1123px; margin: 0 auto 24px; padding: 46px 38px; background: #fff; box-shadow: 0 12px 36px rgba(15, 23, 42, 0.12); }
    }
    @media print {
      body { background: #fff; }
      .bundle-page { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
    }
  </style></head><body>${body}</body></html>`;
}

export function printBuildingBundlePdf(records: PropertyRecord[] | PropertyRecord, sources: BuildingBundleSources) {
  const recordList = Array.isArray(records) ? records : [records];
  const html = buildPdfHtml(recordList, sources);
  if (!html) return false;

  const w = window.open('', '_blank');
  if (!w) {
    alert('팝업이 차단되었습니다. 팝업 허용 후 다시 시도해 주세요.');
    return true;
  }

  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();

  const trigger = () => setTimeout(() => w.print(), 350);
  if (w.document.readyState === 'complete') trigger();
  else w.onload = trigger;
  return true;
}
