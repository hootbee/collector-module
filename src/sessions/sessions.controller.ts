import { Controller, Post } from '@nestjs/common';
import { StoreService } from '../store/store.service';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly storeService: StoreService) {}

  @Post()
  createSession() {
    const session = this.storeService.createSession();
    return {
      sessionId: session.id,
      createdAt: session.createdAt,
    };
  }
}
