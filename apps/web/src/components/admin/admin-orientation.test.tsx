import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  dismissed: false,
  setDismissed: vi.fn((value: boolean) => {
    harness.dismissed = value;
  }),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: boolean | (() => boolean)) => [harness.dismissed || (typeof initial === "function" ? initial() : initial), harness.setDismissed],
  };
});

vi.mock("@/components/ui/button", async () => {
  const React = await import("react");
  return {
    Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
      React.createElement("button", props as Record<string, unknown>, children),
  };
});

vi.mock("@/lib/i18n", () => ({
  useLocale: () => ({
    t: {
      admin: {
        orientation: {
          title: "How policy changes work",
          description: "Prepare policy changes here.",
          steps: { stage: "Stage changes.", review: "Review changes.", publish: "Publish changes." },
          locked: "Locked controls stay locked.",
          dismiss: "Dismiss orientation",
        },
      },
    },
  }),
}));

import { AdminOrientation } from "./admin-orientation";

type ElementProps = { children?: ReactNode; [key: string]: unknown };

function props(element: ReactElement): ElementProps {
  return element.props as ElementProps;
}

function dismissButton(element: ReactElement): ReactElement {
  const header = (props(element).children as ReactNode[])[0] as ReactElement;
  return (props(header).children as ReactNode[])[1] as ReactElement;
}

describe("AdminOrientation", () => {
  beforeEach(() => {
    harness.dismissed = false;
    harness.setDismissed.mockClear();
  });

  it("calls onDismiss once and disappears after its localized dismiss control is activated", () => {
    const onDismiss = vi.fn();
    const firstRender = AdminOrientation({ onDismiss });
    expect(firstRender).not.toBeNull();

    const button = dismissButton(firstRender as ReactElement);
    expect(props(button)["aria-label"]).toBe("Dismiss orientation");
    (props(button).onClick as () => void)();

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(harness.setDismissed).toHaveBeenCalledOnce();
    expect(AdminOrientation({ onDismiss })).toBeNull();
  });
});
