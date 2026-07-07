// 일괄열람 등록양식 .xls(BIFF8) 생성 + 30건 단위 분할 + zip
// 양식 구조: 시트명 '등록양식', A2부터 4-4-6 하이픈 텍스트, B열 이후 검토용 메타데이터
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import type { PropertyRecord } from '../../shared/types';

export const BATCH_SIZE = 30;

const HEADERS = [
  '부동산고유번호(14자리)',
  '유형',
  '주소',
  '도로명주소',
  '건물명',
  '층',
  '호',
  '상태',
];

function buildBatchXls(records: PropertyRecord[]): ArrayBuffer {
  const aoa: string[][] = [HEADERS];
  for (const r of records) {
    aoa.push([
      r.pinFmt,
      r.type,
      r.address,
      r.roadAddr,
      r.building,
      r.floor,
      r.room,
      r.useCls,
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // IROS 업로드가 읽는 A열 고유번호 셀을 명시적 텍스트로 유지
  for (let i = 0; i < records.length; i++) {
    ws[`A${i + 2}`] = { t: 's', v: records[i].pinFmt };
  }
  ws['!cols'] = [
    { wch: 20 },
    { wch: 10 },
    { wch: 34 },
    { wch: 34 },
    { wch: 22 },
    { wch: 8 },
    { wch: 8 },
    { wch: 10 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '등록양식');
  return XLSX.write(wb, { bookType: 'biff8', type: 'array' }) as ArrayBuffer;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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

export function batchCount(pinCount: number): number {
  return Math.ceil(pinCount / BATCH_SIZE);
}

/** 전체 레코드 → 등록양식 다운로드. 1개 batch면 .xls, 여러 개면 zip. */
export async function downloadBatches(records: PropertyRecord[], jobName = 'iros'): Promise<void> {
  const batches = chunk(records, BATCH_SIZE);
  if (batches.length === 0) return;

  if (batches.length === 1) {
    const buf = buildBatchXls(batches[0]);
    triggerDownload(new Blob([buf], { type: 'application/vnd.ms-excel' }), `${jobName}_batch_001.xls`);
    return;
  }

  const zip = new JSZip();
  batches.forEach((b, i) => {
    zip.file(`${jobName}_batch_${String(i + 1).padStart(3, '0')}.xls`, buildBatchXls(b));
  });
  const blob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(blob, `${jobName}_${batches.length}개_batch.zip`);
}
