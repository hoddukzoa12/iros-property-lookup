import { useMemo, useState } from 'react';
import { collect, fetchLandInfo } from './api';
import { downloadBatches, batchCount } from './lib/excel';
import { printLandPdf } from './lib/landpdf';
import type { PropertyRecord, LandInfo } from '../shared/types';

const won = (n: string) => (n ? Number(n).toLocaleString('ko-KR') : '');

type Row = {
  address: string;
  status: 'pending' | 'loading' | 'done' | 'error';
  records: PropertyRecord[];
  selectedPins: string[];
  total: number;
  error?: string;
};

// IROS 검색 백엔드는 동시 요청 시 불안정하게 0을 반환한다(false "결과 없음" 유발).
// → 직렬 처리 + 주소 간 페이싱으로 신뢰성 확보 (실측: 직렬은 100% 정확, 동시성은 누락 발생).
const CONCURRENCY = 1;
const PACE_MS = 800;                      // 주소 간 간격
type MatchKind = 'exact' | 'related' | 'caution' | 'review';

const MATCH_LABELS: Record<MatchKind, string> = {
  exact: '정확',
  related: '관련',
  caution: '주의',
  review: '검토',
};
const MATCH_ORDER: MatchKind[] = ['exact', 'related', 'caution', 'review'];
type ResultFilter = 'all' | 'selected' | MatchKind;
const FILTER_OPTIONS: { value: ResultFilter; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: 'selected', label: '선택' },
  { value: 'exact', label: '정확' },
  { value: 'related', label: '관련' },
  { value: 'caution', label: '주의' },
  { value: 'review', label: '검토' },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ParsedLot = {
  dong?: string;
  mountain: boolean;
  bun: string;
  ji: string;
  tail?: string;
};

type ParsedRoad = {
  roadName: string;
  mainNo: string;
  subNo: string;
  buildingNo?: string;
  roomNo?: string;
};

function normalizeAddress(value: string) {
  return value
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactAddress(value: string) {
  return normalizeAddress(value).replace(/\s+/g, '');
}

function extractDong(value: string): string | undefined {
  const matches = Array.from(normalizeAddress(value).matchAll(/([가-힣0-9]+(?:읍|면|동|리|가))/g));
  return matches.length ? matches[matches.length - 1][1] : undefined;
}

function extractRoadAddress(value: string): ParsedRoad | null {
  const normalized = normalizeAddress(value);
  const match = /([가-힣0-9]+?(?:로(?:\d+길)?|길))\s*(\d+)(?:-(\d+))?/.exec(normalized);
  if (!match) return null;

  const tail = normalized.slice(match.index + match[0].length);
  const buildingNo = /(?:제\s*)?(\d+)\s*동/.exec(tail)?.[1];
  const roomNo = /(?:제\s*)?(\d+)\s*호/.exec(tail)?.[1];
  const looseNumbers = Array.from(tail.matchAll(/\d+/g)).map((m) => m[0]);

  return {
    roadName: match[1],
    mainNo: match[2],
    subNo: match[3] ?? '',
    buildingNo: buildingNo ?? (looseNumbers.length >= 2 ? looseNumbers[0] : undefined),
    roomNo: roomNo ?? (looseNumbers.length >= 2 ? looseNumbers[looseNumbers.length - 1] : undefined),
  };
}

function extractQueryLot(value: string): ParsedLot | null {
  const normalized = normalizeAddress(value);
  const compactMatches = Array.from(
    normalized.matchAll(/([가-힣0-9]+?(?:읍|면|동|리|가))\s*(산\s*)?(\d+)(?:-(\d+))?/g),
  );
  const compactMatch = compactMatches.length ? compactMatches[compactMatches.length - 1] : undefined;
  if (compactMatch) {
    return {
      dong: compactMatch[1],
      mountain: Boolean(compactMatch[2]),
      bun: compactMatch[3],
      ji: compactMatch[4] ?? '',
    };
  }

  const matches = Array.from(normalized.matchAll(/(?:^|\s)(산\s*)?(\d+)(?:-(\d+))?(?=$|\s|번지|호|,|\))/g));
  const dong = extractDong(normalized);
  let match = matches.length ? matches[matches.length - 1] : undefined;

  if (!match && dong) {
    const afterDong = normalized.slice(normalized.lastIndexOf(dong) + dong.length).trim();
    match = /^(산\s*)?(\d+)(?:-(\d+))?/.exec(afterDong) ?? undefined;
  }

  if (!match) return null;
  return {
    dong,
    mountain: Boolean(match[1]),
    bun: match[2],
    ji: match[3] ?? '',
  };
}

