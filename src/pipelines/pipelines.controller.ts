import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { PipelinesService } from './pipelines.service';

@Controller()
export class PipelinesController {
  constructor(private readonly pipelinesService: PipelinesService) {}

  @Get('pipeline-templates')
  listSharedTemplates() {
    return this.pipelinesService.listSharedTemplates();
  }

  @Get('pipeline-templates/:templateId')
  getSharedTemplate(@Param('templateId') templateId: string) {
    return this.pipelinesService.getSharedTemplate(templateId);
  }

  @Post('pipeline-templates/:templateId/copy')
  copySharedTemplate(
    @Param('templateId') templateId: string,
    @Body() body: { userId?: string; title?: string },
  ) {
    return this.pipelinesService.copySharedTemplate(templateId, {
      userId: body.userId,
      title: body.title,
    });
  }

  @Get('pipelines')
  listPipelines(@Query('userId') userId?: string) {
    return this.pipelinesService.listPipelines(userId?.trim() || null);
  }

  @Get('pipelines/:pipelineId')
  getPipeline(@Param('pipelineId') pipelineId: string) {
    return this.pipelinesService.getPipeline(pipelineId);
  }

  @Post('pipelines/:pipelineId/modules')
  addModule(
    @Param('pipelineId') pipelineId: string,
    @Body()
    body: {
      moduleId?: string;
      afterModuleId?: string;
      layout?: Record<string, unknown>;
    },
  ) {
    return this.pipelinesService.addModule(pipelineId, {
      moduleId: body.moduleId,
      afterModuleId: body.afterModuleId,
      layout: body.layout,
    });
  }

  @Delete('pipelines/:pipelineId/modules/:moduleId')
  removeModule(
    @Param('pipelineId') pipelineId: string,
    @Param('moduleId') moduleId: string,
  ) {
    return this.pipelinesService.removeModule(pipelineId, moduleId);
  }
}
