import type { ModuleCatalogItem } from '../common/contracts';

export const baseModulesCatalog: ModuleCatalogItem[] = [
  {
    id: 'workflow',
    label: '전체 워크플로우',
    description: '파이프라인 허브에서 도메인별 흐름을 고르거나, 사이드바에서 모듈로 바로 이동합니다.',
    pipelineFrom: [],
  },
  {
    id: 'diagnosis',
    label: '데이터 진단',
    description: '샘플 구성, 결측치, 불균형 의심 여부를 빠르게 점검합니다.',
    pipelineFrom: [],
  },
  {
    id: 'domain',
    label: '도메인 정의',
    description: '도메인/태스크/스코프를 명시해 탐색 기준을 정리합니다.',
    pipelineFrom: ['diagnosis'],
  },
  {
    id: 'search',
    label: '외부 데이터 탐색',
    description: '가설 기반 검색 쿼리와 후보 데이터셋을 검토합니다.',
    pipelineFrom: ['domain'],
  },
  {
    id: 'matching',
    label: '정합성 검토',
    description: '현재 데이터와 후보 데이터의 의미적 적합성을 비교합니다.',
    pipelineFrom: ['search'],
  },
  {
    id: 'synthesis',
    label: '합성데이터 설계',
    description: '합성 전략과 제약조건을 정의해 보완 방향을 설정합니다.',
    pipelineFrom: ['matching'],
  },
  {
    id: 'results',
    label: '결과 비교',
    description: '원본/보완/합성 결과 지표를 비교해 의사결정을 돕습니다.',
    pipelineFrom: ['synthesis'],
  },
];

export const domainModulesCatalog: ModuleCatalogItem[] = [
  {
    id: 'med_master_patient_index',
    domainKey: 'medical',
    label: '환자·표본 식별 정합',
    description: '기관 간 환자·생체 표본 키를 맞추고, 분할·중복 건을 정리합니다.',
    pipelineFrom: [],
  },
  {
    id: 'med_outcome_coding',
    domainKey: 'medical',
    label: '결과·사망 코드 체계',
    description: '사망·중증 전환 라벨과 진단·행정 코드의 매핑·검증 규칙을 둡니다.',
    pipelineFrom: [],
  },
  {
    id: 'med_privacy_cell',
    domainKey: 'medical',
    label: '민감정보 셀 통제',
    description: '필드·셀 단위 마스킹, 재식별 위험 검토, 접근 권한 범위를 정의합니다.',
    pipelineFrom: [],
  },
  {
    id: 'fin_entity_resolution',
    domainKey: 'finance',
    label: '거래 주체 해상도',
    description: '계좌·법인·결제수단을 하나의 실체로 묶고 이상 링크를 정리합니다.',
    pipelineFrom: [],
  },
  {
    id: 'fin_pattern_library',
    domainKey: 'finance',
    label: '탐지 패턴·임계값',
    description: '의심 시나리오 라이브러리와 점수·임계값 운영 규칙을 관리합니다.',
    pipelineFrom: [],
  },
  {
    id: 'fin_audit_trail',
    domainKey: 'finance',
    label: '감사·신고 필드 매핑',
    description: '규제 신고·감사 추적에 필요한 필드와 출처 시스템을 연결합니다.',
    pipelineFrom: [],
  },
  {
    id: 'mfg_sensor_align',
    domainKey: 'manufacturing',
    label: '센서 채널 정렬',
    description: '채널·샘플링 주기를 맞추고 결측·이상 구간 보간 정책을 둡니다.',
    pipelineFrom: [],
  },
  {
    id: 'mfg_lot_genealogy',
    domainKey: 'manufacturing',
    label: 'LOT·공정 계보',
    description: '원자재·공정·완제품 LOT의 역추적 키와 단계 전이를 정의합니다.',
    pipelineFrom: [],
  },
  {
    id: 'mfg_spc_rules',
    domainKey: 'manufacturing',
    label: 'SPC·알람 규칙',
    description: '관리도, Western Electric 류 규칙, 알람 임계와 에스컬레이션을 설정합니다.',
    pipelineFrom: [],
  },
];
