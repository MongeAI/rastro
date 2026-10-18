import { ruleIssueText, type GraphRules, type RuleIssue } from '@rastro/core';
import type { RuleOutcome, RulesCheck, RuleViolation } from '@rastro/graph';
import { useI18n } from '../lib/i18n';

interface Props {
  rules: GraphRules;
  /** Problemas no arquivo de regras (vazio quando ele é válido). */
  issues: RuleIssue[];
  check: RulesCheck | null;
  highlight: boolean;
  onHighlight(value: boolean): void;
  /** Vai para a entidade onde a violação aparece (a origem da primeira relação). */
  onOpen(violation: RuleViolation): void;
}

const MAX = 40;

/** Aba "Regras": as regras de arquitetura (rastro.rules.json) e o que as quebra, com prova. */
export function RulesPanel({ rules, issues, check, highlight, onHighlight, onOpen }: Props) {
  const { t, lang } = useI18n();
  const r = t.rules;
  const total = check ? check.errors + check.warnings : 0;

  return (
    <div className="details">
      <header className="details-head">
        <p className="eyebrow">{r.eyebrow}</p>
        <h2 className="details-name">
          {!check
            ? r.invalid
            : !check.outcomes.length
              ? r.noRules
              : total === 0
                ? r.allPassed(check.outcomes.length)
                : [
                    ...(check.errors ? [r.violations(check.errors)] : []),
                    ...(check.warnings ? [r.warnings(check.warnings)] : []),
                  ].join(' · ')}
        </h2>
        <p className="muted small mono">{rules.source}</p>
        {check?.introduced && (
          <p className="muted small">
            {r.introduced(check.introduced.errors + check.introduced.warnings)}
          </p>
        )}
        {check && total > 0 && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={highlight}
              onChange={(e) => onHighlight(e.target.checked)}
            />
            {r.highlight}
            <span className="change-legend">
              <span className="sw violation-sw" /> {r.legend}
            </span>
          </label>
        )}
      </header>

      {!check && (
        <section className="details-section">
          <ul className="diag-list">
            {issues.map((issue, i) => (
              <li key={i} className="mono small">
                {ruleIssueText(issue, lang)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {check?.outcomes.map((outcome) => (
        <RuleSection key={outcome.rule.name} outcome={outcome} onOpen={onOpen} />
      ))}

      {check && check.outcomes.length > 0 && (
        <p className="muted small details-section insight-hint">{r.hint}</p>
      )}
    </div>
  );
}

function RuleSection({
  outcome,
  onOpen,
}: {
  outcome: RuleOutcome;
  onOpen(violation: RuleViolation): void;
}) {
  const { t } = useI18n();
  const r = t.rules;
  const { rule, violations, possible } = outcome;
  const state = !violations.length ? 'ok' : rule.severity === 'error' ? 'error' : 'warning';
  return (
    <section className="details-section">
      <h3 className="section-title rule-title">
        <span className={`rule-mark ${state}`} aria-hidden="true">
          {state === 'ok' ? '✓' : state === 'error' ? '✗' : '!'}
        </span>
        <span className="rule-name">{rule.name}</span>
        {violations.length > 0 ? (
          <span className="count">{violations.length}</span>
        ) : (
          <span className="sr-only">{r.passed}</span>
        )}
        {rule.severity === 'warning' && <span className="tag">{r.warning}</span>}
      </h3>
      {outcome.files === 0 && <p className="small warn-text">{r.noFiles}</p>}
      {rule.because && violations.length > 0 && (
        <p className="muted small insight-hint">{rule.because}</p>
      )}
      {violations.length > 0 && <ViolationList list={violations} onOpen={onOpen} />}
      {possible.length > 0 && (
        <details className="rule-possible">
          <summary className="muted small">{r.possible(possible.length)}</summary>
          <p className="muted small insight-hint">{r.possibleHint}</p>
          <ViolationList list={possible} onOpen={onOpen} />
        </details>
      )}
    </section>
  );
}

function ViolationList({
  list,
  onOpen,
}: {
  list: RuleViolation[];
  onOpen(violation: RuleViolation): void;
}) {
  const { t } = useI18n();
  const r = t.rules;
  return (
    <>
      <ul className="rel-list">
        {list.slice(0, MAX).map((v) => {
          const first = v.cycle?.[0]?.evidence ?? v.evidence[0];
          const where = first ? `${first.file}:${first.line}` : undefined;
          return (
            <li key={`${v.from}\n${v.to}`}>
              <button
                type="button"
                className="rel-item rule-violation"
                title={where}
                onClick={() => onOpen(v)}
              >
                <span className="rel-name">
                  {v.cycle ? (
                    <>
                      {v.cycle.map((s) => s.file).join(' → ')} → {v.cycle[0]!.file}
                    </>
                  ) : (
                    <>
                      {v.from} → <span className="mono">{v.to}</span>
                    </>
                  )}
                </span>
                <span className="rel-loc">
                  {v.introduced && <span className="tag new-tag">{r.isNew}</span>}{' '}
                  {v.cycle
                    ? v.cycleSize && v.cycleSize > v.cycle.length
                      ? r.cycleOf(v.cycleSize)
                      : ''
                    : [
                        ...v.kinds.map((k) => r.kind[k] ?? k),
                        ...(v.typeOnly ? [r.typeOnly] : []),
                      ].join(', ')}
                  {where ? ` · ${where}` : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {list.length > MAX && <p className="muted small">{t.common.andMore(list.length - MAX)}</p>}
    </>
  );
}
