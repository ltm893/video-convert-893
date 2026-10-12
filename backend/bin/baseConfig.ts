import * as fs from "fs";
import * as path from "path";

const PLACEHOLDER_ID = "your-id-here";

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
  const id = quotedField(text, "id");
  const awsRegion = quotedField(text, "awsRegion");
  if (!id || id === PLACEHOLDER_ID) {
    throw new Error("Set id in " + file);
  }
  if (!awsRegion) {
    throw new Error("Set awsRegion in " + file);
  }
  return { id, awsRegion };
}

export function withBaseId<T extends { id?: string; awsRegion?: string }>(
  local: T
): T & { id: string; awsRegion: string } {
  const localId = (local.id ?? "").trim();
  const keepLocalId = localId !== "" && localId !== PLACEHOLDER_ID;
  const localRegion = (local.awsRegion ?? "").trim();
  const base = keepLocalId && localRegion ? null : readBaseConfig();
  return {
    ...local,
    id: keepLocalId ? localId : base!.id,
    awsRegion: localRegion || base!.awsRegion,
  };
}
