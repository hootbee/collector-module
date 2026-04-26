# Backend

이 백엔드는 **모듈형 모놀리스 API의 초기 서버**입니다.  
현재는 auth와 collection 모듈을 포함하며, collection은 추후 worker 컨테이너로 분리할 수 있는 수집 모듈입니다.

현재 범위:

- PostgreSQL 연결 및 초기 스키마 적용 smoke
- Google OAuth 기반 auth API
- JWT access token + HttpOnly refresh cookie
- collection job 생성
- 외부 source 수집
- raw/normalized 결과 저장
- 선택한 dataset의 원본 파일 다운로드
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

브라우저 fallback 단독 smoke:

```bash
COLLECTION_BROWSER_FALLBACK_ENABLED=true npm run collection:browser:smoke
```

## API

- `GET /api/v1/health`
- `GET /api/v1/database/health`
- `POST /api/v1/auth/google`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`
- `POST /api/v1/collection/jobs`
- `GET /api/v1/collection/jobs/:jobId`
- `GET /api/v1/collection/jobs/:jobId/results`
- `POST /api/v1/collection/jobs/:jobId/downloads`
- `GET /api/v1/collection/downloads/:downloadJobId`
- `GET /api/v1/collection/downloads/:downloadJobId/results`

## Auth

초기 auth는 API 내부 모듈로 구현되어 있습니다.

- Google Social Login
- access token: Bearer JWT
- refresh token: HttpOnly cookie
- 현재 저장소: in-memory `StoreService`
- 추후 PostgreSQL repository 전환 시 `users`, `oauth_accounts`, `refresh_tokens` 테이블 사용

환경변수:

```bash
AUTH_JWT_SECRET=change-me-to-a-long-random-secret-value
AUTH_REFRESH_TOKEN_SECRET=change-me-to-a-long-random-refresh-secret
AUTH_ACCESS_TOKEN_TTL_SECONDS=900
AUTH_REFRESH_TOKEN_TTL_SECONDS=1209600
AUTH_COOKIE_SECURE=false
AUTH_COOKIE_SAME_SITE=lax
GOOGLE_CLIENT_ID=
```

Google 로그인:

```http
POST /api/v1/auth/google
Content-Type: application/json

{
  "idToken": "google-id-token"
}
```

응답:

```json
{
  "user": {
    "id": "user-...",
    "email": "user@example.com",
    "name": "User",
    "role": "user"
  },
  "accessToken": "...",
  "tokenType": "Bearer",
  "expiresIn": 900
}
```

현재 사용자:

```http
GET /api/v1/auth/me
Authorization: Bearer <accessToken>
```

로컬 smoke:

```bash
npm run auth:smoke
```

## PostgreSQL

PostgreSQL 연결은 `DatabaseModule`에서 관리합니다. 현재는 연결과 초기 스키마 적용 기반을 먼저 붙였고, 기존 in-memory `StoreService`를 PostgreSQL repository로 교체하는 작업은 다음 단계입니다.

환경변수:

```bash
DATABASE_URL=postgres://stage_one:stage_one@127.0.0.1:5432/stage_one
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=stage_one
PGUSER=stage_one
PGPASSWORD=stage_one
DB_POOL_MAX=10
DB_CONNECTION_TIMEOUT_MS=5000
DB_IDLE_TIMEOUT_MS=30000
DB_SSL=false
DB_SSL_REJECT_UNAUTHORIZED=true
```

연결 확인:

```bash
npm run db:smoke
```

초기 스키마까지 적용:

```bash
DB_SMOKE_MIGRATE=true npm run db:smoke
```

로컬 PostgreSQL 컨테이너:

```bash
docker compose -f docker-compose.postgres.yml up -d
```

HTTP health:

```http
GET /api/v1/database/health
```

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

## 원본 데이터 다운로드

collection 결과의 `datasetItems`에는 다음 메타데이터가 포함됩니다.

- `downloadUrl`
- `downloadMethod`
- `downloadHint`
- `downloadReference`

이 정보를 바탕으로 서버가 실제 원본 파일을 다운로드할 수 있습니다.

다운로드 job 생성 예시:

```json
{
  "itemIds": ["hf:ardavey/human-ai-generated-text"],
  "targetDir": "storage/downloads/manual-run",
  "maxFilesPerItem": 2
}
```

호출:

```bash
curl -X POST http://127.0.0.1:8787/api/v1/collection/jobs/<collectionJobId>/downloads \
  -H 'Content-Type: application/json' \
  -d '{
    "itemIds": ["hf:ardavey/human-ai-generated-text"],
    "targetDir": "storage/downloads/manual-run",
    "maxFilesPerItem": 2
  }'