function extractPrimaryLot(address: string, queryDong?: string): ParsedLot | null {
  const normalized = normalizeAddress(address);
  let source = normalized;
  if (queryDong) {
    const dongIndex = normalized.lastIndexOf(queryDong);
    if (dongIndex >= 0) source = normalized.slice(dongIndex + queryDong.length).trim();
  }

  const match = /(?:^|\s)(산\s*)?(\d+)(?:-(\d+))?/.exec(source);
  if (!match) return null;

  return {
    mountain: Boolean(match[1]),
    bun: match[2],
    ji: match[3] ?? '',
    tail: source.slice(match.index + match[0].length).trim(),
  };
}

function classifyRoadRecord(queryAddress: string, record: PropertyRecord): MatchKind | null {
  const queryRoad = extractRoadAddress(queryAddress);
  if (!queryRoad) return null;

  const recordRoad = extractRoadAddress(record.roadAddr);
  if (!recordRoad) return 'caution';

  const sameRoad =
    compactAddress(recordRoad.roadName) === compactAddress(queryRoad.roadName) &&
    recordRoad.mainNo === queryRoad.mainNo &&
    recordRoad.subNo === queryRoad.subNo;
  if (!sameRoad) return 'caution';

  if (queryRoad.buildingNo && recordRoad.buildingNo !== queryRoad.buildingNo) return 'caution';
  if (queryRoad.roomNo && recordRoad.roomNo !== queryRoad.roomNo) return 'caution';

  return queryRoad.buildingNo || queryRoad.roomNo ? 'exact' : 'related';
}

function classifyRecord(queryAddress: string, record: PropertyRecord): MatchKind {
  const roadKind = classifyRoadRecord(queryAddress, record);
  if (roadKind) return roadKind;

  const queryLot = extractQueryLot(queryAddress);
  if (!queryLot) return 'review';

  if (queryLot.dong && !normalizeAddress(record.address).includes(queryLot.dong)) return 'caution';

  const primaryLot = extractPrimaryLot(record.address, queryLot.dong);
  if (!primaryLot) return 'review';

  const sameLot = primaryLot.bun === queryLot.bun && primaryLot.ji === queryLot.ji;
  if (!sameLot || primaryLot.mountain !== queryLot.mountain) return 'caution';

  return primaryLot.tail ? 'related' : 'exact';
}

function shouldSelectByDefault(kind: MatchKind) {
  return kind === 'exact' || kind === 'related';
}

function countMatches(kinds: MatchKind[]) {
  return kinds.reduce<Record<MatchKind, number>>(
    (acc, kind) => ({ ...acc, [kind]: acc[kind] + 1 }),
    { exact: 0, related: 0, caution: 0, review: 0 },
  );
}

function shouldExpandByDefault(kinds: MatchKind[], selectedCount: number) {
  const counts = countMatches(kinds);
  return selectedCount === 0 || counts.caution > 0 || counts.review > 0;
}

function searchText(value: string) {
  const normalized = normalizeAddress(value).toLowerCase();
  return `${normalized} ${normalized.replace(/\s+/g, '')}`;
}

function matchesSearch(value: string, query: string) {
  if (!query) return true;
  const needle = searchText(query);
  return searchText(value).includes(needle);
}

function recordSearchText(rowAddress: string, record: PropertyRecord, kind: MatchKind) {
  return [
    rowAddress,
    record.pin,
    record.pinFmt,
    record.type,
    record.address,
    record.roadAddr,
    record.building,
    record.floor,
    record.room,
    record.useCls,
    MATCH_LABELS[kind],
  ].join(' ');
}

function matchesResultFilter(kind: MatchKind, selected: boolean, filter: ResultFilter) {
  if (filter === 'all') return true;
  if (filter === 'selected') return selected;
  return kind === filter;
}

