import { ts } from 'ts-morph';
import { compareStrings } from '@rastro/core';
import { entityForDeclaration, type AnalyzerContext } from './analyze.js';

/** Limite de candidatos guardados por chamada (o grafo continua pequeno em hierarquias enormes). */
export const MAX_CANDIDATES = 50;

type ClassLike = ts.ClassDeclaration | ts.ClassExpression;

/**
 * Candidatos _possíveis_ para chamadas por interface ou por método abstrato.
 *
 * Em `repo.save()` com `repo: Repository`, o verificador de tipos aponta para a assinatura da
 * interface, que não tem corpo nem nó no grafo: o alvo real só existe em execução. As classes do
 * projeto que **declaram** `implements Repository` (diretamente, por uma interface que estende
 * `Repository` ou por uma classe base que a implementa), ou que estendem a classe abstrata, são
 * os alvos possíveis. Eles nunca viram relações resolvidas: ficam em `meta.candidates` do nó
 * não resolvido. Classes que só "têm o mesmo formato" (tipagem estrutural) não entram.
 */
export class ImplementationIndex {
  /** Tipo (interface, alias de tipo ou classe) → classes do projeto que o implementam ou estendem. */
  private byType?: Map<ts.Symbol, Set<ClassLike>>;
  private readonly supertypesCache = new Map<ClassLike, Set<ts.Symbol>>();

  constructor(private readonly ctx: AnalyzerContext) {}

  /**
   * Parte "por interface" de uma chamada (`nameNode` é o nome em `obj.nome()`): `undefined`
   * quando nenhuma parte do tipo do receptor declara o membro só como assinatura (interface,
   * alias de tipo ou método abstrato). Senão, os ids das implementações possíveis (talvez
   * nenhuma). Com `r: UserRepo | SqlRepo`, só `UserRepo` conta: `SqlRepo.save` é comprovado.
   */
  indirectTargets(nameNode: ts.Node, member: ts.Symbol): { candidates: string[] } | undefined {
    const bodyless = (member.declarations ?? []).filter(isSignatureWithoutBody);
    if (!bodyless.length) return undefined;
    const parts = this.receiverParts(nameNode, member.name);
    let owners: ts.Symbol[];
    if (parts.length) {
      owners = parts.filter((p) => p.bodyless).map((p) => p.symbol);
      if (!owners.length) return undefined;
    } else {
      owners = bodyless.flatMap((d) => this.declaringOwner(d));
    }
    const byType = this.index();
    const found = new Set<string>();
    for (const owner of owners) {
      for (const cls of byType.get(owner) ?? []) {
        for (const id of this.implementationsIn(cls, member.name)) found.add(id);
      }
    }
    return { candidates: [...found].sort(compareStrings).slice(0, MAX_CANDIDATES) };
  }

  /**
   * Partes do tipo estático do receptor (`repo` em `repo.save()`) que são interface, alias ou
   * classe, e se o membro chamado é, nelas, só uma assinatura sem corpo.
   */
  private receiverParts(
    nameNode: ts.Node,
    name: string,
  ): Array<{ symbol: ts.Symbol; bodyless: boolean }> {
    const access = nameNode.parent;
    if (!access || !ts.isPropertyAccessExpression(access) || access.name !== nameNode) return [];
    const { checker } = this.ctx;
    let type: ts.Type;
    try {
      type = checker.getTypeAtLocation(access.expression);
    } catch {
      return [];
    }
    // `this` e genéricos (`T extends Repository`): vale a restrição
    if (type.flags & ts.TypeFlags.TypeParameter)
      type = checker.getBaseConstraintOfType(type) ?? type;
    const parts = type.isUnion() ? type.types : [type];
    const owners: Array<{ symbol: ts.Symbol; bodyless: boolean }> = [];
    for (const part of parts) {
      const symbol = part.aliasSymbol ?? part.getSymbol();
      if (!symbol || !isTypeOwner(symbol)) continue;
      let declarations: ts.Declaration[];
      try {
        declarations = checker.getPropertyOfType(part, name)?.declarations ?? [];
      } catch {
        declarations = [];
      }
      owners.push({
        symbol,
        bodyless: declarations.length > 0 && declarations.every(isSignatureWithoutBody),
      });
    }
    return owners;
  }

