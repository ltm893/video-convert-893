import * as fs from "fs";
import * as path from "path";
import { resolveId, resolveRegion } from "../lib/baseId.cjs";

export function baseConfigFile(): string {
  if (process.env.BASE_CONFIG_PATH) return process.env.BASE_CONFIG_PATH;
  return path.resolve(__dirname, "../../../cognito-s3-stack-893/base/bin/config.ts");
}

function quotedField(text: string, key: string): string {
  const match = text.match(new RegExp("^\\s*" + key + ":\\s*\"([^\"]*)\"", "m"));
  return match ? match[1].trim() : "";
}

export function readBaseConfig(): { id: string; awsRegion: string } {
  const file = baseConfigFile();
  if (!fs.existsSync(file)) {
    throw new Error(
      "Set id in cognito-s3-stack-893/base/bin/config.ts. Not found at " + file +
      ". Set BASE_CONFIG_PATH if that repo is not a sibling."
    );
  }
  const text = fs.readFileSync(file, "utf8");
  return {
    id: resolveId(undefined, quotedField(text, "id")),
    awsRegion: resolveRegion(undefined, quotedField(text, "awsRegion")),
  };
}

export function withBaseId<T extends { id?: string; awsRegion?: string }>(
  local: T
): T & { id: string; awsRegion: string } {
  const localId = (local.id ?? "").trim();
  const localRegion = (local.awsRegion ?? "").trim();
  const needsBase = !localId || localId === "your-id-here" || !localRegion;
  const base = needsBase ? readBaseConfig() : null;
  return {
    ...local,
    id: resolveId(local.id, base?.id),
    awsRegion: resolveRegion(local.awsRegion, base?.awsRegion),
  };
}
