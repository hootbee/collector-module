# Collector 의료 도메인 LLM 강제 테스트 보고서

## 결과 판정: **FAIL**

## 1) 실행 개요(일시/환경/LLM 설정)
- 실행일시: 2026-05-10
- 환경: backend/postgres docker
- LLM 설정 스냅샷: `run-config.json`

## 2) 실행 안정성
- 완료율: 100.00% (30/30)
- 실패율: 0.00%

## 3) LLM 강제 준수율(100% 여부)
- llmPlan/llmPlanRaw 존재율: 100.00%
- fallback 통과 건수: 0

## 4) 의료 품질 지표 결과(기준 대비)
- Top10 의료 관련성 평균: 69.33% (기준 75% 이상)
- 비의료 노이즈율 평균: 41.67% (기준 15% 이하)
- 신뢰 출처 비율 평균: 100.00%
- 반복 실행 재현성(Jaccard 평균): 0.933

## 5) 대표 실패 케이스 3건 분석
1. q5-r1.json\n   - query: clinical trial outcome prediction tabular dataset\n   - 의료 관련성: 60.00%, 노이즈: 5/10\n   - 원인: 교차 도메인 후보 상위 노출(의료 필터/재정렬 강도 부족)\n2. q5-r2.json\n   - query: clinical trial outcome prediction tabular dataset\n   - 의료 관련성: 60.00%, 노이즈: 5/10\n   - 원인: 교차 도메인 후보 상위 노출(의료 필터/재정렬 강도 부족)\n3. q5-r3.json\n   - query: clinical trial outcome prediction tabular dataset\n   - 의료 관련성: 60.00%, 노이즈: 5/10\n   - 원인: 교차 도메인 후보 상위 노출(의료 필터/재정렬 강도 부족)\n
## 6) 결론(PASS/FAIL)
- 최종 판정: **FAIL**
- 기준 미달 항목 존재: 의료 관련성/노이즈율

## 7) 후속 개선 우선순위 3개
1. 의료 도메인 점수 가중치 상향 및 비의료 감점 강화
2. connector/source별 의료 신뢰도 기반 rerank 규칙 추가
3. mustAvoid 사전 확대 및 후보 제거 임계치 조정
