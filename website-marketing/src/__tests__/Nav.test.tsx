import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import Nav from "@/components/Nav";

describe("Nav", () => {
  it("renders the Bosphor logo text", () => {
    render(<Nav />);
    expect(screen.getByText("Bosphor")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
  });

  it("renders Docs and GitHub links", () => {
    render(<Nav />);
    const docsLinks = screen.getAllByText("Docs");
    const githubLinks = screen.getAllByText("GitHub");
    expect(docsLinks.length).toBeGreaterThan(0);
    expect(githubLinks.length).toBeGreaterThan(0);
  });

  it("has the correct href for Docs link", () => {
    render(<Nav />);
    const docsLinks = screen.getAllByText("Docs");
    const docsLink = docsLinks[0].closest("a");
    expect(docsLink).toHaveAttribute("href", "https://docs.bosphor.xyz");
  });

  it("has the correct href for GitHub link", () => {
    render(<Nav />);
    const githubLinks = screen.getAllByText("GitHub");
    const githubLink = githubLinks[0].closest("a");
    expect(githubLink).toHaveAttribute(
      "href",
      "https://github.com/riva-labs/bosphor"
    );
  });

  it("has a navigation role", () => {
    render(<Nav />);
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });

  it("toggles mobile menu on button click", () => {
    render(<Nav />);
    const toggleButton = screen.getByLabelText("Toggle menu");
    expect(toggleButton).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggleButton);
    expect(toggleButton).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggleButton);
    expect(toggleButton).toHaveAttribute("aria-expanded", "false");
  });
});
