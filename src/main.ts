import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

export async function createApp() {
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create(AppModule, {
    cors: false,
  });

  app.enableCors();
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
