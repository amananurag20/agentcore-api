import { BadRequestException, Injectable } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import * as mammoth from 'mammoth';
import * as ExcelJS from 'exceljs';

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

  private async extractDocx(buffer: Buffer): Promise<ExtractedKnowledgeFile> {
    const result = await mammoth.extractRawText({ buffer });
    const text = this.cleanText(result.value);
    if (!text) {
      throw new BadRequestException('DOCX contains no extractable text');
    }
    return {
      text,
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
      text,
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

  private hasExtension(fileName: string | null | undefined, extension: string) {
    return fileName?.toLowerCase().endsWith(extension) ?? false;
  }
}
