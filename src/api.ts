import type { CollectRequest, CollectResponse } from '../shared/types';

export async function collect(req: CollectRequest): Promise<CollectResponse> {
  const res = await fetch('/api/collect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return (await res.json()) as CollectResponse;
}
