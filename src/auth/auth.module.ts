import { Module } from '@nestjs/common';
import { StoreModule } from '../store/store.module';
import { AuthController } from './auth.controller';
import { AuthPasswordService } from './auth-password.service';
import { AuthService } from './auth.service';
import { AuthTokenService } from './auth-token.service';
import { GoogleOAuthService } from './google-oauth.service';

@Module({
  imports: [StoreModule],
  controllers: [AuthController],
  providers: [AuthService, AuthTokenService, AuthPasswordService, GoogleOAuthService],
  exports: [AuthService, AuthTokenService],
})
export class AuthModule {}
