// 프론트엔드(Vite)와 Worker가 공유하는 타입

/** 정규화된 부동산 레코드 (IROS dataList → 우리 스키마) */
export interface PropertyRecord {
  pin: string;        // 14자리 부동산고유번호
  pinFmt: string;     // 4-4-6 하이픈 (1102-2004-010236)
  type: string;       // 토지 / 건물 / 집합건물 (real_cls_cd)
  address: string;    // 지번 주소 (real_indi_cont)
  roadAddr: string;   // 도로명 주소 (rd_addr)
  building: string;   // 건물명 (buld_name)
  floor: string;      // 층 (buld_no_floor)
  room: string;       // 호 (buld_no_room)
  useCls: string;     // 현행 / 폐쇄 (use_cls_cd)
}

/** POST /api/collect 요청 — 주소 한 줄 통째로 (시/도 불필요, admin_regn1 빈값으로 검색됨) */
export interface CollectRequest {
  address: string;    // 예: "서울특별시 송파구 석촌동 265-5" 또는 "송파구 석촌동 265-5" 둘 다 OK
}

/** POST /api/collect 응답 */
export interface CollectResponse {
  ok: boolean;
  total: number;               // IROS 보고 totalRecordCount
  collected: number;           // 실제 수집·중복제거 후 건수
  records: PropertyRecord[];
  error?: string;
}

// ── 토지 공시지가 + 토지등급 (V-World) ──────────────────────────
export interface JigaRow {
  year: string;        // 가격기준년도
  month: string;       // 기준월 (2자리)
  price: string;       // 개별공시지가(원/㎡)
  publishDate: string; // 공시일자
  jibun: string;       // 지번
  addr: string;        // 토지소재지
}
export interface GradeRow {
  kind: string;        // 등급구분 (토지/기준수확량)
  grade: string;       // 등급
  changeDate: string;  // 변동일
}
export interface LandInfo {
  key: string;         // 매칭용 (부동산고유번호 pin)
  address: string;
  pnu: string | null;
  jiga: JigaRow[];
  grade: GradeRow[];
  error?: string;
}

/** POST /api/landinfo 요청/응답 */
export interface LandInfoRequest {
  items: { key: string; address: string }[];
}
export interface LandInfoResponse {
  ok: boolean;
  results: LandInfo[];
  error?: string;
}

// ── 토지이용계획 인쇄 HTML (EUM) ──────────────────────────────
export interface EumPrintItem {
  key: string;
  address: string;
  label?: string;
  jigaText?: string;
}

export interface EumPrintRequest {
  items: EumPrintItem[];
}
