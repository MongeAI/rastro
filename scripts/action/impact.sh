#!/usr/bin/env bash
# GitHub Action do Rastro (action.yml): analisa o projeto, calcula o impacto das mudanças do
# pull request e publica o resultado (resumo do job, saídas, relatório HTML).
# Nada do projeto analisado é executado: o Rastro só lê arquivos e roda git em modo leitura.
#
# Entradas (variáveis de ambiente, nunca interpoladas no script):
#   RASTRO_PATH, RASTRO_BASE, RASTRO_EXCLUDE (uma por linha), RASTRO_LANG, RASTRO_VERSION,
#   RASTRO_REPO_URL (https://github.com/<repo>, base dos links), RASTRO_REPORT (true/false)
#   RASTRO_BIN: comando do Rastro já instalado (usado nos testes; sem ele, instala do npm)
set -euo pipefail

path="${RASTRO_PATH:-.}"
base="${RASTRO_BASE:-${GITHUB_BASE_REF:-}}"
lang="${RASTRO_LANG:-en}"
temp="${RUNNER_TEMP:-$(mktemp -d)}"

if ! command -v jq >/dev/null 2>&1; then
  echo "::error title=Rastro::jq is required but was not found on the runner."
  exit 1
fi

if [ -z "$base" ]; then
  echo "::error title=Rastro::No base branch to compare against. Run on pull_request or set the 'base' input."
  exit 1
fi
case "$base" in
  -*) echo "::error title=Rastro::Invalid base: $base"; exit 1 ;;
esac

# uma pasta nova por execução: a action pode rodar mais de uma vez no mesmo job (uma por
# pacote de um monorepo, com artifact-name diferente) sem uma sobrescrever a outra
mkdir -p "$temp"
out="$(mktemp -d "$temp/rastro.XXXXXX")"

# Nada da pasta do pull request pode influenciar o Rastro: o npx/npm rodando ali leria o
# .npmrc da PR (node-options, registry) e até um node_modules commitado. Instala numa pasta
# neutra do runner, do registro público, sem scripts, e roda o bin pelo caminho absoluto.
if [ -n "${RASTRO_BIN:-}" ]; then
  read -r -a rastro <<<"$RASTRO_BIN"
else
  tool="$temp/rastro-cli"
  mkdir -p "$tool"
  (
    cd "$tool"
    env -u NODE_OPTIONS npm install --prefix "$tool" --no-save --no-package-lock --ignore-scripts \
      --no-audit --no-fund --registry=https://registry.npmjs.org/ \
      "@mongeai/rastro@${RASTRO_VERSION:-latest}" >/dev/null
  )
  rastro=(env -u NODE_OPTIONS node "$tool/node_modules/@mongeai/rastro/bin/rastro.js")
fi

# o git precisa do histórico para achar o ponto em que a branch saiu da base
if [ "$(git -C "$path" rev-parse --is-shallow-repository)" = "true" ]; then
  git -C "$path" fetch --quiet --no-tags --unshallow origin \
    "+refs/heads/${base}:refs/remotes/origin/${base}" || true
fi
ref="$base"
if git -C "$path" remote get-url origin >/dev/null 2>&1; then
  git -C "$path" fetch --quiet --no-tags origin "+refs/heads/${base}:refs/remotes/origin/${base}" || true
  if git -C "$path" rev-parse --verify --quiet "refs/remotes/origin/${base}" >/dev/null; then
    ref="origin/${base}"
  fi
fi

# No runner, o .git/config vem do actions/checkout (que guarda credenciais num includeIf),
# não do pull request: confiar nele aqui é seguro e necessário com o checkout v6+.
args=(--lang "$lang" --trust-git-config)
while IFS= read -r pattern; do
  # com "=": um padrão que começa com "-" não vira outra opção
  [ -n "$pattern" ] && args+=("--exclude=$pattern")
done <<<"${RASTRO_EXCLUDE:-}"

# uma análise só; o impacto e o relatório saem do mesmo grafo. Se o git falhar, o analyze
# para com o erro do git (e a action falha com a mensagem certa).
"${rastro[@]}" analyze "$path" --since "$ref" -o "$out/graph.json" "${args[@]}"

link_args=()
if [ -n "${RASTRO_REPO_URL:-}" ]; then
  # links para o commit que foi analisado (no pull_request, o merge commit do checkout, não o
  # head da PR: as linhas vêm dele) e para a pasta analisada relativa à raiz do repositório
  # git (não ao workspace: o checkout pode estar em outra pasta), com cada parte codificada
  commit="$(git -C "$path" rev-parse --verify HEAD)"
  sub="$(jq -rn --arg p "$(git -C "$path" rev-parse --show-prefix)" '$p | sub("/+$"; "") | if . == "" then "" else split("/") | map(@uri) | join("/") end')"
  link_args=(--link "${RASTRO_REPO_URL%/}/blob/${commit}${sub:+/$sub}")
fi
"${rastro[@]}" impact "$out/graph.json" --format markdown "${link_args[@]}" --lang "$lang" >"$out/impact.md"
"${rastro[@]}" impact "$out/graph.json" --format json --lang "$lang" >"$out/impact.json"
"${rastro[@]}" impact "$out/graph.json" --tests --lang "$lang" >"$out/tests.txt"
if [ "${RASTRO_REPORT:-true}" = "true" ]; then
  "${rastro[@]}" export "$out/graph.json" --format html -o "$out/rastro-report.html" --lang "$lang"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$out/impact.md" >>"$GITHUB_STEP_SUMMARY"
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "dir=$out"
    echo "markdown=$out/impact.md"
    echo "json=$out/impact.json"
    echo "impacted=$(jq -r '.summary.impacted' "$out/impact.json")"
    echo "changed=$(jq -r '.summary.changed' "$out/impact.json")"
    echo "broken=$(jq -r '.summary.broken' "$out/impact.json")"
    # violações novas de regras de arquitetura (todas) e as que reprovam (severidade error)
    echo "violations=$(jq -r '.summary.violations // 0' "$out/impact.json")"
    # arquivo de regras com problemas também reprova (como uma configuração de lint quebrada)
    echo "failing=$(jq -r 'if .rules.issues then "invalid" else (.rules.summary.introduced.errors // 0) end' "$out/impact.json")"
    delimiter="RASTRO_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
    echo "tests<<$delimiter"
    cat "$out/tests.txt"
    echo "$delimiter"
  } >>"$GITHUB_OUTPUT"
fi
