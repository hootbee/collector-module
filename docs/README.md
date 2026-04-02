# Backend Docs

이 디렉토리는 `backend` 서버만 기준으로 한 기술 문서 모음이다.

현재 서버 범위:

- 세션 생성
- CSV 업로드
- 데이터 분석
- 도메인 추천
- 외부 후보 수집 job 생성 및 polling

현재 서버 범위에 포함되지 않는 것:

- 정합성 검토
- 합성 데이터 생성
- 성능 검증
- 실제 웹 크롤러 기반 외부 수집

문서 목록:

- [API 레퍼런스](./api-reference.md)
- [백엔드 파이프라인 흐름](./pipeline-flow.md)
- [로컬 LLM 사용 정책 및 연결 지점](./local-llm.md)
- [LLM provider 설정](./openai-provider.md)
- [실행 로그](./run-log.md)

핵심 전제:

- 현재 구현은 `Nest.js` 서버이다.
- 현재 구현은 로컬 LLM 없이 동작한다.
- 데이터 분석은 순수 통계/규칙 기반이다.
- 도메인 추천, 키워드 확장, 검색 질의 생성도 현재는 규칙 기반이다.
- 필요하면 `OpenAI` 또는 `OpenAI-compatible/vLLM` provider를 추천 경로에 선택적으로 붙일 수 있다.
- 외부 후보 수집은 실제 크롤링이 아니라 교체 가능한 카탈로그 커넥터 기반이다.