export default function App() {
  const [input, setInput] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});
  const [searchTerm, setSearchTerm] = useState('');
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all');
  const [running, setRunning] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [landInfo, setLandInfo] = useState<Record<string, LandInfo>>({}); // pin → 공시지가·토지등급
  const [landLoading, setLandLoading] = useState(false);
  const [landDownloading, setLandDownloading] = useState(false);

  // 전체 주소 통합 레코드 (고유번호 기준 중복 제거) — 다운로드용
  const exportRecords = useMemo(() => {
    const seen = new Set<string>();
    const records: PropertyRecord[] = [];
    for (const r of rows) {
      const selected = new Set(r.selectedPins);
      for (const rec of r.records)
        if (selected.has(rec.pin) && !seen.has(rec.pin)) { seen.add(rec.pin); records.push(rec); }
    }
    return records;
  }, [rows]);

  const done = rows.filter((r) => r.status === 'done' || r.status === 'error').length;

  async function onCollect() {
    const addresses = input.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!addresses.length) return;
    setRunning(true);
    setExpandedRows({});
    setLandInfo({});
    setRows(addresses.map((a) => ({ address: a, status: 'pending', records: [], selectedPins: [], total: 0 })));

    const update = (i: number, patch: Partial<Row>) =>
      setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

    const landItems: { key: string; address: string }[] = [];

    let next = 0;
    const worker = async () => {
      while (next < addresses.length) {
        const i = next++;
        update(i, { status: 'loading' });
        try {
          const res = await collect({ address: addresses[i] });
          if (res.ok) {
            const kinds = res.records.map((rec) => classifyRecord(addresses[i], rec));
            const selectedPins = res.records
              .filter((_, idx) => shouldSelectByDefault(kinds[idx]))
              .map((rec) => rec.pin);
            setExpandedRows((prev) => ({ ...prev, [i]: shouldExpandByDefault(kinds, selectedPins.length) }));
            update(i, { status: 'done', records: res.records, selectedPins, total: res.total });
            // 토지만 공시지가·토지등급 대상으로 수집
            for (const rec of res.records)
              if (rec.type === '토지') landItems.push({ key: rec.pin, address: rec.address });
          }
          else {
            setExpandedRows((prev) => ({ ...prev, [i]: true }));
            update(i, { status: 'error', error: res.error });
          }
        } catch (e: any) {
          setExpandedRows((prev) => ({ ...prev, [i]: true }));
          update(i, { status: 'error', error: e?.message ?? '오류' });
        }
        if (next < addresses.length) await sleep(PACE_MS); // 주소 간 페이싱
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, addresses.length) }, worker));
    setRunning(false);

    // 토지 공시지가·토지등급 조회 → 컬럼 채움
    if (landItems.length) {
      setLandLoading(true);
      try {
        const res = await fetchLandInfo({ items: landItems });
        if (res.ok) {
          setLandInfo(Object.fromEntries(res.results.map((r) => [r.key, r])));
        }
      } finally {
        setLandLoading(false);
      }
    }
  }

  // 선택된 토지 중 공시지가/토지등급 데이터가 있는 것
  const selectedLands = useMemo(
    () => exportRecords.filter((rec) => rec.type === '토지' && landInfo[rec.pin]).map((rec) => landInfo[rec.pin]),
    [exportRecords, landInfo],
  );

  async function onLandDownload() {
    if (!selectedLands.length) return;
    setLandDownloading(true);
    try {
      printLandPdf(selectedLands);
    } finally {
      setLandDownloading(false);
    }
  }

  function setSelectedPins(rowIndex: number, selectedPins: string[]) {
    setRows((prev) => prev.map((r, idx) => (idx === rowIndex ? { ...r, selectedPins } : r)));
  }

  function toggleExpanded(rowIndex: number) {
    setExpandedRows((prev) => ({ ...prev, [rowIndex]: !prev[rowIndex] }));
  }

  function togglePin(rowIndex: number, pin: string) {
    const row = rows[rowIndex];
    if (!row) return;
    const selected = new Set(row.selectedPins);
    if (selected.has(pin)) selected.delete(pin);
    else selected.add(pin);
    setSelectedPins(rowIndex, Array.from(selected));
  }

  function selectSuggested(rowIndex: number) {
    const row = rows[rowIndex];
    if (!row) return;
    setSelectedPins(
      rowIndex,
      row.records
        .filter((rec) => shouldSelectByDefault(classifyRecord(row.address, rec)))
        .map((rec) => rec.pin),
    );
  }

  function selectAll(rowIndex: number) {
    const row = rows[rowIndex];
    if (!row) return;
    setSelectedPins(rowIndex, row.records.map((rec) => rec.pin));
  }

  function clearSelection(rowIndex: number) {
    setSelectedPins(rowIndex, []);
  }

  async function onDownload() {
    if (!exportRecords.length) return;
    setDownloading(true);
    try {
      await downloadBatches(exportRecords);
    } finally {
      setDownloading(false);
    }
  }

  const nBatch = batchCount(exportRecords.length);
  const query = searchTerm.trim();
  const filtersActive = Boolean(query) || resultFilter !== 'all';
  const visibleRows = rows
    .map((r, i) => {
      const selected = new Set(r.selectedPins);
      const selectedCount = r.records.filter((rec) => selected.has(rec.pin)).length;
      const classifiedRecords = r.records.map((rec) => ({ rec, kind: classifyRecord(r.address, rec) }));
      const visibleClassifiedRecords = classifiedRecords.filter(({ rec, kind }) =>
        matchesResultFilter(kind, selected.has(rec.pin), resultFilter) &&
        matchesSearch(recordSearchText(r.address, rec, kind), query),
      );
      const matchCounts = countMatches(classifiedRecords.map((x) => x.kind));
      const rowMatches = r.status === 'done'
        ? (r.records.length === 0
          ? resultFilter === 'all' && matchesSearch(`${r.address} 결과 없음`, query)
          : visibleClassifiedRecords.length > 0)
        : resultFilter === 'all' && matchesSearch(`${r.address} ${r.error ?? ''} ${r.status}`, query);
      const expanded = filtersActive || (expandedRows[i] ?? false);

      return {
        row: r,
        index: i,
        selected,
        selectedCount,
        classifiedRecords,
        visibleClassifiedRecords,
        matchCounts,
        expanded,
        visible: rowMatches,
      };
    })
    .filter((item) => item.visible);

  function clearFilters() {
    setSearchTerm('');
    setResultFilter('all');
  }

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>부동산고유번호 조회</h1>
          <p className="sub">주소를 줄바꿈으로 여러 건 입력하세요. 시·도 없이 주소만 넣어도 됩니다.</p>
        </div>
        <div className="top-actions">
          <button className="dl" onClick={onDownload} disabled={!exportRecords.length || downloading}>
            {downloading ? '생성 중…' : `엑셀 다운로드 (${exportRecords.length}건 · ${nBatch}개 batch${nBatch > 1 ? ' zip' : ''})`}
          </button>
          <button
            className="dl land"
            onClick={onLandDownload}
            disabled={!selectedLands.length || landDownloading || landLoading}
            title="선택한 토지의 공시지가+토지등급을 하나의 PDF로"
          >
            {landLoading ? '토지정보 조회 중…' : landDownloading ? '생성 중…' : `토지 다운로드 (${selectedLands.length}필지 PDF)`}
          </button>
        </div>
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

      {rows.length > 0 && (
        <div className="filters">
          <input
            className="filter-search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="주소, 도로명, 고유번호, 동/호"
          />
          <div className="filter-segments" role="group" aria-label="결과 필터">
            {FILTER_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={resultFilter === option.value ? 'active' : undefined}
                onClick={() => setResultFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button type="button" className="filter-reset" onClick={clearFilters} disabled={!filtersActive}>
            초기화
          </button>
        </div>
      )}

      <div className="results">
        {visibleRows.length === 0 && rows.length > 0 && (
          <div className="empty-filter">조건에 맞는 결과가 없습니다.</div>
        )}

        {visibleRows.map(({ row: r, index: i, selected, selectedCount, visibleClassifiedRecords, matchCounts, expanded }) => {
          return (
            <section key={i} className={`card ${r.status} ${expanded ? 'expanded' : 'collapsed'}`}>
              <button
                type="button"
                className="card-head"
                onClick={() => toggleExpanded(i)}
                aria-expanded={expanded}
                aria-controls={`result-panel-${i}`}
              >
                <div className="head-main">
                  <span className="addr">{r.address}</span>
                  {r.status === 'done' && r.records.length > 0 && (
                    <span className="select-summary">선택 {selectedCount}/{r.records.length}건</span>
                  )}
                  {r.status === 'done' && r.records.length > 0 && (
                    <span className="match-counts">
                      {MATCH_ORDER.filter((kind) => matchCounts[kind] > 0).map((kind) => (
                        <span key={kind} className={`match-count ${kind}`}>
                          {MATCH_LABELS[kind]} {matchCounts[kind]}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <span className="head-side">
                  <span className={`badge ${r.status}`}>
                    {r.status === 'pending' && '대기'}
                    {r.status === 'loading' && '조회 중…'}
                    {r.status === 'done' && `${r.records.length}건`}
                    {r.status === 'error' && '실패'}
                  </span>
                  <span className="chevron" aria-hidden="true" />
                </span>
              </button>

              {expanded && (
                <div id={`result-panel-${i}`} className="card-panel">
                  {r.status === 'error' && <div className="err-msg">{r.error}</div>}

                  {r.status === 'done' && r.records.length === 0 && <div className="err-msg">결과 없음</div>}

                  {r.status === 'done' && r.records.length > 0 && (
                    <>
                      <div className="record-toolbar">
                        <span>정확·관련 결과가 기본 선택됩니다.</span>
                        <div className="record-actions">
                          <button type="button" onClick={() => selectSuggested(i)}>정확·관련 선택</button>
                          <button type="button" onClick={() => selectAll(i)}>전체선택</button>
                          <button type="button" onClick={() => clearSelection(i)}>전체해제</button>
                        </div>
                      </div>

                      <div className="table-wrap">
                        <table className="records-table">
                          <thead>
                            <tr>
                              <th className="check-col">선택</th>
                              <th>매칭</th>
                              <th>고유번호</th>
                              <th>유형</th>
                              <th>부동산표시</th>
                              <th>공시지가</th>
                              <th>토지등급</th>
                            </tr>
                          </thead>
                          <tbody>
                            {visibleClassifiedRecords.map(({ rec, kind }) => {
                              const checked = selected.has(rec.pin);
                              return (
                                <tr key={rec.pin} className={checked ? 'selected-row' : undefined}>
                                  <td className="check-col">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => togglePin(i, rec.pin)}
                                      aria-label={`${rec.pinFmt} 선택`}
                                    />
                                  </td>
                                  <td><span className={`match ${kind}`}>{MATCH_LABELS[kind]}</span></td>
                                  <td className="pin">{rec.pinFmt}</td>
                                  <td>{rec.type}</td>
                                  <td className="addr-cell">
                                    <div>{rec.address}</div>
                                    {(rec.roadAddr || rec.floor || rec.room) && (
                                      <div className="record-meta">
                                        {[rec.roadAddr, rec.floor && `${rec.floor}층`, rec.room && `${rec.room}호`]
                                          .filter(Boolean)
                                          .join(' · ')}
                                      </div>
                                    )}
                                  </td>
                                  {(() => {
                                    if (rec.type !== '토지') return (<><td className="land-cell">-</td><td className="land-cell">-</td></>);
                                    const li = landInfo[rec.pin];
                                    if (!li) return (<><td className="land-cell">{landLoading ? '조회 중…' : '-'}</td><td className="land-cell">{landLoading ? '조회 중…' : '-'}</td></>);
                                    const jiga = li.jiga[0];
                                    const grade = li.grade[0];
                                    return (
                                      <>
                                        <td className="land-cell num">
                                          {jiga ? <><strong>{won(jiga.price)}</strong><span className="land-sub">{jiga.year}년</span></> : '없음'}
                                        </td>
                                        <td className="land-cell">
                                          {grade ? <><strong>{grade.grade}</strong><span className="land-sub">{grade.changeDate}</span></> : '없음'}
                                        </td>
                                      </>
                                    );
                                  })()}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}
