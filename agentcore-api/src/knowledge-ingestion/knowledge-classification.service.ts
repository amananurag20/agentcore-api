import { Injectable } from '@nestjs/common';
import { ChatService } from '../ai/chat.service';

export interface KnowledgeClassification {
  categories: string[];
  level: number;
  rationale: string;
  classifier: 'ai' | 'heuristic';
}

@Injectable()
export class KnowledgeClassificationService {
  constructor(private readonly chatService: ChatService) {}

  async classify(input: {
    organizationId: string;
    title: string;
    text: string;
  }): Promise<KnowledgeClassification> {
    const sample = input.text.slice(0, 12_000);
    const result = await this.chatService.answerWithContext({
      organizationId: input.organizationId,
      question:
        'Classify this organizational knowledge. Return only compact JSON with keys categories (2-5 lowercase labels), level (integer 0-4), and rationale (one sentence). Levels: 0 public, 1 internal, 2 restricted, 3 confidential, 4 owner-only.',
      context: [{ content: `Title: ${input.title}\n\n${sample}`, score: 1 }],
    });
    if (!result.usedFallback) {
      const parsed = this.parseClassification(result.answer);
      if (parsed) return { ...parsed, classifier: 'ai' };
    }
    return this.heuristicClassification(input.title, sample);
  }

  private parseClassification(
    answer: string,
  ): Omit<KnowledgeClassification, 'classifier'> | null {
    const match = answer.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const value = JSON.parse(match[0]) as Record<string, unknown>;
      if (!Array.isArray(value.categories) || typeof value.level !== 'number') {
        return null;
      }
      return {
        categories: this.normalizeCategories(value.categories),
        level: this.clampLevel(value.level),
        rationale:
          typeof value.rationale === 'string'
            ? value.rationale.slice(0, 500)
            : 'Suggested by the configured AI classifier.',
      };
    } catch {
      return null;
    }
  }

  private heuristicClassification(
    title: string,
    text: string,
  ): KnowledgeClassification {
    const content = `${title}\n${text}`.toLowerCase();
    const categories: string[] = [];
    const categoryRules: Array<[string, RegExp]> = [
      ['finance', /\b(invoice|revenue|financial|pricing|payment|bank|tax)\b/],
      ['legal', /\b(contract|legal|lawsuit|agreement|compliance)\b/],
      ['customer-data', /\b(customer|client|email address|phone number|pii)\b/],
      ['people', /\b(employee|staff|salary|payroll|human resources|hr)\b/],
      ['operations', /\b(sop|procedure|workflow|schedule|operations)\b/],
      ['product', /\b(product|service|feature|technical|documentation)\b/],
      ['public-info', /\b(faq|opening hours|about us|marketing|contact us)\b/],
    ];
    for (const [category, rule] of categoryRules) {
      if (rule.test(content)) categories.push(category);
    }

    let level = 1;
    let rationale = 'General organizational material defaults to internal.';
    if (
      /\b(password|secret key|api key|credential|merger|acquisition|legal dispute)\b/.test(
        content,
      )
    ) {
      level = 4;
      rationale =
        'Credentials-adjacent, legal-dispute, or corporate transaction language detected.';
    } else if (
      /\b(ssn|passport|medical record|customer export|confidential|salary|payroll|contract)\b/.test(
        content,
      )
    ) {
      level = 3;
      rationale =
        'Confidential personal, contractual, or compensation language detected.';
    } else if (
      /\b(supplier terms|pricing rule|staff schedule|restricted|invoice|bank)\b/.test(
        content,
      )
    ) {
      level = 2;
      rationale = 'Restricted commercial or operational language detected.';
    } else if (
      /\b(faq|opening hours|published|public|marketing)\b/.test(content)
    ) {
      level = 0;
      rationale = 'The content appears intended for public consumption.';
    }

    return {
      categories: categories.length ? categories.slice(0, 5) : ['general'],
      level,
      rationale,
      classifier: 'heuristic',
    };
  }

  private normalizeCategories(input: unknown[]) {
    return [
      ...new Set(
        input
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) =>
            entry
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-'),
          )
          .filter(Boolean),
      ),
    ].slice(0, 5);
  }

  private clampLevel(level: number) {
    return Math.max(0, Math.min(4, Math.round(level)));
  }
}
