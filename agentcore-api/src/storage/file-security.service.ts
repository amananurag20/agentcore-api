import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'net';

export type MalwareScanResult = {
  status: 'clean' | 'not_required';
  message: string;
};

@Injectable()
export class FileSecurityService {
  private readonly host?: string;
  private readonly port: number;
  private readonly required: boolean;
  private readonly timeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    this.host = this.configService.get<string>('CLAMAV_HOST');
    this.port = this.configService.get<number>('CLAMAV_PORT') ?? 3310;
    this.required =
      this.configService.get<boolean>('MALWARE_SCAN_REQUIRED') ?? true;
    this.timeoutMs =
      this.configService.get<number>('MALWARE_SCAN_TIMEOUT_MS') ?? 15_000;
  }

  async scan(buffer: Buffer): Promise<MalwareScanResult> {
    if (!this.host) {
      if (this.required) {
        throw new ServiceUnavailableException(
          'File malware scanning is required but ClamAV is not configured',
        );
      }
      return {
        status: 'not_required',
        message: 'ClamAV is not configured',
      };
    }

    const response = await this.scanWithClamAv(buffer);
    if (response.includes('FOUND')) {
      throw new BadRequestException(
        `Upload rejected by malware scanner: ${response.replace(/\0/g, '').trim()}`,
      );
    }
    if (!response.includes('OK')) {
      throw new ServiceUnavailableException(
        `Malware scanner returned an unexpected response: ${response.trim()}`,
      );
    }
    return { status: 'clean', message: response.replace(/\0/g, '').trim() };
  }

  private scanWithClamAv(buffer: Buffer): Promise<string> {
    const host = this.host;
    if (!host) {
      return Promise.reject(
        new ServiceUnavailableException('Malware scanner host is missing'),
      );
    }
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      const fail = (error: Error) => {
        socket.destroy();
        reject(
          new ServiceUnavailableException(
            `Malware scanner is unavailable: ${error.message}`,
          ),
        );
      };

      socket.setTimeout(this.timeoutMs, () =>
        fail(new Error('scan request timed out')),
      );
      socket.once('error', fail);
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.connect(this.port, host, () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
          const chunk = buffer.subarray(offset, offset + 64 * 1024);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length, 0);
          socket.write(size);
          socket.write(chunk);
        }
        socket.end(Buffer.alloc(4));
      });
    });
  }
}
