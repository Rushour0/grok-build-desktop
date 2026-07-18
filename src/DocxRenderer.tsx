import * as React from "react";
import { useEffect, useState } from "react";

import { allowedAttrs, isAllowedTag, sanitizeHref } from "./lib/docViewer/htmlAllowlist";

type RenderState =
  | { status: "loading" }
  | { status: "success"; content: React.ReactNode }
  | { status: "error"; message: string };

function nodeToReact(node: Node, key: React.Key): React.ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  const children = Array.from(element.childNodes, (child, index) =>
    nodeToReact(child, `${String(key)}-${index}`),
  );

  if (!isAllowedTag(tag)) {
    return React.createElement(React.Fragment, { key }, children);
  }

  const props: Record<string, string | number | React.Key> = { key };

  for (const attribute of allowedAttrs(tag)) {
    const value = element.getAttribute(attribute);
    if (value === null) {
      continue;
    }

    if (tag === "a" && attribute === "href") {
      const href = sanitizeHref(value);
      if (href === null) {
        return React.createElement("span", { key }, children);
      }
      props.href = href;
      continue;
    }

    if ((attribute === "colspan" || attribute === "rowspan") && /^\d+$/.test(value)) {
      props[attribute === "colspan" ? "colSpan" : "rowSpan"] = Number(value);
    }
  }

  return React.createElement(tag, props, children);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export function DocxRenderer({ data }: { data: Uint8Array }): React.ReactElement {
  const [state, setState] = useState<RenderState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function renderDocument(): Promise<void> {
      try {
        const mammoth = await import("mammoth");
        const { value: html } = await mammoth.convertToHtml({
          arrayBuffer: data.buffer as ArrayBuffer,
        });
        const dom = new DOMParser().parseFromString(html, "text/html");
        const walkedChildren = Array.from(dom.body.childNodes, (node, index) =>
          nodeToReact(node, index),
        );
        const content =
          walkedChildren.length > 0 ? walkedChildren : "This document has no renderable content.";

        if (!cancelled) {
          setState({ status: "success", content });
        }
      } catch (error) {
        if (!cancelled) {
          setState({ status: "error", message: errorMessage(error) });
        }
      }
    }

    void renderDocument();

    return () => {
      cancelled = true;
    };
  }, [data]);

  if (state.status === "loading") {
    return <div className="docv-loading">Rendering document…</div>;
  }

  if (state.status === "error") {
    return <div className="docv-error">Couldn&apos;t render this document: {state.message}</div>;
  }

  return <div className="docv-doc">{state.content}</div>;
}
