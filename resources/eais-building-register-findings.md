# EAIS Building Register Findings

This note supplements `EAIS_BUILDING_REGISTER_AUTOMATION_NOTES.md` with values confirmed from the EAIS Nuxt bundles, read-only API probes, and one user-approved read-application probe on 2026-07-09.

## Required Register Types

Only these register types are required for this project:

| Project type | EAIS condition | Report name |
|---|---|---|
| General building | `regstrKindCd = "2"` and `mjrfmlyYn = "N"` | `djrBldrgstGnrl` |
| Multi-family house | `regstrKindCd = "2"` and `mjrfmlyYn = "Y"` | `djrMjrFmlyHoArea` |
| Exclusive unit | `regstrKindCd = "4"` | `djrBldexpos` |

Confirmed report-name branch from EAIS `$callBciReportViewer`:

```text
bldrgstCurdiGbCd = "0"
regstrKindCd = "2", mjrfmlyYn = "N" -> djrBldrgstGnrl
regstrKindCd = "2", mjrfmlyYn = "Y" -> djrMjrFmlyHoArea
regstrKindCd = "4"                  -> djrBldexpos
```

## Candidate Lookup

The stable path should use parsed legal-dong/lot values rather than relying on Elasticsearch `_id`.

### Main register lookup

```http
POST https://m.eais.go.kr/bci/BCIAAA02R01
```

Payload shape:

```json
{
  "addrGbCd": "0",
  "inqireGbCd": "0",
  "bldrgstCurdiGbCd": "0",
  "bldrgstSeqno": "",
  "reqSigunguCd": "11680",
  "sidoClsfCd": "",
  "bjdongCd": "10100",
  "platGbCd": "0",
  "mnnm": "713",
  "slno": "11",
  "splotNm": "",
  "blockNm": "",
  "lotNm": "",
  "roadNmCd": "",
  "bldMnnm": "",
  "bldSlno": "",
  "sigunguCd": "11680"
}
```

Response field:

```text
jibunAddr[]
```

Use:

```text
general      -> jibunAddr where regstrKindCd = "2" and mjrfmlyYn = "N"
multi-family -> jibunAddr where regstrKindCd = "2" and mjrfmlyYn = "Y"
title parts  -> jibunAddr where regstrKindCd = "3"; use these to fetch exclusive units
```

### Exclusive-unit lookup

```http
POST https://m.eais.go.kr/bci/BCIAAA02R04
```

Payload shape:

```json
{
  "inqireGbCd": "0",
  "reqSigunguCd": "11680",
  "bldrgstCurdiGbCd": "0",
  "upperBldrgstSeqno": "10241615",
  "bldrgstSeqno": ""
}
```

Response field:

```text
findExposList[]
```

Match exclusive units by `dongNm` and `hoNm` when those are available from the input address.

## Basket Payload

Endpoint:

```http
POST https://m.eais.go.kr/bci/BCIAAA02C01
```

Payload shape confirmed from the EAIS list page:

```json
{
  "bldrgstSeqno": "...",
  "regstrGbCd": "2",
  "regstrKindCd": "2",
  "mjrfmlyIssueYn": "N",
  "locSigunguCd": "...",
  "locBjdongCd": "...",
  "locPlatGbCd": "...",
  "locDetlAddr": "...",
  "locMnnm": "...",
  "locSlno": "...",
  "locDongNm": "...",
  "locFlrNm": "...",
  "locHoNm": "...",
  "locBldNm": "...",
  "ownrYn": "...",
  "multiUseBildYn": "...",
  "bldrgstCurdiGbCd": "0"
}
```

Notes:

- `regstrGbCd` is set from `regstrKindCd` in the EAIS client.
- `mjrfmlyIssueYn` must default to `"N"` unless the source candidate says `"Y"`.
- EAIS enforces a maximum of five basket items per application.

## Basket Cleanup

Confirmed endpoints:

```http
POST https://m.eais.go.kr/bci/BCIAAA02R05
POST https://m.eais.go.kr/bci/BCIAAA02D01
POST https://m.eais.go.kr/bci/BCIAAA02D02
```

Payloads:

```json
{ "pbsvcResveDtlsSeqno": "..." }
```

```json
{ "lastUpdusrId": "..." }
```

The list page calls `BCIAAA02R05` without a body in the logged-in flow, but the application page also uses `{ "lastUpdusrId": membId }`.

## Application Submission

Endpoint:

```http
POST https://m.eais.go.kr/bci/BCIAZA02S01
```

Minimal read payload shape from the EAIS application page:

```json
{
  "pbsvcResveDtls": [],
  "ownrExprsYn": "N",
  "bldrgstGbCd": "1",
  "pbsvcRecpInfo": {
    "pbsvcGbCd": "01",
    "issueReadGbCd": "1",
    "certDn": null,
    "pbsvcResveDtlsCnt": 0
  },
  "appntInfo": {
    "appntGbCd": "",
    "appntJmno": "",
    "appntBizno": "",
    "appntNm": "",
    "appntMtelno": "",
    "appntSigunguCd": "",
    "naAppntBjdongCd": "",
    "naAppntRoadCd": "",
    "naAppntMnnm": "",
    "naAppntSlno": "",
    "naAppntGrndUgrndGbCd": "",
    "naAppntDetlAddr": "",
    "appntCorpno": "",
    "appntCoprNm": ""
  },
  "indvGbCd": ""
}
```

`issueReadGbCd = "1"` is read/view. `issueReadGbCd = "0"` is issue/certified output.

## Application History And Report Viewer

Application history:

```http
POST https://m.eais.go.kr/bci/BCIAAA06R01
```

Confirmed default body:

