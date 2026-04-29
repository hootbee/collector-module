import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthLoginResponse, AuthUserResponse, UserRecord } from '../common/contracts';
import { StoreService } from '../store/store.service';
import { AuthPasswordService } from './auth-password.service';
import { AuthTokenService } from './auth-token.service';
import { GoogleOAuthService } from './google-oauth.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly storeService: StoreService,
    private readonly authPasswordService: AuthPasswordService,
    private readonly googleOAuthService: GoogleOAuthService,
    private readonly tokenService: AuthTokenService,
  ) {}

  async signupWithCredentials(input: {
    name: string;
    loginId: string;
    password: string;
  }): Promise<AuthLoginResponse & { refreshToken: string; refreshExpiresAt: string }> {
    const name = input.name.trim();
    const loginId = input.loginId.trim();
    const password = input.password;

    if (!name) {
      throw new UnauthorizedException('Name is required.');
    }
    if (!loginId || loginId.length < 3) {
      throw new UnauthorizedException('Login ID must be at least 3 characters.');
    }
    if (!password || password.length < 8) {
      throw new UnauthorizedException('Password must be at least 8 characters.');
    }

    const existing = await this.storeService.findLocalAuthByLoginId(loginId);
    if (existing) {
      throw new ConflictException('Login ID is already taken.');
    }

    let user: UserRecord;
    try {
      user = await this.storeService.createLocalUser({
        name,
        loginId,
        passwordHash: this.authPasswordService.hashPassword(password),
      });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === '23505') {
        throw new ConflictException('Login ID is already taken.');
      }
      throw error;
    }
    return this.issueLoginResponse(user);
  }

  async loginWithCredentials(input: {
    loginId: string;
    password: string;
  }): Promise<AuthLoginResponse & { refreshToken: string; refreshExpiresAt: string }> {
    const loginId = input.loginId.trim();
    const password = input.password;
    if (!loginId || !password) {
      throw new UnauthorizedException('Login ID and password are required.');
    }

    const local = await this.storeService.findLocalAuthByLoginId(loginId);
    if (!local) {
      throw new UnauthorizedException('Invalid login credentials.');
    }

    const valid = this.authPasswordService.verifyPassword(password, local.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid login credentials.');
    }

    return this.issueLoginResponse(local.user);
  }

  async loginWithGoogle(input: {
    idToken?: string;
    accessToken?: string;
  }): Promise<AuthLoginResponse & { refreshToken: string; refreshExpiresAt: string }> {
    const profile = await this.googleOAuthService.verify(input);
    const user = await this.storeService.upsertOAuthUser({
      provider: 'google',
      providerUserId: profile.providerUserId,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    });
    return this.issueLoginResponse(user);
  }

  async refresh(refreshToken: string): Promise<AuthLoginResponse & { refreshToken: string; refreshExpiresAt: string }> {
    const tokenHash = this.tokenService.hashRefreshToken(refreshToken);
    const record = await this.storeService.getRefreshTokenByHash(tokenHash);
    if (!record || record.revokedAt || new Date(record.expiresAt).getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token is invalid or expired.');
    }
    await this.storeService.revokeRefreshToken(tokenHash);
    const user = await this.storeService.getUser(record.userId);
    if (!user) {
      throw new UnauthorizedException('Refresh token user was not found.');
    }
    return this.issueLoginResponse(user);
  }

  async logout(refreshToken?: string): Promise<void> {
    if (!refreshToken) {
      return;
    }
    await this.storeService.revokeRefreshToken(this.tokenService.hashRefreshToken(refreshToken));
  }

  async getUserFromAccessToken(accessToken: string): Promise<AuthUserResponse> {
    const payload = this.tokenService.verifyAccessToken(accessToken);
    const user = await this.storeService.getUser(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User was not found.');
    }
    return this.toUserResponse(user);
  }

  private async issueLoginResponse(user: UserRecord): Promise<AuthLoginResponse & { refreshToken: string; refreshExpiresAt: string }> {
    const access = this.tokenService.issueAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });
    const refresh = this.tokenService.issueRefreshToken();
    await this.storeService.createRefreshToken({
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
