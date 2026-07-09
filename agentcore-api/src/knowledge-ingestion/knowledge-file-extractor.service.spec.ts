import { BadRequestException } from '@nestjs/common';
import { KnowledgeFileExtractorService } from './knowledge-file-extractor.service';

const getText = jest.fn();
const destroy = jest.fn();

jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn().mockImplementation(() => ({
    getText,
    destroy,
  })),
}));

describe('KnowledgeFileExtractorService', () => {
  beforeEach(() => {
    getText.mockReset();
    destroy.mockReset();
    destroy.mockResolvedValue(undefined);
  });

  it('extracts text from PDFs', async () => {
    getText.mockResolvedValue({
      text: ' Page one text. \n\n\n Page two text. ',
      total: 2,
    });
    const service = new KnowledgeFileExtractorService();

    const result = await service.extract({
      buffer: Buffer.from('%PDF sample'),
      fileName: 'guide.pdf',
      mimeType: 'application/pdf',
    });

    expect(result.text).toBe('Page one text.\n\nPage two text.');
    expect(result.metadata).toEqual({
      extractor: 'pdf-parse',
      pageCount: 2,
    });
    expect(destroy).toHaveBeenCalledTimes(1);
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
});
