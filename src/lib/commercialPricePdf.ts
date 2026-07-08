import type { CommercialPriceInfo, CommercialPriceItem, PropertyRecord } from '../../shared/types';

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

function areaLabel(item: CommercialPriceItem) {
  return item.buildingArea == null ? '' : item.buildingArea.toLocaleString('ko-KR', { maximumFractionDigits: 3 });
}

function buildPage(record: PropertyRecord, info: CommercialPriceInfo) {
  if (!info.items.length) return '';

  return `<article class="price-page">
    <h1>기준시가(상업용 건물/오피스텔)</h1>
    <section class="detail">
      <h2>상세주소</h2>
      <table>
        <tbody>
          <tr><th>입력주소</th><td>${escapeHtml(info.address || record.address)}</td></tr>
          <tr><th>상세주소</th><td>${escapeHtml(info.detailAddress)}</td></tr>
        </tbody>
      </table>
    </section>
    <section class="prices">
      <h2>기준시가</h2>
      <table>
        <thead>
          <tr>
            <th>고시일자</th>
            <th>단위면적당(㎡) 기준시가(원)</th>
            <th>건물면적(㎡)</th>
          </tr>
        </thead>
        <tbody>
          ${info.items.map((item) => `<tr>
            <td>${escapeHtml(item.noticeDate)}</td>
            <td>${escapeHtml(priceLabel(item.unitPrice))}</td>
            <td>${escapeHtml(areaLabel(item))}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>
    <p class="note">※ 상가 등의 호별기준시가 = 단위면적(㎡) 기준시가 * 건물면적(전유면적 + 공용면적)<br>※ 상가 호실의 분할, 합병 등 상세한 정보는 건축물대장으로 확인하시기 바랍니다.</p>
  </article>`;
}

function buildHtml(records: PropertyRecord[], infoByPin: Record<string, CommercialPriceInfo>) {
  const body = records
    .map((record) => {
      const info = infoByPin[record.pin];
      return info ? buildPage(record, info) : '';
    })
    .filter(Boolean)
    .join('');

  if (!body) return '';

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>상가/오피스 기준시가</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #fff; color: #111; font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; }
    @page { size: A4; margin: 13mm; }
    .price-page { break-after: page; page-break-after: always; }
    .price-page:last-child { break-after: auto; page-break-after: auto; }
    h1 { margin: 0 0 26px; padding: 0 0 10px 12px; border-bottom: 3px solid #000; font-size: 20px; font-weight: 800; }
    h2 { margin: 0 0 10px 12px; font-size: 16px; font-weight: 500; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .detail { margin-bottom: 26px; }
    .detail table { border-top: 1px solid #000; }
    .detail th, .detail td { border-bottom: 1px solid #000; padding: 7px 10px; font-size: 14px; line-height: 1.35; }
    .detail th { width: 150px; text-align: left; background: #f7f7f7; font-weight: 800; }
    .prices table { border-top: 3px solid #000; }
    .prices th, .prices td { border-bottom: 2px solid #000; border-right: 1px solid #000; padding: 7px 10px; text-align: center; font-size: 14px; line-height: 1.25; }
    .prices th:last-child, .prices td:last-child { border-right: none; }
    .prices th { font-weight: 800; background: #fafafa; }
    .note { margin: 10px 0 0 14px; font-size: 13px; line-height: 1.35; }
    @media screen {
      body { background: #f3f4f6; padding: 24px 0; }
      .price-page { width: 794px; min-height: 1123px; margin: 0 auto 24px; padding: 48px 38px; background: #fff; box-shadow: 0 12px 36px rgba(15, 23, 42, 0.12); }
    }
    @media print {
      body { background: #fff; }
      .price-page { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
    }
  </style></head><body>${body}</body></html>`;
}

export function printCommercialPricePdf(records: PropertyRecord[], infoByPin: Record<string, CommercialPriceInfo>) {
  const html = buildHtml(records, infoByPin);
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
