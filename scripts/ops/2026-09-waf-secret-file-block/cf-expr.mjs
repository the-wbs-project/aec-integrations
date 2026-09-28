// cf-expr.mjs — a tiny evaluator for the subset of the Cloudflare Rules language that the
// WAF custom rules in docs/waf-rate-limits.md use. It exists so check-corpus.mjs tests the
// LITERAL expression text from the doc, not a hand-written copy of its logic.
//
// Supported: fields http.host, http.request.uri.path, http.request.uri.path.extension,
// http.user_agent; functions lower(), starts_with(), ends_with(); operators contains, eq,
// ne, in {…}; and, or, not; parentheses. Anything else throws, so an expression that grows
// a construct this file does not understand fails the check loudly instead of passing.
//
// Semantics mirror Cloudflare: comparisons are case-sensitive, and path.extension is the
// lowercased text after the last dot of the last path segment ("" for "/.env", "/foo").

const FIELDS = {
  'http.host': (r) => r.host,
  'http.request.uri.path': (r) => r.path,
  'http.request.uri.path.extension': (r) => extensionOf(r.path),
  'http.user_agent': (r) => r.ua ?? '',
};

export function extensionOf(path) {
  const seg = path.split('/').pop();
  const i = seg.lastIndexOf('.');
  return i <= 0 ? '' : seg.slice(i + 1).toLowerCase();
}

function tokenize(src) {
  const out = [];
  const re = /\s*(?:("(?:[^"\\]|\\.)*")|([(){},])|([A-Za-z_][A-Za-z0-9_.]*))/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    const at = re.lastIndex;
    if (!(m = re.exec(src))) {
      if (/^\s*$/.test(src.slice(at))) break;
      throw new Error(`cf-expr: cannot tokenize at ${at}: ${src.slice(at, at + 30)}`);
    }
    if (m[1]) out.push({ t: 'str', v: JSON.parse(m[1]) });
    else if (m[2]) out.push({ t: m[2] });
    else out.push({ t: 'id', v: m[3] });
  }
  return out;
}

export function compile(src) {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const take = (t, v) => {
    const k = toks[i];
    if (!k || k.t !== t || (v !== undefined && k.v !== v))
      throw new Error(`cf-expr: expected ${v ?? t} at token ${i}, got ${JSON.stringify(k)}`);
    i++;
    return k;
  };
  const isKw = (v) => peek()?.t === 'id' && peek().v === v;

  function orExpr() {
    let l = andExpr();
    while (isKw('or')) {
      i++;
      const a = l,
        b = andExpr();
      l = (r) => a(r) || b(r);
    }
    return l;
  }
  function andExpr() {
    let l = notExpr();
    while (isKw('and')) {
      i++;
      const a = l,
        b = notExpr();
      l = (r) => a(r) && b(r);
    }
    return l;
  }
  function notExpr() {
    if (isKw('not')) {
      i++;
      const e = notExpr();
      return (r) => !e(r);
    }
    return comparison();
  }
  function comparison() {
    if (peek()?.t === '(') {
      // A parenthesised boolean group.
      i++;
      const e = orExpr();
      take(')');
      return e;
    }
    const lhs = value();
    if (isKw('contains')) {
      i++;
      const s = take('str').v;
      return (r) => String(lhs(r)).includes(s);
    }
    if (isKw('eq')) {
      i++;
      const s = take('str').v;
      return (r) => lhs(r) === s;
    }
    if (isKw('ne')) {
      i++;
      const s = take('str').v;
      return (r) => lhs(r) !== s;
    }
    if (isKw('in')) {
      i++;
      take('{');
      const set = new Set();
      while (peek()?.t === 'str') set.add(take('str').v);
      take('}');
      return (r) => set.has(lhs(r));
    }
    // A bare boolean-valued function call, e.g. starts_with(...).
    return (r) => Boolean(lhs(r));
  }
  function value() {
    const k = take('id');
    if (peek()?.t === '(') {
      i++;
      const args = [];
      while (peek()?.t !== ')') {
        args.push(
          peek()?.t === 'str'
            ? (
                (s) => () =>
                  s
              )(take('str').v)
            : value(),
        );
        if (peek()?.t === ',') i++;
      }
      take(')');
      const fn = {
        lower:
          ([a]) =>
          (r) =>
            String(a(r)).toLowerCase(),
        starts_with:
          ([a, b]) =>
          (r) =>
            String(a(r)).startsWith(b(r)),
        ends_with:
          ([a, b]) =>
          (r) =>
            String(a(r)).endsWith(b(r)),
      }[k.v];
      if (!fn) throw new Error(`cf-expr: unsupported function ${k.v}`);
      return fn(args);
    }
    const field = FIELDS[k.v];
    if (!field) throw new Error(`cf-expr: unsupported field ${k.v}`);
    return field;
  }

  const fn = orExpr();
  if (i !== toks.length)
    throw new Error(`cf-expr: trailing tokens from ${i}: ${JSON.stringify(toks[i])}`);
  return fn;
}
