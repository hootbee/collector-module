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
  await app.listen(port, '127.0.0.1');
  console.log(`Nest backend listening on http://127.0.0.1:${port}`);
}

if (require.main === module) {
  void bootstrap();
}
