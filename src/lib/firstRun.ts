export type FrStage = "checking" | "needs-install" | "installing" | "ready" | "chat";

export type StepId = "install" | "signin" | "project" | "prompt";
export type StepState = "done" | "active" | "pending";

export interface JourneyStep {
  id: StepId;
  label: string;
  hint: string;
  state: StepState;
}

export interface FirstRunInput {
  stage: FrStage;
  signedIn: boolean;
  hasProject: boolean;
  hasSentFirstPrompt: boolean;
}

type StepDefinition = Omit<JourneyStep, "state"> & {
  isDone: (input: FirstRunInput) => boolean;
};

const STEP_DEFINITIONS: readonly StepDefinition[] = [
  {
    id: "install",
    label: "Install Grok Build",
    hint: "One click — we fetch it from xAI, no terminal.",
    isDone: ({ stage }) => stage === "ready" || stage === "chat",
  },
  {
    id: "signin",
    label: "Sign in with Grok",
    hint: "Opens your browser to finish securely.",
    isDone: ({ signedIn }) => signedIn,
  },
  {
    id: "project",
    label: "Open a project folder",
    hint: "Pick a folder you can undo — ideally one in git.",
    isDone: ({ hasProject }) => hasProject,
  },
  {
    id: "prompt",
    label: "Send your first prompt",
    hint: "Say what you want done, in plain English.",
    isDone: ({ hasSentFirstPrompt }) => hasSentFirstPrompt,
  },
];

export function firstRunSteps(input: FirstRunInput): JourneyStep[] {
  let hasActiveStep = false;

  return STEP_DEFINITIONS.map(({ isDone, ...step }) => {
    if (isDone(input)) {
      return { ...step, state: "done" };
    }

    if (!hasActiveStep) {
      hasActiveStep = true;
      return { ...step, state: "active" };
    }

    return { ...step, state: "pending" };
  });
}

export function firstRunComplete(input: FirstRunInput): boolean {
  return firstRunProgress(input).done === STEP_DEFINITIONS.length;
}

export function firstRunProgress(input: FirstRunInput): { done: number; total: number } {
  return {
    done: STEP_DEFINITIONS.filter(({ isDone }) => isDone(input)).length,
    total: STEP_DEFINITIONS.length,
  };
}
