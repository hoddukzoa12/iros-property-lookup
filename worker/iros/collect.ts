// IROS 검색 API 수집 로직 (Worker, 서버-to-서버)
// 정찰 검증: index.jsp 쿠키 부트스트랩 → retrieveSmplSrchList.do.
// 시/도(admin_regn1) 없이 주소 전체를 swrd로 검색 가능(검증됨). 페이지는 병렬 수집.
import type { CollectRequest, CollectResponse, PropertyRecord } from '../../shared/types';

const BASE = 'https://www.iros.go.kr';
const SEARCH = '/biz/Pr20ViaRlrgSrchCtrl/retrieveSmplSrchList.do';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PAGE_UNIT = 100;
const PAGE_CONCURRENCY = 6; // 한 주소 내 페이지 병렬 상한
const MAX_PAGES = 50; // 안전 상한

/** index.jsp 방문으로 세션 쿠키 확보 → "name=value; name=value" 문자열 반환 */
async function bootstrapCookie(): Promise<string> {
  const res = await fetch(`${BASE}/index.jsp`, { headers: { 'User-Agent': UA } });
  const h = res.headers as any;
  const setCookies: string[] =
    typeof h.getSetCookie === 'function'
      ? h.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return setCookies
    .map((c) => c.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

function makeParam(swrd: string, pageIndex: number) {
  return {
    websquare_param: {
      conn_menu_cls_cd: '01', prgs_mode_cls_cd: '01', inet_srch_cls_cd: 'PR01',
      prgs_stg_cd: '', move_cls: 'P', swrd, addr_cls: '3', kind_cls: 'all',
      land_bing_yn: '', rgs_rec_stat: '현행', admin_regn1: '',
      admin_regn2: '', admin_regn3: '', lot_no: '', buld_name: '',
      buld_no_buld: '', buld_no_room: '', rd_name: '', rd_buld_no: '',
      rd_buld_no2: '', issue_cls: '5', pageIndex: String(pageIndex), pageUnit: PAGE_UNIT,
      cmort_flag: '', kap_seq_flag: '', trade_seq_flag: '', etdoc_sel_yn: '',
      show_cls: '', real_pin_con: '', svc_cls_con: '', item_cls_con: '',
      judge_enr_cls_con: '', cmort_cls_con: '', trade_cls_con: '', extend_srch: '',
      usg_cls_con: '',
    },
  };
}

const fmtPin = (pin: string) =>
  `${pin.slice(0, 4)}-${pin.slice(4, 8)}-${pin.slice(8, 14)}`;

function normalize(d: any): PropertyRecord {
  const pin = String(d.pin ?? '');
  return {
    pin,
    pinFmt: pin.length === 14 ? fmtPin(pin) : pin,
    type: d.real_cls_cd ?? '',
    address: d.real_indi_cont ?? '',
    roadAddr: d.rd_addr ?? '',
    building: d.buld_name ?? '',
    floor: d.buld_no_floor ?? '',
    room: d.buld_no_room ?? '',
    useCls: d.use_cls_cd ?? '',
  };
}

async function callSearch(cookie: string, body: object): Promise<any> {
  const res = await fetch(`${BASE}${SEARCH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json',
      'User-Agent': UA,
      Referer: `${BASE}/index.jsp`,
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** 주소 1건의 전체 고유번호 수집 (페이지 병렬 + 중복 제거) */
export async function collectAddress(req: CollectRequest): Promise<CollectResponse> {
  const swrd = req.address.trim();
  if (!swrd) return { ok: false, total: 0, collected: 0, records: [], error: '주소가 비어있습니다.' };

  const cookie = await bootstrapCookie();

  const first = await callSearch(cookie, makeParam(swrd, 1));
  if (first?.nrsMessageType === 'error') {
    return { ok: false, total: 0, collected: 0, records: [], error: first.nrsMessageValue ?? '검색 오류' };
  }
  const total: number = first?.paginationInfo?.totalRecordCount ?? 0;
  const pages: number = Math.min(first?.paginationInfo?.totalPageCount ?? 0, MAX_PAGES);

  // 페이지별 dataList 모음 (page1 포함)
  const pageLists: any[][] = [first?.dataList ?? []];

  // 페이지 2..N 병렬 수집 (동시성 상한)
  const rest: number[] = [];
  for (let p = 2; p <= pages; p++) rest.push(p);
  for (let i = 0; i < rest.length; i += PAGE_CONCURRENCY) {
    const group = rest.slice(i, i + PAGE_CONCURRENCY);
    const results = await Promise.all(group.map((p) => callSearch(cookie, makeParam(swrd, p))));
    for (const r of results) {
      if (r?.nrsMessageType !== 'error') pageLists.push(r?.dataList ?? []);
    }
  }

  // 병합 + pin 중복 제거
  const seen = new Set<string>();
  const records: PropertyRecord[] = [];
  for (const list of pageLists) {
    for (const d of list) {
      const pin = String(d.pin ?? '');
      if (pin && !seen.has(pin)) {
        seen.add(pin);
        records.push(normalize(d));
      }
    }
  }

  return { ok: true, total, collected: records.length, records };
}
