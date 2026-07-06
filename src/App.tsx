import { useMemo, useState } from 'react';
import { collect } from './api';
import { downloadBatches, batchCount, BATCH_SIZE } from './lib/excel';
import type { PropertyRecord } from '../shared/types';

type Row = {
  address: string;
  status: 'pending' | 'loading' | 'done' | 'error';
  records: PropertyRecord[];
  total: number;
  error?: string;
};

// IROS 검색 백엔드는 동시 요청 시 불안정하게 0을 반환한다(false "결과 없음" 유발).
// → 직렬 처리 + 주소 간 페이싱으로 신뢰성 확보 (실측: 직렬은 100% 정확, 동시성은 누락 발생).
const CONCURRENCY = 1;
const PACE_MS = 800;                      // 주소 간 간격
const TYPE_ORDER = ['건물', '토지', '집합건물'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function groupByType(records: PropertyRecord[]) {
  const g: Record<string, PropertyRecord[]> = {};
  for (const r of records) (g[r.type] ??= []).push(r);
  return Object.keys(g)
    .sort((a, b) => {
      const ia = TYPE_ORDER.indexOf(a), ib = TYPE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    })
    .map((type) => ({ type, records: g[type] }));
}

export default function App() {
  const [input, setInput] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // 전체 주소 통합 고유번호 (중복 제거) — 다운로드용
  const allPins = useMemo(() => {
    const seen = new Set<string>();
    const pins: string[] = [];
    for (const r of rows)
      for (const rec of r.records)
        if (!seen.has(rec.pin)) { seen.add(rec.pin); pins.push(rec.pinFmt); }
    return pins;
  }, [rows]);

  const done = rows.filter((r) => r.status === 'done' || r.status === 'error').length;

  async function onCollect() {
    const addresses = input.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!addresses.length) return;
    setRunning(true);
    setRows(addresses.map((a) => ({ address: a, status: 'pending', records: [], total: 0 })));

    const update = (i: number, patch: Partial<Row>) =>
      setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

    let next = 0;
    const worker = async () => {
      while (next < addresses.length) {
        const i = next++;
        update(i, { status: 'loading' });
        try {
          const res = await collect({ address: addresses[i] });
          if (res.ok) update(i, { status: 'done', records: res.records, total: res.total });
          else update(i, { status: 'error', error: res.error });
        } catch (e: any) {
          update(i, { status: 'error', error: e?.message ?? '오류' });
        }
        if (next < addresses.length) await sleep(PACE_MS); // 주소 간 페이싱
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, addresses.length) }, worker));
    setRunning(false);
  }

  async function onDownload() {
    if (!allPins.length) return;
    setDownloading(true);
    try {
      await downloadBatches(allPins);
    } finally {
      setDownloading(false);
    }
  }

  const nBatch = batchCount(allPins.length);

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>부동산고유번호 조회</h1>
          <p className="sub">주소를 줄바꿈으로 여러 건 입력하세요. 시·도 없이 주소만 넣어도 됩니다.</p>
        </div>
        <button className="dl" onClick={onDownload} disabled={!allPins.length || downloading}>
          {downloading ? '생성 중…' : `엑셀 다운로드 (${allPins.length}건 · ${nBatch}개 batch${nBatch > 1 ? ' zip' : ''})`}
        </button>
      </header>

      <div className="form">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={'서울특별시 송파구 석촌동 265-5\n서울특별시 서초구 반포동 20-1\n...'}
          rows={5}
        />
        <button className="go" onClick={onCollect} disabled={running}>
          {running ? `조회 중… (${done}/${rows.length})` : '조회'}
        </button>
      </div>

      <div className="results">
        {rows.map((r, i) => (
          <section key={i} className={`card ${r.status}`}>
            <div className="card-head">
              <span className="addr">{r.address}</span>
              <span className={`badge ${r.status}`}>
                {r.status === 'pending' && '대기'}
                {r.status === 'loading' && '조회 중…'}
                {r.status === 'done' && `${r.records.length}건`}
                {r.status === 'error' && '실패'}
              </span>
            </div>

            {r.status === 'error' && <div className="err-msg">{r.error}</div>}

            {r.status === 'done' && r.records.length === 0 && <div className="err-msg">결과 없음</div>}

            {r.status === 'done' && r.records.length > 0 && (
              <div className="groups">
                {groupByType(r.records).map((g) => (
                  <div key={g.type} className="group">
                    <span className="gtype">{g.type} ({g.records.length}건)</span>
                    <span className="gpins">{g.records.map((x) => x.pinFmt).join(', ')}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
