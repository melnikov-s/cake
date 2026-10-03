import { deflateSync } from "node:zlib";

/** Valid, deliberately oversized PNG so Pi's preview resizing is exercised. */
export function originalImageBytes() {
  const crc32 = (data: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2400, 0);
  header.writeUInt32BE(8, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((1 + 2400 * 3) * 8, 180);
  for (let row = 0; row < 8; row++) rows[row * (1 + 2400 * 3)] = 0;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    // Original metadata exceeds a common per-argument limit; previews discard it.
    chunk("tEXt", Buffer.from("Comment\0" + "provider-original-metadata".repeat(9000))),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Use ordinary Pi filesystem tools; do not introduce a binary-save runtime. */
export function nativeImageScript(options: { save?: string; reference?: string } = {}) {
  const input = options.reference
    ? `const reference = await tools.bash({ command: ${JSON.stringify(nodeCommand(`process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(options.reference)}).toString('base64'))`))} });
       if (reference.exit_code !== 0 || reference.truncated) throw new Error("Reference image could not be read completely");
       input.push({ type: "image", data: reference.output.trim(), mimeType: "image/png" });`
    : "";
  const save = options.save
    ? `await tools.write({ path: ${JSON.stringify(`${options.save}.base64.tmp`)}, content: block.data });
       const saved = await tools.bash({ command: ${JSON.stringify(nodeCommand(`const fs = require('node:fs'); const stage = ${JSON.stringify(`${options.save}.base64.tmp`)}; try { fs.writeFileSync(${JSON.stringify(options.save)}, Buffer.from(fs.readFileSync(stage, 'utf8'), 'base64'), { flag: 'wx' }); } finally { fs.unlinkSync(stage); }`))} });
       if (saved.exit_code !== 0) throw new Error(saved.output);
       text("Saved original: " + ${JSON.stringify(options.save)});`
    : "";
  return `const available = await models.getAvailableOfType("image", "openrouter");
    const painter = available.find(m => m.id === "google/gemini-2.5-flash-image");
    if (!painter) throw new Error("No available OpenRouter image model; configure OpenRouter credentials (not a ChatGPT subscription).");
    const input = [{ type: "text", text: "A red fox in the snow, watercolor" }];
    ${input}
    const result = await models.generateImages(painter, { input });
    if (result.stopReason !== "stop") throw new Error(result.errorMessage || result.stopReason);
    for (const block of result.output) {
      if (block.type === "image") { ${save} image(block); }
      else text(block.text);
    }`;
}

function nodeCommand(source: string) {
  return `node -e '${source.replace(/'/g, "'\"'\"'")}'`;
}

export function imageProviderResponse(data = originalImageBytes().toString("base64")) {
  return {
    id: "fixture-image",
    choices: [
      {
        message: {
          role: "assistant",
          content: "Generated fox",
          images: [{ image_url: { url: `data:image/png;base64,${data}` } }],
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 17, completion_tokens: 29 },
  };
}
