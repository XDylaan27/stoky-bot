import webpmux from 'node-webpmux';

// Compose partial frames before resizing: each output frame is independent.
export function compositeFrame(canvas, width, height, pixels, frame) {
  if (frame.x + frame.width > width || frame.y + frame.height > height || pixels.length !== frame.width * frame.height * 4) throw new Error('Fotograma fuera del lienzo');
  for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
    const s = (y * frame.width + x) * 4, d = ((y + frame.y) * width + x + frame.x) * 4;
    if (!frame.blend) { canvas.set(pixels.subarray(s, s + 4), d); continue; }
    const a = pixels[s + 3] / 255, b = canvas[d + 3] / 255, alpha = a + b * (1 - a);
    for (let c = 0; c < 3; c++) canvas[d + c] = alpha ? Math.round((pixels[s + c] * a + canvas[d + c] * b * (1 - a)) / alpha) : 0;
    canvas[d + 3] = Math.round(alpha * 255);
  }
}

export function resizeCanvas(canvas, width, height, maxSide = 512) {
  const output = Buffer.alloc(512 * 512 * 4);
  const ratio = Math.min(maxSide / width, maxSide / height);
  const w = Math.max(1, Math.round(width * ratio)), h = Math.max(1, Math.round(height * ratio));
  const left = Math.floor((512 - w) / 2), top = Math.floor((512 - h) / 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.max(0, Math.min(width - 1, (x + 0.5) / ratio - 0.5));
    const sy = Math.max(0, Math.min(height - 1, (y + 0.5) / ratio - 0.5));
    const x0 = Math.floor(sx), y0 = Math.floor(sy), dx = sx - x0, dy = sy - y0;
    const colors = [0, 0, 0]; let alpha = 0;
    for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) {
      const weight = (xx ? dx : 1 - dx) * (yy ? dy : 1 - dy);
      const at = (Math.min(height - 1, y0 + yy) * width + Math.min(width - 1, x0 + xx)) * 4;
      const weightedAlpha = canvas[at + 3] * weight;
      alpha += weightedAlpha;
      for (let c = 0; c < 3; c++) colors[c] += canvas[at + c] * weightedAlpha;
    }
    const dest = ((top + y) * 512 + left + x) * 4;
    for (let c = 0; c < 3; c++) output[dest + c] = alpha ? Math.round(colors[c] / alpha) : 0;
    output[dest + 3] = Math.round(alpha);
  }
  return output;
}

export async function normalizeAnimatedWebp(buffer, quality = 65) {
  await webpmux.Image.initLib();
  const input = new webpmux.Image();
  await input.load(buffer);
  if (!input.hasAnim || input.width * input.height > 1024 * 1024 || input.frames.length > 180) throw new Error('Animacion demasiado compleja');
  // For very detailed clips, reduce the drawing area while keeping a 512px
  // transparent canvas and every frame/delay. Do not drop frames to fit size.
  const attempts = [
    { q: Math.min(quality, 65), side: 512 },
    { q: Math.min(quality, 40), side: 512 },
    { q: Math.min(quality, 25), side: 512 },
    { q: Math.min(quality, 40), side: 448 },
    { q: Math.min(quality, 35), side: 384 },
    { q: Math.min(quality, 30), side: 320 }
  ];
  for (const { q, side } of attempts) {
    const canvas = Buffer.alloc(input.width * input.height * 4), frames = [];
    let duration = 0;
    for (let i = 0; i < input.frames.length && duration < 6000; i++) {
      // node-webpmux 3.2 exposes raw ANMF coordinates, in units of TWO pixels.
      const rawFrame = input.frames[i];
      const frame = { ...rawFrame, x: rawFrame.x * 2, y: rawFrame.y * 2 };
      compositeFrame(canvas, input.width, input.height, await input.getFrameData(i), frame);
      const image = await webpmux.Image.getEmptyImage();
      const result = await image.setImageData(resizeCanvas(canvas, input.width, input.height, side), { width: 512, height: 512, quality: q, method: 4 });
      if (result !== 0) throw new Error('No se pudo codificar el fotograma');
      const delay = Math.min(Math.max(20, frame.delay), 6000 - duration);
      frames.push(await webpmux.Image.generateFrame({ img: image, x: 0, y: 0, delay, blend: false, dispose: true }));
      duration += delay;
      if (frame.dispose) for (let y = frame.y; y < frame.y + frame.height; y++) canvas.fill(0, (y * input.width + frame.x) * 4, (y * input.width + frame.x + frame.width) * 4);
      // Yield between frames so WhatsApp can continue handling messages.
      await new Promise(resolve => setImmediate(resolve));
    }
    const output = await webpmux.Image.save(null, { width: 512, height: 512, frames, bgColor: [0, 0, 0, 0], loops: 0 });
    if (output.length <= 480 * 1024) return output;
  }
  throw new Error('La animacion supera el tamano permitido incluso tras comprimir');
}
