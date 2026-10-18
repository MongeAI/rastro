import { t } from './i18n.js';

/**
 * Traduz os erros do `parseArgs` do Node (em inglês, com aspas estranhas e dicas confusas
 * como "argument is ambiguous") para mensagens curtas no idioma da CLI. O Node não expõe a
 * opção em um campo próprio: ela é lida do texto, que é estável entre versões. Erros que não
 * reconhecemos voltam como vieram.
 */
export function argsErrorMessage(err: unknown): string {
  const e = err as { code?: string; message?: string };
  const message = String(e.message ?? err);
  const u = t().usage;
  // a forma longa quando o Node mostra as duas ("-p, --port <value>")
  const quoted = /'([^']*)'/.exec(message)?.[1] ?? '';
  const flag = /--[^\s,<>]+/.exec(quoted)?.[0] ?? quoted.split(/[\s,]/)[0] ?? quoted;
  switch (e.code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
      return flag ? u.unknownOption(flag) : message;
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      if (!flag) return message;
      if (/does not take an argument/.test(message)) return u.takesNoValue(flag);
      // "ambiguous": o valor começa com "-" (ex.: --max-files -3)
      if (/ambiguous/.test(message)) return u.dashValue(flag);
      return u.needsValue(flag);
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL':
      return quoted ? u.unexpectedArg(quoted) : message;
    default:
      return message;
  }
}
