import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  EditorContent,
  Extension,
  InputRule,
  markInputRule,
  markPasteRule,
  useEditor,
  useEditorState,
  type Editor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Bold from "@tiptap/extension-bold";
import Italic, { underscoreInputRegex, underscorePasteRegex } from "@tiptap/extension-italic";
import Strike from "@tiptap/extension-strike";
import Underline from "@tiptap/extension-underline";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import Suggestion, { exitSuggestion, type SuggestionProps } from "@tiptap/suggestion";
import { GROUP_MENTION_EVERYONE, type GroupMemberDto } from "@shared";
import { bodyToDoc, docToBody, isSafeHref, type DocNode } from "../lib/richText";
import { Button, Field, inputClass, Modal } from "./ui";

/**
 * The message bar's text box: a Slack-style editor where bold looks bold as it
 * is typed, saved as the small Markdown-like syntax in lib/richText.ts so a
 * post's `body` stays text on the wire.
 *
 * Its own module, loaded lazily by GroupDetail, so Tiptap and ProseMirror stay
 * out of the main bundle until someone opens a group.
 */

/** Phones and tablets: Enter is the keyboard's "return", a new line, not send. */
function isTouchDevice(): boolean {
  return window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false;
}

/** One row in the @ mention list: a member, or the whole group. */
type MentionOption = { kind: "everyone" } | { kind: "member"; member: GroupMemberDto };

type MentionState = {
  query: string;
  range: { from: number; to: number };
  rect: DOMRect | null;
};

const mentionKey = new PluginKey("mention");

/*
 * Typing the markers formats the text in place, so the box never shows raw
 * syntax. Slack's own shortcuts -- *bold*, _italic_, ~strike~ -- alongside the
 * stored syntax's **bold**, ~~strike~~ and ++underline++. A single * is bold
 * here, as in Slack, so italics are underscores only.
 */
const singleStarInput = /(?:^|\s)(\*(?!\s)([^*]+?)(?<!\s)\*)$/;
const singleStarPaste = /(?:^|\s)(\*(?!\s)([^*]+?)(?<!\s)\*)/g;
const singleTildeInput = /(?:^|\s)(~(?!\s)([^~]+?)(?<!\s)~)$/;
const singleTildePaste = /(?:^|\s)(~(?!\s)([^~]+?)(?<!\s)~)/g;
const plusInput = /(?:^|\s)(\+\+(?!\s)([^+]+?)(?<!\s)\+\+)$/;
const plusPaste = /(?:^|\s)(\+\+(?!\s)([^+]+?)(?<!\s)\+\+)/g;

const MessageBold = Bold.extend({
  addInputRules() {
    return [...(this.parent?.() ?? []), markInputRule({ find: singleStarInput, type: this.type })];
  },
  addPasteRules() {
    return [...(this.parent?.() ?? []), markPasteRule({ find: singleStarPaste, type: this.type })];
  },
});

const MessageItalic = Italic.extend({
  addInputRules() {
    return [markInputRule({ find: underscoreInputRegex, type: this.type })];
  },
  addPasteRules() {
    return [markPasteRule({ find: underscorePasteRegex, type: this.type })];
  },
});

const MessageStrike = Strike.extend({
  addInputRules() {
    return [...(this.parent?.() ?? []), markInputRule({ find: singleTildeInput, type: this.type })];
  },
  addPasteRules() {
    return [...(this.parent?.() ?? []), markPasteRule({ find: singleTildePaste, type: this.type })];
  },
});

const MessageUnderline = Underline.extend({
  addInputRules() {
    return [markInputRule({ find: plusInput, type: this.type })];
  },
  addPasteRules() {
    return [markPasteRule({ find: plusPaste, type: this.type })];
  },
});

