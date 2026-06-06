import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import Hero from "@/components/Hero";

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...props} />;
  },
}));

vi.mock("framer-motion", () => ({
  motion: {
    div: ({
      children,
      ...props
    }: {
      children?: React.ReactNode;
      [key: string]: unknown;
    }) => <div {...filterMotionProps(props)}>{children}</div>,
    h1: ({
      children,
      ...props
    }: {
      children?: React.ReactNode;
      [key: string]: unknown;
    }) => <h1 {...filterMotionProps(props)}>{children}</h1>,
    p: ({
      children,
      ...props
    }: {
      children?: React.ReactNode;
      [key: string]: unknown;
    }) => <p {...filterMotionProps(props)}>{children}</p>,
  },
}));

function filterMotionProps(props: Record<string, unknown>) {
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    if (
      !["initial", "animate", "transition", "whileHover", "whileTap"].includes(
        key
      )
    ) {
      filtered[key] = props[key];
    }
  }
  return filtered;
}

describe("Hero", () => {
  it("renders the headline text", () => {
    render(<Hero />);
    expect(screen.getByText(/MAKING WALRUS/)).toBeInTheDocument();
    expect(screen.getByText(/CHAIN-AGNOSTIC/)).toBeInTheDocument();
  });

  it("renders the subtitle", () => {
    render(<Hero />);
    expect(
      screen.getByText(/Cross-chain storage intent routing/)
    ).toBeInTheDocument();
  });

  it("renders the status badge", () => {
    render(<Hero />);
    expect(screen.getByText("Live on Testnet")).toBeInTheDocument();
  });

  it("renders the Go to Docs CTA with correct href", () => {
    render(<Hero />);
    const docsLink = screen.getByText("Go to Docs").closest("a");
    expect(docsLink).toHaveAttribute("href", "https://docs.bosphor.xyz");
  });

  it("renders the View on GitHub CTA with correct href", () => {
    render(<Hero />);
    const githubLink = screen.getByText("View on GitHub").closest("a");
    expect(githubLink).toHaveAttribute(
      "href",
      "https://github.com/riva-labs/bosphor"
    );
  });

  it("renders the waving beaver mascot", () => {
    render(<Hero />);
    const img = screen.getByAltText("Bosphor beaver waving");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "/mascot/01_waving.png");
  });

  it("renders the background wordmark", () => {
    render(<Hero />);
    expect(screen.getByText("BOSPHOR")).toBeInTheDocument();
  });
});
