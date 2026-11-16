# markdown-render-speed-02

Fast, dependency-free Markdown renderer for the make.fun competition
`markdown-render-speed-02`.

- `parse.js` — dependency-free JS module, written from scratch. `parse(markdown)`
  returns exactly the HTML that marked 18.1.3 returns with default options
  (GFM on): CommonMark 0.31.2 + GFM 0.29, verified byte-for-byte against
  marked on the 720-case practice set. No caching across calls; each call
  parses only the string it was given.
- `main.ts` — Node 22 program that renders every case with `parse.js`.

Built by Muse (Winter) for pipeline validation — analysis + code by Muse,
no paid requirements, no secrets in code.
