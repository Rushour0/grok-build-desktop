import { describe, expect, it } from "vitest";

import {
  firstRunComplete,
  firstRunProgress,
  firstRunSteps,
  type FirstRunInput,
} from "./firstRun";

const brandNewUser: FirstRunInput = {
  stage: "checking",
  signedIn: false,
  hasProject: false,
  hasSentFirstPrompt: false,
};

describe("firstRunSteps", () => {
  it("models a brand-new user", () => {
    const input = { ...brandNewUser, stage: "needs-install" as const };

    expect(firstRunSteps(input)).toEqual([
      {
        id: "install",
        label: "Install Grok Build",
        hint: "One click — we fetch it from xAI, no terminal.",
        state: "active",
      },
      {
        id: "signin",
        label: "Sign in with Grok",
        hint: "Opens your browser to finish securely.",
        state: "pending",
      },
      {
        id: "project",
        label: "Open a project folder",
        hint: "Pick a folder you can undo — ideally one in git.",
        state: "pending",
      },
      {
        id: "prompt",
        label: "Send your first prompt",
        hint: "Say what you want done, in plain English.",
        state: "pending",
      },
    ]);
    expect(firstRunComplete(input)).toBe(false);
    expect(firstRunProgress(input)).toEqual({ done: 0, total: 4 });
  });

  it("treats checking as an unfinished install", () => {
    expect(firstRunSteps(brandNewUser).map(({ state }) => state)).toEqual([
      "active",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("moves to sign in after installation", () => {
    const input: FirstRunInput = { ...brandNewUser, stage: "ready" };

    expect(firstRunSteps(input).map(({ state }) => state)).toEqual([
      "done",
      "active",
      "pending",
      "pending",
    ]);
  });

  it("moves to project selection after sign in", () => {
    const input: FirstRunInput = {
      ...brandNewUser,
      stage: "ready",
      signedIn: true,
    };

    expect(firstRunSteps(input).map(({ state }) => state)).toEqual([
      "done",
      "done",
      "active",
      "pending",
    ]);
  });

  it("moves to the first prompt after a project opens", () => {
    const input: FirstRunInput = {
      stage: "chat",
      signedIn: true,
      hasProject: true,
      hasSentFirstPrompt: false,
    };

    expect(firstRunSteps(input).map(({ state }) => state)).toEqual([
      "done",
      "done",
      "done",
      "active",
    ]);
    expect(firstRunComplete(input)).toBe(false);
    expect(firstRunProgress(input)).toEqual({ done: 3, total: 4 });
  });

  it("marks every step done when the journey is complete", () => {
    const input: FirstRunInput = {
      stage: "chat",
      signedIn: true,
      hasProject: true,
      hasSentFirstPrompt: true,
    };

    const steps = firstRunSteps(input);

    expect(steps.every(({ state }) => state === "done")).toBe(true);
    expect(steps.some(({ state }) => state === "active")).toBe(false);
    expect(firstRunComplete(input)).toBe(true);
    expect(firstRunProgress(input)).toEqual({ done: 4, total: 4 });
  });

  it("honestly represents later completed steps before installation", () => {
    const input: FirstRunInput = {
      ...brandNewUser,
      stage: "needs-install",
      signedIn: true,
    };
    const steps = firstRunSteps(input);

    expect(steps.slice(0, 2).map(({ id, state }) => ({ id, state }))).toEqual([
      { id: "install", state: "active" },
      { id: "signin", state: "done" },
    ]);
    expect(steps.filter(({ state }) => state === "active")).toEqual([
      expect.objectContaining({ id: "install" }),
    ]);
  });

  it("always returns four steps in display order", () => {
    const inputs: FirstRunInput[] = [
      brandNewUser,
      { ...brandNewUser, stage: "installing" },
      { ...brandNewUser, stage: "ready", signedIn: true },
      { stage: "chat", signedIn: true, hasProject: true, hasSentFirstPrompt: true },
    ];

    for (const input of inputs) {
      const steps = firstRunSteps(input);

      expect(steps).toHaveLength(4);
      expect(steps.map(({ id }) => id)).toEqual(["install", "signin", "project", "prompt"]);
    }
  });

  it("has one active step when incomplete and none when complete", () => {
    const inputs: FirstRunInput[] = [
      brandNewUser,
      { ...brandNewUser, stage: "ready" },
      { ...brandNewUser, stage: "ready", signedIn: true, hasProject: true },
      { stage: "chat", signedIn: true, hasProject: true, hasSentFirstPrompt: true },
    ];

    for (const input of inputs) {
      const activeSteps = firstRunSteps(input).filter(({ state }) => state === "active");

      expect(activeSteps).toHaveLength(firstRunComplete(input) ? 0 : 1);
    }
  });

  it("keeps progress aligned with the step states across input combinations", () => {
    const stages: FirstRunInput["stage"][] = [
      "checking",
      "needs-install",
      "installing",
      "ready",
      "chat",
    ];

    for (const stage of stages) {
      for (const signedIn of [false, true]) {
        for (const hasProject of [false, true]) {
          for (const hasSentFirstPrompt of [false, true]) {
            const input: FirstRunInput = { stage, signedIn, hasProject, hasSentFirstPrompt };
            const doneSteps = firstRunSteps(input).filter(({ state }) => state === "done").length;

            expect(firstRunProgress(input)).toEqual({ done: doneSteps, total: 4 });
          }
        }
      }
    }
  });
});
