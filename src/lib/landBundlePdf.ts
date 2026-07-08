import type { LandInfo, PropertyRecord } from '../../shared/types';

const won = (n: string) => (n ? Number(n).toLocaleString('ko-KR') : '');

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jigaPage(info: LandInfo) {
  if (!info.jiga.length) return '';
  const rows = info.jiga
    .map((row) => `<tr>
      <td>${escapeHtml(row.year)}</td>
      <td class="addr">${escapeHtml(row.addr)}</td>
      <td>${escapeHtml(row.jibun)}번지</td>
      <td class="num">${escapeHtml(won(row.price))}</td>
      <td>${escapeHtml(`${row.year}-${row.month}`)}</td>
      <td>${escapeHtml(row.publishDate)}</td>
      <td></td>
    </tr>`)
    .join('');

  return `<section class="land-bundle-page">
    <h1>개별공시지가 열람</h1>
    <table>
      <thead>
        <tr class="grp"><th colspan="3">신청대상 토지</th><th colspan="4">확인내용</th></tr>
        <tr class="col"><th>가격기준<br>년도</th><th>토지소재지</th><th>지번</th><th>개별공시지가<br>(원)</th><th>기준일자</th><th>공시일자</th><th>비고</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="land-foot">*단위면적(㎡)당 산정가격임.</div>
  </section>`;
}

function gradePage(info: LandInfo) {
  if (!info.grade.length) return '';
  const rows = info.grade
    .map((row) => `<tr>
      <td>${escapeHtml(row.kind)}</td>
      <td>${escapeHtml(row.grade)}</td>
      <td>${escapeHtml(row.changeDate)}</td>
    </tr>`)
    .join('');

  return `<section class="land-bundle-page">
    <h1>토지등급 열람</h1>
    <p class="land-subject">${escapeHtml(info.address)}</p>
    <table>
      <thead><tr class="col"><th>등급구분</th><th>등급</th><th>변동일</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function extractEumPages(eumHtml: string) {
  if (!eumHtml) return [];
  const doc = new DOMParser().parseFromString(eumHtml, 'text/html');
  const pages = Array.from(doc.body?.querySelectorAll('.eum-page') ?? [])
    .map((page) => page.outerHTML)
    .filter(Boolean);
  return pages.length ? pages : [doc.body?.innerHTML ?? ''];
}

function buildBody(record: PropertyRecord, landInfo: LandInfo | null, eumPage: string) {
  const landBody = landInfo ? `${jigaPage(landInfo)}${gradePage(landInfo)}` : '';
  return `${eumPage}${landBody}`;
}

function buildHtml(records: PropertyRecord[], landInfoByPin: Record<string, LandInfo>, eumHtml: string) {
  const eumPages = extractEumPages(eumHtml);
  const body = records
    .map((record, index) => buildBody(record, landInfoByPin[record.pin] ?? null, eumPages[index] ?? ''))
    .filter(Boolean)
    .join('');
  if (!body) return '';
  const title = records.length === 1 ? `${records[0].address} 토지 통합 PDF` : '토지 통합 PDF';

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
  <base href="https://www.eum.go.kr/web/ar/lu/">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" type="text/css" href="https://www.eum.go.kr/web/css/prt/common.css">
  <link rel="stylesheet" type="text/css" href="https://www.eum.go.kr/web/css/prt/layout.css">
  <link rel="stylesheet" type="text/css" href="https://www.eum.go.kr/web/css/prt/plan.style.css">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #fff; color: #111; font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; }
    @page { size: A4; margin: 13mm; }
    .land-bundle-page,
    .eum-page { break-after: page; page-break-after: always; }
    .land-bundle-page:last-child,
    .eum-page:last-child { break-after: auto; page-break-after: auto; }
    .land-bundle-page h1 {
      margin: 0 0 12px; text-align: center; font-size: 17px; font-weight: 900;
    }
    .land-subject { margin: 0 0 14px; text-align: center; font-size: 13px; color: #222; }
    .land-bundle-page table {
      width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 11px;
    }
    .land-bundle-page thead { display: table-header-group; }
    .land-bundle-page th {
      border: 1px solid #999; padding: 6px 4px; background: #f7f7f7; text-align: center; font-weight: 800;
    }
    .land-bundle-page .grp th { background: #f0f0f0; }
    .land-bundle-page td {
      border: 1px solid #bbb; padding: 5px 6px; text-align: center; vertical-align: middle;
    }
    .land-bundle-page td.addr { text-align: left; }
    .land-bundle-page td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .land-foot { margin-top: 10px; font-size: 10px; color: #333; }
    .eum-stamp {
      width: 660px; margin: 0 auto 6px; color: #6b7280;
      font: 11px/1.4 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; text-align: right;
    }
    .eum-error {
      max-width: 660px; min-height: 240px; margin: 20mm auto; padding: 32px;
      border: 1px solid #d1d5db; font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif;
    }
    tr { break-inside: avoid; page-break-inside: avoid; }
    @media screen {
      body { background: #f3f4f6; padding: 24px 0; }
      .land-bundle-page,
      .eum-page {
        width: 720px; min-height: 1018px; margin: 0 auto 24px; padding: 24px;
        background: #fff; box-shadow: 0 12px 36px rgba(15, 23, 42, 0.12);
      }
      .eum-page .popPrint { width: 660px !important; margin: 0 auto !important; }
    }
    @media print {
      body { background: #fff; }
      .land-bundle-page,
      .eum-page { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
      .eum-stamp { display: none; }
    }
  </style></head><body>${body}</body></html>`;
}

export function buildLandBundlePdfHtml(record: PropertyRecord, landInfo: LandInfo | null, eumHtml: string) {
  return buildHtml([record], landInfo ? { [record.pin]: landInfo } : {}, eumHtml);
}

export function buildLandBundlePdfHtmlMany(
  records: PropertyRecord[],
  landInfoByPin: Record<string, LandInfo>,
  eumHtml: string,
) {
  return buildHtml(records, landInfoByPin, eumHtml);
}
