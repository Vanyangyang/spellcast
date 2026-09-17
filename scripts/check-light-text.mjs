import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const rendererPath = path.join(root, "src", "light-text.ts");
const cssPath = path.join(root, "src", "light-text.css");

class FakeNode {
  children = [];
  parentNode = null;
  #text = "";

  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === "string" ? new FakeText(node) : node;
      child.parentNode = this;
      this.children.push(child);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.#text = "";
    this.append(...nodes);
  }

  get textContent() {
    return this.#text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this.#text = String(value ?? "");
    this.children = [];
  }
}

class FakeText extends FakeNode {
  constructor(text) {
    super();
    this.textContent = text;
  }
}

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
  }

  add(...tokens) {
    const names = new Set(this.owner.className.split(/\s+/).filter(Boolean));
    tokens.forEach((token) => names.add(token));
    this.owner.className = [...names].join(" ");
  }

  contains(token) {
    return this.owner.className.split(/\s+/).includes(token);
  }
}

class FakeElement extends FakeNode {
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    this.className = "";
    this.attributes = new Map();
    this.classList = new FakeClassList(this);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

class FakeDocument {
  createElement(tagName) {
    return new FakeElement(tagName);
  }

  createTextNode(text) {
    return new FakeText(text);
  }
}

function elements(rootNode, tagName) {
  const matches = [];
  for (const child of rootNode.children) {
    if (child instanceof FakeElement && child.tagName === tagName) matches.push(child);
    matches.push(...elements(child, tagName));
  }
  return matches;
}

const temp = await mkdtemp(path.join(tmpdir(), "spellcast-light-text-"));
const modulePath = path.join(temp, "light-text.mjs");
const previousDocument = globalThis.document;

try {
  await build({
    entryPoints: [rendererPath],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: modulePath,
    loader: { ".css": "text" },
    logLevel: "silent",
  });

  globalThis.document = new FakeDocument();
  const { renderLightText } = await import(pathToFileURL(modulePath).href);
  const host = document.createElement("section");
  host.textContent = "old content";
  const backtick = String.fromCharCode(96);
  const source = [
    "A **bold** *italic* [safe](https://example.com/docs?q=1) [mail](mailto:hello@example.com) and " + backtick + "code" + backtick + ".",
    "",
    "> A quoted sentence.",
    "",
    "- first item",
    "- second item",
    "",
    "3. ordered item",
    "4. another item",
    "",
    backtick.repeat(3) + "ts",
    "const value = '<safe>';",
    backtick.repeat(3),
    "",
    "<img src=\"https://bad.example/image.png\"> <script>alert('x')</script>",
    "",
    "[script](javascript:alert(1)) [data](data:text/plain,no) [file](file:///secret)",
  ].join("\n");

  renderLightText(host, source);

  assert.equal(host.classList.contains("light-text"), true);
  assert.equal(host.textContent.includes("old content"), false, "render should replace the previous view");
  assert.equal(elements(host, "P").length >= 2, true, "paragraphs should be rendered");
  assert.equal(elements(host, "STRONG").length, 1, "strong Markdown should be structural");
  assert.equal(elements(host, "EM").length, 1, "emphasis Markdown should be structural");
  assert.equal(elements(host, "BLOCKQUOTE").length, 1, "quotes should be structural");
  assert.equal(elements(host, "UL").length, 1, "unordered lists should be structural");
  assert.equal(elements(host, "OL").length, 1, "ordered lists should be structural");
  assert.equal(elements(host, "OL")[0].start, 3, "ordered list start should be retained");
  assert.equal(elements(host, "PRE").length, 1, "fenced code should use a pre block");
  assert.equal(elements(host, "CODE").length >= 2, true, "inline and fenced code should use code elements");

  const links = elements(host, "A");
  assert.deepEqual(links.map((link) => link.getAttribute("href")), ["https://example.com/docs?q=1", "mailto:hello@example.com"]);
  assert.equal(elements(host, "IMG").length, 0, "images must never be created");
  for (const forbidden of ["SCRIPT", "IFRAME", "VIDEO", "AUDIO", "OBJECT", "EMBED", "SOURCE"]) {
    assert.equal(elements(host, forbidden).length, 0, forbidden.toLowerCase() + " must never be created");
  }
  assert.equal(host.textContent.includes("<img src=\"https://bad.example/image.png\">"), true, "raw HTML should remain inert text");
  assert.equal(source.includes("javascript:alert(1)"), true, "the caller-owned source string must remain unchanged");

  const [rendererSource, css] = await Promise.all([readFile(rendererPath, "utf8"), readFile(cssPath, "utf8")]);
  assert.doesNotMatch(rendererSource, /\binnerHTML\b/, "the renderer must not use HTML parsing sinks");
  assert.doesNotMatch(css, /url\(/i, "the stylesheet must not load remote assets");
  assert.match(css, /\.light-text-code-block[\s\S]*overflow:\s*auto/, "code blocks must remain scrollable inside cards");

  console.log("PASS: light Markdown structures render through DOM nodes; raw HTML, media, and unsafe link schemes stay inert.");
} finally {
  globalThis.document = previousDocument;
  await rm(temp, { recursive: true, force: true });
}
