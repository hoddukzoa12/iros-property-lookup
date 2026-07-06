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
