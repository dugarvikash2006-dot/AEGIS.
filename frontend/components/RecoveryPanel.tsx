import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type {
  CandidateResult,
  RecoveryAction,
  RecoveryDiagnosis,
  RecoveryPhase,
  RecoveryRunResult,
  SimulationResult,
} from "../types/network";
import { OUTCOME_META } from "../lib/pipelineStages";
import DigitalTwinModal from "./DigitalTwinModal";

// Read-only recovery DETAIL view — "why did AEGIS decide this?". The high-level
// pipeline "what happened?" lives in the PipelineBar. This never calls a backend
// API, never decides an outcome, and never mutates network state.

type RecoveryPanelProps = {
  result: RecoveryRunResult | null;
  phase: RecoveryPhase;
  running: boolean;
  error: string | null;
  onClose: () => void;
};

function actionText(action: RecoveryAction): string {
  switch (action.type) {
    case "migrate_service":
      return `Migrate ${action.service_id} → ${action.to_node}`;
    case "quarantine_node":
      return `Quarantine ${action.node_id}`;
    case "drain_node":
      return `Drain ${action.node_id}`;
    case "restore_node":
      return `Restore ${action.node_id}`;
    case "reset_link":
      return `Reset link ${action.edge_id}`;
    case "reroute": {
      const avoid = [...action.avoid_nodes, ...action.avoid_edges];
      return avoid.length
        ? `Reroute ${action.service_id} (avoid ${avoid.join(", ")})`
        : `Reroute ${action.service_id}`;
    }
  }
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signedPts(value: number): string {
  const pts = value * 100;
  return `${pts >= 0 ? "+" : ""}${pts.toFixed(1)} pts`;
}

// --- sub-blocks --------------------------------------------------------------

function DiagnosisBlock({ dx }: { dx: RecoveryDiagnosis }) {
  const [labelPart, targetPart] = dx.summary.includes(":")
    ? [dx.summary.slice(0, dx.summary.indexOf(":")), dx.summary.slice(dx.summary.indexOf(":") + 1).trim()]
    : [dx.summary, ""];
  const confPct = Math.round(dx.confidence * 100);
  const chips = [
    ...dx.suspected_nodes.map((n) => ({ kind: "node", v: n })),
    ...dx.suspected_edges.map((e) => ({ kind: "edge", v: e })),
    ...dx.suspected_services.map((s) => ({ kind: "svc", v: s })),
  ];

  return (
    <section className="rp-block">
      <div className="rp-block-head">DIAGNOSIS</div>
      <div className="rp-dx-title">{labelPart.toUpperCase()}</div>
      {targetPart && <div className="rp-dx-target">{targetPart}</div>}

      <div className="rp-conf">
        <span className="rp-conf-label">CONFIDENCE</span>
        <div className="rp-conf-bar">
          <div className="rp-conf-fill" style={{ width: `${confPct}%` }} />
        </div>
        <span className="rp-conf-val">{confPct}%</span>
      </div>

      {chips.length > 0 && (
        <div className="rp-chips">
          {chips.map((c) => (
            <span key={`${c.kind}-${c.v}`} className={`rp-chip rp-chip-${c.kind}`}>
              {c.v}
            </span>
          ))}
        </div>
      )}

      <details className="rp-why">
        <summary>Diagnosis rationale</summary>
        <p>{dx.rationale}</p>
      </details>
    </section>
  );
}

function TwinBlock({ sim }: { sim: SimulationResult }) {
  return (
    <div className="rp-sub">
      <div className="rp-sub-head">
        DIGITAL TWIN
        <span className={`rp-tag ${sim.feasible ? "rp-ok" : "rp-bad"}`}>
          {sim.feasible ? "FEASIBLE" : "INFEASIBLE"}
        </span>
      </div>
      {sim.feasible && sim.metrics ? (
        <div className="rp-metrics">
          <div>
            <span>AVAILABILITY</span>
            <strong>{pct(sim.metrics.availability)}</strong>
          </div>
          {sim.delta && (
            <div>
              <span>Δ AVAILABILITY</span>
              <strong>{signedPts(sim.delta.availability)}</strong>
            </div>
          )}
          <div>
            <span>AVG LATENCY</span>
            <strong>{sim.metrics.avg_latency.toFixed(1)} ms</strong>
          </div>
          <div>
            <span>WORST NODE LOAD</span>
            <strong>{Math.round(sim.metrics.worst_node_load * 100)}%</strong>
          </div>
        </div>
      ) : (
        <>
          <p className="rp-reason">
            ✕ Simulation failed — this strategy did not produce a viable network state.
          </p>
          {sim.infeasible_reason && (
            <p className="rp-reason rp-reason-detail">{sim.infeasible_reason}</p>
          )}
          {sim.errors.length > 0 && (
            <ul className="rp-actions">
              {sim.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function SafetyBlock({ candidate }: { candidate: CandidateResult }) {
  const d = candidate.safety;
  return (
    <div className="rp-sub">
      <div className="rp-sub-head">
        SAFETY ENGINE
        <span className={`rp-tag ${d.approved ? "rp-ok" : "rp-bad"}`}>
          {d.approved ? "APPROVED" : "REJECTED"}
        </span>
      </div>
      {!d.approved && d.violations.length > 0 && (
        <ul className="rp-violations">
          {d.violations.map((v, i) => (
            <li key={`${v.rule}-${i}`} className={`rp-viol rp-viol-${v.level}`}>
              <span className="rp-viol-rule">{v.rule}</span>
              <span className="rp-viol-detail">{v.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="rp-policy">policy {d.policy_version}</div>
    </div>
  );
}

// --- AI Recovery Analysis --------------------------------------------------
// Every value below is derived from authoritative backend fields only:
// candidate.simulation.feasible, candidate.safety.approved, result.applied_plan_id.
// The frontend never re-ranks candidates or recomputes "best".

type CandidateVerdict = "selected" | "safe" | "rejected" | "infeasible";

function candidateVerdict(c: CandidateResult, result: RecoveryRunResult): CandidateVerdict {
  if (result.applied_plan_id !== null && c.plan.id === result.applied_plan_id) return "selected";
  if (!c.simulation.feasible) return "infeasible";
  if (!c.safety.approved) return "rejected";
  return "safe"; // simulation-feasible AND safety-approved, but not the plan AEGIS executed
}

const VERDICT_META: Record<
  CandidateVerdict,
  { tag: string; note: string; kind: "ok" | "bad" | "neutral" }
> = {
  selected: {
    tag: "★ SELECTED — BEST SAFE PLAN",
    note: "Applied to the live network — the only plan AEGIS executed.",
    kind: "ok",
  },
  safe: {
    tag: "PASSED — NOT SELECTED",
    note: "Simulation-feasible and safety-approved, but not the plan AEGIS selected to execute.",
    kind: "neutral",
  },
  rejected: {
    tag: "SIMULATION PASSED · SAFETY REJECTED",
    note: "Not eligible for execution.",
    kind: "bad",
  },
  infeasible: {
    tag: "SIMULATION FAILED",
    note: "Did not produce a viable network state. Not eligible for execution.",
    kind: "bad",
  },
};

function analysisStats(candidates: CandidateResult[], appliedId: string | null) {
  return {
    considered: candidates.length,
    passedTwin: candidates.filter((c) => c.simulation.feasible).length,
    safetyApproved: candidates.filter((c) => c.simulation.feasible && c.safety.approved).length,
    selected: appliedId !== null ? 1 : 0,
  };
}

// Compact funnel: proposals -> twin/safety glyphs -> selection / no-safe-plan.
function EvalStrip({ result }: { result: RecoveryRunResult }) {
  const cands = result.candidates;
  const selected = cands.find((c) => candidateVerdict(c, result) === "selected");

  return (
    <div className="ra-strip">
      <div className="ra-strip-row">
        <span className="ra-strip-cap">AI PROPOSALS</span>
        <span className="ra-strip-legend">TWIN · SAFETY</span>
      </div>
      <div className="ra-strip-cells">
        {cands.map((c, i) => {
          const v = candidateVerdict(c, result);
          return (
            <div key={c.plan.id} className={`ra-strip-cell ra-cell-${v}`} title={c.plan.strategy_label}>
              <span className="ra-strip-n">S{i + 1}</span>
              <span className="ra-strip-g">{c.simulation.feasible ? "✓" : "✕"}</span>
              <span className="ra-strip-g">{c.safety.approved ? "✓" : "✕"}</span>
            </div>
          );
        })}
      </div>
      <div className="ra-strip-arrow">↓</div>
      <span className="ra-strip-cap">SAFETY GATE</span>
      <div className="ra-strip-arrow">↓</div>
      {selected ? (
        <>
          <div className="ra-strip-sel">★ {selected.plan.strategy_label}</div>
          <div className="ra-strip-arrow">↓</div>
          <span className="ra-strip-cap ra-strip-cap-ok">EXECUTOR ✓ APPLIED</span>
        </>
      ) : (
        <div className="ra-strip-none">NO SAFE PLAN — nothing executed</div>
      )}
    </div>
  );
}

function AnalysisCandidate({
  candidate,
  index,
  result,
}: {
  candidate: CandidateResult;
  index: number;
  result: RecoveryRunResult;
}) {
  const verdict = candidateVerdict(candidate, result);
  const meta = VERDICT_META[verdict];
  const p = candidate.plan;

  return (
    <article className={`ra-cand ra-cand-${verdict}`}>
      <div className="ra-cand-head">
        <span className="ra-cand-n">STRATEGY {index + 1}</span>
        <span className={`rp-tag ${p.source === "llm" ? "rp-ai" : "rp-neutral"}`}>
          {p.source === "llm" ? "AI" : "HEURISTIC"}
        </span>
      </div>
      <div className="ra-cand-title">{p.strategy_label}</div>
      {p.rationale && <p className="ra-cand-rationale">{p.rationale}</p>}

      <div className="ra-flow">
        <div className="ra-step">
          <div className="ra-step-head">PROPOSAL</div>
          <ul className="rp-actions">
            {p.actions.map((a, i) => (
              <li key={`${a.type}-${i}`}>{actionText(a)}</li>
            ))}
          </ul>
        </div>
        <div className="ra-arrow">↓</div>
        <TwinBlock sim={candidate.simulation} />
        <div className="ra-arrow">↓</div>
        <SafetyBlock candidate={candidate} />
        <div className="ra-arrow">↓</div>
        <div className={`ra-verdict ra-verdict-${meta.kind}`}>
          <span className="ra-verdict-tag">{meta.tag}</span>
          <span className="ra-verdict-note">{meta.note}</span>
        </div>
      </div>
    </article>
  );
}

type ShowcasePhase = "idle" | "stacking" | "selecting" | "settling" | "settled";

function PassedCandidateCard({
  candidate,
  index,
  selected,
  visible,
  stackIndex,
  phase,
}: {
  candidate: CandidateResult;
  index: number;
  selected: boolean;
  visible: boolean;
  stackIndex: number;
  phase: ShowcasePhase;
}) {
  const metrics = candidate.simulation.metrics;

  return (
    <article
      className={`ra-showcase-card${visible ? " is-visible" : ""}${
        selected ? " is-selected" : ""
      }${phase === "selecting" ? " is-selecting" : ""}`}
      style={
        {
          "--stack-index": stackIndex,
          "--stack-offset": `${Math.min(stackIndex, 4) * 8}px`,
          "--stack-scale": Math.max(0.9, 1 - stackIndex * 0.025),
        } as CSSProperties
      }
      aria-hidden={!visible}
    >
      <div className="ra-showcase-head">
        <span>STRATEGY {index + 1}</span>
        <span className="ra-showcase-pass">✓ PASSED</span>
      </div>
      <div className="ra-showcase-title">{candidate.plan.strategy_label}</div>
      <div className="ra-showcase-actions">
        {candidate.plan.actions.slice(0, 2).map((action, actionIndex) => (
          <span key={`${action.type}-${actionIndex}`}>{actionText(action)}</span>
        ))}
      </div>
      <div className="ra-showcase-metrics">
        <div>
          <span>AVAILABILITY</span>
          <strong>{metrics ? pct(metrics.availability) : "—"}</strong>
        </div>
        <div>
          <span>AVG LATENCY</span>
          <strong>{metrics ? `${metrics.avg_latency.toFixed(1)} ms` : "—"}</strong>
        </div>
      </div>
      <div className="ra-showcase-foot">
        <span>DIGITAL TWIN ✓</span>
        <span>SAFETY GATE ✓</span>
      </div>
      {selected && (phase === "selecting" || phase === "settling") && (
        <div className="ra-showcase-winner">★ SELECTED — BEST SAFE PLAN</div>
      )}
    </article>
  );
}

function PassedSolutionsShowcase({
  candidates,
  selectedId,
  visibleCount,
  phase,
}: {
  candidates: { candidate: CandidateResult; originalIndex: number }[];
  selectedId: string;
  visibleCount: number;
  phase: ShowcasePhase;
}) {
  return (
    <div className={`ra-showcase ra-showcase-${phase}`} role="status" aria-live="polite">
      <div className="ra-showcase-status">
        <span className="ra-showcase-pulse" />
        {phase === "selecting" || phase === "settling"
          ? "Selecting the strongest safe recovery"
          : `Safety checks passed ${Math.min(visibleCount, candidates.length)} of ${candidates.length}`}
      </div>
      <div className="ra-showcase-stage">
        {candidates.map(({ candidate, originalIndex }, stackIndex) => (
          <PassedCandidateCard
            key={candidate.plan.id}
            candidate={candidate}
            index={originalIndex}
            selected={candidate.plan.id === selectedId}
            visible={stackIndex < visibleCount}
            stackIndex={stackIndex}
            phase={phase}
          />
        ))}
      </div>
      <div className="ra-showcase-dots" aria-hidden="true">
        {candidates.map(({ candidate }, index) => (
          <span key={candidate.plan.id} className={index < visibleCount ? "is-complete" : ""} />
        ))}
      </div>
    </div>
  );
}

function RecoveryAnalysis({ result }: { result: RecoveryRunResult }) {
  const stats = analysisStats(result.candidates, result.applied_plan_id);
  const passedCandidates = useMemo(
    () =>
      result.candidates
        .map((candidate, originalIndex) => ({ candidate, originalIndex }))
        .filter(({ candidate }) => candidate.simulation.feasible && candidate.safety.approved),
    [result],
  );
  const prefersReducedMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const shouldShowcase =
    result.applied_plan_id !== null && passedCandidates.length >= 2 && !prefersReducedMotion;
  const [showcasePhase, setShowcasePhase] = useState<ShowcasePhase>(
    shouldShowcase ? "idle" : "settled",
  );
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    if (!shouldShowcase || result.applied_plan_id === null) return;

    const timers: number[] = [];

    timers.push(
      window.setTimeout(() => {
        setShowcasePhase("stacking");
        setVisibleCount(1);
      }, 180),
    );

    for (let index = 1; index < passedCandidates.length; index += 1) {
      timers.push(window.setTimeout(() => setVisibleCount(index + 1), 180 + index * 720));
    }

    const stackCompleteAt = 180 + (passedCandidates.length - 1) * 720;
    timers.push(window.setTimeout(() => setShowcasePhase("selecting"), stackCompleteAt + 820));
    timers.push(window.setTimeout(() => setShowcasePhase("settling"), stackCompleteAt + 1900));
    timers.push(window.setTimeout(() => setShowcasePhase("settled"), stackCompleteAt + 2650));

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [passedCandidates, result.applied_plan_id, result.run_id, shouldShowcase]);

  const showcasing = shouldShowcase && showcasePhase !== "settled";

  return (
    <section className={`rp-block ra${showcasing ? " ra-is-showcasing" : " ra-is-settled"}`}>
      <div className="ra-header">
        <div className="ra-title">AI RECOVERY ANALYSIS</div>
        <div className="ra-sub">Multiple recovery strategies evaluated before execution</div>
      </div>

      {result.candidates.length === 0 ? (
        <p className="rp-reason">
          No recovery strategies were generated — {result.diagnosis?.summary ?? "no actionable fault detected"}.
        </p>
      ) : (
        <>
          <div className="ra-stats">
            <div>
              <strong>{stats.considered}</strong>
              <span>CONSIDERED</span>
            </div>
            <div>
              <strong>{stats.passedTwin}</strong>
              <span>PASSED TWIN</span>
            </div>
            <div>
              <strong>{stats.safetyApproved}</strong>
              <span>SAFETY OK</span>
            </div>
            <div className={stats.selected ? "ra-stat-sel" : "ra-stat-none"}>
              <strong>{stats.selected}</strong>
              <span>SELECTED</span>
            </div>
          </div>

          {showcasing && result.applied_plan_id !== null ? (
            <PassedSolutionsShowcase
              candidates={passedCandidates}
              selectedId={result.applied_plan_id}
              visibleCount={visibleCount}
              phase={showcasePhase}
            />
          ) : (
            <div className="ra-settled-content">
              <EvalStrip result={result} />

              <div className="ra-cands">
                {result.candidates.map((c, i) => (
                  <AnalysisCandidate key={c.plan.id} candidate={c} index={i} result={result} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function AegisDecision({ result }: { result: RecoveryRunResult }) {
  const meta = OUTCOME_META[result.outcome] ?? { label: result.outcome.toUpperCase(), kind: "bad" as const };
  const selected = result.candidates.find(
    (c) => result.applied_plan_id !== null && c.plan.id === result.applied_plan_id,
  );

  return (
    <section className={`ra-decision ra-decision-${meta.kind}`}>
      <div className="ra-decision-head">AEGIS DECISION</div>
      <div className="ra-decision-label">{meta.label}</div>

      {result.outcome === "applied" && selected && (
        <>
          <div className="ra-decision-plan">
            <span>PLAN SELECTED</span>
            <strong>{selected.plan.strategy_label}</strong>
          </div>
          <div className="ra-decision-rows">
            <div>
              <span>DIGITAL TWIN</span>
              <span className="ra-ok">✓ PASSED</span>
            </div>
            <div>
              <span>SAFETY GATE</span>
              <span className="ra-ok">✓ APPROVED</span>
            </div>
            <div>
              <span>EXECUTOR</span>
              <span className="ra-ok">✓ APPLIED</span>
            </div>
          </div>
          {result.resulting_version !== null && (
            <div className="ra-decision-ver">Network state version: v{result.resulting_version}</div>
          )}
        </>
      )}

      {result.outcome === "no_safe_plan" && (
        <p className="ra-decision-msg">
          {result.candidates.length} recovery{" "}
          {result.candidates.length === 1 ? "strategy was" : "strategies were"} evaluated, but none
          passed the required safety conditions. The network was left unchanged.
        </p>
      )}

      {result.outcome === "no_plan" && (
        <p className="ra-decision-msg">
          The network is within all thresholds. No recovery was required and nothing was changed.
        </p>
      )}

      {(result.outcome === "error" || result.outcome === "diagnosis_failed") && (
        <p className="ra-decision-msg">{result.message} The network was not modified.</p>
      )}

      {result.outcome === "approved_pending" && (
        <p className="ra-decision-msg">
          A plan passed the Digital Twin and Safety Gate, but auto-apply is disabled so it was not
          executed. The network is unchanged.
        </p>
      )}
    </section>
  );
}

// --- AI explanation (plain English) -----------------------------------------

/** Turn a recovery action into a friendly one-liner. */
function friendlyAction(action: RecoveryAction): string {
  switch (action.type) {
    case "quarantine_node":
      return `Isolated node "${action.node_id}" so it can't cause more problems.`;
    case "drain_node":
      return `Gradually moved all traffic away from "${action.node_id}".`;
    case "restore_node":
      return `Brought node "${action.node_id}" back online.`;
    case "migrate_service":
      return `Moved the "${action.service_id}" service to a healthier server ("${action.to_node}").`;
    case "reset_link":
      return `Reset the network link "${action.edge_id}" to clear its fault.`;
    case "reroute": {
      const avoidList = [...action.avoid_nodes, ...action.avoid_edges];
      return avoidList.length
        ? `Re-routed "${action.service_id}" traffic around the broken path (avoiding ${avoidList.join(", ")}).`
        : `Re-routed "${action.service_id}" to use a better network path.`;
    }
  }
}

/** Build the plain-English summary paragraph from structured result data. */
function buildExplanation(result: RecoveryRunResult): string[] {
  const lines: string[] = [];

  // 1) What was wrong?
  if (result.diagnosis) {
    const dx = result.diagnosis;
    const targets = [
      ...dx.suspected_nodes.map((n) => `node "${n}"`),
      ...dx.suspected_edges.map((e) => `link "${e}"`),
      ...dx.suspected_services.map((s) => `service "${s}"`),
    ];
    lines.push(
      targets.length > 0
        ? `AEGIS detected a problem involving ${targets.join(", ")}. The diagnosis: "${dx.summary}" (${Math.round(dx.confidence * 100)}% confidence).`
        : `AEGIS detected an issue: "${dx.summary}" (${Math.round(dx.confidence * 100)}% confidence).`,
    );
  }

  // 2) What did it do?
  const applied = result.candidates.find(
    (c) => result.applied_plan_id !== null && c.plan.id === result.applied_plan_id,
  );
  if (applied) {
    const plan = applied.plan;
    lines.push(
      `To fix this, the system used the "${plan.strategy_label}" strategy (generated by the ${plan.source === "llm" ? "AI model" : "built-in heuristic engine"}).`,
    );
    lines.push("Here's what it did, step by step:");
    plan.actions.forEach((a, i) => {
      lines.push(`  ${i + 1}. ${friendlyAction(a)}`);
    });

    // 3) Did it work?
    const sim = applied.simulation;
    if (sim.feasible && sim.delta) {
      const availDelta = sim.delta.availability * 100;
      const latDelta = sim.delta.avg_latency;
      const parts: string[] = [];
      if (Math.abs(availDelta) > 0.05) {
        parts.push(
          availDelta > 0
            ? `availability improved by ${availDelta.toFixed(1)} percentage points`
            : `availability changed by ${availDelta.toFixed(1)} percentage points`,
        );
      }
      if (Math.abs(latDelta) > 0.5) {
        parts.push(
          latDelta < 0
            ? `average latency decreased by ${Math.abs(latDelta).toFixed(1)} ms`
            : `average latency increased by ${latDelta.toFixed(1)} ms`,
        );
      }
      if (parts.length > 0) {
        lines.push(`After applying the fix: ${parts.join(", ")}.`);
      }
    }

    if (applied.safety.approved) {
      lines.push("The Safety Engine reviewed and approved the plan before it was applied.");
    }
  } else if (result.outcome === "no_plan") {
    lines.push("No issues requiring intervention were found — the network appears healthy.");
  } else if (result.outcome === "no_safe_plan") {
    lines.push("Recovery plans were generated but none passed the Safety Engine's review. The network was left unchanged to avoid risk.");
  } else if (result.outcome === "error") {
    lines.push("An error occurred during the recovery process. The network was not modified.");
  }

  return lines;
}

function AIExplanationBlock({ result }: { result: RecoveryRunResult }) {
  const lines = buildExplanation(result);
  const source = result.candidates.find(
    (c) => result.applied_plan_id !== null && c.plan.id === result.applied_plan_id,
  )?.plan.source;

  return (
    <section className="rp-block rp-explain">
      <div className="rp-block-head">
        <span>
          🤖 WHAT HAPPENED — IN SIMPLE WORDS
        </span>
        {source && (
          <span className={`rp-tag ${source === "llm" ? "rp-ai" : "rp-neutral"}`}>
            {source === "llm" ? "AI-GENERATED" : "HEURISTIC"}
          </span>
        )}
      </div>
      <div className="rp-explain-body">
        {lines.map((line, i) => (
          <p key={i} className={line.startsWith("  ") ? "rp-explain-step" : "rp-explain-text"}>
            {line}
          </p>
        ))}
      </div>
    </section>
  );
}

// --- panel -----------------------------------------------------------------

function RecoveryPanel({ result, phase, running, error, onClose }: RecoveryPanelProps) {
  const [showTwin, setShowTwin] = useState(false);

  // Does the result have at least one candidate with simulation data?
  const hasTwinData =
    result !== null &&
    result.candidates.some((c) => c.simulation.metrics !== null || c.simulation.infeasible_reason !== null);

  return (
    <div className="recovery-panel">
      <div className="rp-head">
        <div>
          <span className="rp-eyebrow">RECOVERY RUN</span>
          <h3 className="rp-run-id">{result ? result.run_id : running ? "running…" : "—"}</h3>
        </div>
        <div className="rp-head-right">
          {result && (
            <span className={`rp-badge rp-${(OUTCOME_META[result.outcome] ?? { kind: "bad" }).kind}`}>
              {(OUTCOME_META[result.outcome] ?? { label: result.outcome }).label}
            </span>
          )}
          <button className="rp-close" onClick={onClose}>
            BACK TO INSPECTOR
          </button>
        </div>
      </div>

      {running && !result && (
        <p className="rp-progress">
          {phase === "diagnosing" && "Diagnosing network fault…"}
          {phase === "simulating" && "Testing recovery plans in the Digital Twin…"}
          {phase === "evaluating" && "Evaluating the deterministic safety policy…"}
          {phase === "executing" && "Applying the approved plan…"}
          {phase === "idle" && "Starting recovery…"}
          {phase === "done" && "Finishing…"}
        </p>
      )}

      {error && (
        <div className="rp-error">
          <div className="rp-error-label">RECOVERY REQUEST FAILED</div>
          <p>{error}</p>
        </div>
      )}

      {result && (
        <div className="rp-body">
          <div className="rp-meta">
            <div>
              <span>BASED ON</span>
              <strong>v{result.based_on_version}</strong>
            </div>
            <div>
              <span>RESULT VERSION</span>
              <strong>{result.resulting_version !== null ? `v${result.resulting_version}` : "—"}</strong>
            </div>
          </div>

          {result.diagnosis ? (
            <DiagnosisBlock dx={result.diagnosis} />
          ) : (
            <section className="rp-block">
              <div className="rp-block-head">DIAGNOSIS</div>
              <p className="rp-reason">No diagnosis was produced ({result.outcome}).</p>
            </section>
          )}

          <RecoveryAnalysis result={result} />

          <AegisDecision result={result} />

          {/* --- AI Explanation: plain-English summary --- */}
          <AIExplanationBlock result={result} />

          {/* --- Visualize Digital Twin button --- */}
          {hasTwinData && (
            <button
              className="rp-twin-btn"
              onClick={() => setShowTwin(true)}
            >
              🔬 VISUALIZE DIGITAL TWIN
            </button>
          )}
        </div>
      )}

      {/* Digital Twin full-screen popup */}
      {showTwin && result && (
        <DigitalTwinModal result={result} onClose={() => setShowTwin(false)} />
      )}
    </div>
  );
}

export default RecoveryPanel;
