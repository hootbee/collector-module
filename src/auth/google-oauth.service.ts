import { Injectable, UnauthorizedException } from '@nestjs/common';

export type GoogleProfile = {
  providerUserId: string;
  email: string;
  name: string;
  avatarUrl?: string;
};

type GoogleTokenInfoResponse = {
  sub?: string;
  aud?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
  picture?: string;
  error_description?: string;
};

type GoogleUserInfoResponse = {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

@Injectable()
export class GoogleOAuthService {
  async verify(input: {
    idToken?: string;
    accessToken?: string;
  }): Promise<GoogleProfile> {
    if (process.env.AUTH_DEV_BYPASS_GOOGLE === 'true') {
      return this.devProfile();
    }
    if (input.idToken?.trim()) {
      return this.verifyIdToken(input.idToken.trim());
    }
    if (input.accessToken?.trim()) {
      return this.verifyAccessToken(input.accessToken.trim());
    }
    throw new UnauthorizedException('Google idToken or accessToken is required.');
  }

  private async verifyIdToken(idToken: string): Promise<GoogleProfile> {
    const url = new URL('https://oauth2.googleapis.com/tokeninfo');
    url.searchParams.set('id_token', idToken);
    const response = await fetch(url);
    if (!response.ok) {
      throw new UnauthorizedException(`Google id token verification failed with HTTP ${response.status}.`);
    }
    const info = await response.json() as GoogleTokenInfoResponse;
    if (info.error_description) {
      throw new UnauthorizedException(info.error_description);
    }
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    if (clientId && info.aud !== clientId) {
      throw new UnauthorizedException('Google token audience does not match GOOGLE_CLIENT_ID.');
    }
    return this.toProfile(info);
  }

  private async verifyAccessToken(accessToken: string): Promise<GoogleProfile> {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) {
      throw new UnauthorizedException(`Google userinfo request failed with HTTP ${response.status}.`);
    }
    return this.toProfile(await response.json() as GoogleUserInfoResponse);
  }

  private toProfile(info: GoogleTokenInfoResponse | GoogleUserInfoResponse): GoogleProfile {
    if (!info.sub || !info.email) {
      throw new UnauthorizedException('Google profile is missing sub or email.');
    }
    const verified = info.email_verified;
    if (verified !== true && verified !== 'true') {
      throw new UnauthorizedException('Google email is not verified.');
    }
    return {
      providerUserId: info.sub,
      email: info.email,
      name: info.name || info.email,
      avatarUrl: info.picture,
    };
  }

  private devProfile(): GoogleProfile {
    return {
      providerUserId: process.env.AUTH_DEV_GOOGLE_SUB?.trim() || 'dev-google-user',
      email: process.env.AUTH_DEV_EMAIL?.trim() || 'dev@example.com',
      name: process.env.AUTH_DEV_NAME?.trim() || 'Dev User',
      avatarUrl: process.env.AUTH_DEV_AVATAR_URL?.trim() || undefined,
    };
  }
}
