import { execFile } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Playable-video helpers.
 *
 * Playwright records VP8 `.webm`, which neither QuickTime nor Safari opens.
 * Playwright offers no codec knob, so after a session we transcode to H.264
 * `.mp4` with faststart (moov first — plays before the download finishes).
 * No new dependency: system `ffmpeg` wins, otherwise the copy Playwright
 * itself downloaded for recording (it ships one in its browser cache).
 * Everything here fails soft — no ffmpeg means `.webm` only, never a
 * failed run.
 */

type Exec = (cmd: string, args: string[]) => Promise<void>;

const defaultExec: Exec = (cmd, args) =>
  new Promise<void>((resolvePromise, reject) => {
    execFile(cmd, args, { timeout: 30_000 }, (err) => (err ? reject(err) : resolvePromise()));
  });

/** Exact argv for a directly-playable mp4. Pure — unit-tested, never hand-edit. */
export function transcodeArgs(input: string, output: string): string[] {
  return [
    "-y",
    "-i",
    input,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "23",
    "-preset",
    "veryfast",
    "-movflags",
    "+faststart",
    output,
  ];
}

/** Candidate Playwright browser-cache roots, in lookup order. */
export function browserCacheDirs(): string[] {
  const out: string[] = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) out.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  const home = homedir();
  if (process.platform === "darwin") out.push(join(home, "Library", "Caches", "ms-playwright"));
  out.push(join(home, ".cache", "ms-playwright"));
  return out;
}

/**
 * Locate an ffmpeg binary: system PATH first, then Playwright's bundled copy
 * (the ffmpeg build inside a browser cache dir, next to the chromium builds).
 * `extraDirs` exists so tests never touch the real filesystem roots.
 */
export async function findFfmpeg(deps?: { exec?: Exec; extraDirs?: string[] }): Promise<string | null> {
  const exec = deps?.exec ?? defaultExec;
  try {
    await exec("ffmpeg", ["-version"]);
    return "ffmpeg";
  } catch {
    // not on PATH — fall through to the bundled copy
  }
  const roots = [...(deps?.extraDirs ?? []), ...browserCacheDirs()];
  const bins = process.platform === "win32" ? ["ffmpeg.exe"] : ["ffmpeg", "ffmpeg-mac", "ffmpeg-linux"];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("ffmpeg-")) continue;
      // Playwright lays the binary straight inside (ffmpeg-1011/ffmpeg-mac);
      // check that first, then one directory deeper for other layouts
      const candidates = [join(root, entry)];
      try {
        for (const inner of readdirSync(join(root, entry), { withFileTypes: true })) {
          if (inner.isDirectory()) candidates.push(join(root, entry, inner.name));
        }
      } catch {
        continue;
      }
      for (const dir of candidates) {
        for (const bin of bins) {
          const candidate = join(dir, bin);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }
  return null;
}

/**
 * Transcode one recording to playable mp4. Returns true only when the output
 * exists afterwards. Never throws — a half-written output is removed so a
 * later run never mistakes it for a finished video.
 */
export async function transcodeToMp4(
  ffmpeg: string,
  input: string,
  output: string,
  deps?: { exec?: Exec },
): Promise<boolean> {
  if (!existsSync(input)) return false;
  const exec = deps?.exec ?? defaultExec;
  try {
    await exec(ffmpeg, transcodeArgs(input, output));
    return existsSync(output);
  } catch {
    try {
      rmSync(output, { force: true });
    } catch {
      // nothing to clean — leave the webm as the only artifact
    }
    return false;
  }
}
