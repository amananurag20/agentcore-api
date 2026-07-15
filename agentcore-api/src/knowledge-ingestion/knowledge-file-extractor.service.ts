import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PDFParse } from 'pdf-parse';
import * as mammoth from 'mammoth';
import * as ExcelJS from 'exceljs';
import {
  KnowledgeExtractionRuntimePolicy,
  KnowledgeOcrPageResult,
  KnowledgeOcrService,
} from './knowledge-ocr.service';

export interface ExtractedKnowledgePage {
  pageNumber: number;
  text: string;
  extractionMethod: 'native' | 'ocr' | 'unprocessed';
  confidence: number | null;
  provider: string | null;
  model: string | null;
  cacheHit: boolean;
  metadata: Record<string, unknown>;
}

export interface ExtractedKnowledgeFile {
  text: string;
  metadata: Record<string, unknown>;
  pages?: ExtractedKnowledgePage[];
}

@Injectable()
export class KnowledgeFileExtractorService {
  private readonly maxCharacters: number;
  private readonly maxPdfPages: number;
  private readonly nativeTextMinimumCharacters: number;
  private readonly nativeTextMinimumRatio: number;
  private readonly ocrPageConcurrency: number;
  private readonly ocrRenderWidth: number;

  constructor(
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly ocrService?: KnowledgeOcrService,
  ) {
    this.maxCharacters =
      this.configService?.get<number>('KNOWLEDGE_MAX_EXTRACTED_CHARACTERS') ??
      25_000_000;
    this.maxPdfPages =
      this.configService?.get<number>('KNOWLEDGE_PDF_MAX_PAGES') ?? 5_000;
    this.nativeTextMinimumCharacters =
      this.configService?.get<number>(
        'KNOWLEDGE_PDF_NATIVE_TEXT_MIN_CHARACTERS_PER_PAGE',
      ) ?? 40;
    this.nativeTextMinimumRatio =
      this.configService?.get<number>(
        'KNOWLEDGE_PDF_NATIVE_TEXT_MIN_ALPHANUMERIC_RATIO',
      ) ?? 0.5;
    this.ocrPageConcurrency =
      this.configService?.get<number>('KNOWLEDGE_OCR_PAGE_CONCURRENCY') ?? 4;
    this.ocrRenderWidth =
      this.configService?.get<number>('KNOWLEDGE_OCR_RENDER_WIDTH') ?? 1_800;
  }