  /** Interface, alias de tipo ou classe onde a assinatura foi declarada. */
  private declaringOwner(decl: ts.Declaration): ts.Symbol[] {
    let owner: ts.Node | undefined = decl.parent;
    if (owner && ts.isTypeLiteralNode(owner) && ts.isTypeAliasDeclaration(owner.parent))
      owner = owner.parent;
    if (
      owner &&
      (ts.isInterfaceDeclaration(owner) ||
        ts.isTypeAliasDeclaration(owner) ||
        ts.isClassDeclaration(owner) ||
        ts.isClassExpression(owner))
    ) {
      const symbol = binderSymbol(owner);
      return symbol ? [symbol] : [];
    }
    return [];
  }

  /** Membro de instância `name` da classe (próprio ou herdado) que é uma entidade do grafo. */
  private implementationsIn(cls: ClassLike, name: string): string[] {
    const { checker } = this.ctx;
    const symbol = binderSymbol(cls);
    if (!symbol) return [];
    try {
      const property = checker.getPropertyOfType(checker.getDeclaredTypeOfSymbol(symbol), name);
      return (property?.declarations ?? [])
        .map((d) => entityForDeclaration(this.ctx, d))
        .filter((id): id is string => !!id);
    } catch {
      return [];
    }
  }

  /** Monta (uma vez) o índice tipo → classes, a partir das classes registradas no grafo. */
  private index(): Map<ts.Symbol, Set<ClassLike>> {
    if (this.byType) return this.byType;
    const byType = new Map<ts.Symbol, Set<ClassLike>>();
    for (const node of new Set(this.ctx.entities.keys())) {
      if (!ts.isClassDeclaration(node) && !ts.isClassExpression(node)) continue;
      for (const type of this.supertypes(node, new Set())) {
        let set = byType.get(type);
        if (!set) byType.set(type, (set = new Set()));
        set.add(node);
      }
    }
    return (this.byType = byType);
  }

  /**
   * Tudo o que a classe declara implementar ou estender, direta ou indiretamente: interfaces de
   * `implements` (e as que elas estendem) e as classes base (com o que elas implementam).
   */
  private supertypes(cls: ClassLike, visiting: Set<ts.Node>): Set<ts.Symbol> {
    const cached = this.supertypesCache.get(cls);
    if (cached) return cached;
    const result = new Set<ts.Symbol>();
    if (visiting.has(cls)) return result; // herança circular (código inválido)
    visiting.add(cls);
    this.collectHeritage(cls, result, visiting);
    this.supertypesCache.set(cls, result);
    return result;
  }

  private collectHeritage(
    decl: ClassLike | ts.InterfaceDeclaration,
    result: Set<ts.Symbol>,
    visiting: Set<ts.Node>,
  ): void {
    for (const clause of decl.heritageClauses ?? []) {
      for (const type of clause.types) {
        const symbol = this.symbolOf(type.expression);
        if (!symbol || result.has(symbol)) continue;
        result.add(symbol);
        for (const parent of symbol.declarations ?? []) {
          if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) {
            for (const s of this.supertypes(parent, visiting)) result.add(s);
          } else if (ts.isInterfaceDeclaration(parent) && !visiting.has(parent)) {
            visiting.add(parent);
            this.collectHeritage(parent, result, visiting);
          }
        }
      }
    }
  }

  /** Símbolo de `Repository` em `implements Repository<T>` (seguindo imports). */
  private symbolOf(expression: ts.Expression): ts.Symbol | undefined {
    const { checker } = this.ctx;
    const target = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    let symbol: ts.Symbol | undefined;
    try {
      symbol = checker.getSymbolAtLocation(target);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return undefined;
    }
    return symbol;
  }
}

/** Assinatura sem implementação: membro de interface/tipo ou método/propriedade abstrata. */
export function isSignatureWithoutBody(decl: ts.Declaration): boolean {
  if (ts.isMethodSignature(decl) || ts.isPropertySignature(decl)) return true;
  if (ts.isMethodDeclaration(decl) || ts.isPropertyDeclaration(decl))
    return (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Abstract) !== 0;
  return false;
}

function isTypeOwner(symbol: ts.Symbol): boolean {
  return (
    (symbol.flags &
      (ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.TypeAlias)) !==
    0
  );
}

/** Símbolo atribuído pelo binder a uma declaração (também para classes anônimas). */
function binderSymbol(node: ts.Node): ts.Symbol | undefined {
  return (node as unknown as { symbol?: ts.Symbol }).symbol;
}
