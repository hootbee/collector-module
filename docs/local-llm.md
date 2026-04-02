# Local LLM Usage

## 현재 상태

현재 백엔드는 로컬 LLM 없이 동작한다.

즉:

- 데이터 분석은 로컬 LLM을 사용하지 않는다.
- 도메인 추천도 현재는 로컬 LLM을 사용하지 않는다.
- 키워드 확장과 검색 질의 생성도 현재는 로컬 LLM을 사용하지 않는다.

현재 구현은 전부 규칙 기반 대체 로직이다.

추가로 현재 서버는 선택적 LLM provider를 붙일 수 있도록 확장되었다.

즉 현재 선택지는 아래 두 가지다.

```text
1. 로컬 LLM 없음 -> 규칙 기반 추천
2. OpenAI 또는 OpenAI-compatible/vLLM provider 사용 -> LLM 추천 + 실패 시 규칙 기반 fallback
```

## 로컬 LLM을 사용하지 않는 영역

아래 단계는 원칙적으로 로컬 LLM 없이 가는 것이 맞다.

```text
CSV 파싱
결측치 계산
클래스 불균형 계산
회귀 타깃 통계 계산
메타 컬럼 후보 계산
```

이 단계는 결정적이고 재현 가능한 통계 계산이므로,
로컬 LLM을 붙일 이유가 거의 없다.

관련 구현:

- `backend/src/common/csv.ts`
- `backend/src/profiling/profiling.service.ts`

## 로컬 LLM을 사용할 수 있는 영역

로컬 LLM이 준비되면 아래 역할에만 붙이는 것이 적절하다.

```text
사용자 description 요약
도메인 후보 생성
추천 근거 문장 정리
키워드 확장
검색 질의 생성
크롤링 결과 요약문 정리
```

즉 로컬 LLM은 현재 프로젝트에서
`분석 엔진`이 아니라 `추천/검색 보조기`에 가깝다.

## 현재 코드에서 로컬 LLM 대체 지점

현재 가장 직접적인 교체 지점은 아래 파일이다.

```text
backend/src/domain-recommendation/domain-recommendation.service.ts
```

이 파일은 현재:

- rule-based keyword extraction
- domain scoring
- expandedKeywords 생성
- generatedQueries 생성

을 담당한다.

로컬 LLM을 붙일 경우, 가장 먼저 바뀌는 영역은 이 서비스다.

현재 LLM provider를 붙인 구현은 아래 파일에 들어 있다.

```text
backend/src/llm/openai-recommendation.service.ts
```

## 추천되는 연결 방식

현재 구조를 크게 바꾸지 않으려면 다음 방식이 적절하다.

### 1. 서비스 경계는 유지

- controller는 그대로 둔다
- response contract도 그대로 둔다
- 내부 구현만 규칙 기반에서 LLM 기반으로 교체한다

즉 외부 API는 그대로 유지하고,
내부 추천 생성기만 바꾼다.

### 2. 규칙 기반 fallback 유지

로컬 LLM 연결이 불안정할 수 있으므로:

- LLM 호출 실패 시
- timeout 발생 시
- 출력 파싱 실패 시

현재 rule-based recommendation으로 fallback하는 구조가 좋다.

## 권장 LLM 입력

로컬 LLM에 넘길 입력은 아래 수준이면 충분하다.

```text
dataset description
column names
target columns
task type
metadata columns
missing/imbalance summary 요약
```

원본 rows 전체를 그대로 넣는 것은 권장하지 않는다.

이유:

- 컨텍스트 낭비
- 개인정보/민감 정보 위험
- 재현성 저하

## 권장 LLM 출력

현재 API 계약을 유지하려면 LLM 출력도 아래 구조로 정리하는 것이 맞다.

```text
recommendedDomains
evidenceSummary
expandedKeywords
generatedQueries
```

즉 LLM 출력은 자유문보다는 구조화 JSON 형태가 적합하다.

## 로컬 LLM을 아직 쓰지 않는 이유

현재 단계에서 로컬 LLM이 미연결인 상태를 고려하면:

- 먼저 서버 API 계약을 고정하는 것이 우선
- 프론트와 연결 가능한 응답 구조를 확보하는 것이 우선
- discovery job 흐름을 먼저 검증하는 것이 우선

따라서 현재 구현은:

```text
규칙 기반으로 전체 파이프라인 동작 보장
-> 이후 로컬 LLM 또는 OpenAI 준비되면 recommendation layer만 교체/확장
```

전략으로 가는 것이 맞다.

## 향후 확장 후보

로컬 LLM이 붙은 뒤 확장 가능한 부분:

- 더 자연스러운 도메인 설명문 생성
- 사용자 description의 요약/정규화
- 다국어 키워드 확장
- 검색 질의 다변화
- 수집 후보 요약문 품질 향상

하지만 아래는 이번 단계에서도, 다음 단계에서도 쉽게 LLM 중심으로 가면 안 된다.

```text
정합성 최종 판정
실제 병합 가능 여부 확정
성능 검증 결론
합성 데이터 생성 품질 판정
```

이 영역은 통계/규칙/검증 로직이 중심이어야 한다.
