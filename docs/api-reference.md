# API Reference

기본 prefix:

```text
/api/v1
```

## 1. Health Check

```text
GET /api/v1/health
```

기능:

- 서버가 정상적으로 떠 있는지 확인한다.

응답:

```json
{
  "status": "ok"
}
```

## 2. Session 생성

```text
POST /api/v1/sessions
```

기능:

- 업로드 작업을 묶는 `sessionId`를 생성한다.
- 이후 dataset upload 요청과 연결되는 작업 단위의 시작점이다.

응답 예시:

```json
{
  "sessionId": "session-8156c272954e",
  "createdAt": "2026-04-01T08:38:28.770Z"
}
```

## 3. Dataset Upload

```text
POST /api/v1/datasets/upload
```

기능:

- CSV 파일 업로드
- CSV 파싱
- 행 수, 열 수, 컬럼 목록 추출
- `targetColumns`, `taskType`, `description` 저장
- `datasetId` 발급
- 원본 CSV를 `backend/storage/uploads` 아래에 저장

요청 형식:

```text
multipart/form-data
```

필드:

```text
sessionId: string
targetColumns: JSON string array
taskType: classification | anomaly | regression
description: string
file: csv file
```

응답 예시:

```json
{
  "sessionId": "session-8156c272954e",
  "datasetId": "dataset-c6ea04a96fae",
  "fileName": "codex-upload-test.csv",
  "rowCount": 3,
  "colCount": 4,
  "columns": ["customer_id", "region", "income", "churn"]
}
```

## 4. Dataset Analyze

```text
POST /api/v1/datasets/:datasetId/analyze
```

기능:

- 업로드된 dataset에 대해 데이터 프로파일링 수행
- 결측치 통계 계산
- classification/anomaly면 클래스 분포와 imbalance ratio 계산
- regression이면 수치형 타깃 기초 통계 계산
- 메타 컬럼 후보 산출

응답 예시:

```json
{
  "sessionId": "session-897ff7767a4b",
  "datasetId": "dataset-6d7daff6408e",
  "fileName": "codex-upload-test-2.csv",
  "rowCount": 3,
  "colCount": 4,
  "columns": ["customer_id", "region", "income", "churn"],
  "targetColumns": ["churn"],
  "taskType": "classification",
  "description": "Repeated terminal upload verification",
  "missingStats": [
    { "column": "customer_id", "missingCount": 0, "totalRows": 3, "missingRate": 0 },
    { "column": "region", "missingCount": 0, "totalRows": 3, "missingRate": 0 },
    { "column": "income", "missingCount": 0, "totalRows": 3, "missingRate": 0 },
    { "column": "churn", "missingCount": 0, "totalRows": 3, "missingRate": 0 }
  ],
  "imbalanceSummary": [
    {
      "col": "churn",
      "stat": {
        "column": "churn",
        "valueCounts": [
          { "value": "no", "count": 2, "ratio": 0.6666666666666666 },
          { "value": "yes", "count": 1, "ratio": 0.3333333333333333 }
        ],
        "distinctCount": 2,
        "minorityRatio": 0.3333333333333333,
        "majorityRatio": 0.6666666666666666,
        "imbalanceRatio": 2,
        "isHighlyImbalanced": false
      }
    }
  ],
  "numericSummary": [],
  "metadataCandidates": ["customer_id", "region", "income"]
}
```

## 5. Domain Recommendation

```text
POST /api/v1/domains/recommend
```

기능:

- `datasetId`와 `metadataColumns`를 받아 도메인 추천 수행
- 현재는 로컬 LLM 없이 규칙 기반 추천으로 동작
- 추천 도메인
- 추천 근거
- 확장 키워드
- 검색 질의
를 생성한다

요청 예시:

```json
{
  "datasetId": "dataset-6d7daff6408e",
  "metadataColumns": ["customer_id", "region", "income"]
}
```

응답 핵심 필드:

```text
datasetSummary
evidenceSummary
recommendedDomains
expandedKeywords
generatedQueries
```

## 6. Discovery Job 생성

```text
POST /api/v1/discovery/jobs
```

기능:

- 외부 후보 수집용 background job 생성
- 입력된 `datasetId`, `metadataColumns`, `selectedDomains`를 바탕으로
  지식 후보와 데이터셋 후보 수집 시작
- 현재는 실제 웹 크롤링이 아니라 카탈로그 기반 커넥터 검색으로 동작

요청 예시:

```json
{
  "datasetId": "dataset-6d7daff6408e",
  "metadataColumns": ["customer_id", "region", "income"],
  "selectedDomains": [
    "Financial anomaly table for sparse event and fraud detection"
  ]
}
```

응답 핵심 필드:

```json
{
  "jobId": "job-...",
  "datasetId": "dataset-...",
  "status": "queued",
  "stage": "waiting"
}
```

## 7. Discovery Job 상태 조회

```text
GET /api/v1/discovery/jobs/:jobId
```

기능:

- discovery job의 현재 상태 확인
- `queued`, `running`, `completed`, `failed`
- 현재 stage
- 현재까지 수집된 knowledge/dataset 개수
- 에러 정보 확인

응답 핵심 필드:

```text
status
stage
knowledgeCount
datasetCount
error
```

## 8. Discovery Job 결과 조회

```text
GET /api/v1/discovery/jobs/:jobId/results
```

기능:

- 수집된 외부 지식 후보 목록 반환
- 수집된 외부 데이터셋 후보 목록 반환
- 생성된 검색 질의와 확장 키워드 반환

응답 핵심 필드:

```text
generatedQueries
expandedKeywords
knowledgeItems
datasetItems
```
