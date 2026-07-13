import { Module } from '@nestjs/common';
import { S3StorageService } from './s3-storage.service';
import { FileSecurityService } from './file-security.service';

@Module({
  providers: [FileSecurityService, S3StorageService],
  exports: [FileSecurityService, S3StorageService],
})
export class StorageModule {}
