import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFfmpeg, transcodeArgs, transcodeToMp4 } from "./video.js";

describe("transcodeArgs", () => {
  it("encodes H.264 with faststart so the mp4 plays before it finishes downloading", () => {
    const args = transcodeArgs("video.webm", "video.mp4");
    assert.deepEqual(args.slice(0, 3), ["-y", "-i", "video.webm"]);
    assert.equal(args[args.length - 1], "video.mp4");
    assert.ok(args.includes("libx264"), "H.264 plays in QuickTime and Safari");
    assert.ok(args.includes("yuv420p"), "required for H.264 playback in Safari");
    assert.ok(args.includes("+faststart"), "moov first — streams progressively");
  });
});

describe("findFfmpeg", () => {
  it("prefers system ffmpeg on PATH", async () => {
    let called: string[] = [];
    const found = await findFfmpeg({
      exec: async (cmd, args) => {
        called.push(cmd);
        assert.deepEqual(args, ["-version"]);
      },
    });
    assert.equal(found, "ffmpeg");
    assert.deepEqual(called, ["ffmpeg"]);
  });

  it("falls back to a Playwright-bundled copy when PATH has none", async () => {
    const root = join(tmpdir(), `leakdown-ffmpeg-test-${process.pid}`);
    const bin = join(root, "ffmpeg-1011", "ffmpeg-mac-arm64", "ffmpeg");
    mkdirSync(join(root, "ffmpeg-1011", "ffmpeg-mac-arm64"), { recursive: true });
    writeFileSync(bin, "");
    try {
      const found = await findFfmpeg({
        exec: async () => {
          throw new Error("not on PATH");
        },
        extraDirs: [root],
      });
      assert.equal(found, bin);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("transcodeToMp4", () => {
  it("returns false for a missing recording without calling ffmpeg", async () => {
    let called = false;
    const ok = await transcodeToMp4("ffmpeg", join(tmpdir(), "no-such-recording.webm"), join(tmpdir(), "out.mp4"), {
      exec: async () => {
        called = true;
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  });

  it("never throws and removes a half-written output on failure", async () => {
    const root = join(tmpdir(), `leakdown-transcode-test-${process.pid}`);
    mkdirSync(root, { recursive: true });
    const input = join(root, "in.webm");
    const output = join(root, "out.mp4");
    writeFileSync(input, "fake");
    writeFileSync(output, "partial");
    try {
      const ok = await transcodeToMp4("ffmpeg", input, output, {
        exec: async () => {
          throw new Error("codec missing");
        },
      });
      assert.equal(ok, false);
      assert.equal(existsSync(output), false, "a later run must not mistake it for finished");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns true only when the output exists after a clean run", async () => {
    const root = join(tmpdir(), `leakdown-transcode-ok-${process.pid}`);
    mkdirSync(root, { recursive: true });
    const input = join(root, "in.webm");
    const output = join(root, "out.mp4");
    writeFileSync(input, "fake");
    try {
      const ok = await transcodeToMp4("ffmpeg", input, output, {
        exec: async (_cmd, _args) => {
          writeFileSync(output, "done");
        },
      });
      assert.equal(ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
