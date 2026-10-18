import type { SourceFile } from 'ts-morph';
import type { DiscoveredFile } from '../discover.js';
import { safely, type AnalyzerContext } from '../analyze.js';
import { copySharedHandlerCalls, finishRoutes, RouteState } from './common.js';
import { detectExpressRoutes } from './express.js';
import { collectFastifyRegistrations, detectFastifyRoutes } from './fastify.js';
import { detectHonoRoutes } from './hono.js';
import { detectNestRoutes, finishNest } from './nest.js';
import { detectNextRoutes } from './next.js';

/**
 * Regras de rotas por framework (Express, Fastify, Hono, NestJS e Next.js).
 * Regra da casa: uma rota só existe quando o framework é comprovado (o símbolo vem do pacote
 * do framework, pelo verificador de tipos, ou a convenção de arquivos do Next.js vale para o
 * projeto). Nada é executado e nenhuma rota é inventada.
 *
 * Uso: `prepare` em todos os arquivos (antes), `detect` em cada arquivo e `finish` no fim,
 * quando montagens feitas em outros arquivos já são conhecidas.
 */
export class RouteDetector {
  private readonly state: RouteState;

  constructor(private readonly ctx: AnalyzerContext) {
    this.state = new RouteState(ctx);
  }

  /** Passo preparatório: registros de plugins do Fastify (podem estar em qualquer arquivo). */
  prepare(file: DiscoveredFile, sf: SourceFile): void {
    safely(this.ctx, file, 'rotas (Fastify)', () => collectFastifyRegistrations(this.state, sf));
  }

  detect(file: DiscoveredFile, sf: SourceFile): void {
    const { ctx, state } = this;
    safely(ctx, file, 'rotas (Express)', () => detectExpressRoutes(state, file, sf));
    safely(ctx, file, 'rotas (Fastify)', () => detectFastifyRoutes(state, file, sf));
    safely(ctx, file, 'rotas (Hono)', () => detectHonoRoutes(state, file, sf));
    safely(ctx, file, 'rotas (NestJS)', () => detectNestRoutes(state, file, sf));
    safely(ctx, file, 'rotas (Next.js)', () => detectNextRoutes(state, file, sf));
  }

  /** Caminhos completos (prefixos de montagem compostos entre arquivos). */
  finish(): void {
    finishNest(this.state);
    finishRoutes(this.state);
  }

  /** Depois das chamadas: rotas que dividem um handler inline recebem as mesmas chamadas. */
  afterCalls(): void {
    copySharedHandlerCalls(this.state);
  }
}
