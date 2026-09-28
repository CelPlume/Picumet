// F-01（LAB_TEST_REPORT_2026-09-26）：@aws-sdk/xml-builder 的 package.json `browser` 字段把
// parseXML 指到 xml-parser.browser.js（基于 DOMParser），wrangler/esbuild 按 browser 条件打包，
// 而 workerd **没有 DOMParser** —— CreateMultipartUpload / CompleteMultipartUpload / CopyObject /
// ListParts / ListObjectsV2 / DeleteObjects 等一切需要解析 XML 响应的 S3 调用全部抛
// `DOMParser is not defined`（多存储下大文件上传与移动/改名不可用）。
//
// 本文件是官方包纯 JS 实现（dist-es 的 node 构建，368 行，零平台 API）的 vendored 副本，
// 通过 wrangler.toml `[alias]` 与 vitest resolve.alias 整包替换 `@aws-sdk/xml-builder`。
// 导出面与官方 index 一致：{ XmlNode, XmlText, parseXML }。
// 升级 @aws-sdk/client-s3 时如上游解析器有行为变更，需同步本文件（版本锚定 package.json ^3.700）。

/** @internal Stringable 契约（官方 dist-types/stringable.d.ts） */
interface Stringable {
  toString(): string;
}

const ATTR_ESCAPE_RE = /[&<>"]/g;
const ATTR_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};
export function escapeAttribute(value: string): string {
  return value.replace(ATTR_ESCAPE_RE, (ch) => ATTR_ESCAPE_MAP[ch]);
}

const ELEMENT_ESCAPE_RE = /[&"'<>\r\n\u0085\u2028]/g;
const ELEMENT_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  '"': "&quot;",
  "'": "&apos;",
  "<": "&lt;",
  ">": "&gt;",
  "\r": "&#x0D;",
  "\n": "&#x0A;",
  "": "&#85;",
  " ": "&#2028;",
};
export function escapeElement(value: string): string {
  return value.replace(ELEMENT_ESCAPE_RE, (ch) => ELEMENT_ESCAPE_MAP[ch]);
}

export class XmlText implements Stringable {
  value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return escapeElement(`${this.value}`);
  }
}

export class XmlNode implements Stringable {
  private name: string;
  readonly children: Stringable[];
  private attributes: Record<string, unknown> = {};

  static of(name: string, childText?: string, withName?: string): XmlNode {
    const node = new XmlNode(name);
    if (childText !== undefined) {
      node.addChildNode(new XmlText(childText));
    }
    if (withName !== undefined) {
      node.withName(withName);
    }
    return node;
  }

  constructor(name: string, children: Stringable[] = []) {
    this.name = name;
    this.children = children;
  }

  withName(name: string): XmlNode {
    this.name = name;
    return this;
  }

  addAttribute(name: string, value: unknown): XmlNode {
    this.attributes[name] = value;
    return this;
  }

  addChildNode(child: Stringable): XmlNode {
    this.children.push(child);
    return this;
  }

  removeAttribute(name: string): XmlNode {
    delete this.attributes[name];
    return this;
  }

  n(name: string): XmlNode {
    this.name = name;
    return this;
  }

  c(child: Stringable): XmlNode {
    this.children.push(child);
    return this;
  }

  a(name: string, value: unknown): XmlNode {
    if (value != null) {
      this.attributes[name] = value;
    }
    return this;
  }

  cc(input: unknown, field: string, withName: string = field): void {
    const record = input as Record<string, unknown>;
    if (record[field] != null) {
      const node = XmlNode.of(field, record[field] as string).withName(withName);
      this.c(node);
    }
  }

  l(
    input: unknown,
    listName: string,
    memberName: string,
    valueProvider: () => XmlNode[]
  ): void {
    const record = input as Record<string, unknown>;
    if (record[listName] != null) {
      const nodes = valueProvider();
      nodes.map((node) => {
        node.withName(memberName);
        this.c(node);
      });
    }
  }

