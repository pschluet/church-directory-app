import { describe, expect, it } from "vitest";
import {
  bodyToDoc,
  docToBody,
  parseBody,
  parseInline,
  toPlainText,
  type DocNode,
} from "../src/lib/richText";

const text = (t: string, marks?: string[]): DocNode => ({
  type: "text",
  text: t,
  ...(marks ? { marks: marks.map((type) => ({ type })) } : {}),
});
const para = (...content: DocNode[]): DocNode => ({ type: "paragraph", content });

describe("parseInline", () => {
  it("reads each kind of formatting", () => {
    expect(parseInline("**b** _i_ ++u++ ~~s~~ [l](https://x.org)")).toEqual([
      { kind: "bold", children: [{ kind: "text", text: "b" }] },
      { kind: "text", text: " " },
      { kind: "italic", children: [{ kind: "text", text: "i" }] },
      { kind: "text", text: " " },
      { kind: "underline", children: [{ kind: "text", text: "u" }] },
      { kind: "text", text: " " },
      { kind: "strike", children: [{ kind: "text", text: "s" }] },
      { kind: "text", text: " " },
      { kind: "link", href: "https://x.org", children: [{ kind: "text", text: "l" }] },
    ]);
  });

  it("nests", () => {
    expect(parseInline("**a _b_**")).toEqual([
      {
        kind: "bold",
        children: [
          { kind: "text", text: "a " },
          { kind: "italic", children: [{ kind: "text", text: "b" }] },
        ],
      },
    ]);
  });

  it("leaves old plain messages alone", () => {
    for (const plain of [
      "snake_case_name",
      "2*3*4 = 24",
      "1+1 = 2",
      "email me at me@everyone.org",
      "a ** b",
      "[not a link]",
    ]) {
      expect(toPlainText(plain)).toBe(plain);
    }
  });

  it("does not link an unsafe scheme", () => {
    expect(parseInline("[click](javascript:alert(1))")).toEqual([
      { kind: "text", text: "click" },
      { kind: "text", text: ")" },
    ]);
  });

  it("honours backslash escapes", () => {
    expect(toPlainText("\\*\\*not bold\\*\\* \\_x\\_ \\[y\\]")).toBe("**not bold** _x_ [y]");
  });
});

describe("parseBody", () => {
  it("reads bulleted and numbered lists, nested and with line breaks", () => {
    const blocks = parseBody("Intro\n- one\n  more\n  1. inner\n- two\n3. three\nAfter");
    expect(blocks.map((b) => b.kind)).toEqual(["line", "list", "list", "line"]);
    const bullets = blocks[1];
    if (bullets?.kind !== "list") throw new Error("expected a list");
    expect(bullets.items).toHaveLength(2);
    expect(bullets.items[0]!.lines).toHaveLength(2);
    expect(bullets.items[0]!.children[0]!.ordered).toBe(true);
    const numbered = blocks[2];
    expect(numbered?.kind === "list" && numbered.start).toBe(3);
  });

  it("keeps blank lines", () => {
    expect(toPlainText("a\n\nb")).toBe("a\n\nb");
  });
});

describe("toPlainText", () => {
  it("bullets and numbers list items", () => {
    expect(toPlainText("- **a**\n- b\n\n1. c")).toBe("• a\n• b\n\n1. c");
  });
});