  async extract(input: {
    buffer: Buffer;
    fileName?: string | null;
    mimeType?: string | null;
    organizationId?: string;
  }): Promise<ExtractedKnowledgeFile> {
    const policy = this.ocrService
      ? await this.ocrService.resolveRuntimePolicy(input.organizationId)
      : this.defaultRuntimePolicy();
    const mimeType = input.mimeType?.toLowerCase() ?? '';

    if (
      mimeType === 'application/pdf' ||
      this.hasExtension(input.fileName, '.pdf')
    ) {
      return this.extractPdf(input, policy);
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
          policy.maxExtractedCharacters,
        ),
        metadata: { extractor: 'text' },
      };
    }

    if (
      mimeType ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      this.hasExtension(input.fileName, '.docx')
    ) {
      return this.extractDocx(input.buffer, policy.maxExtractedCharacters);
    }

    if (
      mimeType ===
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      this.hasExtension(input.fileName, '.xlsx')
    ) {
      return this.extractSpreadsheet(
        input.buffer,
        policy.maxExtractedCharacters,
      );
    }

    throw new BadRequestException(
      `Unsupported uploaded file type: ${input.mimeType || 'unknown'}`,
    );
  }

  private async extractPdf(
    input: {
      buffer: Buffer;
      fileName?: string | null;
      organizationId?: string;
    },
    policy: KnowledgeExtractionRuntimePolicy,
  ): Promise<ExtractedKnowledgeFile> {
    const parser = new PDFParse({ data: input.buffer });

    try {
      const result = await parser.getText({
        pageJoiner: '',
      });
      if (result.total > policy.maxPdfPages) {
        throw new BadRequestException(
          `PDF exceeds the ${policy.maxPdfPages} page ingestion limit`,
        );
      }

      const nativePages = result.pages?.length
        ? result.pages.map((page) => ({
            pageNumber: page.num,
            text: this.cleanText(page.text),
          }))
        : [{ pageNumber: 1, text: this.cleanText(result.text) }];
      const mode = policy.mode;
      const pages: ExtractedKnowledgePage[] = nativePages.map((page) => {
        const nativeTextUsable = this.hasUsableNativeText(page.text, policy);
        const useNative = mode !== 'always' && nativeTextUsable;
        return {
          pageNumber: page.pageNumber,
          text: useNative ? page.text : '',
          extractionMethod: useNative ? 'native' : 'unprocessed',
          confidence: useNative ? 1 : null,
          provider: useNative ? 'pdf-parse' : null,
          model: null,
          cacheHit: false,
          metadata: {
            nativeCharacterCount: page.text.length,
            nativeAlphanumericRatio: this.alphanumericRatio(page.text),
          },
        };
      });
      const pagesNeedingOcr = pages.filter(
        (page) => page.extractionMethod === 'unprocessed',
      );

      if (pagesNeedingOcr.length && this.ocrService?.isConfigured(policy)) {
        for (
          let offset = 0;
          offset < pagesNeedingOcr.length;
          offset += policy.ocrPageConcurrency
        ) {
          const batch = pagesNeedingOcr.slice(
            offset,
            offset + policy.ocrPageConcurrency,
          );
          const screenshots = await parser.getScreenshot({
            partial: batch.map((page) => page.pageNumber),
            desiredWidth: policy.ocrRenderWidth,
            imageDataUrl: false,
            imageBuffer: true,
          });
          const screenshotByPage = new Map(
            screenshots.pages.map((page) => [page.pageNumber, page]),
          );
          const recognized = await Promise.all(
            batch.map(async (page) => {
              const screenshot = screenshotByPage.get(page.pageNumber);
              if (!screenshot?.data?.length) {
                throw new BadRequestException(
                  `Could not render PDF page ${page.pageNumber} for OCR`,
                );
              }
              return this.ocrService!.recognizePage({
                organizationId: input.organizationId,
                image: Buffer.from(screenshot.data),
                pageNumber: page.pageNumber,
                documentName: input.fileName,
                policy,
              });
            }),
          );
          recognized.forEach((ocr, index) =>
            this.applyOcrResult(batch[index], ocr),
          );
        }
      }

      const extractedPages = pages.filter((page) => page.text.length > 0);
      const text = this.assertWithinLimit(
        extractedPages
          .map(
            (page) => `[Page ${page.pageNumber}]\n${this.cleanText(page.text)}`,
          )
          .join('\n\n'),
        policy.maxExtractedCharacters,
      );
      if (!text) {
        throw new BadRequestException(
          pagesNeedingOcr.length
            ? 'PDF has no extractable text. Configure an OCR provider for scanned pages.'
            : 'PDF contains no extractable text',
        );
      }

      const ocrPages = pages.filter((page) => page.extractionMethod === 'ocr');
      const emptyOcrPages = ocrPages.filter((page) => page.text.length === 0);
      const unprocessedPages = pages.filter(
        (page) => page.extractionMethod === 'unprocessed',
      );
      return {
        text,
        pages: extractedPages,
        metadata: {
          extractor: ocrPages.length ? 'hybrid-pdf' : 'pdf-parse',
          pageCount: result.total,
          extractedPageCount: extractedPages.length,
          nativePageCount: pages.filter(
            (page) => page.extractionMethod === 'native',
          ).length,
          ocrPageCount: ocrPages.length,
          ocrCacheHitCount: ocrPages.filter((page) => page.cacheHit).length,
          emptyOcrPageCount: emptyOcrPages.length,
          emptyOcrPages: emptyOcrPages.map((page) => page.pageNumber),
          unprocessedPageCount: unprocessedPages.length,
          unprocessedPages: unprocessedPages.map((page) => page.pageNumber),
        },
      };
    } finally {
      await parser.destroy();
    }
  }

  private async extractDocx(
    buffer: Buffer,
    maxCharacters: number,
  ): Promise<ExtractedKnowledgeFile> {
    const result = await mammoth.extractRawText({ buffer });
    const text = this.cleanText(result.value);
    if (!text) {
      throw new BadRequestException('DOCX contains no extractable text');
    }
    return {
      text: this.assertWithinLimit(text, maxCharacters),
      metadata: {
        extractor: 'mammoth',
        warnings: result.messages.map((message) => message.message),
      },
    };
  }

  private async extractSpreadsheet(
    buffer: Buffer,
    maxCharacters: number,
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
      text: this.assertWithinLimit(text, maxCharacters),
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

  private applyOcrResult(
    page: ExtractedKnowledgePage,
    ocr: KnowledgeOcrPageResult,
  ) {
    page.text = this.cleanText(ocr.text);
    page.extractionMethod = 'ocr';
    page.confidence = ocr.confidence;
    page.provider = ocr.provider;
    page.model = ocr.model;
    page.cacheHit = ocr.cacheHit;
    page.metadata = { ...page.metadata, ...ocr.metadata };
  }

  private hasUsableNativeText(
    text: string,
    policy: KnowledgeExtractionRuntimePolicy,
  ): boolean {
    return (
      text.length >= policy.nativeTextMinimumCharacters &&
      this.alphanumericRatio(text) >= policy.nativeTextMinimumRatio
    );
  }

  private alphanumericRatio(text: string): number {
    const nonWhitespace = text.replace(/\s/g, '');
    if (!nonWhitespace.length) return 0;
    return (
      (nonWhitespace.match(/[\p{L}\p{N}]/gu)?.length ?? 0) /
      nonWhitespace.length
    );
  }

  private assertWithinLimit(
    text: string,
    maxCharacters = this.maxCharacters,
  ): string {
    if (text.length > maxCharacters) {
      throw new BadRequestException(
        `Extracted content exceeds the ${maxCharacters} character limit`,
      );
    }
    return text;
  }

  private hasExtension(fileName: string | null | undefined, extension: string) {
    return fileName?.toLowerCase().endsWith(extension) ?? false;
  }

  private defaultRuntimePolicy(): KnowledgeExtractionRuntimePolicy {
    return {
      mode: 'disabled',
      primary: null,
      fallback: null,
      minimumConfidence: 0.75,
      timeoutMs: 60_000,
      maxRetries: 2,
      nativeTextMinimumCharacters: this.nativeTextMinimumCharacters,
      nativeTextMinimumRatio: this.nativeTextMinimumRatio,
      ocrPageConcurrency: this.ocrPageConcurrency,
      ocrRenderWidth: this.ocrRenderWidth,
      maxPdfPages: this.maxPdfPages,
      maxExtractedCharacters: this.maxCharacters,
      pipelineSignature: 'disabled',
    };
  }
}
