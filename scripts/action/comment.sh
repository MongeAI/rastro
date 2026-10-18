#!/usr/bin/env bash
# Publica (ou atualiza) o comentário do Rastro no pull request. Um comentário por pasta
# analisada: o marcador no começo (<!-- rastro-impact --> para a raiz, como nas versões
# anteriores; <!-- rastro-impact:<pasta> --> para as outras), escrito pelo autor esperado (o
# bot do token), identifica o comentário anterior. Comentários de outras pessoas com o
# marcador são ignorados.
#
# Entradas: RASTRO_MARKDOWN (arquivo), RASTRO_PATH (pasta analisada; padrão .),
#   RASTRO_REPORT_URL (link do relatório, opcional), RASTRO_LANG,
#   RASTRO_AUTHOR (login do autor dos comentários; padrão github-actions[bot]),
#   GH_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH.
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "::error title=Rastro::jq is required but was not found on the runner."
  exit 1
fi

pr="$(jq -r '.pull_request.number // empty' "${GITHUB_EVENT_PATH:-/dev/null}" 2>/dev/null || true)"
if [ -z "$pr" ]; then
  echo "Rastro: not a pull request event, skipping the comment."
  exit 0
fi

author="${RASTRO_AUTHOR:-github-actions[bot]}"
if ! [[ "$author" =~ ^[A-Za-z0-9-]+(\[bot\])?$ ]]; then
  echo "::error title=Rastro::Invalid comment author: $author"
  exit 1
fi

# a pasta, normalizada (./a/ = a; . = raiz) e codificada parte a parte: só letras, números,
# "-_.~", "%" e "/" sobram, então nada nela fecha o comentário HTML (-->) nem a string do jq
key="$(jq -rn --arg p "${RASTRO_PATH:-.}" '$p | gsub("/+"; "/") | sub("^(\\./)+"; "") | sub("/+$"; "") | gsub("/(\\./)+"; "/") | sub("/\\.$"; "") | if . == "." then "" else split("/") | map(@uri) | join("/") end')"
if [ -z "$key" ]; then
  marker='<!-- rastro-impact -->'
else
  marker="<!-- rastro-impact:${key} -->"
fi

body="$(mktemp)"
{
  echo "$marker"
  # o Markdown do Rastro já começa com o marcador genérico: troca pelo desta pasta
  sed '1{/^<!-- rastro-impact -->$/d;}' "$RASTRO_MARKDOWN"
} >"$body"
if [ -n "${RASTRO_REPORT_URL:-}" ]; then
  if [ "${RASTRO_LANG:-en}" = "pt" ]; then
    label="📎 Relatório interativo (abre offline):"
    name="baixar rastro-report"
  else
    label="📎 Interactive report (works offline):"
    name="download rastro-report"
  fi
  printf '\n%s [%s](%s)\n' "$label" "$name" "$RASTRO_REPORT_URL" >>"$body"
fi

# nenhum marcador é prefixo de outro (todos terminam em " -->", e a pasta não tem espaços):
# <!-- rastro-impact --> não acha <!-- rastro-impact:pkg -->, nem pkg acha pkg/sub
existing="$(gh api --paginate "repos/${GITHUB_REPOSITORY}/issues/${pr}/comments" \
  --jq ".[] | select(.user.login == \"${author}\" and (.body | startswith(\"${marker}\"))) | .id" |
  head -n 1 || true)"

# PRs de forks recebem um token só de leitura: sem permissão, avisa e segue (o resumo do job
# continua com o relatório)
if [ -n "$existing" ]; then
  gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${existing}" -F "body=@${body}" >/dev/null ||
    echo "::warning title=Rastro::Could not update the pull request comment (missing permission?)."
else
  gh api -X POST "repos/${GITHUB_REPOSITORY}/issues/${pr}/comments" -F "body=@${body}" >/dev/null ||
    echo "::warning title=Rastro::Could not comment on the pull request (missing 'pull-requests: write' permission, or a pull request from a fork)."
fi
