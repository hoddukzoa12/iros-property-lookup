// IROS 검색 API 수집 로직 (Worker, 서버-to-서버)
//
// IROS 검색 백엔드 특성 (실측):
//  - 세션 상태 기반이라 페이지 병렬 호출 시 결과가 깨진다 → 큰 pageUnit으로 "단일 호출".
//  - 큰 결과셋 쿼리는 불안정하게 total=0을 반환한다(작은 결과는 항상 성공) → total>0 나올 때까지 재시도.
//  - 매 시도마다 새 세션 쿠키를 쓴다.
import type { CollectRequest, CollectResponse, PropertyRecord } from '../../shared/types';

const BASE = 'https://www.iros.go.kr';
const SEARCH = '/biz/Pr20ViaRlrgSrchCtrl/retrieveSmplSrchList.do';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PAGE_UNIT = 10000; // 한 번에 전량 수신 (페이지네이션 회피)
const MAX_ATTEMPTS = 8; // total>0 나올 때까지 재시도
const RETRY_DELAY_MS = 1200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bootstrapCookie(): Promise<string> {
  const res = await fetch(`${BASE}/index.jsp`, { headers: { 'User-Agent': UA } });
  const h = res.headers as any;
  const setCookies: string[] =
    typeof h.getSetCookie === 'function'
      ? h.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
}

function makeParam(swrd: string) {
  return {
    websquare_param: {
      conn_menu_cls_cd: '01', prgs_mode_cls_cd: '01', inet_srch_cls_cd: 'PR01',
      prgs_stg_cd: '', move_cls: 'P', swrd, addr_cls: '3', kind_cls: 'all',
      land_bing_yn: '', rgs_rec_stat: '현행', admin_regn1: '',
      admin_regn2: '', admin_regn3: '', lot_no: '', buld_name: '',
      buld_no_buld: '', buld_no_room: '', rd_name: '', rd_buld_no: '',
      rd_buld_no2: '', issue_cls: '5', pageIndex: '1', pageUnit: PAGE_UNIT,
      cmort_flag: '', kap_seq_flag: '', trade_seq_flag: '', etdoc_sel_yn: '',
      show_cls: '', real_pin_con: '', svc_cls_con: '', item_cls_con: '',
      judge_enr_cls_con: '', cmort_cls_con: '', trade_cls_con: '', extend_srch: '',
      usg_cls_con: '',
    },
  };
}

const fmtPin = (pin: string) => `${pin.slice(0, 4)}-${pin.slice(4, 8)}-${pin.slice(8, 14)}`;

function textValue(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTrailingBuilding(address: string, building: string): string {
  if (!address || !building) return address;
  return address.endsWith(building) ? address.slice(0, -building.length).trim() : address;
}

function normalize(d: any): PropertyRecord {
  const pin = String(d.pin ?? '');
  const building = textValue(d.buld_name);
  const address = stripTrailingBuilding(
    textValue(d.real_indi_cont_detail) || textValue(d.real_indi_cont),
    building,
  );
  const roadAddr = textValue(d.rd_addr_detail) || textValue(d.rd_addr);
  return {
    pin,
    pinFmt: pin.length === 14 ? fmtPin(pin) : pin,
    type: d.real_cls_cd ?? '',
    address,
    roadAddr,
    building,
    floor: textValue(d.buld_no_floor),
    room: textValue(d.buld_no_room),
    useCls: textValue(d.use_cls_cd),
  };
}

async function searchOnce(swrd: string): Promise<{ total: number; list: any[]; error?: string }> {
  const cookie = await bootstrapCookie();
  const res = await fetch(`${BASE}${SEARCH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json',
      'User-Agent': UA,
      Referer: `${BASE}/index.jsp`,
      Cookie: cookie,
    },
    body: JSON.stringify(makeParam(swrd)),
  });
  const data: any = await res.json();
  if (data?.nrsMessageType === 'error') {
    return { total: 0, list: [], error: data.nrsMessageValue ?? '검색 오류' };
  }
  const total = data?.paginationInfo?.totalRecordCount ?? 0;
  const list = data?.dataList ?? [];
  return { total, list };
}

/**
 * 주소 1건 수집. 큰 pageUnit 단일 호출 + total>0 나올 때까지 재시도.
 * 성공 판정: total > 0 && 반환행수 === total (부분 응답은 실패로 간주하고 재시도).
 * 모든 시도가 0이면 "결과 없음"으로 처리.
 */
export async function collectAddress(req: CollectRequest): Promise<CollectResponse> {
  const swrd = req.address.trim();
  if (!swrd) return { ok: false, total: 0, collected: 0, records: [], error: '주소가 비어있습니다.' };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { total, list, error } = await searchOnce(swrd);
    if (error) return { ok: false, total: 0, collected: 0, records: [], error };

    const enough = total > 0 && (list.length === total || list.length >= PAGE_UNIT);
    if (enough) {
      const seen = new Set<string>();
      const records: PropertyRecord[] = [];
      for (const d of list) {
        const pin = String(d.pin ?? '');
        if (pin && !seen.has(pin)) {
          seen.add(pin);
          records.push(normalize(d));
        }
      }
      return { ok: true, total, collected: records.length, records };
    }

    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }

  // 모든 시도가 0 → 결과 없음 (또는 지속적 불안정)
  return { ok: true, total: 0, collected: 0, records: [] };
}
