import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { StoreService } from './store.service';

@Module({
  imports: [DatabaseModule],
  providers: [StoreService],
  exports: [StoreService],
})
export class StoreModule {}