/** Typing [text](address) turns it into a link to that address, showing only the text. */
const LinkShortcut = Extension.create({
  name: "linkShortcut",
  addInputRules() {
    return [
      new InputRule({
        find: /\[([^\]]+)\]\(([^)\s]+)\)$/,
        handler: ({ state, range, match }) => {
          const [, text = "", raw = ""] = match;
          const href = normalizeHref(raw);
          const link = state.schema.marks.link;
          if (!link || !isSafeHref(href)) return null;
          state.tr.replaceWith(
            range.from,
            range.to,
            state.schema.text(text, [link.create({ href })])
          );
          // What comes next is typed plain, not as more of the link.
          state.tr.removeStoredMark(link);
        },
      }),
    ];
  },
});

export default function RichComposerEditor({
  value,
  onChange,
  members,
  placeholder,
  ariaLabel,
  maxLength,
  autoFocus = false,
  focusToken,
  onSubmit,
  onEditor,
  onFocus,
}: {
  /** The body, in lib/richText.ts syntax. */
  value: string;
  onChange: (value: string) => void;
  members: GroupMemberDto[];
  placeholder: string;
  ariaLabel: string;
  /** The longest body allowed; an edit that would pass it is refused. */
  maxLength: number;
  autoFocus?: boolean;
  /** Focus (caret at the end) whenever this changes -- for text put in the box from outside. */
  focusToken?: unknown;
  /** Enter on a desktop sends. The mention list keeps Enter while it is open. */
  onSubmit: () => void;
  /** The editor, once it exists, for the formatting buttons and emoji. */
  onEditor?: (editor: Editor | null) => void;
  onFocus?: () => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  /** What the editor last reported, so a `value` it produced is not pushed back in. */
  const lastEmitted = useRef(value);

  // The plugins are made once; these keep their callbacks on the latest render.
  const latest = useRef({ onChange, onSubmit, onFocus, maxLength });
  latest.current = { onChange, onSubmit, onFocus, maxLength };

  // "@everyone" leads the list while what's typed could still become it, and
  // only when there is someone besides the writer for it to reach.
  const matches: MentionOption[] =
    mention === null
      ? []
      : [
          ...(members.length > 0 && GROUP_MENTION_EVERYONE.startsWith(mention.query.toLowerCase())
            ? [{ kind: "everyone" } as const]
            : []),
          ...members
            .filter((m) => m.name.toLowerCase().includes(mention.query.toLowerCase()))
            .slice(0, 6)
            .map((member) => ({ kind: "member", member }) as const),
        ];
  const mentionRef = useRef({ mention, matches, highlighted });
  mentionRef.current = { mention, matches, highlighted };

  function pick(editor: Editor, option: MentionOption): void {
    const current = mentionRef.current.mention;
    if (!current) return;
    const name = option.kind === "everyone" ? GROUP_MENTION_EVERYONE : option.member.name;
    // Literal text, not a mention node: the body says "@Name" and the mention
    // is read back out of it (see GroupDetail's @ mentions).
    editor
      .chain()
      .focus()
      .insertContentAt(current.range, [{ type: "text", text: `@${name} ` }])
      .run();
    setMention(null);
  }
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const editorRef = useRef<Editor | null>(null);

  const editor = useEditor({
    autofocus: autoFocus ? "end" : false,
    content: bodyToDoc(value),
    extensions: [
      StarterKit.configure({
        // Its empty line after a list stays behind when the list is undone,
        // leaving a blank box two lines tall.
        trailingNode: false,
        heading: false,
        blockquote: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        bold: false,
        italic: false,
        strike: false,
        underline: false,
        link: { openOnClick: false, autolink: false, linkOnPaste: true },
      }),
      MessageBold,
      MessageItalic,
      MessageStrike,
      MessageUnderline,
      LinkShortcut,
      Extension.create({
        name: "messageKeys",
        // Ahead of the lists' own Enter, so Enter on a desktop sends from a list too.
        priority: 150,
        addKeyboardShortcuts() {
          const newLine = () =>
            this.editor.commands.first(({ commands }) => [
              () => commands.splitListItem("listItem"),
              () => commands.liftEmptyBlock(),
              () => commands.splitBlock(),
            ]);
          return {
            Enter: () => {
              if (this.editor.view.composing || isTouchDevice()) return false;
              latest.current.onSubmit();
              return true;
            },
            "Shift-Enter": newLine,
          };
        },
        addProseMirrorPlugins() {
          return [
            new Plugin({
              // An edit that would make the body longer than the server takes.
              filterTransaction: (tr, state) =>
                !tr.docChanged ||
                tr.doc.content.size <= state.doc.content.size ||
                docToBody(tr.doc.toJSON() as DocNode).length <= latest.current.maxLength,
            }),
          ];
        },
      }),
      Extension.create({
        name: "mentionPicker",
        // The open list owns the arrows and Enter, so it goes first of all.
        priority: 200,
        addProseMirrorPlugins() {
          return [
            Suggestion({
              editor: this.editor,
              pluginKey: mentionKey,
              char: "@",
              items: () => [],
              render: () => {
                const show = (props: SuggestionProps) => {
                  setMention({
                    query: props.query,
                    range: props.range,
                    rect: props.clientRect?.() ?? null,
                  });
                };
                return {
                  onStart: (props) => {
                    setHighlighted(0);
                    show(props);
                  },
                  onUpdate: (props) => {
                    setHighlighted(0);
                    show(props);
                  },
                  onExit: () => setMention(null),
                  onKeyDown: ({ event, view }) => {
                    const { matches: options, highlighted: index } = mentionRef.current;
                    if (options.length === 0) return false;
                    if (event.key === "ArrowDown") {
                      setHighlighted((h) => (h + 1) % options.length);
                      return true;
                    }
                    if (event.key === "ArrowUp") {
                      setHighlighted((h) => (h - 1 + options.length) % options.length);
                      return true;
                    }
                    if (event.key === "Enter" || event.key === "Tab") {
                      pickRef.current(this.editor, options[index]!);
                      return true;
                    }
                    if (event.key === "Escape") {
                      // Closes the list only; not whatever surrounds this box (a reply, an edit).
                      event.stopPropagation();
                      exitSuggestion(view, mentionKey);
                      return true;
                    }
                    return false;
                  },
                };
              },
            }),
          ];
        },
      }),
    ],
    editorProps: {
      /*
       * Plain text pasted in -- a message copied from elsewhere, or a list typed
       * in Notes -- is read with the same parser that renders messages, so its
       * lists, links and formatting arrive formatted rather than as markers.
       * Anything carrying its own HTML is left to the editor, which keeps its
       * formatting.
       */
      handlePaste: (_view, event) => {
        const data = event.clipboardData;
        const text = data?.getData("text/plain");
        if (!text || data?.getData("text/html")) return false;
        const content = bodyToDoc(text).content ?? [];
        if (content.length === 0) return false;
        // A single line goes into the line where the caret is, not a new one.
        const only = content.length === 1 ? content[0] : null;
        editorRef.current
          ?.chain()
          .focus()
          .insertContent(only?.type === "paragraph" ? (only.content ?? []) : content)
          .run();
        return true;
      },
      attributes: {
        role: "textbox",
        "aria-label": ariaLabel,
        "aria-multiline": "true",
        class:
          "block max-h-40 w-full overflow-y-auto px-1 py-2.5 text-ink outline-none [&_a]:text-accent [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6",
      },
    },
    onUpdate: ({ editor: current }) => {
      const body = docToBody(current.getJSON() as DocNode);
      lastEmitted.current = body;
      latest.current.onChange(body);
    },
    onFocus: () => latest.current.onFocus?.(),
    onBlur: () => window.setTimeout(() => setMention(null), 150),
  });

  editorRef.current = editor;

  // The label follows the bar: "Message", "Reply", or "Edit message".
  useEffect(() => {
    editor?.setOptions({
      editorProps: {
        attributes: { ...editor.options.editorProps.attributes, "aria-label": ariaLabel },
      },
    });
  }, [editor, ariaLabel]);

  useEffect(() => {
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);

  // A body from outside -- cleared after sending, a message to edit, a draft
  // coming back -- replaces what is in the box.
  useEffect(() => {
    if (!editor || value === lastEmitted.current) return;
    lastEmitted.current = value;
    editor.commands.setContent(bodyToDoc(value), { emitUpdate: false });
    // Typing carries on from the end of it -- a message opened for editing
    // arrives a render after the focus asked for it, so that focus's caret is gone.
    editor.commands.setTextSelection(editor.state.doc.content.size);
  }, [editor, value]);

  useEffect(() => {
    if (focusToken === undefined || !editor) return;
    editor.commands.focus("end");
  }, [editor, focusToken]);

  // Empty means a single blank line: a list started but not yet typed in has
  // its bullet or number where the placeholder would be.
  const isEmpty = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const doc = e?.state.doc;
      if (!doc) return true;
      const only = doc.childCount === 1 ? doc.firstChild : null;
      return only?.type.name === "paragraph" && only.content.size === 0;
    },
  });
  const wrapperBox = wrapperRef.current?.getBoundingClientRect();

  return (
    <div ref={wrapperRef} className="relative min-w-0 flex-1">
      <EditorContent editor={editor} />
      {/* Drawn here, on one line, rather than by the editor: a long group name
          ellipsises instead of wrapping the empty box to two lines. */}
      {isEmpty && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 truncate px-1 py-2.5 text-ink-muted"
        >
          {placeholder}
        </span>
      )}
      {editor && mention && matches.length > 0 && (
        <ul
          className="absolute z-20 max-h-48 w-56 overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-lg"
          style={{
            bottom: wrapperBox && mention.rect ? wrapperBox.bottom - mention.rect.top : "100%",
            left: wrapperBox && mention.rect ? Math.max(0, mention.rect.left - wrapperBox.left) : 0,
          }}
        >
          {matches.map((option, index) => (
            <li key={option.kind === "everyone" ? "@everyone" : option.member.appUserId}>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(editor, option);
                }}
                className={`block w-full px-3 py-1.5 text-left text-sm ${
                  index === highlighted ? "bg-surface-muted text-primary" : "text-ink"
                }`}
              >
                {option.kind === "everyone" ? (
                  <>
                    @{GROUP_MENTION_EVERYONE}
                    <span className="block text-xs text-ink-muted">
                      Notify everyone in this group
                    </span>
                  </>
                ) : (
                  option.member.name
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Aa row
// ---------------------------------------------------------------------------

function FormatIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const FORMAT_ICONS = {
  bold: (
    <FormatIcon>
      <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" strokeWidth="2.5" />
    </FormatIcon>
  ),
  italic: (
    <FormatIcon>
      <path d="M11 5h6M7 19h6M14 5l-4 14" />
    </FormatIcon>
  ),
  underline: (
    <FormatIcon>
      <path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14" />
    </FormatIcon>
  ),
  strike: (
    <FormatIcon>
      <path d="M4 12h16M16.5 7.5A4 3 0 0 0 12 5c-2.5 0-4 1.3-4 3 0 1.2.8 2.2 2.5 2.8M8 16.5c.6 1.5 2.2 2.5 4 2.5 2.4 0 4-1.3 4-3 0-.9-.4-1.7-1.2-2.3" />
    </FormatIcon>
  ),
  link: (
    <FormatIcon>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </FormatIcon>
  ),
  orderedList: (
    <FormatIcon>
      <path d="M10 6h10M10 12h10M10 18h10" />
      <path
        d="M4 5l1.5-1v5M3.5 14.5c.3-.6.9-1 1.6-1 .8 0 1.4.5 1.4 1.2 0 1.3-3 2.3-3 3.8h3"
        strokeWidth="1.5"
      />
    </FormatIcon>
  ),
  bulletList: (
    <FormatIcon>
      <path d="M10 6h10M10 12h10M10 18h10" />
      <circle cx="4.5" cy="6" r="1" fill="currentColor" />
      <circle cx="4.5" cy="12" r="1" fill="currentColor" />
      <circle cx="4.5" cy="18" r="1" fill="currentColor" />
    </FormatIcon>
  ),
};

type FormatName = keyof typeof FORMAT_ICONS;

const FORMATS: { name: FormatName; label: string }[] = [
  { name: "bold", label: "Bold" },
  { name: "italic", label: "Italic" },
  { name: "underline", label: "Underline" },
  { name: "strike", label: "Strikethrough" },
  { name: "link", label: "Link" },
  { name: "orderedList", label: "Numbered list" },
  { name: "bulletList", label: "Bulleted list" },
];

function applyFormat(editor: Editor, name: Exclude<FormatName, "link">): void {
  const chain = editor.chain().focus();
  if (name === "bold") chain.toggleBold().run();
  else if (name === "italic") chain.toggleItalic().run();
  else if (name === "underline") chain.toggleUnderline().run();
  else if (name === "strike") chain.toggleStrike().run();
  else if (name === "orderedList") chain.toggleOrderedList().run();
  else chain.toggleBulletList().run();
}

/** "example.org" means https://example.org; an address with @ means mail. */
function normalizeHref(raw: string): string {
  const href = raw.trim();
  if (/^(https?:\/\/|mailto:)/i.test(href)) return href;
  if (/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(href)) return `mailto:${href}`;
  return `https://${href}`;
}

/**
 * Bold through bulleted list, as toggles that light up while the caret is in
 * text that has them. Pressing one never takes focus from the text, so the
 * selection it applies to is still there.
 */
export function FormatButtons({ editor }: { editor: Editor | null }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      Object.fromEntries(FORMATS.map(({ name }) => [name, e?.isActive(name) ?? false])) as Record<
        FormatName,
        boolean
      >,
  });
  const [linking, setLinking] = useState<{ text: string; href: string } | null>(null);

  function startLink(): void {
    if (!editor) return;
    if (editor.isActive("link")) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const { from, to } = editor.state.selection;
    setLinking({ text: editor.state.doc.textBetween(from, to, " "), href: "" });
  }

  function saveLink(): void {
    if (!editor || !linking || linking.href.trim() === "") return;
    const href = normalizeHref(linking.href);
    const text = linking.text.trim() || linking.href.trim();
    editor
      .chain()
      .focus()
      .insertContent({ type: "text", text, marks: [{ type: "link", attrs: { href } }] })
      .unsetMark("link")
      .run();
    setLinking(null);
  }

  return (
    <>
      {FORMATS.map(({ name, label }) => (
        <button
          key={name}
          type="button"
          aria-label={label}
          aria-pressed={active?.[name] ?? false}
          disabled={!editor}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (!editor) return;
            if (name === "link") startLink();
            else applyFormat(editor, name);
          }}
          className={`inline-flex h-9 w-8 shrink-0 items-center justify-center rounded-md transition hover:bg-surface-muted sm:w-9 ${
            active?.[name] ? "bg-surface-muted text-primary" : "text-ink-muted hover:text-ink"
          }`}
        >
          {FORMAT_ICONS[name]}
        </button>
      ))}
      {linking && (
        <Modal title="Add a link" onClose={() => setLinking(null)}>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              saveLink();
            }}
          >
            <Field label="Text">
              <input
                className={inputClass}
                value={linking.text}
                onChange={(event) => setLinking({ ...linking, text: event.target.value })}
              />
            </Field>
            <Field label="Link">
              <input
                className={inputClass}
                type="url"
                inputMode="url"
                autoFocus
                placeholder="https://"
                value={linking.href}
                onChange={(event) => setLinking({ ...linking, href: event.target.value })}
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" disabled={linking.href.trim() === ""}>
                Save
              </Button>
              <Button variant="ghost" onClick={() => setLinking(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
