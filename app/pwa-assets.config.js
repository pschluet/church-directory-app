/*
 * How the PNGs in public/ were generated from public/favicon.svg. Not part of
 * any build -- the icons are committed, because the generator pulls in sharp
 * (~30MB of native binaries) for a set of files that changes about never:
 *
 *   npx --yes @vite-pwa/assets-generator@^1.0.2
 *
 * Kept so the next change to the cross does not have to guess these numbers,
 * the way public/favicon.svg records that favicon.ico is the same geometry
 * rasterised and has to be regenerated with it.
 */
export default {
  images: ["public/favicon.svg"],
  preset: {
    // No `favicons` entry: favicon.ico is hand-rasterised to match the SVG at
    // 16 and 32px, and the generator's 48px render would replace it with a
    // blurrier one.
    transparent: { sizes: [64, 192, 512], padding: 0.05 },

    // Android masks away everything outside the middle 80%, and the cross is
    // drawn edge to edge, so it needs both the padding and a background --
    // a maskable icon may not be transparent. #ffffff is --color-surface.
    maskable: { sizes: [512], padding: 0.3, resizeOptions: { background: "#ffffff" } },

    // Much less padding than maskable: iOS only clips the corners with its
    // squircle, it does not shrink the art, so the 0.3 the preset defaults to
    // leaves the cross looking shrunken next to every other home-screen icon.
    apple: { sizes: [180], padding: 0.12, resizeOptions: { background: "#ffffff" } },
  },
};
