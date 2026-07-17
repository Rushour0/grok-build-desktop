// `diff` (jsdiff) v7 ships no bundled types and its `exports` map exposes no `types`
// condition, so TypeScript can't resolve declarations for it. We use exactly two functions;
// declare just those rather than pulling in a `@types/diff` that tracks a different major.
declare module "diff" {
  export interface Change {
    value: string;
    added?: boolean;
    removed?: boolean;
    count?: number;
  }
  export function diffLines(oldStr: string, newStr: string, options?: unknown): Change[];
  export function diffWordsWithSpace(oldStr: string, newStr: string, options?: unknown): Change[];
}
