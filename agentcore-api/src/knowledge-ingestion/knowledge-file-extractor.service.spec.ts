import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KnowledgeFileExtractorService } from './knowledge-file-extractor.service';
import { KnowledgeOcrService } from './knowledge-ocr.service';
import * as ExcelJS from 'exceljs';

const getText = jest.fn();
const getScreenshot = jest.fn();
const destroy = jest.fn();

jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn().mockImplementation(() => ({
    getText,
    getScreenshot,
    destroy,
  })),
}));

describe('KnowledgeFileExtractorService', () => {
  beforeEach(() => {
    getText.mockReset();
    getScreenshot.mockReset();
    destroy.mockReset();
    destroy.mockResolvedValue(undefined);
  });

  it('extracts text from PDFs', async () => {
    getText.mockResolvedValue({
      text: ' Page one text. \n\n\n Page two text. ',
      total: 2,
      pages: [
        { num: 1, text: ' Page one text with enough readable content. ' },
        { num: 2, text: ' Page two text with enough readable content. ' },
      ],
    });
    const service = new KnowledgeFileExtractorService();

    const result = await service.extract({
      buffer: Buffer.from('%PDF sample'),
      fileName: 'guide.pdf',
      mimeType: 'application/pdf',
    });

    expect(result.text).toBe(
      '[Page 1]\nPage one text with enough readable content.\n\n' +
        '[Page 2]\nPage two text with enough readable content.',
    );
    expect(result.metadata).toEqual({
      extractor: 'pdf-parse',
      pageCount: 2,
      extractedPageCount: 2,
      nativePageCount: 2,
      ocrPageCount: 0,
      ocrCacheHitCount: 0,
      emptyOcrPageCount: 0,
      emptyOcrPages: [],
      unprocessedPageCount: 0,
      unprocessedPages: [],
    });
    expect(result.pages).toHaveLength(2);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('OCRs only low-text PDF pages and retains page metadata', async () => {
    getText.mockResolvedValue({
      text: '',
      total: 2,
      pages: [
        {
          num: 1,
          text: 'A native page with enough selectable text to use directly.',
        },
        { num: 2, text: '' },
      ],
    });
    getScreenshot.mockResolvedValue({
      total: 2,
      pages: [
        {
          pageNumber: 2,
          data: Uint8Array.from([1, 2, 3]),
          dataUrl: '',
          width: 1800,
          height: 2400,
          scale: 1,
        },
      ],
    });
    const recognizePage = jest.fn().mockResolvedValue({
      text: 'Text recovered from the scanned second page.',
      confidence: 0.93,
      provider: 'local-tesseract',
      model: 'tesseract-5',
      cacheHit: true,
      metadata: { language: 'eng' },
    });
    const ocrService = {
      getMode: jest.fn().mockReturnValue('fallback'),
      isConfigured: jest.fn().mockReturnValue(true),
      resolveRuntimePolicy: jest.fn().mockResolvedValue(runtimePolicy(true)),
      recognizePage,
    } as unknown as KnowledgeOcrService;
    const service = new KnowledgeFileExtractorService(undefined, ocrService);

    const result = await service.extract({
      buffer: Buffer.from('%PDF sample'),
      fileName: 'mixed.pdf',
      mimeType: 'application/pdf',
      organizationId: 'org-1',
    });

    expect(result.metadata).toMatchObject({
      extractor: 'hybrid-pdf',
      nativePageCount: 1,
      ocrPageCount: 1,
      ocrCacheHitCount: 1,
      unprocessedPageCount: 0,
    });
    expect(result.pages?.[1]).toMatchObject({
      pageNumber: 2,
      extractionMethod: 'ocr',
      confidence: 0.93,
      provider: 'local-tesseract',
      cacheHit: true,
    });
    expect(recognizePage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        pageNumber: 2,
      }),
    );
  });

  it('rejects a fully scanned PDF when OCR is not configured', async () => {
    getText.mockResolvedValue({
      text: '',
      total: 1,
      pages: [{ num: 1, text: '' }],
    });
    const service = new KnowledgeFileExtractorService(
      { get: jest.fn() } as unknown as ConfigService,
      {
        getMode: jest.fn().mockReturnValue('fallback'),
        isConfigured: jest.fn().mockReturnValue(false),
        resolveRuntimePolicy: jest.fn().mockResolvedValue(runtimePolicy(false)),
      } as unknown as KnowledgeOcrService,
    );

    await expect(
      service.extract({
        buffer: Buffer.from('%PDF scan'),
        fileName: 'scan.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow('Configure an OCR provider');
  });

  it('extracts text uploads without PDF parsing', async () => {
    const service = new KnowledgeFileExtractorService();

    const result = await service.extract({
      buffer: Buffer.from('Hello   world\n\n\nSecond line'),
      fileName: 'notes.md',
      mimeType: 'text/markdown',
    });

    expect(result).toEqual({
      text: 'Hello world\n\nSecond line',
      metadata: { extractor: 'text' },
    });
    expect(getText).not.toHaveBeenCalled();
  });

  it('extracts sheet-aware text from XLSX workbooks', async () => {
    const service = new KnowledgeFileExtractorService();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Pricing');
    sheet.addRows([
      ['Service', 'Price'],
      ['Consultation', 120],
    ]);
    const workbookBuffer = await workbook.xlsx.writeBuffer();
    const result = await service.extract({
      buffer: Buffer.from(workbookBuffer),
      fileName: 'pricing.xlsx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    expect(result.text).toContain('Sheet: Pricing');
    expect(result.text).toContain('Consultation,120');
    expect(result.metadata).toMatchObject({
      extractor: 'exceljs',
      sheetCount: 1,
    });
  });

  it('rejects unsupported uploads', async () => {
    const service = new KnowledgeFileExtractorService();

    await expect(
      service.extract({
        buffer: Buffer.from('image'),
        fileName: 'image.png',
        mimeType: 'image/png',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  function runtimePolicy(configured: boolean) {
    return {
      mode: 'fallback' as const,
      primary: configured
        ? {
            endpoint: 'http://ocr.local/process',
            provider: 'local_tesseract',
            settings: {},
          }
        : null,
      fallback: null,
      minimumConfidence: 0.75,
      timeoutMs: 60_000,
      maxRetries: 2,
      nativeTextMinimumCharacters: 40,
      nativeTextMinimumRatio: 0.5,
      ocrPageConcurrency: 4,
      ocrRenderWidth: 1_800,
      maxPdfPages: 5_000,
      maxExtractedCharacters: 25_000_000,
      pipelineSignature: 'test',
    };
  }
});
