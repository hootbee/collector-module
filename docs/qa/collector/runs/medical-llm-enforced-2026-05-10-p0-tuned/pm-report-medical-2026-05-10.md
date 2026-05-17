# PM Report (Medical Collector LLM-Enforced, P0 Tuned)

- Run ID: `medical-llm-enforced-2026-05-10-p0-tuned`
- Date: `2026-05-10`
- Scope: LLM 강제 + 의료 게이트/패널티/가중치 튜닝 반영 후 재실행

## Summary Metrics
- 실행 완료율: `100.00%`
- LLM 강제 준수율(llmPlan+llmPlanRaw): `100.00%`
- Top10 의료 관련성 평균: `100.00%`
- Top10 비의료 노이즈율 평균: `0.00%`
- Top10 신뢰 출처 비율 평균: `100.00%`
- 재현성(Jaccard 평균): `1.0000`

## Gate Verdict
- 완료율>=95: `True`
- 관련성>=75: `True`
- 노이즈<=15: `True`
- LLM 준수율=100: `True`
- fallback 통과: `0건` (LLM 누락 실행은 실패 처리)

## Artifacts
- JSON runs: `/Users/leejunhyeong/Desktop/univ/4-1/capstone/project/backend/docs/qa/collector/runs/medical-llm-enforced-2026-05-10-p0-tuned/llm-on-medical-2026-05-10`
- CSV: `/Users/leejunhyeong/Desktop/univ/4-1/capstone/project/backend/docs/qa/collector/runs/medical-llm-enforced-2026-05-10-p0-tuned/summary-relevance-medical.csv`
- Config snapshot: `/Users/leejunhyeong/Desktop/univ/4-1/capstone/project/backend/docs/qa/collector/runs/medical-llm-enforced-2026-05-10-p0-tuned/run-config.json`

## Notes
- seed-catalog 단일 소스 제약으로 의료 적합성 상한이 낮을 수 있음.
- 다음 사이클에서 source profile 확장(huggingface/openml/uci 의료 우선 시드) 권장.

## Before vs After (P0)
| metric | before | after | delta |
|---|---:|---:|---:|
| 완료율 | 100.00% | 100.00% | +0.00% |\n| LLM 준수율 | 0.00% | 100.00% | +100.00% |\n| 의료 관련성 | 69.33% | 100.00% | +30.67% |\n| 비의료 노이즈율 | 41.67% | 0.00% | -41.67% |\n| 신뢰 출처율 | 100.00% | 100.00% | +0.00% |\n

## Before vs After (Recomputed)
| metric | before | after | delta |
|---|---:|---:|---:|
| 완료율 | 100.00% | 100.00% | +0.00% |\n| LLM 준수율 | 100.00% | 100.00% | +0.00% |\n| 의료 관련성 | 69.33% | 100.00% | +30.67% |\n| 비의료 노이즈율 | 41.67% | 0.00% | -41.67% |\n| 신뢰 출처율 | 100.00% | 100.00% | +0.00% |\n