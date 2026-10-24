/** Download integrity metadata; contains no host paths or model credentials. */
import { createHash } from "node:crypto";
export function artifactManifest(
  run: { id: number; status: string; created_at: string },
  files: { id: number; name: string; data: Uint8Array }[],
) {
  return {
    schema_version: 1,
    run_id: run.id,
    status: run.status,
    partial: run.status !== "completed",
    created_at: run.created_at,
    storage: "linux-local",
    files: files.map((f) => ({
      id: f.id,
      name: f.name,
      archive_path: `files/${f.id}-${f.name}`,
      bytes: f.data.byteLength,
      sha256: createHash("sha256").update(f.data).digest("hex"),
    })),
  };
}
