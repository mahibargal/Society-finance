import fs from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { PNG } from "pngjs";

const svg = fs.readFileSync("public/icons/icon.svg", "utf8");
const maskableSvg = fs.readFileSync("public/icons/icon-maskable.svg", "utf8");

function renderToFile(source, size, file) {
  const resvg = new Resvg(source, {
    fitTo: { mode: "width", value: size },
    background: "#0d9488",
  });
  fs.writeFileSync(file, resvg.render().asPng());
}

function renderMaskable(size, file) {
  const innerSize = Math.round(size * 0.68);
  const resvg = new Resvg(maskableSvg, {
    fitTo: { mode: "width", value: innerSize },
    background: "#0d9488",
  });
  const decoded = PNG.sync.read(resvg.render().asPng());
  const out = new PNG({ width: size, height: size });
  const padX = Math.floor((size - decoded.width) / 2);
  const padY = Math.floor((size - decoded.height) / 2);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const oi = (size * y + x) << 2;
      out.data[oi] = 13;
      out.data[oi + 1] = 148;
      out.data[oi + 2] = 136;
      out.data[oi + 3] = 255;
    }
  }
  for (let y = 0; y < decoded.height; y += 1) {
    for (let x = 0; x < decoded.width; x += 1) {
      const si = (decoded.width * y + x) << 2;
      if (decoded.data[si + 3] < 128) continue;
      const ox = x + padX;
      const oy = y + padY;
      const oi = (size * oy + ox) << 2;
      out.data[oi] = decoded.data[si];
      out.data[oi + 1] = decoded.data[si + 1];
      out.data[oi + 2] = decoded.data[si + 2];
      out.data[oi + 3] = 255;
    }
  }
  fs.writeFileSync(file, PNG.sync.write(out));
}

fs.mkdirSync("public/icons", { recursive: true });
renderToFile(svg, 180, "public/icons/apple-touch-icon.png");
renderToFile(svg, 192, "public/icons/icon-192.png");
renderToFile(svg, 512, "public/icons/icon-512.png");
renderMaskable(512, "public/icons/icon-512-maskable.png");
console.log("Icons written to public/icons/");
