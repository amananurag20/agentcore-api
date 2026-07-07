import { Injectable } from '@nestjs/common';

export interface TextChunk {
  content: string;
  charCount: number;
  tokenEstimate: number;
}

@Injectable()
export class TextChunkerService {
  private readonly chunkSize = 1000;
  private readonly overlapSize = 150;

  chunk(input: string): TextChunk[] {
    const text = input.trim().replace(/\s+/g, ' ');

    if (!text) {
      return [];
    }

    const chunks: TextChunk[] = [];
    let cursor = 0;

    while (cursor < text.length) {
      const end = Math.min(cursor + this.chunkSize, text.length);
      const content = text.slice(cursor, end).trim();

      if (content) {
        chunks.push({
          content,
          charCount: content.length,
          tokenEstimate: Math.ceil(content.length / 4),
        });
      }

      if (end === text.length) {
        break;
      }

      cursor = Math.max(end - this.overlapSize, cursor + 1);
    }

    return chunks;
  }
}
