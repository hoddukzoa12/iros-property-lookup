import type {
  ApartmentOfficialPriceInfo,
  IndividualHousePriceInfo,
  PropertyRecord,
  RealtyPriceInfo,
} from '../../shared/types';

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function priceLabel(value: number | null) {
  return value == null ? '' : value.toLocaleString('ko-KR');
}

function areaLabel(value: number | null) {
  return value == null ? '' : value.toLocaleString('ko-KR', { maximumFractionDigits: 3 });
}

function buildApartmentPage(record: PropertyRecord, info: ApartmentOfficialPriceInfo) {
  if (!info.items.length) return '';
  return `<article class="price-page apartment">
    <h1>공동주택 공시가격</h1>
    <p class="subject">물건소재지: ${escapeHtml(info.detailAddress || record.address)}</p>
    <table>
      <thead>
        <tr>
          <th>공시기준</th>
          <th>단지명</th>
          <th>동명</th>
          <th>호명</th>
          <th>전용면적(㎡)</th>
          <th>공동주택가격(원)</th>
        </tr>
      </thead>
      <tbody>
        ${info.items.map((item) => `<tr>
          <td>${escapeHtml(item.baseDate)}</td>
          <td>${escapeHtml(item.complexName)}</td>
          <td>${escapeHtml(item.dongName)}</td>
          <td>${escapeHtml(item.roomName)}</td>
          <td class="num">${escapeHtml(areaLabel(item.exclusiveArea))}</td>
          <td class="num">${escapeHtml(priceLabel(item.price))}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </article>`;
}

function buildIndividualPage(record: PropertyRecord, info: IndividualHousePriceInfo) {
  if (!info.items.length) return '';
  const region = info.items[0]?.address || record.address;
  return `<article class="price-page individual">
    <h1>개별주택가격</h1>
    <p class="subject">열람지역 : ${escapeHtml(region)}</p>
    <table>
      <thead>
        <tr>
          <th>가격기준연도<br>(기준일)</th>
          <th>주택소재지</th>
          <th>대지면적(㎡)<br>전체</th>
          <th>대지면적(㎡)<br>산정</th>
          <th>건물연면적(㎡)<br>전체</th>
          <th>건물연면적(㎡)<br>산정</th>
          <th>개별주택가격<br>(원)</th>
        </tr>
      </thead>
      <tbody>
        ${info.items.map((item) => `<tr>
          <td>${escapeHtml(item.baseDate)}</td>
          <td class="addr">${escapeHtml(item.address)}</td>
          <td class="num">${escapeHtml(areaLabel(item.landAreaTotal))}</td>
          <td class="num">${escapeHtml(areaLabel(item.landAreaCalculated))}</td>
          <td class="num">${escapeHtml(areaLabel(item.buildingAreaTotal))}</td>
          <td class="num">${escapeHtml(areaLabel(item.buildingAreaCalculated))}</td>
          <td class="num">${escapeHtml(priceLabel(item.price))}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </article>`;
}

function buildHtml(title: string, body: string) {
  if (!body) return '';

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #fff; color: #111827; font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; }
    @page { size: A4; margin: 13mm; }
    .price-page { break-after: page; page-break-after: always; }
    .price-page:last-child { break-after: auto; page-break-after: auto; }
    h1 { margin: 0 0 18px; text-align: center; font-size: 19px; font-weight: 900; }
    .subject { margin: 0 0 12px; font-size: 13px; font-weight: 700; line-height: 1.45; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; border-top: 2px solid #111827; }
    th, td { border: 1px solid #d7dce5; padding: 6px 5px; text-align: center; vertical-align: middle; font-size: 10.5px; line-height: 1.35; }
    th { background: #f8fafc; font-weight: 900; color: #111827; }
    td.addr { text-align: left; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .apartment th:nth-child(1) { width: 13%; }
    .apartment th:nth-child(2) { width: 27%; }
    .apartment th:nth-child(3), .apartment th:nth-child(4) { width: 10%; }
    .apartment th:nth-child(5) { width: 17%; }
    .apartment th:nth-child(6) { width: 23%; }
    .individual th:nth-child(1) { width: 15%; }
    .individual th:nth-child(2) { width: 28%; }
    .individual th:nth-child(3), .individual th:nth-child(4), .individual th:nth-child(5), .individual th:nth-child(6) { width: 11%; }
    .individual th:nth-child(7) { width: 12%; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    @media screen {
      body { background: #f3f4f6; padding: 24px 0; }
      .price-page { width: 794px; min-height: 1123px; margin: 0 auto 24px; padding: 46px 38px; background: #fff; box-shadow: 0 12px 36px rgba(15, 23, 42, 0.12); }
    }
    @media print {
      body { background: #fff; }
      .price-page { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
    }
  </style></head><body>${body}</body></html>`;
}

function printHtml(html: string) {
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

export function printApartmentPricePdf(records: PropertyRecord[], infoByPin: Record<string, RealtyPriceInfo>) {
  const body = records
    .map((record) => {
      const info = infoByPin[record.pin]?.apartment;
      return info ? buildApartmentPage(record, info) : '';
    })
    .filter(Boolean)
    .join('');
  return printHtml(buildHtml('공동주택가격 출력', body));
}

export function printIndividualPricePdf(records: PropertyRecord[], infoByPin: Record<string, RealtyPriceInfo>) {
  const body = records
    .map((record) => {
      const info = infoByPin[record.pin]?.individual;
      return info ? buildIndividualPage(record, info) : '';
    })
    .filter(Boolean)
    .join('');
  return printHtml(buildHtml('개별주택가격 출력', body));
}
