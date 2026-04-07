import type { DiscoveryContext } from '../../common/contracts';
import type { DiscoveryPlan } from '../types/collection-plan';
import type {
  DatasetDiscoveryHit,
  DiscoverySearchOutcome,
  KnowledgeDiscoveryHit,
} from '../types/collection-hit';

export interface DiscoveryConnector {
  searchKnowledgeHits(
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<KnowledgeDiscoveryHit>>;
  searchDatasetHits(
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<DatasetDiscoveryHit>>;
}
