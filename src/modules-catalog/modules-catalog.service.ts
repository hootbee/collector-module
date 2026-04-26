import { Injectable } from '@nestjs/common';
import type { ModuleCatalogResponse } from '../common/contracts';
import { baseModulesCatalog, domainModulesCatalog } from './modules-catalog.data';

@Injectable()
export class ModulesCatalogService {
  listAll(): ModuleCatalogResponse {
    return {
      modules: [...baseModulesCatalog, ...domainModulesCatalog].map((module) => ({ ...module })),
    };
  }

  listByDomain(domainKey?: string): ModuleCatalogResponse {
    const normalized = domainKey?.trim().toLowerCase();
    if (!normalized) {
      return { modules: [] };
    }
    return {
      modules: domainModulesCatalog
        .filter((module) => module.domainKey?.toLowerCase() === normalized)
        .map((module) => ({ ...module })),
    };
  }
}
