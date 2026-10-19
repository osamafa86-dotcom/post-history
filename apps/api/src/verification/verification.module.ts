import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig, storageConfigured } from '../config/config';
import { OBJECT_STORAGE, type ObjectStorage, S3ObjectStorage } from './object-storage';
import { VerificationWorker } from './verification.worker';

const unconfigured: ObjectStorage = {
  head: () => Promise.reject(new Error('object storage is not configured')),
  read: () => Promise.reject(new Error('object storage is not configured')),
};

@Module({
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig): ObjectStorage =>
        storageConfigured(c)
          ? new S3ObjectStorage({ endpoint: c.S3_ENDPOINT!, region: c.S3_REGION, accessKeyId: c.S3_ACCESS_KEY!, secretAccessKey: c.S3_SECRET_KEY! })
          : unconfigured,
    },
    VerificationWorker,
  ],
  exports: [VerificationWorker, OBJECT_STORAGE],
})
export class VerificationModule {}
