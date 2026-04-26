import { Module } from '@nestjs/common';
import { StoreModule } from '../store/store.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthTokenService } from './auth-token.service';
import { GoogleOAuthService } from './google-oauth.service';

@Module({
  imports: [StoreModule],
  controllers: [AuthController],
  providers: [AuthService, AuthTokenService, GoogleOAuthService],
  exports: [AuthService, AuthTokenService],
})
export class AuthModule {}
