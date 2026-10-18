#!/usr/bin/env bash
# Publica (ou atualiza) o comentário do Rastro no pull request. Um comentário só por PR: o
# marcador <!-- rastro-impact --> no começo, escrito pelo autor esperado (o bot do token),
# identifica o comentário anterior. Comentários de outras pessoas com o marcador são ignorados.
#
# Entradas: RASTRO_MARKDOWN (arquivo), RASTRO_REPORT_URL (link do relatório, opcional),
#   RASTRO_LANG, RASTRO_AUTHOR (login do autor dos comentários; padrão github-actions[bot]),
#   GH_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH.
set -euo pipefail

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

body="$(mktemp)"
cat "$RASTRO_MARKDOWN" >"$body"
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

marker='<!-- rastro-impact -->'
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
