import { formatPrice } from '@/lib/format';

export function renderCart(total: number): string {
  return `Total: ${formatPrice(total)}`;
}
