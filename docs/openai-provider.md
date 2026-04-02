# LLM Provider

## 목적

현재 backend는 기본적으로 규칙 기반 추천으로 동작한다.

이 문서는 선택적 LLM provider를 붙일 때의 동작과 설정을 설명한다.

## 적용 범위

현재 LLM을 붙이는 영역은 아래뿐이다.

```text
도메인 추천
키워드 확장
검색 질의 생성
추천 근거 문장 정리
```

즉 다음 단계에는 LLM을 쓰지 않는다.

```text
CSV 파싱
결측치 계산
클래스 불균형 계산
회귀 통계 계산
메타 컬럼 후보 계산
```

## 현재 구현 위치

LLM provider 구현:

- `backend/src/llm/openai-recommendation.service.ts`

LLM과 규칙 기반 fallback을 함께 조합하는 서비스:

- `backend/src/domain-recommendation/domain-recommendation.service.ts`

## 동작 방식

현재 추천 흐름은 다음과 같다.

```text
1. rule-based recommendation을 먼저 만들 수 있는 상태를 유지
2. provider 설정이 있으면 LLM 호출 시도
3. LLM이 정상 응답하면 그 결과를 recommendation 응답으로 사용
4. LLM 호출 실패/timeout/파싱 실패 시 rule-based recommendation으로 fallback
```

즉 LLM은 선택적 가속 계층이지,
현재 서버가 LLM 없이는 동작하지 않는 구조는 아니다.

## 환경변수

### provider 종류

```text
rule-based
openai
openai-compatible
vllm
```

### OpenAI 사용 시

```text
LLM_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5-mini
OPENAI_TIMEOUT_MS=30000
```

### OpenAI-compatible 또는 vLLM 사용 시

```text
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://210.117.143.180:12020
LLM_MODEL=openai/gpt-oss-120b
LLM_API_MODE=chat_completions
LLM_TIMEOUT_MS=30000
```

참고:

```text
LLM_API_KEY는 OpenAI-compatible 서버가 무인증이면 비워둘 수 있다.
LLM_API_MODE는 openai면 responses, vLLM이면 chat_completions가 기본값이다.
```

## 기본 모델

현재 기본값:

```text
OpenAI: gpt-5-mini
OpenAI-compatible/vLLM: 환경변수로 지정
```

이유:

- 추천/키워드 확장/질의 생성은 대규모 tool orchestration보다 구조화된 text output이 중요함
- 비용과 속도 측면에서 더 실용적임
- 현재 용도는 모델 학습/평가가 아니라 추천 보조 계층임

## API 방식

provider에 따라 API 방식이 다르다.

요약:

```text
openai -> POST /v1/responses
openai-compatible / vllm -> POST /v1/chat/completions
```

OpenAI는 structured output 형태로 JSON schema를 요구한다.

OpenAI-compatible/vLLM은 JSON 전용 프롬프트를 사용하고,
응답에서 JSON block을 추출해 파싱한다.

현재 서버는 아래 구조를 목표로 응답을 파싱한다.

```text
extractedKeywords
descriptionSignals
recommendedDomains
expandedKeywords
generatedQueries
```

## 현재 응답 조합 방식

LLM이 생성하는 필드:

- `extractedKeywords`
- `descriptionSignals`
- `recommendedDomains`
- `expandedKeywords`
- `generatedQueries`

규칙/통계 기반으로 계속 유지하는 필드:

- `datasetSummary`
- `influentialFeatureColumns`
- `influentialTargetColumns`

즉 현재 recommendation 응답은
LLM 결과와 deterministic 필드를 혼합한 구조다.

## 주의사항

### 1. 분석 단계는 LLM에 넘기지 않는다

분석은 deterministic 해야 한다.

따라서:

- 결측치 계산
- imbalance 계산
- numeric summary 계산

은 계속 서버 내부 통계 로직으로 유지한다.

### 2. 원본 row 전체를 무조건 LLM에 보내지 않는다

현재 프롬프트는 주로 아래 정보만 보낸다.

```text
description
columns
targetColumns
taskType
metadataColumns
missing/imbalance/numeric summary
```

이는 다음 이유 때문이다.

- context 절약
- 민감정보 최소화
- 재현성 개선

### 3. LLM 실패 시 fallback 유지

LLM이 아래 사유로 실패할 수 있다.

- 인증 실패
- timeout
- 네트워크 문제
- 응답 파싱 실패
- JSON schema 위반

이 경우 현재 구현은 rule-based recommendation으로 내려간다.

## 실행 예시

### OpenAI

```bash
export LLM_PROVIDER=openai
export OPENAI_API_KEY=your_api_key
export OPENAI_MODEL=gpt-5-mini
export OPENAI_TIMEOUT_MS=30000
cd backend
npm run start:dev
```

### OpenAI-compatible/vLLM

```bash
export LLM_PROVIDER=openai-compatible
export LLM_BASE_URL=http://210.117.143.180:12020
export LLM_MODEL=openai/gpt-oss-120b
export LLM_API_MODE=chat_completions
export LLM_TIMEOUT_MS=30000
cd backend
npm run smoke
```

## 현재 확인된 사항

원격 서버 `http://210.117.143.180:12020`는 아래 특성을 가진다.

```text
health endpoint 응답 가능
OpenAI-compatible API 노출
/v1/models 조회 가능
chat/completions 호출 가능
```

즉 backend에서 `openai-compatible` provider로 붙일 수 있다.

다만 모델 출력 품질이 불안정할 수 있으므로,
현재 구조처럼 fallback을 유지하는 것이 맞다.

## 참고

OpenAI 공식 문서 기준으로는:

- Responses API 사용
- Structured Outputs 사용

방식이 현재 OpenAI provider 구현 의도와 가장 잘 맞는다.