  lc(
    input: unknown,
    listName: string,
    memberName: string,
    valueProvider: () => XmlNode[]
  ): void {
    const record = input as Record<string, unknown>;
    if (record[listName] != null) {
      const nodes = valueProvider();
      const containerNode = new XmlNode(memberName);
      nodes.map((node) => {
        containerNode.c(node);
      });
      this.c(containerNode);
    }
  }

  toString(): string {
    const hasChildren = Boolean(this.children.length);
    let xmlText = `<${this.name}`;
    const attributes = this.attributes;
    for (const attributeName of Object.keys(attributes)) {
      const attribute = attributes[attributeName];
      if (attribute != null) {
        xmlText += ` ${attributeName}="${escapeAttribute(`${attribute}`)}"`;
      }
    }
    return (xmlText += !hasChildren
      ? "/>"
      : `>${this.children.map((c) => c.toString()).join("")}</${this.name}>`);
  }
}

/**
 * AWS SDK XML to object converter（纯 JS 实现，无 DOMParser）。
 * @internal
 */
export function parseXML(xml: string): unknown {
  const state = new AwsXmlParser(xml);
  return state.parse();
}

function writeKey(obj: Record<string, unknown>): void {
  Object.defineProperty(obj, "__proto__", { value: undefined, writable: true, enumerable: true, configurable: true });
}

class AwsXmlParser {
  x: string;
  i = 0;
  z: number;

  constructor(x: string) {
    this.x = x.replace(/\r\n?/g, "\n");
    this.z = this.x.length;
  }

  parse(): unknown {
    const p = this;
    const { z } = p;
    while (p.i < z) {
      p.trim();
      if (p.i >= z) {
        break;
      }
      if (p.isNext("<?")) {
        p.readTo("?>");
        p.trim();
      } else if (p.isNext("<!--")) {
        p.readTo("-->");
        p.trim();
      } else if (p.isNext("<!DOCTYPE", false)) {
        p.skipDoctype();
        p.trim();
      } else if (p.x[p.i] === "<") {
        const root = p.parseTag();
        return { [root.tag]: root.value };
      } else {
        throw new Error("@aws-sdk XML parse error: unexpected content.");
      }
    }
    throw new Error("@aws-sdk XML parse error: no root element.");
  }

  isNext(s: string, caseSensitive = true): boolean {
    const p = this;
    if (caseSensitive) {
      return p.x.startsWith(s, p.i);
    }
    return p.x.toLowerCase().startsWith(s.toLowerCase(), p.i);
  }

  readTo(stop: string): string {
    const p = this;
    const _i = p.x.indexOf(stop, p.i);
    if (_i === -1) {
      throw new Error(`@aws-sdk XML parse error: expected "${stop}" not found.`);
    }
    const result = p.x.slice(p.i, _i);
    p.i = _i + stop.length;
    return result;
  }

  trim(): void {
    const p = this;
    while (p.i < p.z && " \t\r\n".includes(p.x[p.i])) {
      ++p.i;
    }
  }

  readAttrValue(): string {
    const p = this;
    const quote = p.x[p.i];
    ++p.i;
    let value = "";
    while (p.i < p.z && p.x[p.i] !== quote) {
      value += p.x[p.i++];
    }
    ++p.i;
    return p.decodeEntities(value);
  }

