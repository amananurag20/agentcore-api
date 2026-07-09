import { BadRequestException, Injectable } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';

export interface ExtractedKnowledgeFile {
  text: string;
  metadata: Record<string, unknown>;
}

@Injectable()
export class KnowledgeFileExtractorService {
  async extract(input: {
    buffer: Buffer;
    fileName?: string | null;
    mimeType?: string | null;
  }): Promise<ExtractedKnowledgeFile> {
    const mimeType = input.mimeType?.toLowerCase() ?? '';

    if (
      mimeType === 'application/pdf' ||
      this.hasExtension(input.fileName, '.pdf')
    ) {
      return this.extractPdf(input.buffer);
    }

    if (
      mimeType.startsWith('text/') ||
      ['.txt', '.md', '.csv', '.tsv'].some((extension) =>
        this.hasExtension(input.fileName, extension),
      )
    ) {
      return {
        text: this.cleanText(input.buffer.toString('utf8')),
        metadata: { extractor: 'text' },
      };
    }

    throw new BadRequestException(
      `Unsupported uploaded file type: ${input.mimeType || 'unknown'}`,
    );
  }

  private async extractPdf(buffer: Buffer): Promise<ExtractedKnowledgeFile> {
    const parser = new PDFParse({ data: buffer });

    try {
      const result = await parser.getText({
        pageJoiner: '\n\n',
      });
      const text = this.cleanText(result.text);

      if (!text) {
        throw new BadRequestException('PDF contains no extractable text');
      }

      return {
        text,
        metadata: {
          extractor: 'pdf-parse',
          pageCount: result.total,
        },
      };
    } finally {
      await parser.destroy();
    }
  }

  private cleanText(input: string): string {
    return input
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private hasExtension(fileName: string | null | undefined, extension: string) {
    return fileName?.toLowerCase().endsWith(extension) ?? false;
  }
}
