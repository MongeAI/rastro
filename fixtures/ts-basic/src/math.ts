export function sum(a: number, b: number): number {
  return a + b;
}

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, v) => sum(acc, v), 0) / values.length;
}

export const double = (n: number): number => multiply(n, 2);

function multiply(a: number, b: number): number {
  return a * b;
}
