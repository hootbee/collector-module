# Collector Search QA Pack

Collector(Agent AI 웹 검색) 품질 검증용 문서/템플릿 패키지입니다.

## 파일 구성
- `test-matrix.md`: 실행 매트릭스(쿼리, planner, source 조합, 반복)
- `labeling-guide.md`: relevance/noise/trust 라벨링 기준
- `report-template.md`: 최종 결과 보고서 템플릿
- `templates/results.jsonl`: 자동 수집 결과 저장 포맷(1줄 1실행)
- `templates/top10-labels.csv`: Top10 수동/반자동 라벨링 시트
- `templates/summary-metrics.csv`: 집계 지표 요약 시트

## 권장 실행 순서
1. `collection:smoke`로 환경 정상성 확인
2. `test-matrix.md`의 Phase 1~4 순서대로 실행
3. `results.jsonl` 누적
4. `top10-labels.csv` 라벨링
5. `summary-metrics.csv` 지표 계산
6. `report-template.md`로 결과 정리

## 고정 실험 조건
- 동일 브랜치/커밋에서 비교
- 동일 시간대에 OFF/ON 비교 세트 실행
- 가능하면 planner seed/temperature 고정
- 동일 connector 활성 상태 유지

