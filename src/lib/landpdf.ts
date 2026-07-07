// 선택한 토지들의 공시지가 + 토지등급을 하나의 문서로 합쳐 PDF로 출력
// (브라우저 인쇄 → "PDF로 저장"; 필지마다 공시지가 페이지 + 토지등급 페이지)
import type { LandInfo } from '../../shared/types';

const won = (n: string) => (n ? Number(n).toLocaleString('ko-KR') : '');

function jigaTable(li: LandInfo): string {
  const rows = li.jiga
    .map(
      (r) => `<tr>
      <td>${r.year}</td><td class="addr">${r.addr}</td><td>${r.jibun}번지</td>
      <td class="num">${won(r.price)}</td><td>${r.year}-${r.month}</td><td>${r.publishDate}</td><td></td>
    </tr>`,
    )
    .join('');
  return `<section>
    <h1>개별공시지가 열람</h1>
    <table><thead>
      <tr class="grp"><th colspan="3">신청대상 토지</th><th colspan="4">확인내용</th></tr>
      <tr class="col"><th>가격기준<br>년도</th><th>토지소재지</th><th>지번</th><th>개별공시지가<br>(원)</th><th>기준일자</th><th>공시일자</th><th>비고</th></tr>
    </thead><tbody>${rows}</tbody></table>
    <div class="foot">*단위면적(㎡)당 산정가격임.</div>
  </section>`;
}

function gradeTable(li: LandInfo): string {
  const body = li.grade.length
    ? li.grade
        .map((r) => `<tr><td>${r.kind}</td><td>${r.grade}</td><td>${r.changeDate}</td></tr>`)
        .join('')
    : `<tr><td colspan="3" class="empty">토지등급 자료가 없습니다.</td></tr>`;
  return `<section class="brk">
    <h1>토지등급 열람</h1>
    <p class="sub">${li.address}</p>
    <table><thead><tr class="col"><th>등급구분</th><th>등급</th><th>변동일</th></tr></thead>
    <tbody>${body}</tbody></table>
  </section>`;
}

function buildHtml(lands: LandInfo[]): string {
  const body = lands
    .map((li, i) => `<div class="${i > 0 ? 'brk' : ''}">${jigaTable(li)}${gradeTable(li)}</div>`)
    .join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>토지 공시지가·토지등급</title><style>
  * { box-sizing: border-box; }
  body { font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif; color:#111; margin:0; }
  @page { size: A4; margin: 16mm; }
  .brk { break-before: page; }
  h1 { text-align:center; font-size:16px; font-weight:800; margin:0 0 10px; }
  .sub { text-align:center; font-size:13px; margin:0 0 14px; color:#222; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  thead { display: table-header-group; }
  thead .grp th { background:#f0f0f0; font-weight:800; border:1px solid #999; padding:6px; }
  thead .col th { background:#f7f7f7; font-weight:700; border:1px solid #999; padding:6px 4px; }
  td { border:1px solid #bbb; padding:5px 6px; text-align:center; }
  td.addr { text-align:left; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  td.empty { padding:26px; color:#666; }
  .foot { margin-top:10px; font-size:10px; color:#333; break-inside:avoid; break-before:avoid; }
  tr { break-inside: avoid; }
  </style></head><body>${body}</body></html>`;
}

/** 인쇄 창을 열어 합쳐진 문서를 출력(→PDF 저장) */
export function printLandPdf(lands: LandInfo[]): void {
  if (!lands.length) return;
  const html = buildHtml(lands);
  const w = window.open('', '_blank');
  if (!w) {
    alert('팝업이 차단되었습니다. 팝업 허용 후 다시 시도해 주세요.');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  // 렌더 후 인쇄
  const trigger = () => setTimeout(() => w.print(), 300);
  if (w.document.readyState === 'complete') trigger();
  else w.onload = trigger;
}
