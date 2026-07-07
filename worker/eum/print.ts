// EUM 토지이용계획 부분인쇄 HTML 수집 + 일괄 인쇄 문서 생성
import { addressToPnu, type LdongEnv } from '../ldong/lookup';
import type { EumPrintItem } from '../../shared/types';

export interface EumPrintEnv extends LdongEnv {}

type EumPrintPage =
  | { ok: true; item: EumPrintItem; pnu: string; content: string }
  | { ok: false; item: EumPrintItem; pnu: string | null; error: string };

const EUM_ORIGIN = 'https://www.eum.go.kr';
const EUM_PRINT_BASE = `${EUM_ORIGIN}/web/ar/lu`;
const EUM_PRINT_PATH = `${EUM_PRINT_BASE}/luLandDetPrintPop.jsp`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const decoder = new TextDecoder('euc-kr');

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function printUrl(pnu: string, address: string): string {
  const url = new URL(EUM_PRINT_PATH);
  const params: Record<string, string> = {
    selGbn: 'umd',
    isNoScr: 'script',
    s_type: '1',
    p_location: address,
    p_type: 'one',
    p_type1: 'true',
    p_type2: 'true',
    p_type3: 'true',
    p_type4: 'true',
    p_type5: 'false',
    p_type6: 'false',
    p_type7: 'false',
    mode: 'search',
    pnu,
    scale: '1200',
    add: 'land',
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function readEucKr(res: Response): Promise<string> {
  return decoder.decode(await res.arrayBuffer());
}

function cookieHeader(res: Response): string {
  const h = res.headers as any;
  const setCookies: string[] =
    typeof h.getSetCookie === 'function'
      ? h.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return setCookies.map((cookie) => cookie.split(';')[0]).filter(Boolean).join('; ');
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchImageDataUri(src: string, cookie: string): Promise<string | null> {
  const url = new URL(src, `${EUM_PRINT_BASE}/`).toString();
  const res = await fetch(url, {
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      Referer: EUM_PRINT_PATH,
      'User-Agent': UA,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  if (!res.ok) return null;
  const type = res.headers.get('content-type')?.split(';')[0] || 'image/png';
  return `data:${type};base64,${arrayBufferToBase64(await res.arrayBuffer())}`;
}

async function inlineSessionImages(content: string, cookie: string): Promise<string> {
  const srcs = Array.from(content.matchAll(/\bsrc=(["'])(images\?key=[^"']+)\1/gi)).map((m) => m[2]);
  const uniqueSrcs = Array.from(new Set(srcs));
  if (!uniqueSrcs.length) return content;

  const pairs = await Promise.all(
    uniqueSrcs.map(async (src) => [src, await fetchImageDataUri(src, cookie).catch(() => null)] as const),
  );
  const replacements = new Map(pairs.filter((pair): pair is readonly [string, string] => Boolean(pair[1])));

  return content.replace(/\bsrc=(["'])(images\?key=[^"']+)\1/gi, (full, quote: string, src: string) => {
    const dataUri = replacements.get(src);
    return dataUri ? `src=${quote}${dataUri}${quote}` : full;
  });
}

function extractPrintBody(html: string): string {
  const start = html.indexOf('<div class="popPrint">');
  const end = html.lastIndexOf('</body>');
  if (start < 0 || end <= start) throw new Error('인쇄 HTML 본문을 찾지 못했습니다.');

  return html
    .slice(start, end)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/\s+on(?:load|click|change|mouseover|mouseout|keydown|keyup)=("[^"]*"|'[^']*')/gi, '');
}

function injectJiga(content: string, jigaText?: string): string {
  if (!jigaText) return content;
  return content.replace(
    /(<td\b[^>]*\bid=["']jiga["'][^>]*>)([\s\S]*?)(<\/td>)/i,
    `$1${escapeHtml(jigaText)}$3`,
  );
}

async function fetchPrintPage(
  item: EumPrintItem,
  env: EumPrintEnv,
  ctx?: ExecutionContext,
): Promise<EumPrintPage> {
  const pnu = await addressToPnu(item.address, env, ctx);
  if (!pnu) return { ok: false, item, pnu: null, error: 'PNU 변환 실패' };

  try {
    const res = await fetch(printUrl(pnu, item.address), {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: `${EUM_PRINT_BASE}/luLandDet.jsp`,
        'User-Agent': UA,
      },
    });
    if (!res.ok) return { ok: false, item, pnu, error: `EUM HTTP ${res.status}` };

    const html = await readEucKr(res);
    const content = injectJiga(await inlineSessionImages(extractPrintBody(html), cookieHeader(res)), item.jigaText);
    return { ok: true, item, pnu, content };
  } catch (e: any) {
    return { ok: false, item, pnu, error: e?.message ?? 'EUM 조회 실패' };
  }
}

function renderPage(page: EumPrintPage, index: number): string {
  const breakClass = index > 0 ? ' page-break' : '';
  if (!page.ok) {
    return `<section class="eum-page${breakClass}">
      <div class="eum-error">
        <h1>토지이용계획 조회 실패</h1>
        <dl>
          <dt>대상</dt><dd>${escapeHtml(page.item.label || page.item.key || page.item.address)}</dd>
          <dt>주소</dt><dd>${escapeHtml(page.item.address)}</dd>
          <dt>PNU</dt><dd>${escapeHtml(page.pnu ?? '-')}</dd>
          <dt>사유</dt><dd>${escapeHtml(page.error)}</dd>
        </dl>
      </div>
    </section>`;
  }

  return `<section class="eum-page${breakClass}">
    <div class="eum-stamp">${escapeHtml(page.item.label || page.item.key)} · PNU ${escapeHtml(page.pnu)}</div>
    ${page.content}
  </section>`;
}

function renderCombined(pages: EumPrintPage[]): string {
  const body = pages.map(renderPage).join('');
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <base href="${EUM_PRINT_BASE}/">
  <title>토지이용계획 일괄 인쇄</title>
  <link rel="stylesheet" type="text/css" href="${EUM_ORIGIN}/web/css/prt/common.css">
  <link rel="stylesheet" type="text/css" href="${EUM_ORIGIN}/web/css/prt/layout.css">
  <link rel="stylesheet" type="text/css" href="${EUM_ORIGIN}/web/css/prt/plan.style.css">
  <style>
    * { box-sizing: border-box; }
    @page { size: A4; margin: 10mm; }
    body { margin: 0; background: #fff; color: #111; }
    .eum-page { break-after: page; page-break-after: always; }
    .eum-page:last-child { break-after: auto; page-break-after: auto; }
    .eum-stamp {
      width: 660px; margin: 0 auto 6px; color: #6b7280;
      font: 11px/1.4 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; text-align: right;
    }
    .eum-error {
      max-width: 660px; min-height: 240px; margin: 20mm auto; padding: 32px;
      border: 1px solid #d1d5db; font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif;
    }
    .eum-error h1 { margin: 0 0 18px; font-size: 18px; }
    .eum-error dl { display: grid; grid-template-columns: 80px 1fr; gap: 8px 12px; margin: 0; font-size: 13px; }
    .eum-error dt { color: #6b7280; font-weight: 700; }
    .eum-error dd { margin: 0; }
    @media screen {
      body { background: #f3f4f6; padding: 24px 0; }
      .eum-page {
        width: 720px; margin: 0 auto 24px; padding: 24px;
        background: #fff; box-shadow: 0 12px 36px rgba(15, 23, 42, 0.12);
      }
      .eum-page .popPrint { width: 660px !important; margin: 0 auto !important; }
    }
    @media print {
      body { background: #fff; }
      .eum-page { width: auto; margin: 0; padding: 0; box-shadow: none; }
      .eum-stamp { display: none; }
    }
  </style>
</head>
<body>${body}</body>
</html>`;
}

export async function buildEumPrintHtml(
  items: EumPrintItem[],
  env: EumPrintEnv,
  ctx?: ExecutionContext,
  concurrency = 3,
): Promise<string> {
  const pages: EumPrintPage[] = new Array(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      pages[index] = await fetchPrintPage(items[index], env, ctx);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker));
  return renderCombined(pages);
}
