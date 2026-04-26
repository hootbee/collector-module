import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export type AccessTokenPayload = {
  sub: string;
  email: string;
  role: 'user' | 'admin';
  jti: string;
  iat: number;
  exp: number;
};

@Injectable()
export class AuthTokenService {
  private readonly accessTokenTtlSeconds = Number(process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS ?? 900);
  private readonly refreshTokenTtlSeconds = Number(process.env.AUTH_REFRESH_TOKEN_TTL_SECONDS ?? 1209600);

  issueAccessToken(input: {
    userId: string;
    email: string;
    role: 'user' | 'admin';
  }): { accessToken: string; expiresIn: number } {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload: AccessTokenPayload = {
      sub: input.userId,
      email: input.email,
      role: input.role,
      jti: randomUUID(),
      iat: nowSeconds,
      exp: nowSeconds + this.accessTokenTtlSeconds,
    };
    return {
      accessToken: this.signJwt(payload),
      expiresIn: this.accessTokenTtlSeconds,
    };
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    const [encodedHeader, encodedPayload, signature] = token.split('.');
    if (!encodedHeader || !encodedPayload || !signature) {
      throw new UnauthorizedException('Invalid access token.');
    }

    const expected = this.hmac(`${encodedHeader}.${encodedPayload}`);
    if (!this.safeEqual(signature, expected)) {
      throw new UnauthorizedException('Invalid access token signature.');
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as AccessTokenPayload;
    if (!payload.sub || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('Access token is expired.');
    }
    return payload;
  }

  issueRefreshToken(): { refreshToken: string; tokenHash: string; expiresAt: string } {
    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + this.refreshTokenTtlSeconds * 1000).toISOString();
    return {
      refreshToken,
      tokenHash: this.hashRefreshToken(refreshToken),
      expiresAt,
    };
  }

  hashRefreshToken(refreshToken: string): string {
    return createHmac('sha256', this.refreshSecret()).update(refreshToken).digest('hex');
  }

  private signJwt(payload: Record<string, unknown>): string {
    const header = this.base64UrlJson({ alg: 'HS256', typ: 'JWT' });
    const body = this.base64UrlJson(payload);
    const signature = this.hmac(`${header}.${body}`);
    return `${header}.${body}.${signature}`;
  }

  private hmac(value: string): string {
    return createHmac('sha256', this.accessSecret()).update(value).digest('base64url');
  }

  private base64UrlJson(value: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  private safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }

  private accessSecret(): string {
    const secret = process.env.AUTH_JWT_SECRET?.trim();
    if (!secret || secret.length < 32) {
      throw new Error('AUTH_JWT_SECRET must be configured with at least 32 characters.');
    }
    return secret;
  }

  private refreshSecret(): string {
    return process.env.AUTH_REFRESH_TOKEN_SECRET?.trim() || this.accessSecret();
  }
}
