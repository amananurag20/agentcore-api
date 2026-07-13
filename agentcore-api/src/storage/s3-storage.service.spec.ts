import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3StorageService } from './s3-storage.service';

describe('S3StorageService', () => {
  const configValues: Record<string, unknown> = {
    S3_BUCKET: 'test-bucket',
    S3_STORAGE_PROVIDER: 's3',
    S3_REGION: 'ap-south-1',
    S3_ACCESS_KEY_ID: 'test-access-key',
    S3_SECRET_ACCESS_KEY: 'test-secret-key',
  };

  function createService(send: jest.Mock) {
    const config = {
      get: jest.fn((key: string) => configValues[key]),
    } as unknown as ConfigService;
    const service = new S3StorageService(config);

    Object.defineProperty(service, 'client', {
      value: { send },
    });
    Object.defineProperty(service, 'logger', {
      value: { error: jest.fn() },
    });

    return service;
  }

  function createPdf(name: string): Express.Multer.File {
    const buffer = Buffer.from('%PDF-1.4 test');

    return {
      fieldname: 'file',
      originalname: name,
      encoding: '7bit',
      mimetype: 'application/pdf',
      size: buffer.length,
      buffer,
      destination: '',
      filename: '',
      path: '',
      stream: undefined as never,
    };
  }

  it('percent-encodes non-ASCII filenames before sending S3 metadata', async () => {
    let uploadedCommand: PutObjectCommand | undefined;
    const send = jest.fn((command: PutObjectCommand) => {
      uploadedCommand = command;
      return Promise.resolve({});
    });
    const service = createService(send);
    const fileName = 'Company handbook - caf\u00e9.pdf';

    await service.uploadKnowledgeFile({
      organizationId: 'org_demo',
      file: createPdf(fileName),
    });

    const metadata = uploadedCommand?.input.Metadata ?? {};

    expect(metadata.originalNameEncoded).toBe(encodeURIComponent(fileName));
    expect(
      Array.from(metadata.originalNameEncoded ?? '').every(
        (character) => character.charCodeAt(0) <= 127,
      ),
    ).toBe(true);
  });

  it('returns a service-unavailable response when S3 rejects the upload', async () => {
    const service = createService(
      jest.fn().mockRejectedValue(new Error('Invalid character in header')),
    );
    await expect(
      service.uploadKnowledgeFile({
        organizationId: 'org_demo',
        file: createPdf('handbook.pdf'),
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
