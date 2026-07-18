/// A small resident cat that paces the chat header bar — a bit of life where a
/// redundant "Close tab" button used to sit (tabs already have their own × in the
/// strip). Purely decorative: no state, no interactivity, no data. The wander /
/// tail-flick / blink are all CSS (see `.cat*` in App.css) so this component is a
/// static inline SVG — monochrome (`currentColor`) to match the design language,
/// and it holds still under `prefers-reduced-motion` (handled in CSS).
///
/// Inline SVG, not an asset: the app's CSP is `img-src 'self'` / `style-src 'self'`
/// with no external hosts, and every other glyph in this UI is an inline
/// currentColor SVG for the same reason.
export function CatPet(): React.ReactElement {
  return (
    <span className="cat" aria-hidden="true" title="just a cat">
      <span className="cat-walk">
        <svg className="cat-svg" viewBox="0 0 40 28" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          {/* body */}
          <path d="M9 22c-1.6 0-3-1.5-3-3.4V13c0-3 2.4-5.4 5.4-5.4h9.2c3 0 5.4 2.4 5.4 5.4v5.6c0 1.9-1.4 3.4-3 3.4" />
          {/* head + ears */}
          <path className="cat-head" d="M25 14.5c0-2.6 2-4.7 4.5-4.7s4.5 2.1 4.5 4.7-2 4.7-4.5 4.7c-1 0-1.9-.3-2.6-.8" />
          <path className="cat-head" d="M27.6 10.6 26.6 7l2.9 1.6M31.4 10.6 32.4 7l-2.9 1.6" />
          {/* eye */}
          <path className="cat-eye" d="M30.4 14.2h.02" />
          {/* legs */}
          <path d="M10 22v3.2M15 22v3.2M20 22v3.2" />
          {/* tail */}
          <path className="cat-tail" d="M6 18c-2.4 0-3.6-2-3.4-4.4" />
        </svg>
      </span>
    </span>
  );
}
