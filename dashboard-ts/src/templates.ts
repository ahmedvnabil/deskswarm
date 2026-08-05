/**
 * The Jinja templates, rendered by nunjucks.
 *
 * The HTML was not rewritten for this port. nunjucks is close enough to Jinja2
 * that the templates carry over nearly verbatim, which keeps the interface
 * byte-for-byte what it was and takes 1,700 lines of markup out of the blast
 * radius of a backend rewrite. What nunjucks does not ship — Jinja's printf
 * `format`, `tojson`, `map(attribute=…)` — is added back here rather than by
 * editing every template that uses them.
 */

import nunjucks from "nunjucks";
import { TEMPLATE_DIR } from "./settings";

export const nunjucksEnv = new nunjucks.Environment(
  new nunjucks.FileSystemLoader(TEMPLATE_DIR, { noCache: false }),
  { autoescape: true, throwOnUndefined: false },
);

/**
 * Jinja's printf-style `format`. Only the conversions the templates actually
 * use are implemented — %s, %d and %.Nf — because a half-right printf that
 * silently mangles the rest is worse than one that refuses.
 */
function pyFormat(fmt: string, ...args: unknown[]): string {
  let i = 0;
  return String(fmt).replace(/%(?:\.(\d+))?([sdf])/g, (whole, prec, kind) => {
    const value = args[i++];
    if (value === null || value === undefined) return "";
    if (kind === "s") return String(value);
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    if (kind === "d") return String(Math.trunc(n));
    return n.toFixed(prec === undefined ? 6 : Number(prec));
  });
}

nunjucksEnv.addFilter("format", pyFormat as any);

// Jinja spells escape `e`; nunjucks only has `escape`. Both return a marked
// SafeString, so autoescaping does not then escape the result a second time.
const escape = nunjucksEnv.getFilter("escape");
nunjucksEnv.addFilter("e", (value: unknown) => escape(value ?? ""));

// Jinja's `tojson`. nunjucks calls the same thing `dump`.
nunjucksEnv.addFilter("tojson", (value: unknown) =>
  new nunjucks.runtime.SafeString(
    JSON.stringify(value ?? null).replace(/</g, "\\u003c"),
  ),
);

// `map(attribute='day')` — the only form the templates use.
nunjucksEnv.addFilter("map", (arr: any[], opts: any) => {
  const attr = typeof opts === "string" ? opts : opts?.attribute;
  return (arr ?? []).map((item) => (attr ? item?.[attr] : item));
});

// A no-op in JavaScript: `map` already returns a real array. Present so the
// Jinja idiom `… | map(attribute=…) | list | tojson` keeps working.
nunjucksEnv.addFilter("list", (value: any) => Array.from(value ?? []));

export function render(template: string, context: Record<string, unknown> = {}): string {
  return nunjucksEnv.render(template, context);
}
