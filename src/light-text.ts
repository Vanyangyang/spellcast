/**
 * A deliberately small Markdown view. It never persists or rewrites the source
 * string: editors continue to own the original Markdown text.
 *
 * Marked is used only as a tokenizer. Every visible node is created here with
 * DOM APIs so untrusted HTML is always rendered as text rather than executed.
 */
import { marked, type Token, type Tokens } from "marked";
import "./light-text.css";

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textNodes(text: string): Node[] {
  return text ? [document.createTextNode(text)] : [];
}

function tokenText(token: Token): string {
  const candidate = token as { raw?: unknown; text?: unknown };
  if (typeof candidate.raw === "string") return candidate.raw;
  return typeof candidate.text === "string" ? candidate.text : "";
}

function inlineNodes(tokens: Token[] | undefined, fallback: string): Node[] {
  if (!tokens?.length) return textNodes(fallback);
  return tokens.flatMap(renderInlineToken);
}

function appendInline(host: HTMLElement, tokens: Token[] | undefined, fallback: string): void {
  host.append(...inlineNodes(tokens, fallback));
}

function safeHref(rawHref: string): string | null {
  // Reject control characters before URL normalisation can discard them.
  if (!rawHref || /[\u0000-\u001F\u007F]/.test(rawHref)) return null;
  const href = rawHref.trim();
  if (!href) return null;

  try {
    const parsed = new URL(href);
    return ALLOWED_LINK_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function renderInlineToken(token: Token): Node[] {
  switch (token.type) {
    case "text": {
      const text = token as Tokens.Text;
      return inlineNodes(text.tokens, text.text);
    }
    case "escape":
      return textNodes((token as Tokens.Escape).text);
    case "strong": {
      const strong = token as Tokens.Strong;
      const node = element("strong", "light-text-strong");
      appendInline(node, strong.tokens, strong.text);
      return [node];
    }
    case "em": {
      const em = token as Tokens.Em;
      const node = element("em", "light-text-em");
      appendInline(node, em.tokens, em.text);
      return [node];
    }
    case "codespan": {
      const code = element("code", "light-text-inline-code");
      code.textContent = (token as Tokens.Codespan).text;
      return [code];
    }
    case "br":
      return [element("br", "light-text-break")];
    case "del": {
      const del = token as Tokens.Del;
      const node = element("s", "light-text-strike");
      appendInline(node, del.tokens, del.text);
      return [node];
    }
    case "link": {
      const link = token as Tokens.Link;
      const href = safeHref(link.href);
      if (!href) return inlineNodes(link.tokens, link.text);

      const node = element("a", "light-text-link");
      node.setAttribute("href", href);
      node.setAttribute("rel", "noopener noreferrer");
      if (href.startsWith("http:") || href.startsWith("https:")) node.setAttribute("target", "_blank");
      appendInline(node, link.tokens, link.text);
      return [node];
    }
    case "image":
      // Deliberately keep only the textual alternative; never create a loading element.
      return textNodes((token as Tokens.Image).text);
    case "html":
      // Raw HTML is content, never a DOM instruction.
      return textNodes(tokenText(token));
    default:
      return textNodes(tokenText(token));
  }
}

function paragraph(tokens: Token[] | undefined, fallback: string, extraClass?: string): HTMLParagraphElement {
  const className = extraClass ? "light-text-paragraph " + extraClass : "light-text-paragraph";
  const node = element("p", className);
  appendInline(node, tokens, fallback);
  return node;
}

function listItem(item: Tokens.ListItem): HTMLLIElement {
  const node = element("li", "light-text-list-item");
  const first = item.tokens[0];
  const isSingleInlineBlock = item.tokens.length === 1 && (first?.type === "text" || first?.type === "paragraph");

  if (isSingleInlineBlock && first) {
    const inline = first as Tokens.Text | Tokens.Paragraph;
    appendInline(node, inline.tokens, inline.text);
  } else {
    const children = renderBlocks(item.tokens);
    if (children.length) node.append(...children);
    else node.append(...textNodes(item.text));
  }
  return node;
}

function list(token: Tokens.List): HTMLOListElement | HTMLUListElement {
  if (token.ordered) {
    const node = element("ol", "light-text-list");
    if (typeof token.start === "number" && Number.isInteger(token.start) && token.start > 0 && token.start !== 1) {
      node.start = token.start;
    }
    node.append(...token.items.map(listItem));
    return node;
  }

  const node = element("ul", "light-text-list");
  node.append(...token.items.map(listItem));
  return node;
}

function codeBlock(token: Tokens.Code): HTMLPreElement {
  const pre = element("pre", "light-text-code-block");
  const code = element("code", "light-text-code");
  code.textContent = token.text;
  pre.append(code);
  return pre;
}

function renderBlocks(tokens: Token[]): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "space":
      case "def":
      case "hr":
        break;
      case "paragraph": {
        const paragraphToken = token as Tokens.Paragraph;
        nodes.push(paragraph(paragraphToken.tokens, paragraphToken.text));
        break;
      }
      case "heading": {
        // This renderer has no title slot; retain the content as light body text.
        const heading = token as Tokens.Heading;
        nodes.push(paragraph(heading.tokens, heading.text, "light-text-heading"));
        break;
      }
      case "text": {
        const text = token as Tokens.Text;
        nodes.push(paragraph(text.tokens, text.text));
        break;
      }
      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        const blockquote = element("blockquote", "light-text-quote");
        const children = renderBlocks(quote.tokens);
        if (children.length) blockquote.append(...children);
        else blockquote.append(...textNodes(quote.text));
        nodes.push(blockquote);
        break;
      }
      case "list":
        nodes.push(list(token as Tokens.List));
        break;
      case "code":
        nodes.push(codeBlock(token as Tokens.Code));
        break;
      case "html":
        nodes.push(paragraph(undefined, tokenText(token), "light-text-raw"));
        break;
      default: {
        const fallback = tokenText(token);
        if (fallback) nodes.push(paragraph(undefined, fallback, "light-text-raw"));
      }
    }
  }
  return nodes;
}

/** Renders a safe, display-only subset of Markdown into an existing host. */
export function renderLightText(host: HTMLElement, text: string): void {
  host.classList.add("light-text");
  try {
    host.replaceChildren(...renderBlocks(marked.lexer(text, { gfm: true, breaks: false })));
  } catch {
    // A malformed tokenizer input still remains inert, readable text.
    host.replaceChildren(paragraph(undefined, text, "light-text-raw"));
  }
}
