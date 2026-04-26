import type { SharedPipelineTemplate } from '../common/contracts';

export const sharedPipelineTemplates: SharedPipelineTemplate[] = [
  {
    id: 'tpl-collection-first',
    kind: 'collection-workflow',
    domainKey: 'generic-data-collection',
    domainLabel: 'Generic Data Collection',
    title: '수집 우선 파이프라인',
    description: '웹/공식 소스에서 후보 데이터를 수집하고, 이후 모듈을 추가해 확장하는 기본 템플릿입니다.',
    moduleIds: ['collection'],
    connectedAfter: [],
    moduleLayout: {
      collection: { x: 120, y: 120 },
    },
    highlight: 'Collection module only. Analysis/diagnosis modules can be added later.',
  },
  {
    id: 'tpl-collection-review',
    kind: 'collection-review-workflow',
    domainKey: 'candidate-review',
    domainLabel: 'Candidate Review',
    title: '수집 후보 검토 파이프라인',
    description: '수집 후 진단/리포트 stub를 연결해 전체 흐름을 미리 확인하는 템플릿입니다.',
    moduleIds: ['collection', 'diagnosis-stub', 'report-stub'],
    connectedAfter: ['collection', 'diagnosis-stub'],
    moduleLayout: {
      collection: { x: 120, y: 120 },
      'diagnosis-stub': { x: 420, y: 120 },
      'report-stub': { x: 720, y: 120 },
    },
    highlight: 'Downstream modules are placeholders until module internals are implemented.',
  },
];