describe("docToBody / bodyToDoc", () => {
  it("writes marks, merging runs that share them", () => {
    const doc = {
      type: "doc",
      content: [para(text("a "), text("b", ["bold"]), text("c", ["bold", "italic"]), text(" d"))],
    };
    expect(docToBody(doc)).toBe("a **b_c_** d");
  });

  it("keeps spaces outside the markers", () => {
    const doc = { type: "doc", content: [para(text("a"), text(" b", ["bold"]))] };
    expect(docToBody(doc)).toBe("a **b**");
  });

  it("escapes what was typed so it reads back as typed", () => {
    const typed = "snake_case **stars** [x](y) 1+1 a\\b ++";
    const body = docToBody({ type: "doc", content: [para(text(typed))] });
    expect(toPlainText(body)).toBe(typed);
  });

  it("escapes a typed line that looks like a list", () => {
    const body = docToBody({
      type: "doc",
      content: [para(text("- not a list")), para(text("1. nor this"))],
    });
    expect(parseBody(body).every((b) => b.kind === "line")).toBe(true);
    expect(toPlainText(body)).toBe("- not a list\n1. nor this");
  });

  it("writes links with their href", () => {
    const doc = {
      type: "doc",
      content: [
        para({
          type: "text",
          text: "site",
          marks: [{ type: "link", attrs: { href: "https://x.org/a b" } }],
        }),
      ],
    };
    expect(docToBody(doc)).toBe("[site](https://x.org/a%20b)");
  });

  it("drops trailing empty lines but keeps inner ones", () => {
    const doc = {
      type: "doc",
      content: [para(text("a")), { type: "paragraph" }, para(text("b")), { type: "paragraph" }],
    };
    expect(docToBody(doc)).toBe("a\n\nb");
  });

  it("round-trips formatting and lists", () => {
    for (const body of [
      "Hello **there** _you_ ++and++ ~~not~~ [link](https://x.org)",
      "- one\n- two\n  - nested\n- three",
      "3. three\n4. four",
      "line\n\nafter a gap",
      "- item with\n  a line break",
    ]) {
      expect(docToBody(bodyToDoc(body))).toBe(body);
    }
  });
});

describe("docToBody spacing", () => {
  it("keeps a run's trailing space outside its markers", () => {
    const doc: DocNode = { type: "doc", content: [para(text("@Ann Lee ", ["bold"]))] };
    expect(docToBody(doc)).toBe("**@Ann Lee** ");
  });

  it("keeps a space between two runs inside the marks they share", () => {
    const doc: DocNode = {
      type: "doc",
      content: [para(text("a ", ["bold"]), text("b", ["bold", "italic"]))],
    };
    expect(docToBody(doc)).toBe("**a _b_**");
  });
});

describe("# group mentions", () => {
  const ID = "0b9a3f2e-4c1d-4e8f-9a7b-1c2d3e4f5a6b";
  const mention = (label: string | null, marks?: string[]): DocNode => ({
    type: "groupMention",
    attrs: { groupId: ID, label },
    ...(marks ? { marks: marks.map((type) => ({ type })) } : {}),
  });

  it("reads a token as a mention of that group, and anything else as text", () => {
    expect(parseInline(`Ask <#${ID}> now`)).toEqual([
      { kind: "text", text: "Ask " },
      { kind: "groupMention", groupId: ID },
      { kind: "text", text: " now" },
    ]);
    expect(parseInline("<#not-a-group>")).toEqual([{ kind: "text", text: "<#not-a-group>" }]);
    expect(parseInline(`\\<#${ID}>`)).toEqual([{ kind: "text", text: `<#${ID}>` }]);
  });

  it("saves a mention as its id, never its name, inside any formatting", () => {
    const doc: DocNode = {
      type: "doc",
      content: [
        para(text("Ask "), mention("Choir"), text(" now")),
        para(mention("Choir", ["bold"])),
      ],
    };
    expect(docToBody(doc)).toBe(`Ask <#${ID}> now\n**<#${ID}>**`);
  });

  it("loads a mention back into the box with the name it is given", () => {
    const doc = bodyToDoc(`Ask <#${ID}>`, (id) => (id === ID ? "Choir" : null));
    expect(doc.content?.[0]?.content?.[1]).toEqual(mention("Choir"));
    expect(docToBody(doc)).toBe(`Ask <#${ID}>`);
  });

  it("keeps typed text from ever becoming a mention", () => {
    const typed = `<#${ID}>`;
    const body = docToBody({ type: "doc", content: [para(text(typed))] });
    expect(body).toBe(`\\<#${ID}>`);
    expect(parseInline(body)).toEqual([{ kind: "text", text: typed }]);
  });

  it("reads as the name in plain text, or as a secret group without one", () => {
    expect(toPlainText(`Ask <#${ID}>`, () => "Choir")).toBe("Ask #Choir");
    expect(toPlainText(`Ask <#${ID}>`)).toBe("Ask #secret group");
  });
});
