# Remyral brand portfolio

Open `index.html`. It works fully offline and loads nothing external (it uses Inter and Plus Jakarta Sans when they
are installed, otherwise the system font). Treat the PNG and SVG-embedded files as the source of truth for the
artwork.

## Formats

- `assets/png`: PNG assets produced from the approved artwork.
- `assets/svg/*-embedded.svg`: the PNG image embedded in an SVG; the pixels are preserved, but it is **not an
  editable vector**.
- `assets/svg/*-vector.svg`: real SVG paths traced from the alpha contours; gradients and fine details can differ
  from the reference image. Check by hand before print or trademark use.
- Source image / design board: `assets/reference/brand-board.png`.

Every download button on the page points at a file in this folder; there is no separate ZIP package.

## License

The names, logos and brand assets in this folder are not covered by the repository's Apache-2.0 license; see
[TRADEMARKS.md](../../TRADEMARKS.md) for the terms of use. A distributed fork must use its own name and logo.
