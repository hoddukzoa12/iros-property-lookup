import type {
  BuildingTradeInfo,
  BuildingTradeItem,
  BuildingTradeSource,
  PropertyRecord,
} from '../../shared/types';

type ExportTradeSource = Exclude<BuildingTradeSource, 'single'>;

const SOURCE_LABELS: Record<ExportTradeSource, string> = {
  apt: '아파트',
  rowhouse: '연립다세대',
  officetel: '오피스텔',
};

const EXPORT_SOURCES: ExportTradeSource[] = ['apt', 'rowhouse', 'officetel'];

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function dash(value: string) {
  return value || '-';
}

function dealMonth(value: string) {
  return value ? value.slice(0, 7) : '';
}

function monthLabel(value: string) {
  const month = Number(value.slice(5, 7));
  return Number.isFinite(month) && month > 0 ? `${month.toString().padStart(2, '0')}월` : '-';
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

function amountLabel(item: BuildingTradeItem) {
  return item.dealAmountManwon == null ? dash(item.dealAmount) : item.dealAmountManwon.toLocaleString('ko-KR');
}

function groupByMonth(items: BuildingTradeItem[]) {
  const groups = new Map<string, BuildingTradeItem[]>();
  for (const item of [...items].sort((a, b) => b.dealDate.localeCompare(a.dealDate))) {
    const month = dealMonth(item.dealDate);
    const rows = groups.get(month) ?? [];
    rows.push(item);
    groups.set(month, rows);
  }
  return Array.from(groups.entries());
}

function conditionRows(record: PropertyRecord, source: ExportTradeSource, items: BuildingTradeItem[]) {
  const first = items[0];
  const complexName = first?.buildingName || record.building || '-';
  return `<table class="conditions">
    <thead>
      <tr>
        <th>물건</th>
        <th>매매구분</th>
        <th>기준년월</th>
        <th>단지명</th>
        <th>소재지</th>
        <th>면적</th>
        <th>금액</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>${escapeHtml(SOURCE_LABELS[source])}</td>
        <td>매매</td>
        <td>최근 1년</td>
        <td>[${escapeHtml(SOURCE_LABELS[source])}] ${escapeHtml(complexName)}</td>
        <td>${escapeHtml(record.address)}</td>
        <td>--전체--</td>
        <td>--전체--</td>
      </tr>
    </tbody>
  </table>`;
}

function tradeTable(items: BuildingTradeItem[]) {
  return groupByMonth(items)
    .map(([month, rows]) => `<section class="month">
      <h2>${escapeHtml(monthLabel(month))}</h2>
      <table class="trades">
        <thead>
          <tr>
            <th>전용면적<br>(㎡)</th>
            <th>계약일</th>
            <th>해제<br>여부</th>
            <th>해제사유<br>발생일</th>
            <th>등기일자</th>
            <th>거래금액<br>(만원)</th>
            <th>동</th>
            <th>층</th>
            <th>매수자</th>
            <th>매도자</th>
            <th>거래유형<br>중개사 소재지</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((item) => `<tr>
            <td>${escapeHtml(tradeArea(item))}</td>
            <td>${escapeHtml(dealDay(item.dealDate))}</td>
            <td>${escapeHtml(cancelType(item))}</td>
            <td>${escapeHtml(dash(item.raw.cdealDay))}</td>
            <td>${escapeHtml(dash(item.rgstDate))}</td>
            <td class="amount">${escapeHtml(amountLabel(item))}</td>
            <td>${escapeHtml(dash(tradeDong(item)))}</td>
            <td>${escapeHtml(dash(item.floor))}</td>
            <td>${escapeHtml(dash(item.buyerGbn))}</td>
            <td>${escapeHtml(dash(item.sellerGbn))}</td>
            <td class="deal-type">
              <div>${escapeHtml(dash(item.dealingGbn))}</div>
              <div>${escapeHtml(dash(item.estateAgentSggNm))}</div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>`)
    .join('');
}

function sourceSections(record: PropertyRecord, info: BuildingTradeInfo) {
  return EXPORT_SOURCES
    .map((source) => {
      const items = info.items.filter((item) => item.source === source);
      if (!items.length) return '';
      return `<article class="trade-page">
        <header>
          <h1>실거래가 공개시스템</h1>
          <div class="stamp">[${escapeHtml(new Date().toLocaleString('ko-KR'))}]</div>
        </header>
        <h3>자료 검색조건</h3>
        ${conditionRows(record, source, items)}
        ${tradeTable(items)}
      </article>`;
    })
    .join('');
}

function buildHtml(records: PropertyRecord[], tradeInfoByPin: Record<string, BuildingTradeInfo>) {
  const body = records
    .map((record) => {
      const info = tradeInfoByPin[record.pin];
      return info?.items.length ? sourceSections(record, info) : '';
    })
    .filter(Boolean)
    .join('');

  if (!body) return '';

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>실거래가 출력</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; color: #111827; font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; background: #fff; }
    @page { size: A4; margin: 12mm; }
    .trade-page { break-after: page; page-break-after: always; padding: 0; }
    .trade-page:last-child { break-after: auto; page-break-after: auto; }
    header { position: relative; min-height: 54px; margin-bottom: 18px; }
    h1 { margin: 0; padding-top: 18px; text-align: center; font-size: 18px; font-weight: 900; }
    h3 { margin: 20px 0 12px; text-align: center; font-size: 14px; color: #17213b; }
    .stamp { position: absolute; right: 0; bottom: 4px; font-size: 12px; font-weight: 800; color: #17213b; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #e6eaff; padding: 5px 4px; text-align: center; vertical-align: middle; font-size: 10px; line-height: 1.35; }
    th { font-weight: 900; color: #111827; }
    .conditions { margin-bottom: 26px; border-top: 2px solid #5267ff; }
    .conditions th { background: #fff; }
    .conditions th:nth-child(4), .conditions td:nth-child(4) { width: 34%; }
    .conditions th:nth-child(5), .conditions td:nth-child(5) { width: 32%; }
    .month { margin-top: 26px; break-inside: avoid; page-break-inside: avoid; }
    .month h2 { margin: 0 0 8px; text-align: center; font-size: 16px; color: #17213b; }
    .trades { border-top: 2px solid #5267ff; }
    .trades th:nth-child(1) { width: 11%; }
    .trades th:nth-child(2), .trades th:nth-child(3), .trades th:nth-child(4), .trades th:nth-child(7), .trades th:nth-child(8), .trades th:nth-child(9), .trades th:nth-child(10) { width: 7.5%; }
    .trades th:nth-child(5), .trades th:nth-child(6) { width: 10%; }
    .trades th:nth-child(11) { width: 15%; }
    .amount { font-variant-numeric: tabular-nums; }
    .deal-type div + div { margin-top: 4px; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    @media screen {
      body { background: #f3f4f6; padding: 24px 0; }
      .trade-page { width: 794px; min-height: 1123px; margin: 0 auto 24px; padding: 42px; background: #fff; box-shadow: 0 12px 36px rgba(15, 23, 42, 0.12); }
    }
    @media print {
      body { background: #fff; }
      .trade-page { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
    }
  </style></head><body>${body}</body></html>`;
}

export function printTradePdf(records: PropertyRecord[], tradeInfoByPin: Record<string, BuildingTradeInfo>) {
  const html = buildHtml(records, tradeInfoByPin);
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
