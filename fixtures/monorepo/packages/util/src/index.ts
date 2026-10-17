export function formatName(name: string): string {
  return name.trim();
}

export class Greeter {
  greet(name: string): string {
    return `Olá, ${formatName(name)}`;
  }
}
