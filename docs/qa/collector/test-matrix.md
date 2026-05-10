# Collector 품질 테스트 매트릭스

## 공통 파라미터
- `kind=both`
- Top-K 평가는 `Top10` 기준
- 각 실행 결과는 `templates/results.jsonl`에 1줄 기록

## Query Set (5개)
1. 의료: `icu mortality prediction imbalanced clinical tabular dataset`
2. 금융: `credit card fraud detection highly imbalanced transaction dataset`
3. 텍스트 진위/저자: `authorship verification korean text dataset`
4. 시계열: `electricity load forecasting multivariate time series dataset`
5. 제조: `predictive maintenance anomaly detection sensor dataset`

## Source 조합 코드
- `S1`: `seed-catalog`
- `S2`: `seed-catalog,huggingface-datasets,openml-datasets,uci-datasets`
- `S3`: `seed-catalog,huggingface-datasets,openml-datasets,uci-datasets,serpapi-knowledge,crossref-knowledge`

## Phase 0: Smoke
- 1회 실행
- 조건: planner OFF + S1
- 합격: 작업 완료 + dataset/knowledge 최소 1개 이상

## Phase 1: Planner OFF vs ON (핵심)
- `5 queries x 2(planner off/on) x 3회` = 30 runs
- source: S2 고정
- 목적: 관련성/노이즈/신뢰도/재현성 비교

## Phase 2: Source 비교
- `5 queries x 3(source S1/S2/S3) x 2회` = 30 runs
- planner: ON 고정
- 목적: 결과 수 증가 대비 품질 유지 확인

## Phase 3: 장애/부분 실패
- 3 케이스
1. 특정 connector 비활성
2. 특정 connector timeout 유도
3. 외부 검색 source(serp/crossref) 제거
- 목적: partial result 반환 + connectorStatuses 오류 기록 확인

## 최소 실행 세트 합계
- Smoke 1 + Phase1 30 + Phase2 30 + Phase3 3 = **64 runs**

