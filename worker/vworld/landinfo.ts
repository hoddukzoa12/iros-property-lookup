// V-World 개별공시지가 + 토지등급 조회 (PNU 기반)
//   공시지가: https://api.vworld.kr/ned/data/getIndvdLandPriceAttr
//   토지등급: https://api.vworld.kr/ned/data/ladgrdList
import { addressToPnu, type LdongEnv } from '../ldong/lookup';
import type { JigaRow, GradeRow, LandInfo } from '../../shared/types';

export type { JigaRow, GradeRow, LandInfo };

export interface VworldEnv extends LdongEnv {
  VWORLD_API_KEY: string;
}

const mm = (m: unknown) => String(m ?? '').padStart(2, '0');

async function fetchJiga(pnu: string, key: string): Promise<JigaRow[]> {
  const u = `https://api.vworld.kr/ned/data/getIndvdLandPriceAttr?key=${key}&pnu=${pnu}&format=json&numOfRows=100&pageNo=1`;
  const j: any = await (await fetch(u)).json();
  const raw: any[] = j?.indvdLandPrices?.field ?? [];
  // 중복 제거 (연-월-가격)
  const seen = new Set<string>();
  const rows: JigaRow[] = [];
  for (const r of raw) {
    const k = `${r.stdrYear}-${mm(r.stdrMt)}-${r.pblntfPclnd}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({
      year: String(r.stdrYear ?? ''),
      month: mm(r.stdrMt),
      price: String(r.pblntfPclnd ?? ''),
      publishDate: String(r.pblntfDe ?? ''),
      jibun: String(r.mnnmSlno ?? ''),
      addr: `${r.ldCodeNm ?? ''} ${r.mnnmSlno ?? ''}`.trim(),
    });
  }
  rows.sort((a, b) => Number(b.year) - Number(a.year) || (b.month > a.month ? 1 : -1));
  return rows;
}

async function fetchGrade(pnu: string, key: string): Promise<GradeRow[]> {
  const u = `https://api.vworld.kr/ned/data/ladgrdList?key=${key}&pnu=${pnu}&format=json&numOfRows=100&pageNo=1`;
  const j: any = await (await fetch(u)).json();
  const raw: any[] = j?.ladgrdVOList?.ladgrdVOList ?? [];
  const rows: GradeRow[] = raw.map((r) => ({
    kind: r.ladGradSeCode === '1' ? '토지' : r.ladGradSeCode === '2' ? '기준수확량' : '-',
    grade: String(r.ladGrad ?? ''),
    changeDate: String(r.ladGradChangeDe ?? ''),
  }));
  rows.sort((a, b) => (a.changeDate > b.changeDate ? -1 : 1));
  return rows;
}

/** 여러 필지의 공시지가+토지등급 조회. 동시성 제한. */
export async function fetchLandInfos(
  items: { key: string; address: string }[],
  env: VworldEnv,
  ctx?: ExecutionContext,
  concurrency = 4,
): Promise<LandInfo[]> {
  const key = env.VWORLD_API_KEY;
  const out: LandInfo[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const { key: k, address } = items[i];
      try {
        const pnu = await addressToPnu(address, env, ctx);
        if (!pnu) { out[i] = { key: k, address, pnu: null, jiga: [], grade: [], error: 'PNU 변환 실패' }; continue; }
        const [jiga, grade] = await Promise.all([fetchJiga(pnu, key), fetchGrade(pnu, key)]);
        out[i] = { key: k, address, pnu, jiga, grade };
      } catch (e: any) {
        out[i] = { key: k, address, pnu: null, jiga: [], grade: [], error: e?.message ?? '조회 실패' };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker));
  return out;
}
