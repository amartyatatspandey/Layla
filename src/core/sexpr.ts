// Lossless S-expression DOM for KiCad files (.kicad_sch / .kicad_pcb).
// Parses to a tree that can be mutated and serialized back to valid KiCad.

export interface SAtom {
  kind: "atom";
  v: string;
  q: boolean; // was a quoted string
}
export interface SList {
  kind: "list";
  items: SNode[];
}
export type SNode = SAtom | SList;

export function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(6);
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

export function atom(v: string | number, quoted = false): SAtom {
  return { kind: "atom", v: typeof v === "number" ? fmtNum(v) : v, q: quoted };
}
export function str(v: string): SAtom {
  return { kind: "atom", v, q: true };
}
export function sym(v: string): SAtom {
  return { kind: "atom", v, q: false };
}
export function list(...items: SNode[]): SList {
  return { kind: "list", items };
}
export function node(headSym: string, ...rest: SNode[]): SList {
  return { kind: "list", items: [sym(headSym), ...rest] };
}

export function isList(n: SNode | undefined): n is SList {
  return !!n && n.kind === "list";
}
export function isAtom(n: SNode | undefined): n is SAtom {
  return !!n && n.kind === "atom";
}

export function parse(input: string): SList {
  let i = 0;
  const n = input.length;
  function skipWs() {
    while (i < n) {
      const c = input[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else break;
    }
  }
  function parseString(): SAtom {
    i++;
    let out = "";
    while (i < n) {
      const c = input[i];
      if (c === "\\") {
        const nx = input[i + 1];
        if (nx === "n") out += "\n";
        else if (nx === "t") out += "\t";
        else if (nx === "r") out += "\r";
        else out += nx;
        i += 2;
      } else if (c === '"') {
        i++;
        break;
      } else {
        out += c;
        i++;
      }
    }
    return { kind: "atom", v: out, q: true };
  }
  function parseBare(): SAtom {
    const start = i;
    while (i < n) {
      const c = input[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "(" || c === ")") break;
      i++;
    }
    return { kind: "atom", v: input.slice(start, i), q: false };
  }
  function parseList(): SList {
    i++;
    const items: SNode[] = [];
    while (i < n) {
      skipWs();
      const c = input[i];
      if (c === ")") {
        i++;
        break;
      }
      if (c === undefined) break;
      if (c === "(") items.push(parseList());
      else if (c === '"') items.push(parseString());
      else items.push(parseBare());
    }
    return { kind: "list", items };
  }
  skipWs();
  if (input[i] !== "(") throw new Error("expected '(' at start of S-expression");
  return parseList();
}

const QUOTE_ESCAPE = /(["\\\n\t\r])/g;
function quote(s: string): string {
  return (
    '"' +
    s.replace(QUOTE_ESCAPE, (m) =>
      m === "\n" ? "\\n" : m === "\t" ? "\\t" : m === "\r" ? "\\r" : "\\" + m
    ) +
    '"'
  );
}
function atomText(a: SAtom): string {
  if (a.q) return quote(a.v);
  if (a.v === "" || /[\s()"]/.test(a.v)) return quote(a.v);
  return a.v;
}

const INDENT_UNIT = "  ";
const MULTILINE_TAGS = new Set<string>([
  "kicad_pcb", "kicad_sch", "general", "layers", "setup", "pcbplotparams",
  "footprint", "zone", "pts", "polygon", "filled_polygon", "gr_poly", "fp_poly",
  "net_class", "group", "model", "dimension", "stackup", "lib_symbols", "symbol",
  "title_block", "sheet_instances", "symbol_instances",
]);

function isInline(l: SList): boolean {
  const h = isAtom(l.items[0]) ? l.items[0].v : null;
  if (h !== null && MULTILINE_TAGS.has(h)) return false;
  for (const it of l.items) if (isList(it) && it.items.some(isList)) return false;
  return true;
}

export function serialize(root: SNode): string {
  const out: string[] = [];
  function inlineText(n: SNode): string {
    if (isAtom(n)) return atomText(n);
    return "(" + n.items.map(inlineText).join(" ") + ")";
  }
  function emit(nNode: SNode, indent: string) {
    if (isAtom(nNode)) {
      out.push(atomText(nNode));
      return;
    }
    if (isInline(nNode)) {
      out.push("(" + nNode.items.map(inlineText).join(" ") + ")");
      return;
    }
    out.push("(");
    const items = nNode.items;
    let idx = 0;
    while (idx < items.length) {
      const it = items[idx];
      if (!isAtom(it)) break;
      if (idx > 0) out.push(" ");
      out.push(atomText(it));
      idx++;
    }
    const childIndent = indent + INDENT_UNIT;
    for (; idx < items.length; idx++) {
      out.push("\n" + childIndent);
      emit(items[idx], childIndent);
    }
    out.push("\n" + indent + ")");
  }
  emit(root, "");
  return out.join("") + "\n";
}

// ---------- query helpers ----------
export function head(l: SNode | undefined): string | null {
  if (isList(l) && isAtom(l.items[0])) return l.items[0].v;
  return null;
}
export function child(l: SNode, name: string): SList | undefined {
  if (!isList(l)) return undefined;
  for (const it of l.items) if (isList(it) && head(it) === name) return it;
  return undefined;
}
export function childrenOf(l: SNode, name: string): SList[] {
  if (!isList(l)) return [];
  const out: SList[] = [];
  for (const it of l.items) if (isList(it) && head(it) === name) out.push(it);
  return out;
}
export function lists(l: SNode): SList[] {
  if (!isList(l)) return [];
  return l.items.filter(isList) as SList[];
}
export function fieldArgs(l: SNode, name: string): SNode[] | undefined {
  const c = child(l, name);
  return c ? c.items.slice(1) : undefined;
}
export function atomVal(n: SNode | undefined): string | undefined {
  return isAtom(n) ? n.v : undefined;
}
export function numOf(n: SNode | undefined, fallback = 0): number {
  if (isAtom(n)) {
    const x = Number(n.v);
    return Number.isNaN(x) ? fallback : x;
  }
  return fallback;
}
export function strOf(n: SNode | undefined, fallback = ""): string {
  return isAtom(n) ? n.v : fallback;
}
export function fieldNum(l: SNode, name: string, i: number, fallback = 0): number {
  const a = fieldArgs(l, name);
  return a ? numOf(a[i], fallback) : fallback;
}
export function fieldStr(l: SNode, name: string, i = 0, fallback = ""): string {
  const a = fieldArgs(l, name);
  return a ? strOf(a[i], fallback) : fallback;
}
export function readAt(l: SNode): { x: number; y: number; rot: number } | null {
  const a = fieldArgs(l, "at");
  if (!a) return null;
  return { x: numOf(a[0]), y: numOf(a[1]), rot: numOf(a[2], 0) };
}
export function clone<T extends SNode>(n: T): T {
  if (isAtom(n)) return { kind: "atom", v: n.v, q: n.q } as T;
  return { kind: "list", items: n.items.map(clone) } as T;
}
