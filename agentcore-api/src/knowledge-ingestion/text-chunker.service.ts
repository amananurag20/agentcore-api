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
      const hardEnd = Math.min(cursor + this.chunkSize, text.length);
      const end = this.findBoundary(text, cursor, hardEnd);
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
      while (cursor > 0 && cursor < text.length && !/\s/.test(text[cursor])) {
        cursor -= 1;
      }
    }

    return chunks;
  }

  private findBoundary(text: string, start: number, hardEnd: number): number {
    if (hardEnd === text.length) return hardEnd;
    const minimumEnd = Math.min(
      hardEnd,
      start + Math.floor(this.chunkSize * 0.7),
    );
    for (let index = hardEnd; index >= minimumEnd; index -= 1) {
      if (/\s/.test(text[index] ?? '')) return index;
    }
    return hardEnd;
  }
}
