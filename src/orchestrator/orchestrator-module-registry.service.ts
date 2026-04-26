import { Injectable } from '@nestjs/common';
import type { OrchestratorModuleType } from '../common/contracts';

export type OrchestratorModuleSpec = {
  type: OrchestratorModuleType;
  title: string;
  description: string;
  executionMode: 'implemented' | 'stub';
};

@Injectable()
export class OrchestratorModuleRegistryService {
  private readonly modules: OrchestratorModuleSpec[] = [
    {
      type: 'collection',
      title: 'Web/Data Collection',
      description: 'Structured and generic source collection module.',
      executionMode: 'implemented',
    },
    {
      type: 'analysis-stub',
      title: 'Analysis Stub',
      description: 'Placeholder module for future data analysis execution.',
      executionMode: 'stub',
    },
    {
      type: 'diagnosis-stub',
      title: 'Diagnosis Stub',
      description: 'Placeholder module for future diagnosis and quality checks.',
      executionMode: 'stub',
    },
    {
      type: 'report-stub',
      title: 'Report Stub',
      description: 'Placeholder module for future report generation.',
      executionMode: 'stub',
    },
  ];

  list(): OrchestratorModuleSpec[] {
    return this.modules.map((module) => ({ ...module }));
  }

  get(moduleType: OrchestratorModuleType): OrchestratorModuleSpec | undefined {
    return this.modules.find((module) => module.type === moduleType);
  }

  isSupported(moduleType: string): moduleType is OrchestratorModuleType {
    return this.modules.some((module) => module.type === moduleType);
  }
}
