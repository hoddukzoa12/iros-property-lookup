import type {
  CollectRequest, CollectResponse,
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
