# Collector 라벨링 가이드

## 목적
Top10 결과를 일관된 기준으로 평가하기 위한 라벨 규칙입니다.

## 라벨 정의
- `relevant`: 질의 의도와 직접적으로 일치하는 결과
- `irrelevant`: 질의와 명백히 무관하거나 광고/잡음 성격의 결과
- `uncertain`: 제목만으로 판단 어려워 본문 확인이 필요한 결과

## 판정 기준
1. 질의의 핵심 태스크/도메인/데이터 유형 중 2개 이상 일치하면 `relevant`
2. 도메인 불일치 또는 데이터 유형 불일치면 `irrelevant`
3. 정보 부족, 모호한 메타데이터면 `uncertain`

## 신뢰 출처 태깅
- `trusted=1`: 공식 저장소/학술/공신력 있는 기관
  - 예: UCI, OpenML, Hugging Face(공식 dataset card), Crossref 논문 메타
- `trusted=0`: 출처 불명, 개인 블로그/광고성 랜딩

## 노이즈 판정
- `noise=1`: 질의와 무관, 스팸, 중복 홍보 페이지
- `noise=0`: 의미 있는 후보

## 라벨링 운영 규칙
1. 라벨러 2인 교차 태깅 권장
2. 불일치 발생 시 `final_label`은 합의 결과로 확정
3. uncertain 비율이 높으면 query/planner 개선 후보로 표기

