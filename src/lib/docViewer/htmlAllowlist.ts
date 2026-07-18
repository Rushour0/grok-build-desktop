export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "ul",
  "ol",
  "li",
  "br",
  "blockquote",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "a",
  "code",
  "pre",
  "hr",
  "span",
]);

export function isAllowedTag(tag: string): boolean {
  return ALLOWED_TAGS.has(tag.toLowerCase());
}

export function sanitizeHref(href: string | null | undefined): string | null {
  if (!href || !/^https?:\/\/\S+$/i.test(href)) {
    return null;
  }

  return href;
}

export function allowedAttrs(tag: string): string[] {
  switch (tag.toLowerCase()) {
    case "a":
      return ["href"];
    case "th":
    case "td":
      return ["colspan", "rowspan"];
    default:
      return [];
  }
}
