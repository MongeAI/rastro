import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { AnalysisSession, type DiscoverOptions } from '@rastro/analyzer';
import type { RastroGraph } from '@rastro/core';
import { computeInsights, GraphIndex, type Insights } from '@rastro/graph';
import { watchProject, type ProjectWatcher } from './watch.js';

/**
 * O projeto por trás do `rastro mcp`: o grafo sempre fresco para as ferramentas.
 *
 * A análise roda numa worker thread (o analisador é síncrono: na thread principal, ela
 * travaria o protocolo — nem `ping` nem `tools/list` seriam respondidos enquanto isso). A
 * worker guarda a `AnalysisSession`, então cada reanálise só relê os arquivos alterados.
 * O observador de arquivos (o mesmo do `--watch`) só marca o grafo como desatualizado; a
 * reanálise acontece antes de responder à próxima chamada de ferramenta, e chamadas
 * simultâneas esperam a mesma reanálise.
 */

/** Quem analisa o projeto: numa worker thread (CLI) ou na própria thread (testes). */
export interface AnalysisBackend {
  analyze(): Promise<RastroGraph>;
  close(): void;
}

/** Marca do `workerData` que identifica a worker de análise do `rastro mcp`. */
const WORKER_FLAG = 'rastroMcpAnalysis';

interface WorkerInput {
  [WORKER_FLAG]: true;
  root: string;
  discover: DiscoverOptions;
}

type WorkerReply =
  | { type: 'done'; id: number; graph: RastroGraph }
  | { type: 'failed'; id: number; message: string };

/** Este módulo está rodando dentro da worker de análise? (a CLI não roda o `main` nela) */
export const IN_ANALYSIS_WORKER =
  !isMainThread && (workerData as Partial<WorkerInput> | null)?.[WORKER_FLAG] === true;

// dentro da worker: uma sessão de análise que responde a cada pedido
if (IN_ANALYSIS_WORKER && parentPort) {
  const input = workerData as WorkerInput;
  const session = new AnalysisSession(input.root, input.discover);
  const port = parentPort;
  port.on('message', (message: { type: string; id: number }) => {
    if (message?.type !== 'analyze') return;
    session.analyze().then(
      (graph) => port.postMessage({ type: 'done', id: message.id, graph } satisfies WorkerReply),
      (err: unknown) =>
        port.postMessage({
          type: 'failed',
          id: message.id,
          message: err instanceof Error ? err.message : String(err),
        } satisfies WorkerReply),
    );
  });
}

/** Análise na própria thread (testes e ferramentas que não precisam de protocolo responsivo). */
export function inlineBackend(root: string, discover: DiscoverOptions = {}): AnalysisBackend {
  const session = new AnalysisSession(root, discover);
  return { analyze: () => session.analyze(), close: () => {} };
}

/**
 * Análise numa worker thread que carrega o próprio módulo da CLI (`entry`: o `rastro.mjs`
 * empacotado, ou este arquivo compilado). A worker é criada na primeira análise e recriada se
 * cair (perde só o cache do compilador). O `stdout` dela nunca chega ao do processo: lá só
 * passam mensagens do protocolo.
 */
export function workerBackend(
  root: string,
  discover: DiscoverOptions,
  entry: URL = new URL(import.meta.url),
): AnalysisBackend {
  let worker: Worker | undefined;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (graph: RastroGraph) => void; reject: (err: Error) => void }
  >();
  const failAll = (err: Error) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  const spawn = (): Worker => {
    const created = new Worker(entry, {
      workerData: { [WORKER_FLAG]: true, root, discover } satisfies WorkerInput,
      stdout: true,
      stderr: true,
    });
    // qualquer saída da worker vai para o stderr (o stdout é do protocolo)
    created.stdout.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    created.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    created.on('message', (reply: WorkerReply) => {
      const waiting = pending.get(reply.id);
      if (!waiting) return;
      pending.delete(reply.id);
      if (reply.type === 'done') waiting.resolve(reply.graph);
      else waiting.reject(new Error(reply.message));
    });
    created.on('error', (err) => {
      if (worker === created) worker = undefined;
      failAll(err);
    });
    created.on('exit', (code) => {
      if (worker === created) worker = undefined;
      failAll(new Error(`the analysis worker stopped (exit code ${code})`));
    });
    // a worker não segura o processo aberto: ele termina quando a entrada do protocolo fecha
    created.unref();
    return created;
  };
  return {
    analyze() {
      worker ??= spawn();
      const id = nextId++;
      const current = worker;
      return new Promise<RastroGraph>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        current.postMessage({ type: 'analyze', id });
      });
    },
    close() {
      const current = worker;
      worker = undefined;
      failAll(new Error('closed'));
      void current?.terminate();
    },
  };
}