```

다운로드 결과에는 실제 저장된 파일 경로가 포함됩니다.

예:

```json
{
  "itemResults": [
    {
      "itemId": "hf:ardavey/human-ai-generated-text",
      "status": "completed",
      "targetDir": "/abs/path/backend/storage/downloads/manual-run/Hugging-Face/...",
      "files": [
        {
          "fileName": "train-00000-of-00001.parquet",
          "path": "/abs/path/backend/storage/downloads/manual-run/Hugging-Face/.../train-00000-of-00001.parquet",
          "bytes": 69276
        }
      ]
    }
  ]
}
```

지원 방식:

- Hugging Face: hub API로 데이터 파일 목록을 찾은 뒤 실제 파일 다운로드
- OpenML: OpenML data URL 또는 API 기반 다운로드
- Kaggle: Kaggle CLI `datasets download`
- UCI: dataset page에서 실제 데이터 링크를 추출한 뒤 다운로드
- generic source: direct file URL이 있거나 HTML에서 직접 링크를 찾을 수 있을 때만 다운로드

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
- Serp raw 결과 1차 triage filter(명백한 노이즈 제거)
- known host면 전용 source로 재분류
- unknown host면 generic HTML extraction
- 필요하면 unknown HTML page에 대해서만 collection 전용 LLM planner로 다운로드 링크 후보를 재판단
- HTML fetch 결과가 비어 있거나 메타 신호가 매우 약하면 browser fallback(Playwright/Puppeteer)로 한 번 더 추출

원칙:

- structured source를 우선 사용
- 결과가 부족할 때만 generic layer 사용
- generic 결과는 provenance와 source classification을 함께 저장
- unknown source HTML LLM은 보조 계층이며, structured source를 대체하지 않음
- ordering은 강한 제거보다 soft 우선순위 부여 + obvious duplicate 제거에 초점

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

DATABASE_URL=postgres://stage_one:stage_one@127.0.0.1:5432/stage_one
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=stage_one
PGUSER=stage_one
PGPASSWORD=stage_one
DB_POOL_MAX=10
DB_CONNECTION_TIMEOUT_MS=5000
DB_IDLE_TIMEOUT_MS=30000
DB_SSL=false
DB_SSL_REJECT_UNAUTHORIZED=true

COLLECTION_HTTP_TIMEOUT_MS=15000
COLLECTION_HTTP_RETRY_COUNT=3
COLLECTION_CONNECTOR_LIMIT_PER_SOURCE=20
COLLECTION_GENERIC_FETCH_LIMIT=12
COLLECTION_FETCHER_USER_AGENT=stage-one-backend/0.1
COLLECTION_DOWNLOAD_STORAGE_ROOT=storage/downloads
COLLECTION_DOWNLOAD_MAX_FILES_PER_ITEM=5
COLLECTION_DOWNLOAD_MAX_BYTES=1610612736
COLLECTION_DOWNLOAD_TIMEOUT_MS=300000

COLLECTION_ENABLE_SEED_CONNECTOR=true
COLLECTION_ENABLE_HF_CONNECTOR=false
COLLECTION_ENABLE_UCI_CONNECTOR=false
COLLECTION_ENABLE_KAGGLE_CONNECTOR=false
COLLECTION_ENABLE_SERPAPI_CONNECTOR=false
COLLECTION_ENABLE_CROSSREF_CONNECTOR=false
COLLECTION_ENABLE_OPENML_CONNECTOR=false
COLLECTION_LLM_PLANNER_ENABLED=false
COLLECTION_GENERIC_HTML_LLM_ENABLED=false
COLLECTION_GENERIC_HTML_LLM_STRICT=false
COLLECTION_SERP_FILTER_LLM_ENABLED=false
COLLECTION_SERP_FILTER_LLM_STRICT=false
COLLECTION_SERP_FILTER_HIGH_RECALL=true
COLLECTION_SERP_FILTER_LLM_BATCH_LIMIT=8
COLLECTION_BROWSER_FALLBACK_ENABLED=false
COLLECTION_BROWSER_FALLBACK_STRICT=false
COLLECTION_BROWSER_FALLBACK_ENGINE=auto
COLLECTION_BROWSER_FALLBACK_TIMEOUT_MS=15000
COLLECTION_BROWSER_FALLBACK_WAIT_AFTER_LOAD_MS=600
COLLECTION_SMOKE_WAIT_ATTEMPTS=240
COLLECTION_SMOKE_WAIT_MS=1000
COLLECTION_DOWNLOAD_SMOKE_WAIT_ATTEMPTS=360
COLLECTION_DOWNLOAD_SMOKE_WAIT_MS=1000
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

## Generic HTML LLM Planner

generic 2층 수집에서 unknown host HTML page를 만났을 때만 선택적으로 사용할 수 있습니다.

예시:

```bash
COLLECTION_GENERIC_HTML_LLM_ENABLED=true
COLLECTION_GENERIC_HTML_LLM_STRICT=false
```

동작 원칙:

- structured source에는 적용하지 않음
- unknown generic HTML page에만 적용
- 페이지 안에 실제로 있는 `linkCandidates`만 선택 가능
- URL을 상상해서 만들지 않음

## Browser Fallback (선택)

unknown source HTML에서 일반 fetch만으로 추출 신호가 부족할 때, 최후 수단으로 headless browser를 사용할 수 있습니다.

설치(둘 중 하나):

```bash
npm install playwright
# 또는
npm install puppeteer
```

환경변수:

```bash
COLLECTION_BROWSER_FALLBACK_ENABLED=true
COLLECTION_BROWSER_FALLBACK_STRICT=false
COLLECTION_BROWSER_FALLBACK_ENGINE=auto
COLLECTION_BROWSER_FALLBACK_TIMEOUT_MS=15000
COLLECTION_BROWSER_FALLBACK_WAIT_AFTER_LOAD_MS=600
```

원칙:

- 기본 경로는 direct/html extraction
- browser는 마지막 fallback으로만 사용
- 브라우저 엔진 미설치/실패 시 soft-fail(기본)로 전체 수집은 계속 진행
- 실패 시 기본값은 soft-fail이며 rule-based HTML extraction으로 계속 진행
- `COLLECTION_GENERIC_HTML_LLM_STRICT=true`면 이 planner 실패도 예외로 올림

## Serp Result Triage Filter

SerpAPI 검색 결과에 대해 host routing 전에 1차 후보 정리를 할 수 있습니다.

예시:

```bash
COLLECTION_SERP_FILTER_LLM_ENABLED=true
COLLECTION_SERP_FILTER_LLM_STRICT=false
COLLECTION_SERP_FILTER_HIGH_RECALL=true
COLLECTION_SERP_FILTER_LLM_BATCH_LIMIT=8
```

동작 원칙:

- 명백한 로그인/광고/정책/무관 링크만 보수적으로 제거
- recall을 해치지 않도록 공격적 drop은 지양
- 실패 시 기본은 soft-fail
- strict 모드면 실패를 예외로 처리

## Smoke 테스트

수집 smoke:

```bash
npm run collection:smoke
```

다운로드 smoke:

```bash
npm run collection:download:smoke
```

예시:

```bash
env \
  COLLECTION_ENABLE_HF_CONNECTOR=true \
  COLLECTION_DOWNLOAD_SMOKE_SOURCES=huggingface \
  COLLECTION_DOWNLOAD_SMOKE_QUERY='human ai generated text dataset' \
  COLLECTION_DOWNLOAD_SMOKE_ITEM_MATCH='ardavey' \
  npm run collection:download:smoke
```
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
