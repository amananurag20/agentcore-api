export function toPgVector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
