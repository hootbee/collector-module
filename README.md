# Backend

이 백엔드는 **collection 전용 수집 서버**입니다.  
사용자가 검색 의도(`query`)를 넘기면 외부 source에서 dataset/knowledge 후보를 수집하고, raw hit와 정규화된 메타데이터를 함께 저장합니다.

현재 범위:

- collection job 생성
- 외부 source 수집
- raw/normalized 결과 저장
- source별 provenance 저장
- collection 전용 LLM planner
- structured source 우선 + generic web fallback

현재 범위 밖:

- 파일 업로드
- 데이터 분석
- 도메인 추천
- 모델 성능 비교
- 합성 데이터 생성

## 실행 환경

- Node.js 20+
- npm
- TypeScript / Nest.js

일부 source는 추가 도구나 인증이 필요합니다.

## 설치

```bash
cd backend
npm install
```

## 실행

```bash
cd backend
npm run start:dev
```

기본 주소:

- `http://127.0.0.1:8787`

watch 모드:

```bash
npm run start:watch
```

## API

- `GET /api/v1/health`
- `POST /api/v1/collection/jobs`
- `GET /api/v1/collection/jobs/:jobId`
- `GET /api/v1/collection/jobs/:jobId/results`

## Collection 요청 형식

현재 collection은 **파일이나 dataset URL을 입력받지 않습니다.**  
입력은 검색용 query와 source 선택입니다.

예시:

```json
{
  "query": "text provenance benchmark dataset",
  "kind": "both",
  "sources": ["huggingface", "openml", "uci", "kaggle", "serpapi", "crossref"],
  "mustInclude": ["text", "benchmark"],
  "mustAvoid": ["clinical", "fraud"]
}
```

필드 설명:

- `query`: 수집 의도
- `kind`: `dataset` | `knowledge` | `both`
- `sources`: 사용할 source 목록
- `mustInclude`: 반드시 포함되면 좋은 키워드
- `mustAvoid`: 피하고 싶은 키워드

## 수집 구조

수집은 2층 구조로 동작합니다.

1. structured source
- Hugging Face
- OpenML
- Kaggle
- UCI
- Crossref
- seed-catalog

2. generic web fallback
- SerpAPI 기반 검색
- known host면 전용 source로 재분류
- unknown host면 generic HTML extraction

원칙:

- structured source를 우선 사용
- 결과가 부족할 때만 generic layer 사용
- generic 결과는 provenance와 source classification을 함께 저장

## Source별 준비 사항

### 1. Hugging Face

기본 public 검색은 토큰 없이도 가능합니다.

필요한 경우:

- gated/private dataset 접근
- 토큰 기반 rate limit 관리

환경변수:

```bash
HF_TOKEN=...
```

### 2. OpenML

공개 메타데이터 조회는 별도 키 없이 동작합니다.

주의:

- 일부 query variant는 `HTTP 412`가 날 수 있음
- 현재는 connector 내부 fallback으로 우회

### 3. Kaggle

Kaggle은 **공식 CLI 기반**으로 수집합니다.  
즉 Node.js 프로젝트지만, Kaggle CLI는 Python 기반이라 별도 설치가 필요합니다.

설치 예시:

```bash
python3 -m pip install --user kaggle
which kaggle
kaggle --help
```

필수 사항:

- `kaggle` 실행 파일이 실제로 있어야 함
- 인증 정보가 준비돼 있어야 함

지원하는 인증 방식:

1. `kaggle.json` 사용
- 보통 `~/.kaggle/kaggle.json`
- 또는 `KAGGLE_CONFIG_DIR`로 경로 지정

2. Kaggle CLI가 읽을 수 있는 토큰/설정 사용

관련 환경변수:

```bash
KAGGLE_API_TOKEN=
KAGGLE_CONFIG_DIR=/absolute/path/to/backend/storage/kaggle
KAGGLE_CLI_PATH=/absolute/path/to/kaggle
```

주의:

- `KAGGLE_API_TOKEN`만으로 충분한지는 환경에 따라 다를 수 있음
- 가장 안정적인 방식은 `kaggle.json` + `KAGGLE_CONFIG_DIR` 또는 기본 경로 사용
- CLI 실행 실패는 collection 전체 실패가 아니라 soft-fail 처리됨

### 4. UCI

UCI는 공식 search API가 아니라 **HTML adapter** 기반입니다.

특징:

- 별도 인증 불필요
- 페이지 구조 변경에 영향받을 수 있음
- 현재는 텍스트 계열 query 기준으로 relevance filter를 넣어둠

### 5. Crossref

