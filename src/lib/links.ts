/* links.ts — pasted osu! links → what they point at. Same rules as parse_link in
   src-tauri/src/downloads.rs (the backend decides; this is for showing what was recognised). */

export interface LinkTarget {
  kind: "set" | "beatmap";
  id: number;
}

const id = (v: string | undefined): number | null => (v && /^\d{1,10}$/.test(v) && +v > 0 && +v <= 0xffffffff ? +v : null);

/** osu! set and beatmap links in their forms, osu://s/… and osu://b/…, or a bare set ID. */
export function parseLink(line: string): LinkTarget | null {
  const s = line.trim().replace(/^[<>"]+|[<>"]+$/g, "");
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = id(s);
    return n ? { kind: "set", id: n } : null;
  }
  const lower = s.toLowerCase();
  const web = /^https?:\/\/(?:www\.)*osu\.ppy\.sh(.*)$/.exec(lower);
  const rest = web ? web[1] : lower.startsWith("osu:/") ? lower.slice(5) : null;
  if (rest === null) return null;
  const path = rest.split("#")[0];
  const q = path.indexOf("?");
  const [p, query] = q < 0 ? [path, ""] : [path.slice(0, q), path.slice(q + 1)];
  const parts = p.split("/").filter(Boolean);
  const target = (kind: LinkTarget["kind"], v: string | undefined): LinkTarget | null => {
    const n = id(v);
    return n ? { kind, id: n } : null;
  };
  switch (parts[0]) {
    case "beatmapsets":
    case "s":
      return target("set", parts[1]);
    case "beatmaps":
    case "b":
      return target("beatmap", parts[1]);
    case "p":
      if (parts.length !== 2 || parts[1] !== "beatmap") return null;
      return target("beatmap", query.split("&").find((kv) => kv.startsWith("b="))?.slice(2));
    case "dl":
      return parts.length === 2 ? target("set", parts[1]) : null;
    default:
      return null;
  }
}

export interface PastedLinks {
  /** the recognised links, each target once, in order */
  links: string[];
  /** lines with nothing recognisable in them */
  unknown: string[];
}

/** Links out of pasted text: any number per line, between other words. */
export function readLinks(text: string): PastedLinks {
  const links: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let found = false;
    for (const token of line.trim().split(/\s+/)) {
      const t = parseLink(token);
      if (!t) continue;
      found = true;
      const key = `${t.kind}:${t.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push(token);
      }
    }
    if (!found) unknown.push(line.trim());
  }
  return { links, unknown };
}
