import { readFile } from 'fs/promises';

type EvalCase = {
  query: string;
  expectedSourceIds: string[];
  productKey?: string;
};

type SearchResult = { sourceId?: string | null };

async function main() {
  const apiUrl = process.env.KNOWLEDGE_EVAL_API_URL;
  const token = process.env.KNOWLEDGE_EVAL_TOKEN;
  const datasetPath = process.env.KNOWLEDGE_EVAL_DATASET;
  if (!apiUrl || !token || !datasetPath) {
    throw new Error(
      'Set KNOWLEDGE_EVAL_API_URL, KNOWLEDGE_EVAL_TOKEN, and KNOWLEDGE_EVAL_DATASET',
    );
  }
  const cases = JSON.parse(await readFile(datasetPath, 'utf8')) as EvalCase[];
  if (!Array.isArray(cases) || !cases.length)
    throw new Error('Evaluation dataset is empty');
  let reciprocalRank = 0;
  let recalled = 0;
  for (const testCase of cases) {
    const response = await fetch(
      `${apiUrl.replace(/\/$/, '')}/knowledge/search`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          query: testCase.query,
          productKey: testCase.productKey,
          limit: 10,
        }),
      },
    );
    if (!response.ok)
      throw new Error(`Search failed with HTTP ${response.status}`);
    const results = (await response.json()) as SearchResult[];
    const rank = results.findIndex(
      (result) =>
        result.sourceId && testCase.expectedSourceIds.includes(result.sourceId),
    );
    if (rank >= 0) {
      reciprocalRank += 1 / (rank + 1);
      recalled += 1;
    }
  }
  const mrr = reciprocalRank / cases.length;
  const recallAt10 = recalled / cases.length;
  const minimumMrr = Number(process.env.KNOWLEDGE_EVAL_MIN_MRR ?? 0.7);
  const minimumRecall = Number(
    process.env.KNOWLEDGE_EVAL_MIN_RECALL_AT_10 ?? 0.85,
  );
  console.log(
    JSON.stringify({ cases: cases.length, mrr, recallAt10 }, null, 2),
  );
  if (mrr < minimumMrr || recallAt10 < minimumRecall) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