Crossref는 knowledge source입니다.

권장 환경변수:

```bash
CROSSREF_MAILTO=your-email@example.com
```

의미:

- 인증키가 아니라 polite client 식별용 메일 주소
- 실제로 받을 수 있는 메일이면 좋음

### 6. SerpAPI

SerpAPI는 generic web/knowledge 검색 source입니다.

환경변수:

```bash
SERPAPI_API_KEY=...
```

용도:

- 웹 전반에서 관련 후보 발견
- generic fallback layer
- structured source를 대체하는 메인 source는 아님

## 환경변수

전체 예시는 [backend/.env.example](/Users/leejunhyeong/Desktop/univ/4-1/capstone/project/backend/.env.example)에 있습니다.

핵심 항목:

```bash
PORT=8787

COLLECTION_HTTP_TIMEOUT_MS=8000
COLLECTION_HTTP_RETRY_COUNT=2
COLLECTION_CONNECTOR_LIMIT_PER_SOURCE=10
COLLECTION_GENERIC_FETCH_LIMIT=6
COLLECTION_FETCHER_USER_AGENT=stage-one-backend/0.1

COLLECTION_ENABLE_SEED_CONNECTOR=true
COLLECTION_ENABLE_HF_CONNECTOR=false
COLLECTION_ENABLE_UCI_CONNECTOR=false
COLLECTION_ENABLE_KAGGLE_CONNECTOR=false
COLLECTION_ENABLE_SERPAPI_CONNECTOR=false
COLLECTION_ENABLE_CROSSREF_CONNECTOR=false
COLLECTION_ENABLE_OPENML_CONNECTOR=false
```

## Collection LLM Planner

collection 모듈 안에서만 query/source-aware planner를 켤 수 있습니다.

예시:

```bash
COLLECTION_LLM_PLANNER_ENABLED=true
COLLECTION_LLM_PROVIDER=openai-compatible
COLLECTION_LLM_BASE_URL=http://210.117.143.180:12020
COLLECTION_LLM_MODEL=openai/gpt-oss-120b
COLLECTION_LLM_API_MODE=chat_completions
COLLECTION_LLM_TIMEOUT_MS=15000
```

현재 동작 원칙:

- planner가 꺼져 있으면 deterministic planner만 사용
- planner가 켜져 있으면 서버 LLM으로 source-aware query 보강 시도
- planner가 켜진 상태에서 **LLM 통신이 실패하면 collection job도 즉시 실패**
- 서버 LLM이 JSON을 깔끔하게 주지 않아도, 현재는 자유서술 응답을 일부 salvage해서 `llmPlan`으로 반영

## Smoke Test

기본 smoke:

```bash
cd backend
npm run collection:smoke
```

상세 출력:

```bash
cd backend
COLLECTION_SMOKE_DETAIL=detailed COLLECTION_SMOKE_SAMPLE_LIMIT=5 npm run collection:smoke
```

상세 모드에서 보이는 것:

- runSettings
- LLM planner 설정
- connector on/off 상태
- datasetQueries / knowledgeQueries
- connector별 성공/실패
- raw hit
- normalized dataset/knowledge item
- provenance 정보

예시:

```bash
cd backend
env \
  COLLECTION_LLM_PLANNER_ENABLED=true \
  COLLECTION_ENABLE_HF_CONNECTOR=true \
  COLLECTION_ENABLE_OPENML_CONNECTOR=true \
  COLLECTION_ENABLE_UCI_CONNECTOR=true \
  COLLECTION_ENABLE_KAGGLE_CONNECTOR=true \
  COLLECTION_ENABLE_SERPAPI_CONNECTOR=true \
  COLLECTION_ENABLE_CROSSREF_CONNECTOR=true \
  COLLECTION_SMOKE_DETAIL=detailed \
  COLLECTION_SMOKE_SAMPLE_LIMIT=3 \
  COLLECTION_SMOKE_QUERY='text provenance benchmark dataset' \
  COLLECTION_SMOKE_SOURCES=huggingface,openml,uci,kaggle,serpapi,crossref \
  npm run collection:smoke
```

## 참고

- 결과에는 `llmPlanRaw`, `llmPlan`, `routedHits`, `fetchedDocuments`, `rawDatasetHits`, `rawKnowledgeHits`가 포함됩니다.
- collection은 실제 데이터 파일을 다운로드하는 모듈이 아니라, **외부 후보와 메타데이터를 수집하는 모듈**입니다.
- 실제 다운로드 단계가 필요하면 source별 downloader를 별도로 붙여야 합니다.
