export type EaisRegisterType = 'general' | 'multiFamily' | 'exclusive';

export interface EaisRegisterReportConfig {
  label: string;
  regstrKindCd: string;
  mjrfmlyYn?: 'Y' | 'N';
  reportName: string;
}

export const EAIS_REGISTER_REPORT_CONFIG: Record<EaisRegisterType, EaisRegisterReportConfig> = {
  general: {
    label: '일반건축물',
    regstrKindCd: '2',
    mjrfmlyYn: 'N',
    reportName: 'djrBldrgstGnrl',
  },
  multiFamily: {
    label: '다가구',
    regstrKindCd: '2',
    mjrfmlyYn: 'Y',
    reportName: 'djrMjrFmlyHoArea',
  },
  exclusive: {
    label: '전유부',
    regstrKindCd: '4',
    reportName: 'djrBldexpos',
  },
};

export interface EaisRegisterCandidateLike {
  regstrKindCd?: string | number | null;
  mjrfmlyYn?: string | null;
}

export function resolveEaisRegisterType(candidate: EaisRegisterCandidateLike): EaisRegisterType | null {
  const regstrKindCd = String(candidate.regstrKindCd ?? '').trim();
  const mjrfmlyYn = String(candidate.mjrfmlyYn ?? 'N').trim().toUpperCase();

  if (regstrKindCd === '4') return 'exclusive';
  if (regstrKindCd === '2' && mjrfmlyYn === 'Y') return 'multiFamily';
  if (regstrKindCd === '2') return 'general';
  return null;
}

export interface EaisLotSearchInput {
  sigunguCd: string;
  bjdongCd: string;
  platGbCd?: string;
  mnnm: string;
  slno?: string;
  splotNm?: string;
  blockNm?: string;
  lotNm?: string;
}

export function buildEaisLotSearchPayload(input: EaisLotSearchInput) {
  const platGbCd = input.platGbCd ?? '0';
  return {
    addrGbCd: '0',
    inqireGbCd: '0',
    bldrgstCurdiGbCd: '0',
    bldrgstSeqno: '',
    reqSigunguCd: input.sigunguCd,
    sidoClsfCd: '',
    bjdongCd: input.bjdongCd,
    platGbCd,
    mnnm: input.mnnm.replace(/^0+/, '') || '0',
    slno: (input.slno ?? '0').replace(/^0+/, '') || '0',
    splotNm: input.splotNm ?? '',
    blockNm: input.blockNm ?? '',
    lotNm: input.lotNm ?? '',
    roadNmCd: '',
    bldMnnm: '',
    bldSlno: '',
    sigunguCd: input.sigunguCd,
  };
}

export function buildEaisExclusiveListPayload(sigunguCd: string, titleBldrgstSeqno: string) {
  return {
    inqireGbCd: '0',
    reqSigunguCd: sigunguCd,
    bldrgstCurdiGbCd: '0',
    upperBldrgstSeqno: titleBldrgstSeqno,
    bldrgstSeqno: '',
  };
}
