// Cloudflare Worker — /api/* 처리 + 정적 자산 서빙
import { collectAddress } from './iros/collect';
import type { CollectRequest } from '../shared/types';

export interface Env {
  ASSETS: Fetcher;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=UTF-8', ...CORS },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (url.pathname === '/api/health') {
      return json({ ok: true, service: 'iros-property-lookup' });
    }

    if (url.pathname === '/api/collect' && request.method === 'POST') {
      let body: CollectRequest;
      try {
        body = (await request.json()) as CollectRequest;
      } catch {
        return json({ ok: false, error: '잘못된 요청 본문' }, 400);
      }
      if (!body?.address) {
        return json({ ok: false, error: 'address 필수' }, 400);
      }
      try {
        const result = await collectAddress(body);
        return json(result);
      } catch (e: any) {
        return json({ ok: false, total: 0, collected: 0, records: [], error: e?.message ?? '수집 실패' }, 502);
      }
    }

    // 그 외 → 정적 자산 (SPA)
    return env.ASSETS.fetch(request);
  },
};
