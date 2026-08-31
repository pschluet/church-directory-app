import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Avatar } from "../src/components/Avatar";
import { FamilyPhoto } from "../src/components/FamilyPhoto";
import { PhotoLightbox } from "../src/components/PhotoLightbox";

const PERSON = { firstName: "Layla", lastName: "Haddad" };

describe("Avatar", () => {
  it("loads the thumbnail, not the full rendition", () => {
    // The whole point: a card renders at 56px and used to fetch the original.
    render(<Avatar thumbUrl="/photos/org/person/p/01A/thumb" person={PERSON} />);
    expect(screen.getByRole("presentation", { hidden: true })).toHaveAttribute(
      "src",
      "/photos/org/person/p/01A/thumb"
    );
  });

  it("falls back to initials when there is no photo", () => {
    render(<Avatar thumbUrl={null} person={PERSON} />);
    expect(screen.getByText("LH")).toBeInTheDocument();
  });

  it("falls back to initials when the photo fails to load", () => {
    // A key whose object is gone would otherwise render a broken-image icon.
    render(<Avatar thumbUrl="/photos/org/person/p/gone/thumb" person={PERSON} />);
    fireEvent.error(screen.getByRole("presentation", { hidden: true }));
    expect(screen.getByText("LH")).toBeInTheDocument();
  });

  it("shows a replacement photo after the previous one failed", () => {
    // Uploading a new photo changes the prop without remounting, so a bare
    // "did it fail" flag would keep the initials up for the new photo too.
    const { rerender } = render(<Avatar thumbUrl="/photos/gone/thumb" person={PERSON} />);
    fireEvent.error(screen.getByRole("presentation", { hidden: true }));
    expect(screen.getByText("LH")).toBeInTheDocument();

    rerender(<Avatar thumbUrl="/photos/fresh/thumb" person={PERSON} />);
    expect(screen.getByRole("presentation", { hidden: true })).toHaveAttribute(
      "src",
      "/photos/fresh/thumb"
    );
  });

  it("is not clickable without a full rendition, so list cards stay links", () => {
    render(<Avatar thumbUrl="/photos/org/person/p/01A/thumb" person={PERSON} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("opens the full rendition when given one", async () => {
    render(
      <Avatar
        thumbUrl="/photos/org/person/p/01A/thumb"
        fullUrl="/photos/org/person/p/01A/full"
        person={PERSON}
      />
    );

    // Nothing requests the large file until it is asked for.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /full screen/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByAltText("Layla Haddad")).toHaveAttribute(
      "src",
      "/photos/org/person/p/01A/full"
    );
  });
});

describe("FamilyPhoto", () => {
  it("shows the whole photo rather than cropping it to a circle", () => {
    render(
      <FamilyPhoto
        thumbUrl="/photos/org/family/f/01A/thumb"
        fullUrl="/photos/org/family/f/01A/full"
        width={1600}
        height={1067}
        familyName="Haddad"
      />
    );
    const img = screen.getByAltText("The Haddad family");
    expect(img.className).toContain("object-contain");
    expect(img.className).not.toContain("rounded-full");
  });

  it("reserves the box from the stored crop dimensions", () => {
    // Without these the page jumps as each free-form family photo paints.
    render(
      <FamilyPhoto
        thumbUrl="/photos/org/family/f/01A/thumb"
        fullUrl={null}
        width={1600}
        height={1067}
        familyName="Haddad"
      />
    );
    const img = screen.getByAltText("The Haddad family");
    expect(img).toHaveAttribute("width", "1600");
    expect(img).toHaveAttribute("height", "1067");
  });

  it("shows a replacement family photo after the previous one failed", () => {
    const { rerender } = render(
      <FamilyPhoto
        thumbUrl="/photos/gone/thumb"
        fullUrl={null}
        width={null}
        height={null}
        familyName="Haddad"
      />
    );
    fireEvent.error(screen.getByAltText("The Haddad family"));
    expect(screen.queryByAltText("The Haddad family")).not.toBeInTheDocument();

    rerender(
      <FamilyPhoto
        thumbUrl="/photos/fresh/thumb"
        fullUrl={null}
        width={1600}
        height={1067}
        familyName="Haddad"
      />
    );
    expect(screen.getByAltText("The Haddad family")).toHaveAttribute("src", "/photos/fresh/thumb");
  });

  it("falls back to a 4:3 box for a photo that predates cropping", () => {
    render(
      <FamilyPhoto
        thumbUrl="/photos/org/family/f/old.jpg"
        fullUrl={null}
        width={null}
        height={null}
        familyName="Haddad"
      />
    );
    const img = screen.getByAltText("The Haddad family");
    expect(img).toHaveAttribute("width", "4");
    expect(img).toHaveAttribute("height", "3");
  });
});

describe("PhotoLightbox", () => {
  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<PhotoLightbox src="/photos/x/full" alt="A photo" onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes when the scrim is clicked but not the photo", async () => {
    const onClose = vi.fn();
    render(<PhotoLightbox src="/photos/x/full" alt="A photo" onClose={onClose} />);

    await userEvent.click(screen.getByAltText("A photo"));
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("locks the page behind it and restores scrolling on close", () => {
    const { unmount } = render(
      <PhotoLightbox src="/photos/x/full" alt="A photo" onClose={vi.fn()} />
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("puts focus in the dialog so Tab does not wander the page behind", () => {
    render(<PhotoLightbox src="/photos/x/full" alt="A photo" onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });
});
