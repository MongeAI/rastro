#!/usr/bin/env bash
# GitHub Action do Rastro (action.yml): analisa o projeto, calcula o impacto das mudanças do
# pull request e publica o resultado (resumo do job, comentário na PR e relatório HTML).
# Nada do projeto analisado é executado: o Rastro só lê arquivos e roda git em modo leitura.
#
# Entradas (variáveis de ambiente, nunca interpoladas no script):
#   RASTRO_PATH, RASTRO_BASE, RASTRO_EXCLUDE (uma por linha), RASTRO_LANG, RASTRO_VERSION,
#   RASTRO_LINK (base dos links arquivo:linha), RASTRO_REPORT (true/false)
#   RASTRO_BIN: comando do Rastro (padrão: npx @mongeai/rastro@$RASTRO_VERSION; usado nos testes)
set -euo pipefail

path="${RASTRO_PATH:-.}"
base="${RASTRO_BASE:-${GITHUB_BASE_REF:-}}"
out="${RUNNER_TEMP:-$(mktemp -d)}/rastro"
mkdir -p "$out"

if [ -z "$base" ]; then
  echo "::error title=Rastro::No base branch to compare against. Run on pull_request or set the 'base' input."
  exit 1
fi
case "$base" in
  -*) echo "::error title=Rastro::Invalid base: $base"; exit 1 ;;
esac

if [ -n "${RASTRO_BIN:-}" ]; then
  read -r -a rastro <<<"$RASTRO_BIN"
else
  rastro=(npx --yes "@mongeai/rastro@${RASTRO_VERSION:-latest}")
fi

# o git precisa do histórico para achar o ponto em que a branch saiu da base
if [ "$(git -C "$path" rev-parse --is-shallow-repository)" = "true" ]; then
  git -C "$path" fetch --quiet --no-tags --unshallow origin || true
fi
ref="$base"
if git -C "$path" remote get-url origin >/dev/null 2>&1; then
  git -C "$path" fetch --quiet --no-tags origin "+refs/heads/${base}:refs/remotes/origin/${base}" || true
  if git -C "$path" rev-parse --verify --quiet "refs/remotes/origin/${base}" >/dev/null; then
    ref="origin/${base}"
  fi
fi

args=(--lang "${RASTRO_LANG:-en}")
while IFS= read -r pattern; do
  [ -n "$pattern" ] && args+=(--exclude "$pattern")
done <<<"${RASTRO_EXCLUDE:-}"

# uma análise só; o impacto e o relatório saem do mesmo grafo
"${rastro[@]}" analyze "$path" --since "$ref" -o "$out/graph.json" "${args[@]}"
link_args=()
[ -n "${RASTRO_LINK:-}" ] && link_args=(--link "$RASTRO_LINK")
"${rastro[@]}" impact "$out/graph.json" --format markdown "${link_args[@]}" --lang "${RASTRO_LANG:-en}" >"$out/impact.md"
"${rastro[@]}" impact "$out/graph.json" --format json --lang "${RASTRO_LANG:-en}" >"$out/impact.json"
"${rastro[@]}" impact "$out/graph.json" --tests >"$out/tests.txt"
if [ "${RASTRO_REPORT:-true}" = "true" ]; then
  "${rastro[@]}" export "$out/graph.json" --format html -o "$out/rastro-report.html" --lang "${RASTRO_LANG:-en}"
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
    delimiter="RASTRO_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
    echo "tests<<$delimiter"
    cat "$out/tests.txt"
    echo "$delimiter"
  } >>"$GITHUB_OUTPUT"
fi
