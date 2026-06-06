import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import Footer from "@/components/Footer";

describe("Footer", () => {
  it("renders the copyright notice with the current year", () => {
    render(<Footer />);
    const year = new Date().getFullYear();
    expect(
      screen.getByText(new RegExp(`${year}.*Bosphor`))
    ).toBeInTheDocument();
  });

  it("renders the Riva Labs credit", () => {
    render(<Footer />);
    expect(screen.getByText("Riva Labs")).toBeInTheDocument();
  });

  it("links to the Riva Labs GitHub", () => {
    render(<Footer />);
    const link = screen.getByText("Riva Labs").closest("a");
    expect(link).toHaveAttribute("href", "https://github.com/riva-labs");
  });

  it("has contentinfo role", () => {
    render(<Footer />);
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });
});
