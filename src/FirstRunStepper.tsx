import type { JourneyStep } from "./lib/firstRun";

export function FirstRunStepper({ steps }: { steps: JourneyStep[] }): React.ReactElement {
  return (
    <ol className="frs">
      {steps.map((step, i) => (
        <li
          className={"frs-step frs-" + step.state}
          key={step.id}
          aria-current={step.state === "active" ? "step" : undefined}
        >
          <span className="frs-marker" aria-hidden="true">
            {step.state === "done" ? (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : (
              <span className="frs-num">{i + 1}</span>
            )}
          </span>
          <span className="frs-body">
            <span className="frs-label">{step.label}</span>
            {step.state === "active" && <span className="frs-hint">{step.hint}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
