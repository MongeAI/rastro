import { formatPrice } from '@/lib/format';
import { audit } from '@/audit';

export function orderSummary(total: number): string {
  audit('resumo');
  return formatPrice(total);
}
