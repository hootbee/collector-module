import { createApp } from '../main';

function applySmokeEnv() {
  process.env.AUTH_DEV_BYPASS_GOOGLE = 'true';
  process.env.AUTH_JWT_SECRET ||= 'auth-smoke-access-secret-minimum-32-characters';
  process.env.AUTH_REFRESH_TOKEN_SECRET ||= 'auth-smoke-refresh-secret-minimum-32-characters';
  process.env.AUTH_COOKIE_SECURE = 'false';
}

function cookieFromSetCookie(header: string | null): string {
  if (!header) {
    throw new Error('set-cookie header was not returned.');
  }
  return header.split(';')[0] ?? '';
}

async function main() {
  applySmokeEnv();
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();

  try {
    const loginResponse = await fetch(`${baseUrl}/api/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'dev-id-token' }),
    });
    if (!loginResponse.ok) {
      throw new Error(`login failed: HTTP ${loginResponse.status} ${await loginResponse.text()}`);
    }
    const loginCookie = cookieFromSetCookie(loginResponse.headers.get('set-cookie'));
    const login = await loginResponse.json() as {
      user: { id: string; email: string; name: string };
      accessToken: string;
      expiresIn: number;
    };

    const meResponse = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${login.accessToken}` },
    });
    if (!meResponse.ok) {
      throw new Error(`me failed: HTTP ${meResponse.status} ${await meResponse.text()}`);
    }
    const me = await meResponse.json() as { user: { id: string; email: string } };

    const refreshResponse = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: loginCookie },
    });
    if (!refreshResponse.ok) {
      throw new Error(`refresh failed: HTTP ${refreshResponse.status} ${await refreshResponse.text()}`);
    }
    const refreshCookie = cookieFromSetCookie(refreshResponse.headers.get('set-cookie'));
    const refresh = await refreshResponse.json() as { accessToken: string; expiresIn: number };

    const logoutResponse = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { Cookie: refreshCookie },
    });
    if (!logoutResponse.ok) {
      throw new Error(`logout failed: HTTP ${logoutResponse.status} ${await logoutResponse.text()}`);
    }

    console.log(JSON.stringify({
      status: 'ok',
      baseUrl,
      login: {
        user: login.user,
        tokenType: 'Bearer',
        expiresIn: login.expiresIn,
        refreshCookieReturned: Boolean(loginCookie),
      },
      me,
      refresh: {
        accessTokenRotated: refresh.accessToken !== login.accessToken,
        expiresIn: refresh.expiresIn,
        refreshCookieRotated: Boolean(refreshCookie),
      },
      logout: await logoutResponse.json(),
    }, null, 2));
  } finally {
    await app.close();
  }
}

void main();
