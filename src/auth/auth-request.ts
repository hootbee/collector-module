import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

export type MinimalRequest = {
  headers: Record<string, string | string[] | undefined>;
};

function headerValue(request: MinimalRequest, name: string): string {
  const value = request.headers[name] ?? request.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function bearerToken(request: MinimalRequest): string | null {
  const authorization = headerValue(request, 'authorization');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function resolveUserIdFromAccessToken(
  authService: AuthService,
  accessToken?: string | null,
): Promise<string | null> {
  const token = accessToken?.trim();
  if (!token) return null;
  const user = await authService.getUserFromAccessToken(token);
  return user.id;
}

export async function requireUserIdWithOptionalQueryToken(
  authService: AuthService,
  request: MinimalRequest,
  queryAccessToken?: string | null,
): Promise<string> {
  const queryUserId = await resolveUserIdFromAccessToken(authService, queryAccessToken);
  if (queryUserId) return queryUserId;
  return requireUserId(authService, request);
}

export async function resolveOptionalUserId(authService: AuthService, request: MinimalRequest): Promise<string | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const user = await authService.getUserFromAccessToken(token);
  return user.id;
}

export async function requireUserId(authService: AuthService, request: MinimalRequest): Promise<string> {
  const userId = await resolveOptionalUserId(authService, request);
  if (!userId) {
    throw new UnauthorizedException('Authentication is required.');
  }
  return userId;
}
