import { Controller, Get, Query } from '@nestjs/common';
import { ModulesCatalogService } from './modules-catalog.service';

@Controller('modules')
export class ModulesCatalogController {
  constructor(private readonly modulesCatalogService: ModulesCatalogService) {}

  @Get()
  listAll() {
    return this.modulesCatalogService.listAll();
  }

  @Get('domain')
  listByDomain(@Query('domainKey') domainKey?: string) {
    return this.modulesCatalogService.listByDomain(domainKey);
  }
}
