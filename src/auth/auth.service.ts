import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthLoginResponse, AuthUserResponse, UserRecord } from '../common/contracts';
import { StoreService } from '../store/store.service';
import { AuthTokenService } from './auth-token.service';
import { GoogleOAuthService } from './google-oauth.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly storeService: StoreService,
    private readonly googleOAuthService: GoogleOAuthService,
    private readonly tokenService: AuthTokenService,
  ) {}

  async loginWithGoogle(input: {
    idToken?: string;
    accessToken?: string;
  }): Promise<AuthLoginResponse & { refreshToken: string; refreshExpiresAt: string }> {
    const profile = await this.googleOAuthService.verify(input);
    const user = this.storeService.upsertOAuthUser({
      provider: 'google',
      providerUserId: profile.providerUserId,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    });
    return this.issueLoginResponse(user);
  }

  refresh(refreshToken: string): AuthLoginResponse & { refreshToken: string; refreshExpiresAt: string } {
    const tokenHash = this.tokenService.hashRefreshToken(refreshToken);
    const record = this.storeService.getRefreshTokenByHash(tokenHash);
    if (!record || record.revokedAt || new Date(record.expiresAt).getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token is invalid or expired.');
    }
    this.storeService.revokeRefreshToken(tokenHash);
    const user = this.storeService.getUser(record.userId);
    if (!user) {
      throw new UnauthorizedException('Refresh token user was not found.');
    }
    return this.issueLoginResponse(user);
  }

  logout(refreshToken?: string): void {
    if (!refreshToken) {
      return;
    }
    this.storeService.revokeRefreshToken(this.tokenService.hashRefreshToken(refreshToken));
  }

  getUserFromAccessToken(accessToken: string): AuthUserResponse {
    const payload = this.tokenService.verifyAccessToken(accessToken);
    const user = this.storeService.getUser(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User was not found.');
    }
    return this.toUserResponse(user);
  }

  private issueLoginResponse(user: UserRecord): AuthLoginResponse & { refreshToken: string; refreshExpiresAt: string } {
    const access = this.tokenService.issueAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });
    const refresh = this.tokenService.issueRefreshToken();
    this.storeService.createRefreshToken({
      userId: user.id,
      tokenHash: refresh.tokenHash,
      expiresAt: refresh.expiresAt,
    });
    return {
      user: this.toUserResponse(user),
      accessToken: access.accessToken,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      refreshToken: refresh.refreshToken,
      refreshExpiresAt: refresh.expiresAt,
    };
  }

  private toUserResponse(user: UserRecord): AuthUserResponse {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
    };
  }
}
