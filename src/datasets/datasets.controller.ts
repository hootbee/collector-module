import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { TaskType } from '../common/contracts';
import { parseCsvBuffer } from '../common/csv';
import { ProfilingService } from '../profiling/profiling.service';
import { StoreService } from '../store/store.service';

const taskTypes: TaskType[] = ['classification', 'anomaly', 'regression'];
type UploadedCsvFile = { originalname: string; buffer: Buffer };

@Controller('datasets')
export class DatasetsController {
  constructor(
    private readonly storeService: StoreService,
    private readonly profilingService: ProfilingService,
  ) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  uploadDataset(
    @UploadedFile() file: UploadedCsvFile | undefined,
    @Body() body: Record<string, string | undefined>,
  ) {
    const sessionId = body.sessionId?.trim() ?? '';
    const taskType = body.taskType?.trim() as TaskType | '';
    const description = body.description?.trim() ?? '';

    if (!sessionId) {
      throw new BadRequestException('sessionId is required.');
    }
    if (!this.storeService.getSession(sessionId)) {
      throw new NotFoundException(`Session ${sessionId} was not found.`);
    }
    if (!taskTypes.includes(taskType as TaskType)) {
      throw new BadRequestException('taskType must be classification, anomaly, or regression.');
    }
    if (!file?.buffer) {
      throw new BadRequestException('CSV file is required.');
    }

    let targetColumns: string[];
    try {
      const parsed = JSON.parse(body.targetColumns ?? '[]') as unknown;
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
        throw new Error('invalid');
      }
      targetColumns = parsed;
    } catch {
      throw new BadRequestException('targetColumns must be a JSON string array.');
    }

    if (targetColumns.length === 0) {
      throw new BadRequestException('At least one target column is required.');
    }

    const { columns, rows } = parseCsvBuffer(file.buffer);
    const missingTargets = targetColumns.filter((column) => !columns.includes(column));
    if (missingTargets.length > 0) {
      throw new BadRequestException(
        `Target columns not found in CSV: ${missingTargets.join(', ')}`,
      );
    }

    const dataset = this.storeService.createDataset({
      sessionId,
      fileName: file.originalname || 'dataset.csv',
      rawBuffer: file.buffer,
      rows,
      columns,
      targetColumns,
      taskType: taskType as TaskType,
      description,
    });

    return {
      sessionId: dataset.sessionId,
      datasetId: dataset.id,
      fileName: dataset.fileName,
      rowCount: dataset.rowCount,
      colCount: dataset.colCount,
      columns: dataset.columns,
    };
  }

  @Post(':datasetId/analyze')
  analyzeDataset(@Param('datasetId') datasetId: string) {
    const dataset = this.storeService.getDataset(datasetId);
    if (!dataset) {
      throw new NotFoundException(`Dataset ${datasetId} was not found.`);
    }

    const analysis =
      dataset.analysis ?? this.profilingService.analyzeDataset(dataset);

    return this.storeService.setDatasetAnalysis(dataset.id, analysis);
  }
}