/** Um grafo analisado, com o índice e o que as ferramentas consultam com frequência. */
export interface Snapshot {
  graph: RastroGraph;
  index: GraphIndex;
  /** Arquivos analisados (relativos à raiz): os únicos cujo código pode ser lido. */
  analyzedFiles: ReadonlySet<string>;
  /** Quando a análise terminou (ms desde 1970) e quanto levou, de ponta a ponta. */
  finishedAt: number;
  wallMs: number;
  /** Número da análise nesta sessão (1 = a primeira). */
  sequence: number;
  /** Insights calculados na primeira vez que alguém pede (e guardados até a próxima análise). */
  insights(): Insights;
}

export interface LiveProjectOptions {
  /** Observa o projeto e reanalisa quando algo muda (padrão: sim). */
  watch?: boolean;
  /** As mesmas regras da análise para escolher as pastas observadas. */
  discover?: DiscoverOptions;
  /** Varredura em vez de eventos do sistema (testes). */
  polling?: boolean;
  /** Intervalo da varredura (testes). */
  pollMs?: number;
  /** Avisos curtos para o stderr (início, fim de análise, falhas). */
  log?: (event: ProjectEvent) => void;
}

export type ProjectEvent =
  | { type: 'analyzed'; ms: number; files: number; sequence: number }
  | { type: 'failed'; message: string }
  | { type: 'watching'; mode: 'live' | 'polling' }
  | { type: 'watch-fallback'; reason: string; limit: boolean };

/** Quantas análises seguidas uma chamada espera antes de responder com a última (projeto em edição constante). */
const MAX_ROUNDS = 3;
/** Com eventos de arquivos nos últimos `SETTLE_MS`, espera essa calma (salvamentos em etapas)... */
const SETTLE_MS = 100;
/** ...mas nunca mais que isto. */
const MAX_SETTLE_MS = 500;

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

export class LiveProject {
  private snapshot: Snapshot | undefined;
  private running: Promise<Error | undefined> | undefined;
  /** O grafo atual não reflete o disco (ou ainda não existe). */
  private dirty = true;
  private sequence = 0;
  private watcher: ProjectWatcher | undefined;
  private closed = false;
  /** Quando chegou o último evento de arquivo (ms desde 1970). */
  private lastEvent = 0;

  constructor(
    readonly root: string,
    private readonly backend: AnalysisBackend,
    private readonly options: LiveProjectOptions = {},
  ) {}

  /** Vai observar os arquivos (não foi aberto com `--no-watch`)? */
  get watching(): boolean {
    return this.options.watch !== false;
  }

  /** Modo da observação de arquivos: `off` com `--no-watch` (ou antes de começar). */
  get watchMode(): 'live' | 'polling' | 'off' {
    return this.watcher?.mode ?? 'off';
  }

  /** Começa a primeira análise em segundo plano e a observação dos arquivos. Idempotente. */
  start(): void {
    if (this.closed || this.running || this.snapshot || this.watcher) return;
    if (this.options.watch !== false) {
      this.watcher = watchProject(this.root, () => this.markDirty(), {
        ...this.options.discover,
        // o grafo só é reanalisado na próxima chamada: marcar na hora não custa nada
        delayMs: 0,
        ...(this.options.polling ? { polling: true } : {}),
        ...(this.options.pollMs ? { pollMs: this.options.pollMs } : {}),
        onFallback: (err) =>
          this.options.log?.({
            type: 'watch-fallback',
            reason: err.code ?? err.message,
            limit: err.code === 'ENOSPC' || err.code === 'EMFILE',
          }),
      });
      this.options.log?.({ type: 'watching', mode: this.watcher.mode });
    }
    void this.run();
  }

