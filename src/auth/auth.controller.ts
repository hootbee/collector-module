import { Body, Controller, Get, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

type MinimalRequest = {
  headers: Record<string, string | string[] | undefined>;
};

type MinimalResponse = {
  cookie?: (name: string, value: string, options: Record<string, unknown>) => void;
  clearCookie?: (name: string, options?: Record<string, unknown>) => void;
};

const refreshCookieName = 'stage_one_refresh';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('google')
  async loginWithGoogle(
    @Body() body: { idToken?: string; accessToken?: string },
    @Res({ passthrough: true }) response: MinimalResponse,
  ) {
    const login = await this.authService.loginWithGoogle({
      idToken: body.idToken,
      accessToken: body.accessToken,
    });
    this.setRefreshCookie(response, login.refreshToken, login.refreshExpiresAt);
    const { refreshToken: _refreshToken, refreshExpiresAt: _refreshExpiresAt, ...publicResponse } = login;
    return publicResponse;
  }

  @Post('refresh')
  async refresh(
    @Req() request: MinimalRequest,
    @Res({ passthrough: true }) response: MinimalResponse,
  ) {
    const refreshToken = this.readCookie(request, refreshCookieName);
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh cookie is missing.');
    }
    const login = await this.authService.refresh(refreshToken);
    this.setRefreshCookie(response, login.refreshToken, login.refreshExpiresAt);
    const { refreshToken: _refreshToken, refreshExpiresAt: _refreshExpiresAt, ...publicResponse } = login;
    return publicResponse;
  }

  @Post('logout')
  async logout(
    @Req() request: MinimalRequest,
    @Res({ passthrough: true }) response: MinimalResponse,
  ) {
    await this.authService.logout(this.readCookie(request, refreshCookieName));
    response.clearCookie?.(refreshCookieName, this.cookieBaseOptions());
    return { status: 'ok' };
  }

  @Get('me')
  async getMe(@Req() request: MinimalRequest) {
    return {
      user: await this.authService.getUserFromAccessToken(this.readBearerToken(request)),
    };
  }

  private setRefreshCookie(response: MinimalResponse, refreshToken: string, expiresAt: string): void {
    response.cookie?.(refreshCookieName, refreshToken, {
      ...this.cookieBaseOptions(),
      expires: new Date(expiresAt),
    });
  }

  private cookieBaseOptions(): Record<string, unknown> {
    return {
      httpOnly: true,
      secure: process.env.AUTH_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
      sameSite: process.env.AUTH_COOKIE_SAME_SITE?.trim() || 'lax',
      path: '/api/v1/auth',
    };
  }

  private readBearerToken(request: MinimalRequest): string {
    const authorization = this.headerValue(request, 'authorization');
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) {
      throw new UnauthorizedException('Bearer access token is required.');
    }
    return match[1].trim();
  }

  private readCookie(request: MinimalRequest, name: string): string | undefined {
    const cookieHeader = this.headerValue(request, 'cookie');
    return cookieHeader
      .split(';')
      .map((part) => part.trim())
      .map((part) => {
        const index = part.indexOf('=');
        return index >= 0
          ? [part.slice(0, index), decodeURIComponent(part.slice(index + 1))]
          : [part, ''];
      })
      .find(([key]) => key === name)?.[1];
  }

  private headerValue(request: MinimalRequest, name: string): string {
    const value = request.headers[name] ?? request.headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0] ?? '';
    }
    return value ?? '';
  }
}
