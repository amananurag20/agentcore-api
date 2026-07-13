import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PDFParse } from 'pdf-parse';
import * as mammoth from 'mammoth';
import * as ExcelJS from 'exceljs';

export interface ExtractedKnowledgeFile {
  text: string;
  metadata: Record<string, unknown>;
}

@Injectable()
export class KnowledgeFileExtractorService {
  private readonly maxCharacters: number;

  constructor(@Optional() private readonly configService?: ConfigService) {
    this.maxCharacters =
      this.configService?.get<number>('KNOWLEDGE_MAX_EXTRACTED_CHARACTERS') ??
      5_000_000;
  }

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
        text: this.assertWithinLimit(
          this.cleanText(input.buffer.toString('utf8')),
        ),
        metadata: { extractor: 'text' },
      };
    }

    if (
      mimeType ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      this.hasExtension(input.fileName, '.docx')
    ) {
      return this.extractDocx(input.buffer);
    }

    if (
      mimeType ===
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      this.hasExtension(input.fileName, '.xlsx')
    ) {
      return this.extractSpreadsheet(input.buffer);
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

      if (text.length < 10) {
        return this.extractPdfWithOcr(buffer, result.total);
      }

      return {
        text: this.assertWithinLimit(text),
        metadata: {
          extractor: 'pdf-parse',
          pageCount: result.total,
        },
      };
    } finally {
      await parser.destroy();
    }
  }

  private async extractDocx(buffer: Buffer): Promise<ExtractedKnowledgeFile> {
    const result = await mammoth.extractRawText({ buffer });
    const text = this.cleanText(result.value);
    if (!text) {
      throw new BadRequestException('DOCX contains no extractable text');
    }
    return {
      text: this.assertWithinLimit(text),
      metadata: {
        extractor: 'mammoth',
        warnings: result.messages.map((message) => message.message),
      },
    };
  }

  private async extractSpreadsheet(
    buffer: Buffer,
  ): Promise<ExtractedKnowledgeFile> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const sections = workbook.worksheets
      .map((worksheet) => {
        const rows: string[] = [];
        worksheet.eachRow({ includeEmpty: false }, (row) => {
          const values: string[] = [];
          row.eachCell({ includeEmpty: true }, (cell) => {
            const value = cell.text;
            values.push(
              /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value,
            );
          });
          rows.push(values.join(','));
        });
        return rows.length
          ? `Sheet: ${worksheet.name}\n${rows.join('\n')}`
          : '';
      })
      .filter(Boolean);
    const text = this.cleanText(sections.join('\n\n'));
    if (!text) {
      throw new BadRequestException(
        'Spreadsheet contains no extractable cells',
      );
    }
    return {
      text: this.assertWithinLimit(text),
      metadata: {
        extractor: 'exceljs',
        sheetCount: workbook.worksheets.length,
        sheets: workbook.worksheets.map((worksheet) => worksheet.name),
      },
    };
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

  private async extractPdfWithOcr(
    buffer: Buffer,
    parsedPageCount: number,
  ): Promise<ExtractedKnowledgeFile> {
    const endpoint = this.configService?.get<string>('KNOWLEDGE_OCR_ENDPOINT');
    if (!endpoint) {
      throw new BadRequestException(
        'PDF appears to be scanned. Configure KNOWLEDGE_OCR_ENDPOINT to enable OCR.',
      );
    }
    const form = new FormData();
    form.set(
      'file',
      new Blob([Uint8Array.from(buffer)], { type: 'application/pdf' }),
      'scan.pdf',
    );
    const apiKey = this.configService?.get<string>('KNOWLEDGE_OCR_API_KEY');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      body: form,
      signal: AbortSignal.timeout(
        this.configService?.get<number>('KNOWLEDGE_OCR_TIMEOUT_MS') ?? 60_000,
      ),
    });
    if (!response.ok) {
      throw new BadRequestException(
        `OCR service returned HTTP ${response.status}`,
      );
    }
    const result = (await response.json()) as {
      text?: string;
      pageCount?: number;
    };
    const text = this.assertWithinLimit(this.cleanText(result.text ?? ''));
    if (!text) {
      throw new BadRequestException('OCR service returned no readable text');
    }
    return {
      text,
      metadata: {
        extractor: 'ocr',
        pageCount: result.pageCount ?? parsedPageCount,
      },
    };
  }

  private assertWithinLimit(text: string): string {
    if (text.length > this.maxCharacters) {
      throw new BadRequestException(
        `Extracted content exceeds the ${this.maxCharacters} character limit`,
      );
    }
    return text;
  }

  private hasExtension(fileName: string | null | undefined, extension: string) {
    return fileName?.toLowerCase().endsWith(extension) ?? false;
  }
}
