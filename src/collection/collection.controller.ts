import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import type {
  CollectionKind,
  CollectionSourceId,
  ModalitySignal,
  TaskSignal,
} from '../common/contracts';
import { CollectionDownloadService } from './collection-download.service';
import { CollectionService } from './collection.service';

const collectionKinds: CollectionKind[] = ['dataset', 'knowledge', 'both'];
const collectionSources: CollectionSourceId[] = [
  'seed-catalog',
  'huggingface',
  'openml',
  'uci',
  'kaggle',
  'serpapi',
  'crossref',
];

@Controller('collection')
export class CollectionController {
  constructor(
    private readonly collectionService: CollectionService,
    private readonly collectionDownloadService: CollectionDownloadService,
  ) {}

  @Post('jobs')
  async createJob(
    @Body()
    body: {
      query?: string;
      kind?: CollectionKind;
      sources?: CollectionSourceId[];
      taskSignals?: TaskSignal[];
      modalitySignals?: ModalitySignal[];
      mustInclude?: string[];
      mustAvoid?: string[];
    },
  ) {
    const query = body.query?.trim() ?? '';
    if (!query) {
      throw new BadRequestException('query is required.');
    }

    const kind = body.kind ?? 'both';
    if (!collectionKinds.includes(kind)) {
      throw new BadRequestException('kind must be dataset, knowledge, or both.');
    }

    const requestedSources = Array.isArray(body.sources) && body.sources.length > 0
      ? body.sources
      : collectionSources;
    if (
      !Array.isArray(requestedSources) ||
      requestedSources.some((source) => !collectionSources.includes(source))
    ) {
      throw new BadRequestException(`sources must be a subset of: ${collectionSources.join(', ')}`);
    }

    const taskSignals = Array.isArray(body.taskSignals)
      ? body.taskSignals.filter((item): item is TaskSignal => typeof item === 'string')
      : [];
    const modalitySignals = Array.isArray(body.modalitySignals)
      ? body.modalitySignals.filter((item): item is ModalitySignal => typeof item === 'string')
      : [];
    const mustInclude = Array.isArray(body.mustInclude)
      ? body.mustInclude.filter((item): item is string => typeof item === 'string')
      : [];
    const mustAvoid = Array.isArray(body.mustAvoid)
      ? body.mustAvoid.filter((item): item is string => typeof item === 'string')
      : [];

    return this.collectionService.createJob({
      query,
      kind,
      requestedSources,
      taskSignals,
      modalitySignals,
      mustInclude,
      mustAvoid,
    });
  }

  @Get('jobs/:jobId')
  getJobStatus(@Param('jobId') jobId: string) {
    return this.collectionService.getStatus(jobId);
  }

  @Get('jobs/:jobId/results')
  getJobResults(@Param('jobId') jobId: string) {
    return this.collectionService.getResults(jobId);
  }

  @Post('jobs/:jobId/downloads')
  createDownloadJob(
    @Param('jobId') jobId: string,
    @Body()
    body: {
      itemIds?: string[];
      targetDir?: string;
      maxFilesPerItem?: number;
    },
  ) {
    const itemIds = Array.isArray(body.itemIds)
      ? body.itemIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : undefined;
    return this.collectionDownloadService.createDownloadJob({
      collectionJobId: jobId,
      itemIds,
      targetDir: body.targetDir,
      maxFilesPerItem: body.maxFilesPerItem,
    });
  }

  @Get('downloads/:downloadJobId')
  getDownloadJobStatus(@Param('downloadJobId') downloadJobId: string) {
    return this.collectionDownloadService.getStatus(downloadJobId);
  }

  @Get('downloads/:downloadJobId/results')
  getDownloadJobResults(@Param('downloadJobId') downloadJobId: string) {
    return this.collectionDownloadService.getResults(downloadJobId);
  }
}
