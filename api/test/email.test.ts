import { describe, expect, it } from "vitest";
import { fromHeader } from "../src/email";

/**
 * The From header on the invitation email.
 *
 * Worth testing at all because `send()` short-circuits under
 * `EMAIL_MODE=local` before the SES command is built, so nothing else in the
 * suite ever sees this string -- and a malformed one does not degrade, it makes
 * SES reject the whole send.
 */
describe("fromHeader", () => {
  it("names the sender when the stack supplies a name", () => {
    // Cognito's one-time code has always had a display name; this message went
    // out from a bare address, so an invited member's first two emails looked
    // like they came from two different places.
    expect(fromHeader("Directory", "no-reply@pauldev.io")).toBe(
      '"Directory" <no-reply@pauldev.io>'
    );
  });

  it("falls back to the bare address when no name is set", () => {
    /*
     * FROM_NAME is a new environment variable, so between the stack deploy and
     * the function picking it up there is a window where it is absent. This is
     * the previous behaviour exactly, so nothing breaks in that gap.
     */
    expect(fromHeader("", "no-reply@pauldev.io")).toBe("no-reply@pauldev.io");
  });

  it("quotes the name, so a comma cannot break the address", () => {
    // An unquoted display name containing a comma is not one address but two,
    // and SES rejects the send rather than guessing.
    expect(fromHeader("Directory, Parish", "a@b.test")).toBe('"Directory, Parish" <a@b.test>');
  });

  it("escapes a quote or backslash inside the name", () => {
    expect(fromHeader('The "Parish" Directory', "a@b.test")).toBe(
      '"The \\"Parish\\" Directory" <a@b.test>'
    );
    expect(fromHeader("Back\\slash", "a@b.test")).toBe('"Back\\\\slash" <a@b.test>');
  });
});
