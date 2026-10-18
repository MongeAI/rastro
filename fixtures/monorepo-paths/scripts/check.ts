// Fora dos subpacotes: o alias "@/*" não existe aqui e não pode ser emprestado de nenhum deles.
import { formatPrice } from '@/lib/format';

export function check(): string {
  return formatPrice(1);
}
