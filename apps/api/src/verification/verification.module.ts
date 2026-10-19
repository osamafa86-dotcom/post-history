import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { OBJECT_STORAGE, type ObjectStorage, S3ObjectStorage } from './object-storage';
import { VerificationWorker } from './verification.worker';

const unconfigured: ObjectStorage = {
  head: () => Promise.reject(new Error('object storage is not configured (UPLOAD_VERIFIER=external)')),
  read: () => Promise.reject(new Error('object storage is not configured (UPLOAD_VERIFIER=external)')),
};

@Module({
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig): ObjectStorage =>
        c.S3_ENDPOINT && c.S3_ACCESS_KEY && c.S3_SECRET_KEY
          ? new S3ObjectStorage({ endpoint: c.S3_ENDPOINT, region: c.S3_REGION, accessKeyId: c.S3_ACCESS_KEY, secretAccessKey: c.S3_SECRET_KEY })
          : unconfigured,
    },
    VerificationWorker,
  ],
  exports: [VerificationWorker],
})
export class VerificationModule {}
