# Run Log

가볍게 실행 결과를 남기는 문서다.

- 상세한 실험 리포트가 아니라, 언제 무엇을 돌렸고 어떤 결과가 나왔는지 기록한다.
- 시간은 KST 기준으로 적는다.
- 실제 웹 크롤링이 아니라 내부 discovery connector 결과라는 점은 필요할 때만 짧게 적는다.

## 2026-04-02 14:35 KST

### Clinical Sample CSV

- 실행 환경: 로컬 Nest 서버 `127.0.0.1:8790`
- 입력 파일: 임시 clinical sample CSV
- taskType: `classification`
- targetColumns: `["adverse_event_flag"]`

결과 요약:

- `sessions -> upload -> analyze -> recommend -> discovery -> results` 전체 파이프라인 완료
- 추천 단계에서 원격 LLM `210.117.143.180:12020` 사용 성공
- 서버 로그에 `recommendation generated via openai-compatible` 확인
- 추천 결과는 `dom-medical` 1건이 high relevance로 반환됨
- discovery job 완료
- 최종 결과: `knowledgeCount=4`, `datasetCount=3`

메모:

- 이 케이스는 원격 LLM 연동이 실제로 성공한 기준 샘플로 볼 수 있다.
- discovery는 실제 웹 크롤링이 아니라 내부 catalog connector 기반 후보 수집이다.

## 2026-04-02 14:46 KST

### ai_vs_human_content_v2_20000.csv

- 실행 환경: 로컬 Nest 서버 `127.0.0.1:8791`
- 입력 파일: `/Users/leejunhyeong/Downloads/ai_vs_human_content_v2_20000.csv`
- taskType: `classification`
- targetColumns: `["label"]`

데이터 요약:

- 행 수: `20000`
- 열 수: `13`
- 클래스 분포: `ai=10004`, `human=9996`
- 특이 사항: `ai_model` 결측률 약 `49.98%`

결과 요약:

- `sessions -> upload -> analyze -> recommend -> discovery -> results` 전체 파이프라인 완료
- 업로드와 분석은 정상 동작
- discovery job도 정상 완료
- 최종 결과: `knowledgeCount=5`, `datasetCount=5`

추천 단계 메모:

- 원격 LLM 호출은 시도되었음
- 하지만 서버 로그에 `LLM returned no valid recommended domains`가 찍혀 규칙 기반 추천으로 fallback 됨
- 현재 domain catalog가 텍스트/콘텐츠 진위 분류 데이터에 잘 맞지 않아 추천 품질은 제한적이었음

추가 메모:

- 이 데이터셋은 파이프라인 동작 검증에는 적합했지만, 현재 추천 도메인 체계와는 잘 맞지 않았다.
- 텍스트/콘텐츠 분류 계열 도메인을 catalog에 추가하면 결과가 더 자연스러워질 가능성이 높다.

## 2026-04-02 15:25 KST

### Recommendation / Discovery Quality Retest

- 실행 환경: 로컬 Nest 앱 내부 호출 (`app.init()` 기반, HTTP listen 없이 서비스 직접 실행)
- 목적: analyze / recommend / discovery 품질 개선 후 실제 데이터셋 재검증

#### ai_vs_human_content_v2_20000.csv

- 입력 파일: `/Users/leejunhyeong/Downloads/ai_vs_human_content_v2_20000.csv`
- taskType: `classification`
- targetColumns: `["label"]`

결과 요약:

- `analyze -> recommend -> discovery -> results` 흐름 재검증 완료
- `metadataCandidates`가 `["id"]`로 축소됨
- `prompt`, `content`, `source`, `topic`, `word_count`, `char_count`, `language` 등이 feature로 유지됨
- `inferredTextColumns=["prompt","content"]`
- 추천 도메인이 텍스트/NLP 계열로 정렬됨:
  - `dom-ai-generated-content-detection`
  - `dom-text-classification`
  - `dom-content-authenticity`
  - `dom-nlp`
- `expandedKeywords`와 `generatedQueries`가 AI-vs-human / text authenticity 중심으로 생성됨
- discovery 결과도 텍스트/NLP seed 위주로 정렬됨
- 최종 결과: `knowledgeCount=5`, `datasetCount=5`

메모:

- 이 실행은 샌드박스 내 네트워크 제한 때문에 원격 LLM 호출은 `EPERM`으로 fallback 되었지만, rule-based 품질 개선 효과는 충분히 확인됐다.
- 의료/금융/산업 계열 잡음은 최종 discovery 결과에서 제거됐다.

#### Clinical Sample CSV

- 입력 파일: 임시 clinical sample table
- taskType: `classification`
- targetColumns: `["adverse_event_flag"]`

결과 요약:

- `metadataCandidates=["patient_id","visit_date"]`
- `featureColumns=["heart_rate","alt_u_l"]`
- `inferredTemporalColumns=["visit_date"]`
- 추천 도메인은 `dom-medical` 중심으로 유지됨
- discovery 결과도 `ds-mimic-demo`, `ds-synthea`, `kn-ich-e2a` 등 의료 계열만 남음

메모:

- 텍스트/NLP 개선이 기존 clinical table 추천 흐름을 깨지 않았음을 확인했다.
