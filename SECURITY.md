# Política de segurança

> 🇬🇧 **English:** please **do not open a public issue** for security problems. Report them privately through [GitHub's private vulnerability reporting](https://github.com/MongeAI/rastro/security/advisories/new) with the Rastro and Node.js versions, steps to reproduce and the expected impact. We are especially interested in: execution of the analyzed project's code, reading files outside the graph through the local server, access without the token or from another site (DNS rebinding, CSRF), and content injection into the interface. Reports in English or Portuguese are welcome.

O Rastro é local-first e somente leitura (detalhes em [docs/seguranca.md](docs/seguranca.md)). Ainda assim, levamos falhas de segurança a sério.

## Como reportar

**Não abra uma issue pública.** Use o recurso de reporte privado do GitHub:
[Reportar uma vulnerabilidade](https://github.com/MongeAI/rastro/security/advisories/new).

Inclua, se possível:

- versão do Rastro e do Node.js, e sistema operacional;
- passos para reproduzir (um projeto mínimo ou um JSON de grafo ajuda muito);
- o impacto esperado (ex.: leitura de arquivo fora do projeto, execução de código).

Responderemos o quanto antes e manteremos você informado até a correção ser publicada.

## Escopo

Interessam especialmente:

- execução de código do projeto analisado durante a análise;
- leitura de arquivos fora do grafo pelo servidor local (`/api/source`);
- acesso ao servidor local sem o token, ou a partir de outro site (DNS rebinding, CSRF);
- injeção de conteúdo na interface a partir do código analisado ou de um JSON importado.

## Versões suportadas

Correções de segurança são feitas na versão mais recente da branch `main`.
