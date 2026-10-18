import { describe, expect, it } from 'vitest';
import { nodeId, SCHEMA_VERSION, type NodeMeta, type RastroGraph } from '@rastro/core';
import { computeInsights, GraphBuilder, GraphIndex } from '@rastro/graph';

/** Funções citadas uma única vez (só na declaração) e que ninguém chama. */
function graphOf(symbols: Array<[file: string, name: string, meta: NodeMeta]>): GraphIndex {
  const b = new GraphBuilder();
  for (const [file, name, meta] of symbols) {
    const fileId = nodeId.file(file);
    if (!b.hasNode(fileId)) {
      const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
      const mod = b.ensureModule(dir);
      b.addNode({ id: fileId, kind: 'file', name: file, parent: mod });
      b.addEdge({
        kind: 'contains',
        source: mod,
        target: fileId,
        resolution: 'resolved',
        discovery: 'static-ast',
      });
    }
    const id = nodeId.function(file, name);
    b.addNode({
      id,
      kind: 'function',
      name,
      parent: fileId,
      location: { file, startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
      meta: { mentions: 1, ...meta },
    });
    b.addEdge({
      kind: 'contains',
      source: fileId,
      target: id,
      resolution: 'resolved',
      discovery: 'static-ast',
    });
  }
  const done = b.finalize();
  return new GraphIndex({
    schemaVersion: SCHEMA_VERSION,
    nodes: done.nodes,
    edges: done.edges,
  } as unknown as RastroGraph);
}

const unusedIds = (index: GraphIndex) => {
  const { internal, exported } = computeInsights(index, 50).unused;
  return [...internal, ...exported].map((n) => n.id).sort();
};

describe('possivelmente sem uso: pontos de entrada do Next.js', () => {
  it('não acusa exports que o framework chama sozinho em app/, pages/ e middleware', () => {
    const exported = { exported: true };
    const byDefault = { exported: true, defaultExport: true };
    const index = graphOf([
      ['app/layout.tsx', 'RootLayout', byDefault],
      ['app/page.tsx', 'Page', byDefault],
      ['app/page.tsx', 'generateMetadata', exported],
      ['app/blog/[slug]/page.tsx', 'generateStaticParams', exported],
      ['app/api/route.ts', 'GET', exported],
      ['src/app/api/route.ts', 'POST', exported],
      ['pages/_app.tsx', 'App', byDefault],
      ['pages/_document.tsx', 'Doc', byDefault],
      ['pages/blog.tsx', 'getStaticProps', exported],
      ['pages/blog.tsx', 'getServerSideProps', exported],
      ['apps/web/pages/[id].tsx', 'getStaticPaths', exported],
      ['middleware.ts', 'middleware', exported],
      ['src/middleware.ts', 'middleware', exported],
      // continuam sendo apontados
      ['app/page.tsx', 'helper', exported],
      ['app/page.tsx', 'internal', {}],
      ['lib/data.ts', 'GET', exported],
      ['lib/data.ts', 'getStaticProps', exported],
      ['mapp/page.tsx', 'Other', byDefault],
    ]);
    expect(unusedIds(index)).toEqual([
      'fn:app/page.tsx#helper',
      'fn:app/page.tsx#internal',
      'fn:lib/data.ts#GET',
      'fn:lib/data.ts#getStaticProps',
      'fn:mapp/page.tsx#Other',
    ]);
  });
});
