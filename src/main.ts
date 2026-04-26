import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

function resolveAllowedOrigins(): string[] {
  const envOrigins = process.env.CORS_ALLOW_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (envOrigins && envOrigins.length > 0) {
    return envOrigins;
  }
  return [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:7634',
    'http://127.0.0.1:7634',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ];
}

export async function createApp() {
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create(AppModule, {
    cors: false,
  });

  const allowedOrigins = new Set(resolveAllowedOrigins());
  app.enableCors({
    credentials: true,
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      // same-origin / curl / server-side calls may not include Origin header
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS blocked for origin: ${origin}`), false);
    },
  });
  app.setGlobalPrefix('api/v1');

  return app;
}

async function bootstrap() {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST?.trim() || '0.0.0.0';
  await app.listen(port, host);
  console.log(`Nest backend listening on http://${host}:${port}`);
}

if (require.main === module) {
  void bootstrap();
}
