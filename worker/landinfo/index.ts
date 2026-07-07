// 토지 개별공시지가 + 토지등급 조회 (PNU 기반)
//
// 제공자(provider) 추상화:
//  - LH  : Cloudflare Worker에서 도달 가능 (현재 활성). seereal.lh.or.kr 프록시.
//  - VWORLD: 공식 API지만 Cloudflare Worker→api.vworld.kr 이 520으로 막힘(오렌지-투-오렌지).
//            비-Cloudflare 프록시가 생기면 되살릴 수 있게 인터페이스만 유지.
import { addressToPnu, type LdongEnv } from '../ldong/lookup';
import type { JigaRow, GradeRow, LandInfo } from '../../shared/types';

export type { JigaRow, GradeRow, LandInfo };

export interface LandEnv extends LdongEnv {
  VWORLD_API_KEY: string; // (VWORLD provider 되살릴 때 사용)
}

const mm = (m: unknown) => String(m ?? '').padStart(2, '0');
const ymd = (s: string) => (s && s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s);
const stripBunji = (s: string) => String(s ?? '').replace(/번지$/, '').trim();

interface RawResult { jiga: JigaRow[]; grade: GradeRow[] }

interface LandProvider {
  name: string;
  /** 배치 1회 준비(예: LH 세션 쿠키). 반환값이 fetch로 전달됨. */
  setup(env: LandEnv): Promise<unknown>;
  /** PNU 1건의 공시지가+토지등급 */
  fetch(pnu: string, env: LandEnv, sess: unknown): Promise<RawResult>;
}

// ── LH provider ──────────────────────────────────────────────
const LH_BASE = 'https://seereal.lh.or.kr';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function lhBootstrapCookie(): Promise<string> {
  const res = await fetch(`${LH_BASE}/main.do`, { headers: { 'User-Agent': UA } });
  const h = res.headers as any;
  const sc: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  return sc.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
}

function lhHeaders(cookie: string, form: boolean) {
  return {
    ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `${LH_BASE}/main.do`,
    'User-Agent': UA,
    Cookie: cookie,
  };
}

async function lhJiga(pnu: string, cookie: string): Promise<JigaRow[]> {
  const body = 'paramList=' + encodeURIComponent(JSON.stringify([{
    url: 'http://localhost:9090/OnnaraServiceBE/lotdetailinfo1/selectOlnlpListKm.do',
    adm_sect_cd: pnu.slice(0, 5), land_loc_cd: pnu.slice(5, 10), ledg_gbn: pnu.slice(10, 11),
    bobn: pnu.slice(11, 15), bubn: pnu.slice(15, 19), authKey: 'authNumber1234',
  }]));
  const r = await fetch(`${LH_BASE}/proxy/proxy.do?`, { method: 'POST', headers: lhHeaders(cookie, true), body });
  const j: any = await r.json();
  const raw: any[] = j?.result?.[0]?.list2 ?? [];
  const seen = new Set<string>();
  const rows: JigaRow[] = [];
  for (const d of raw) {
    const k = `${d.baseYear}-${mm(d.baseMon)}-${d.pannJiga}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({
      year: String(d.baseYear ?? ''), month: mm(d.baseMon),
      price: String(d.pannJiga ?? ''), publishDate: ymd(String(d.pannYmd ?? '')),
      jibun: stripBunji(d.jibun), addr: '',
    });
  }
  rows.sort((a, b) => Number(b.year) - Number(a.year) || (b.month > a.month ? 1 : -1));
  return rows;
}

async function lhGrade(pnu: string, cookie: string): Promise<GradeRow[]> {
  const u = `${LH_BASE}/nsdiInforGradeList.do?paramList=` + encodeURIComponent(JSON.stringify([{ pnu, authKey: 'authNumber1234' }]));
  const r = await fetch(u, { headers: lhHeaders(cookie, false) });
  const j: any = await r.json();
  const raw: any[] = j?.ladgrdVOList?.ladgrdVOList ?? [];
  const rows: GradeRow[] = raw.map((d) => ({
    kind: d.ladGradSeCode === '1' ? '토지' : d.ladGradSeCode === '2' ? '기준수확량' : (d.ladGradSeCodeNm || '-'),
    grade: String(d.ladGrad ?? ''), changeDate: String(d.ladGradChangeDe ?? ''),
  }));
  rows.sort((a, b) => (a.changeDate > b.changeDate ? -1 : 1));
  return rows;
}

const LH_PROVIDER: LandProvider = {
  name: 'LH',
  setup: async () => lhBootstrapCookie(),
  fetch: async (pnu, _env, sess) => {
    const cookie = sess as string;
    const [jiga, grade] = await Promise.all([lhJiga(pnu, cookie), lhGrade(pnu, cookie)]);
    return { jiga, grade };
  },
};

// 활성 제공자 (교체 지점). 향후 VWORLD_PROVIDER로 바꾸면 됨.
const PROVIDER: LandProvider = LH_PROVIDER;

/** 여러 필지의 공시지가+토지등급 조회. 동시성 제한. */
export async function fetchLandInfos(
  items: { key: string; address: string }[],
  env: LandEnv,
  ctx?: ExecutionContext,
  concurrency = 4,
): Promise<LandInfo[]> {
  const out: LandInfo[] = new Array(items.length);
  let sess: unknown;
  try {
    sess = await PROVIDER.setup(env);
  } catch (e: any) {
    return items.map((it) => ({ key: it.key, address: it.address, pnu: null, jiga: [], grade: [], error: `제공자 준비 실패: ${e?.message}` }));
  }

  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const { key: k, address } = items[i];
      try {
        const pnu = await addressToPnu(address, env, ctx);
        if (!pnu) { out[i] = { key: k, address, pnu: null, jiga: [], grade: [], error: 'PNU 변환 실패' }; continue; }
        const { jiga, grade } = await PROVIDER.fetch(pnu, env, sess);
        // 토지소재지는 사용자가 넣은 전체 주소로 채움(LH landLocNm엔 동이 빠져 있음)
        for (const row of jiga) row.addr = address;
        out[i] = { key: k, address, pnu, jiga, grade };
      } catch (e: any) {
        out[i] = { key: k, address, pnu: null, jiga: [], grade: [], error: e?.message ?? '조회 실패' };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker));
  return out;
}
