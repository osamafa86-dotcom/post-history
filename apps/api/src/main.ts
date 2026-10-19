import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule, configureApp } from './app.module';
import { PinoNestLogger, createLogger } from './common/logger';
import { loadConfig } from './config/config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const app = await NestFactory.create(AppModule.forRoot(config, logger), { logger: new PinoNestLogger(logger) });
  configureApp(app, logger);
  await app.listen(config.PORT, config.HOST);
  logger.info({ port: config.PORT }, 'api listening');
}

void bootstrap();