```json
{
  "membNo": "",
  "pbsvcGbCd": "",
  "progStateFlagArr": ["01"],
  "pbsvcProcessGbCd": "",
  "firstSaveStartDate": "YYYY-MM-DD",
  "firstSaveEndDate": "YYYY-MM-DD",
  "pageNo": 0,
  "recordSize": 10,
  "pageYn": "N"
}
```

The EAIS client opens the building-register report viewer with:

```text
/report/BCIAAA04V01?param=<AES encrypted payload>&actionId=BCIAAA04L01
```

The encrypted payload is built from:

```text
FileName
markAnyYn
actionIdParam
bldrgstCurdiGbCd
issueReadAppDate
pbsvcRecpNo
mgmNo
ISSUE_READ_GB_CD
BLDRGST_GB_CD
FILE_ID and other count fields from:
  POST /report/BCIAAA06R03
  POST /bci/BCIAAA06R03
```

### Confirmed viewer-internal PDF flow

The viewer HTML loads:

```html
<script src="./js/html2xml.min.js"></script>
```

For building-register read applications it calls:

```text
html2xmlDwg('targetDiv1', 'BCIAAA04L01', parameter)
```

`html2xmlDwg` decrypts `parameter` with CryptoJS AES passphrase `cloud.cais.go.kr`, builds an OOF document, and creates a ClipReport report using:

```http
POST https://m.eais.go.kr/report/RPTCAA02R01
Content-Type: application/x-www-form-urlencoded

isEncoding=false
isBigData=false
isMemoryDump=false
ClipID=R01
oof=<OOF XML>
```

The OOF for current building registers uses:

```text
file: type='crf.root', path='%root%/crf/bci/<reportName>.crf'
connection: type='file', namespace='XML1'
connection path: /cais_data/issue/YYYY/MM/DD/<pbsvcRecpNo>/<pbsvcRecpNo>.xml
field FILE_PATH: /cais_data/issue/YYYY/MM/DD/<pbsvcRecpNo>/<pbsvcRecpNo>.png
fields SVR_GB/SVR_HOST: GET /report/RPTCAA02R06
```

After `R01` returns `uid`, poll:

```http
POST https://m.eais.go.kr/report/RPTCAA02R01
Content-Type: application/x-www-form-urlencoded

ClipID=R03
uid=<uid>
clipUID=<uid>
s_time=t<millisecond>
```

When `endReport=true` and `count>0`, PDF export works with:

```http
POST https://m.eais.go.kr/report/RPTCAA02R01
Content-Type: application/x-www-form-urlencoded

ClipID=R09
uid=<uid>
clipUID=<uid>
path=/report
optionValue=<JSON export option>
exportN=<base64 encoded filename>
exportType=2
is_ie=false
```

`optionValue` shape:

```json
{
  "exportType": 2,
  "name": "<base64 encoded filename>",
  "pageType": 1,
  "startNum": 1,
  "endNum": 4,
  "option": {
    "isSplite": false,
    "spliteValue": 1,
    "fileNames": [],
    "userpw": "",
    "textToImage": false,
    "importOriginImage": false,
    "removeHyperlink": false
  }
}
```

Confirmed live result from the user-approved probe:

```text
Application: issueReadGbCd=1, progStateNm=완료
R01: status=true, server version=1.0.0.599
R03: ready after 2 polls, count=4
R09: application/octet-stream, 244715 bytes, PDF magic=%PDF
pdfinfo: 4 pages, A4 landscape, unencrypted
```

Temporary verification artifacts were written outside the repo:

```text
/private/tmp/eais-viewer-valid.html
/private/tmp/eais-building-register.oof.xml
/private/tmp/eais-r01-response.txt
/private/tmp/eais-building-register.pdf
```

## Implementation Risks To Handle

- EAIS basket submission has a side effect: it creates a real read application. The worker should avoid duplicate submissions by grouping selected records into batches and recording each `pbsvcRecpNo` before starting PDF generation.
- EAIS allows up to five basket items per application. Larger user selections need chunking.
- The report viewer parameter expires after roughly 10 minutes because `html2xmlDwg` rejects old `timestamp` values. Server-side generation should build the OOF directly instead of depending on a stale viewer URL.
- The PDF step is asynchronous. Always run `R01`, poll `R03`, then call `R09`; do not assume `R01` completion means the PDF is ready.
- `R09` returns `application/octet-stream`, not `application/pdf`; detect success by `%PDF` bytes and non-trivial size.
- Current proof used `issueReadGbCd=1` read mode. Certified issue mode (`issueReadGbCd=0`) sets `markAnyYn=Y` and may require privacy/download-reason flows, so keep this project to read/view unless requirements change.

## Read-only Probe Results

### General building

Input: `서울특별시 중구 세종대로 110`

Result:

```text
BCIAAA02R01 -> S00000, 2 candidates
first candidate: bldrgstSeqno=10031100209993, regstrKindCd=2, mjrfmlyYn=N
```

### Exclusive unit

Input: `역삼동 713-11 204동 1902호`

Result:

```text
BCIAAA02R01 -> S00000, 8 candidates
204동 title candidate: bldrgstSeqno=10241615, regstrKindCd=3
BCIAAA02R04 -> S00000, 60 exclusive-unit candidates
target: bldrgstSeqno=10241169823, regstrKindCd=4, dongNm=204동, hoNm=1902호
```

### Multi-family note

Input `백현동 502-9` returned `regstrKindCd=2, mjrfmlyYn=N`, so it is a general-building example, not a multi-family example.

The implementation should still support multi-family by selecting candidates where `regstrKindCd=2` and `mjrfmlyYn=Y`.