  parseTag(): { tag: string; value: unknown } {
    const p = this;
    ++p.i;
    let tag = "";
    while (p.i < p.z && !" \t\r\n>/".includes(p.x[p.i])) {
      tag += p.x[p.i++];
    }
    let hasAttrs = false;
    const attrs: Record<string, string> = {};
    while (p.i < p.z) {
      p.trim();
      if (">/".includes(p.x[p.i])) {
        break;
      }
      let name = "";
      while (p.i < p.z && !"= \t\r\n>/?".includes(p.x[p.i])) {
        name += p.x[p.i++];
      }
      p.trim();
      if (p.x[p.i] !== "=") {
        break;
      }
      ++p.i;
      p.trim();
      if (name === "__proto__") {
        writeKey(attrs);
      }
      attrs[name] = p.readAttrValue();
      hasAttrs = true;
    }
    if (p.i >= p.z) {
      throw new Error("@aws-sdk XML parse error: unexpected end of input.");
    }
    if (p.x[p.i] === "/") {
      ++p.i;
      if (p.i >= p.z || p.x[p.i] !== ">") {
        throw new Error("@aws-sdk XML parse error: expected > at the end of self-closing tag.");
      }
      ++p.i;
      return { tag, value: hasAttrs ? attrs : "" };
    }
    if (p.x[p.i] !== ">") {
      throw new Error("@aws-sdk XML parse error: expected > at the end of opening tag.");
    }
    ++p.i;
    const textParts: string[] = [];
    const childTags: Array<{ tag: string; value: unknown }> = [];
    let hasElementChild = false;
    while (p.i < p.z) {
      if (p.isNext("</")) {
        break;
      }
      if (p.x[p.i] === "<") {
        if (p.isNext("<!--")) {
          p.readTo("-->");
        } else if (p.isNext("<![CDATA[")) {
          p.i += 9;
          textParts.push(p.readTo("]]>"));
        } else if (p.isNext("<?")) {
          p.readTo("?>");
        } else {
          hasElementChild = true;
          childTags.push(p.parseTag());
        }
      } else {
        let text = "";
        while (p.i < p.z && p.x[p.i] !== "<") {
          text += p.x[p.i++];
        }
        textParts.push(p.decodeEntities(text));
      }
    }
    if (!p.isNext("</")) {
      throw new Error(`@aws-sdk XML parse error: missing closing tag </${tag}>.`);
    }
    p.i += 2;
    const closeTag = p.readTo(">").trim();
    if (closeTag !== tag) {
      throw new Error(`@aws-sdk XML parse error: mismatched tags <${tag}> and </${closeTag}>.`);
    }
    if (!hasAttrs && textParts.length === 0 && !hasElementChild) {
      return { tag, value: "" };
    }
    if (!hasAttrs && !hasElementChild) {
      const text = textParts.length === 1 ? textParts[0] : textParts.join("");
      if (text.trim() === "" && text.includes("\n")) {
        return { tag, value: "" };
      }
      return { tag, value: text };
    }
    const obj: Record<string, unknown> = {};
    for (const text of textParts) {
      if (text.trim() === "" && text.includes("\n")) {
        continue;
      }
      obj["#text"] = "#text" in obj ? (obj["#text"] as string) + text : text;
    }
    for (const child of childTags) {
      if (child.tag === "__proto__") {
        writeKey(obj);
      }
      if (child.tag in obj) {
        if (Array.isArray(obj[child.tag])) {
          (obj[child.tag] as unknown[]).push(child.value);
        } else {
          obj[child.tag] = [obj[child.tag], child.value];
        }
      } else {
        obj[child.tag] = child.value;
      }
    }
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "__proto__") {
        writeKey(obj);
      }
      obj[k] = v;
    }
    return { tag, value: obj };
  }

  static ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };

  skipDoctype(): void {
    const p = this;
    p.i += 9;
    let depth = 0;
    while (p.i < p.z) {
      const c = p.x[p.i];
      if (c === "[") {
        ++depth;
      } else if (c === "]") {
        --depth;
      } else if (c === ">" && depth === 0) {
        ++p.i;
        return;
      }
      ++p.i;
    }
    throw new Error("@aws-sdk XML parse error: unclosed DOCTYPE.");
  }

  decodeEntities(s: string): string {
    return s.replace(/&(?:#x([0-9a-fA-F]{1,6})|#(\d{1,7})|([a-zA-Z][a-zA-Z0-9]{0,30}));/g, (_, hex, dec, named) => {
      if (hex) {
        return String.fromCharCode(parseInt(hex, 16));
      }
      if (dec) {
        return String.fromCharCode(parseInt(dec, 10));
      }
      return AwsXmlParser.ENTITIES[named] ?? "";
    });
  }
}
