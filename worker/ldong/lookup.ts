// 법정동코드 로더 + 주소→PNU 변환
// 갱신 조건:
//  ② 부트스트랩: KV 비어있으면 최초 1회 블로킹 빌드
//  ③ TTL 안전장치: builtAt 3일 초과면 ctx.waitUntil로 백그라운드 재빌드(응답 안 막음)
//  (① 정기 Cron, ④ 수동 강제는 worker/index.ts)
import { KV_MAP, KV_META, refreshLdong, type LdongMeta } from './refresh';

export interface LdongEnv {
  LDONG: KVNamespace;
  ODCLOUD_API_KEY: string;
}

const TTL_MS = 3 * 24 * 60 * 60 * 1000; // 일일 Cron 연속 실패에 대비한 안전장치

// 아이솔레이트 수명 동안 메모리 캐시 (KV 재조회 방지)
let MEM: { map: Record<string, string>; builtAt: number } | null = null;

/** KV(→필요 시 행정안전부 API)에서 맵 확보. 조건부 갱신 포함. */
async function getMap(env: LdongEnv, ctx?: ExecutionContext): Promise<Record<string, string>> {
  if (MEM) {
    // TTL 초과 시 백그라운드 재빌드 (응답은 기존 맵으로 즉시)
    if (ctx && Date.now() - MEM.builtAt > TTL_MS) {
      ctx.waitUntil(refreshLdong(env).then(() => { MEM = null; }).catch(() => {}));
    }
    return MEM.map;
  }

  const [mapStr, metaStr] = await Promise.all([
    env.LDONG.get(KV_MAP),
    env.LDONG.get(KV_META),
  ]);

  if (!mapStr) {
    // ② 부트스트랩: KV 비어있음(최초/전파지연) → 백그라운드 갱신만.
    //    요청 경로에서 외부 API를 동기 호출하지 않음(520/지연으로 요청 실패 방지).
    if (ctx) ctx.waitUntil(refreshLdong(env).then(() => { MEM = null; }).catch(() => {}));
    return {};
  }

  const map: Record<string, string> = JSON.parse(mapStr);
  const meta: LdongMeta | null = metaStr ? JSON.parse(metaStr) : null;
  const builtAt = meta?.builtAt ?? 0;
  MEM = { map, builtAt };

  // ③ TTL 초과면 백그라운드 재빌드
  if (ctx && Date.now() - builtAt > TTL_MS) {
    ctx.waitUntil(refreshLdong(env).then(() => { MEM = null; }).catch(() => {}));
  }
  return map;
}

// ── 주소 파싱 → PNU 조립 ──────────────────────────────────────
// PNU(19) = 법정동코드(10) + 필지구분(1: 1=일반/토지, 2=산) + 본번(4) + 부번(4)

interface ParsedAddr {
  dongName: string; // 법정동명 (시도 시군구 동)
  san: boolean;
  bobn: string;
  bubn: string;
}

export function parseAddress(address: string): ParsedAddr | null {
  const norm = address.replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim();
  const tokens = norm.split(' ');
  // 지번 시작 토큰: "산" 또는 숫자/산+숫자로 시작
  const idx = tokens.findIndex((t) => /^산$/.test(t) || /^산?\d/.test(t));
  if (idx <= 0) return null;
  const dongName = tokens.slice(0, idx).join(' ');
  const jibunStr = tokens.slice(idx).join(' '); // "산 15-3" | "265-5" | "265-5번지" | "265"
  const jm = /^(산)?\s*(\d+)(?:-(\d+))?/.exec(jibunStr);
  if (!jm) return null;
  return { dongName, san: Boolean(jm[1]), bobn: jm[2], bubn: jm[3] ?? '0' };
}

/** 주소 → PNU(19자리). 변환 불가 시 null. */
export async function addressToPnu(
  address: string,
  env: LdongEnv,
  ctx?: ExecutionContext,
): Promise<string | null> {
  const parsed = parseAddress(address);
  if (!parsed) return null;
  const map = await getMap(env, ctx);
  const code = map[parsed.dongName];
  if (!code) return null;
  const filji = parsed.san ? '2' : '1';
  return code + filji + parsed.bobn.padStart(4, '0') + parsed.bubn.padStart(4, '0');
}

/** 여러 주소 일괄 변환. { address, pnu|null } */
export async function addressesToPnu(
  addresses: string[],
  env: LdongEnv,
  ctx?: ExecutionContext,
): Promise<{ address: string; pnu: string | null }[]> {
  const map = await getMap(env, ctx);
  return addresses.map((address) => {
    const parsed = parseAddress(address);
    if (!parsed) return { address, pnu: null };
    const code = map[parsed.dongName];
    if (!code) return { address, pnu: null };
    const filji = parsed.san ? '2' : '1';
    return { address, pnu: code + filji + parsed.bobn.padStart(4, '0') + parsed.bubn.padStart(4, '0') };
  });
}
