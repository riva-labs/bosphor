import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import BeaverMascot from "@/components/BeaverMascot";

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...props} />;
  },
}));

describe("BeaverMascot", () => {
  it("renders an image with the correct src for the given pose", () => {
    render(<BeaverMascot pose="01_waving" />);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", "/mascot/01_waving.png");
  });

  it("applies the invert filter classes for white silhouette", () => {
    render(<BeaverMascot pose="01_waving" />);
    const img = screen.getByRole("img");
    expect(img.className).toContain("brightness-0");
    expect(img.className).toContain("invert");
  });

  it("renders with default size of 200", () => {
    render(<BeaverMascot pose="01_waving" />);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("width", "200");
    expect(img).toHaveAttribute("height", "200");
  });

  it("accepts a custom size prop", () => {
    render(<BeaverMascot pose="01_waving" size={400} />);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("width", "400");
    expect(img).toHaveAttribute("height", "400");
  });

  it("passes through additional className", () => {
    render(<BeaverMascot pose="01_waving" className="my-custom-class" />);
    const img = screen.getByRole("img");
    expect(img.className).toContain("my-custom-class");
  });

  it("generates alt text from pose name", () => {
    render(<BeaverMascot pose="01_waving" />);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("alt", "Bosphor beaver waving");
  });
});
