# Backend Pipeline Flow

## 전체 흐름

```text
세션 생성
-> CSV 업로드
-> 데이터 분석
-> 도메인 추천
-> discovery job 생성
-> 상태 polling
-> 후보 결과 조회
```

## 단계별 설명

### 1. 세션 생성

- `SessionsController`가 `sessionId`를 만든다.
- 세션은 업로드 작업 단위를 구분하기 위한 식별자다.

관련 파일:

- `backend/src/sessions/sessions.controller.ts`
- `backend/src/store/store.service.ts`

### 2. CSV 업로드

- `DatasetsController`가 multipart/form-data를 받는다.
- 업로드된 파일은 `parseCsvBuffer`로 파싱한다.
- 행 수, 열 수, 컬럼 목록을 추출한다.
- target/task/description과 함께 dataset record를 저장한다.
- 원본 파일은 `backend/storage/uploads`에 저장한다.

관련 파일:

- `backend/src/datasets/datasets.controller.ts`
- `backend/src/common/csv.ts`
- `backend/src/store/store.service.ts`

### 3. 데이터 분석

- `ProfilingService`가 분석을 수행한다.
- 로컬 LLM은 사용하지 않는다.
- 전부 통계/규칙 기반이다.

분석 항목:

- 결측치 통계
- 클래스 분포
- imbalance ratio
- 회귀 타깃 요약 통계
- 메타 컬럼 후보

관련 파일:

- `backend/src/profiling/profiling.service.ts`

### 4. 도메인 추천

- `DomainRecommendationService`가 추천을 수행한다.
- 현재는 규칙 기반 키워드 추출과 점수화 방식이다.
- description, columns, target, metadataColumns를 함께 사용한다.

산출물:

- `datasetSummary`
- `evidenceSummary`
- `recommendedDomains`
- `expandedKeywords`
- `generatedQueries`

관련 파일:

- `backend/src/domain-recommendation/domain-recommendation.service.ts`
- `backend/src/common/catalog.ts`
- `backend/src/common/text.ts`

### 5. 후보 수집(discovery)

- `DiscoveryService`가 background job을 만든다.
- 내부적으로 지식 후보와 데이터셋 후보를 병렬 수집한다.
- 현재는 실제 웹 크롤링이 아니라 카탈로그 기반 커넥터를 사용한다.

산출물:

- `knowledgeItems`
- `datasetItems`
- `generatedQueries`
- `expandedKeywords`

관련 파일:

- `backend/src/discovery/discovery.service.ts`
- `backend/src/connectors/catalog.connectors.ts`

## 현재 후보 수집 구현 방식

현재 후보 수집은 아래처럼 동작한다.

```text
selectedDomains + expandedKeywords + generatedQueries
-> catalog connectors 점수화
-> 상위 후보 선택
-> 프론트 타입과 맞는 구조로 정규화
-> job 결과로 저장
```

즉 현재는:

- 실제 외부 웹 검색 아님
- 실제 논문/가이드라인 사이트 크롤링 아님
- 실제 데이터 마켓/API 호출 아님

대신 장점은:

- API 계약을 먼저 안정화할 수 있음
- 프론트 연동 전 단계 테스트가 쉬움
- 이후 connector 교체가 쉬움

## 메모리 저장소

현재 저장 방식:

- 세션: 메모리
- dataset 메타/rows: 메모리
- discovery job 상태/결과: 메모리
- 원본 CSV: 파일 저장

주의:

- 서버를 재시작하면 메모리 상태는 초기화된다.
- 따라서 현재 구현은 프로토타입/1차 검증용이다.