  /** Algo mudou no disco: a próxima chamada reanalisa. */
  markDirty(): void {
    this.dirty = true;
    this.lastEvent = Date.now();
  }

  /**
   * Antes de decidir que o grafo está em dia: uma edição feita logo antes da chamada pode ter o
   * evento do sistema ainda na fila (lido no mesmo giro do laço de eventos que a requisição, ou
   * no seguinte) e o aviso do observador sai num `setTimeout(0)`. Dois giros e um timer bastam
   * para eles chegarem; na varredura, compara os arquivos na hora. Com eventos muito recentes,
   * espera um pouco de calma (o editor pode salvar em etapas).
   */
  private async settle(): Promise<void> {
    if (!this.watcher) return;
    this.watcher.flush();
    await nextTurn();
    await nextTurn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const deadline = Date.now() + MAX_SETTLE_MS;
    for (;;) {
      const quietFor = Date.now() - this.lastEvent;
      if (quietFor >= SETTLE_MS || Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS - quietFor));
    }
  }

  /**
   * O grafo fresco: espera a análise em andamento e reanalisa se o projeto mudou. Uma análise
   * que falha lança o erro (a chamada seguinte tenta de novo).
   */
  async current(): Promise<Snapshot> {
    if (this.closed) throw new Error('the project is closed');
    if (this.watcher) {
      // a análise em andamento pode terminar (e falhar) durante a espera: a falha é desta chamada
      const inFlight = this.running;
      await this.settle();
      const failure = inFlight && (await inFlight);
      if (failure) throw failure;
    }
    let rounds = 0;
    for (;;) {
      if (this.running) {
        const failure = await this.running;
        if (failure) throw failure;
        continue;
      }
      if (!this.dirty && this.snapshot) return this.snapshot;
      // mudanças sem parar: responde com o grafo mais recente em vez de esperar para sempre
      if (rounds >= MAX_ROUNDS && this.snapshot) return this.snapshot;
      rounds++;
      const failure = await this.run();
      if (failure) throw failure;
    }
  }

  /** Uma análise (nunca duas ao mesmo tempo); devolve o erro, se falhar. */
  private run(): Promise<Error | undefined> {
    if (this.running) return this.running;
    this.dirty = false;
    const started = performance.now();
    this.running = this.backend.analyze().then(
      (graph) => {
        this.running = undefined;
        if (this.closed) return undefined;
        const wallMs = Math.round(performance.now() - started);
        this.snapshot = makeSnapshot(graph, ++this.sequence, wallMs);
        // pastas novas ou removidas, .gitignore alterado: observa o conjunto atual (depois da
        // resposta: percorrer as pastas de um projeto grande leva tempo na thread principal)
        setImmediate(() => {
          if (!this.closed) this.watcher?.refresh();
        });
        this.options.log?.({
          type: 'analyzed',
          ms: wallMs,
          files: graph.stats.files,
          sequence: this.sequence,
        });
        return undefined;
      },
      (err: unknown) => {
        this.running = undefined;
        // a próxima chamada tenta de novo
        this.dirty = true;
        const error = err instanceof Error ? err : new Error(String(err));
        if (!this.closed) this.options.log?.({ type: 'failed', message: error.message });
        return error;
      },
    );
    return this.running;
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = undefined;
    this.backend.close();
  }
}

function makeSnapshot(graph: RastroGraph, sequence: number, wallMs: number): Snapshot {
  const index = new GraphIndex(graph);
  let insights: Insights | undefined;
  return {
    graph,
    index,
    analyzedFiles: new Set(
      graph.nodes
        .filter((n) => n.kind === 'file' && n.meta?.analyzed !== false)
        .map((n) => n.qualifiedName ?? n.name),
    ),
    finishedAt: Date.now(),
    wallMs,
    sequence,
    insights: () => (insights ??= computeInsights(index, 10)),
  };
}
