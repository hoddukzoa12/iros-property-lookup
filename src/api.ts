import type {
  CollectRequest, CollectResponse,
  EumPrintRequest,
  LandInfoRequest, LandInfoResponse,
} from '../shared/types';

export async function collect(req: CollectRequest): Promise<CollectResponse> {
  const res = await fetch('/api/collect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return (await res.json()) as CollectResponse;
}

export async function fetchLandInfo(req: LandInfoRequest): Promise<LandInfoResponse> {
  const res = await fetch('/api/landinfo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return (await res.json()) as LandInfoResponse;
}

export async function fetchEumPrintHtml(req: EumPrintRequest): Promise<string> {
  const res = await fetch('/api/eum/print-html', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const text = await res.text();
  if (!res.ok) {
    try {
      const data = JSON.parse(text) as { error?: string };
      throw new Error(data.error ?? '토지이용계획 인쇄 HTML 생성 실패');
    } catch (e: any) {
      if (e instanceof SyntaxError) throw new Error(text || '토지이용계획 인쇄 HTML 생성 실패');
      throw e;
    }
  }
  return text;
}
