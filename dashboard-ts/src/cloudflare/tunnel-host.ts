/** Docker-only connector provisioning. Never interpolate credentials into shell commands. */
import Docker from "dockerode";
import { randomBytes } from "node:crypto";
import { docker } from "../providers/docker-engine";
import { remoteDocker, serverById, configFor } from "../servers";
export const CLOUDFLARED_IMAGE =
  "cloudflare/cloudflared:2026.10.3@sha256:faa8e0a1475f137c910be6025f43c8e4092fdd35461b31e19fd1390657a1ff39";
export function hostDocker(serverId: number) {
  if (serverId === 0) return docker();
  const server = serverById(serverId);
  if (!server) throw Error("سيرفر SSH غير موجود");
  return remoteDocker(configFor(server));
}
async function pulled(client: Docker, image: string) {
  try {
    await client.getImage(image).inspect();
  } catch (e: any) {
    if (e.statusCode !== 404) throw e;
    const stream = await client.pull(image);
    await new Promise<void>((resolve, reject) =>
      client.modem.followProgress(stream, (err: any) =>
        err ? reject(err) : resolve(),
      ),
    );
  }
}
function candidate(info: any) {
  const labels = info.Config?.Labels || {};
  const name = String(info.Name || "").replace(/^\//, "");
  return (
    labels["com.deskswarm.component"] === "dashboard" ||
    (name.startsWith("deskswarm") &&
      (name.includes("dashboard") ||
        labels["com.docker.compose.service"] === "dashboard"))
  );
}
export const tunnelHost = {
  async discover(serverId: number) {
    const client = hostDocker(serverId);
    const info = await client.info();
    if (info.OSType !== "linux") throw Error("السيرفر يحتاج Linux + Docker");
    const found = [];
    for (const item of await client.listContainers({ all: false })) {
      if (
        !(
          item.Labels?.["com.deskswarm.component"] === "dashboard" ||
          item.Names?.some((n) => /^\/deskswarm.*dashboard/.test(n)) ||
          (item.Labels?.["com.docker.compose.project"] === "deskswarm" &&
            item.Labels?.["com.docker.compose.service"] === "dashboard")
        )
      )
        continue;
      const details = await client.getContainer(item.Id).inspect();
      if (!candidate(details)) continue;
      const network = Object.keys(details.NetworkSettings?.Networks || {}).find(
        (n) => !["host", "none", "bridge"].includes(n),
      );
      if (!network) continue;
      const port = Number(
        details.Config?.Env?.find((e: string) => e.startsWith("PORT="))?.slice(
          5,
        ) || 7000,
      );
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      found.push({
        id: details.Id,
        name: details.Name.replace(/^\//, ""),
        network,
        port,
      });
    }
    return found;
  },
  async probe(serverId: number, containerId: string) {
    const candidates = await tunnelHost.discover(serverId);
    const selected = candidates.find((c) => c.id === containerId);
    if (!selected)
      throw Error(
        "اختر خدمة DeskSwarm شغّالة على شبكة Docker خاصة؛ السيرفر غير مجهّز بعد",
      );
    const client = hostDocker(serverId);
    // An owned throwaway probe checks the target over its actual Docker network.
    await pulled(client, "curlimages/curl:8.17.0");
    const probe = await client.createContainer({
      name: `deskswarm-connectivity-${randomBytes(8).toString("hex")}`,
      Image: "curlimages/curl:8.17.0",
      Cmd: [
        "-fsS",
        "--max-time",
        "12",
        `http://${selected.name}:${selected.port}/health`,
      ],
      Labels: { "com.deskswarm.component": "connectivity-probe" },
      HostConfig: {
        NetworkMode: selected.network,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: 64 * 1024 * 1024,
        PidsLimit: 32,
      },
    });
    try {
      await probe.start();
      const done = await probe.wait();
      const output = await probe.logs({ stdout: true, stderr: false });
      // Docker's multiplex headers surround JSON; look only for the health object.
      if (
        done.StatusCode !== 0 ||
        !Buffer.from(output as any)
          .toString()
          .includes('"status":"ok"')
      )
        throw Error("خدمة DeskSwarm لا تستجيب عبر شبكة Docker");
    } finally {
      await probe.remove({ force: true }).catch(() => {});
    }
    return selected;
  },
  async start(
    serverId: number,
    resource: {
      id: number;
      tunnel_id: string;
      backend: string;
      network: string;
      token: string;
    },
  ) {
    const client = hostDocker(serverId);
    const name = `deskswarm-tunnel-${resource.id}`;
    let container = client.getContainer(name);
    let existing: any;
    try {
      existing = await container.inspect();
    } catch (e: any) {
      if (e.statusCode !== 404) throw e;
    }
    if (existing) {
      if (
        existing.Config?.Labels?.["com.deskswarm.tunnel"] !== resource.tunnel_id
      )
        throw Error("اسم حاوية النفق مستخدم لخدمة أخرى");
      if (
        existing.State?.Running &&
        existing.HostConfig?.NetworkMode === resource.network &&
        existing.Config?.Env?.includes(`TUNNEL_TOKEN=${resource.token}`)
      )
        return existing.Id;
      if (existing.State?.Running) await container.stop({ t: 10 });
      await container.remove();
    }
    await pulled(client, CLOUDFLARED_IMAGE);
    container = await client.createContainer({
      name,
      Image: CLOUDFLARED_IMAGE,
      Cmd: ["tunnel", "--no-autoupdate", "run"],
      Env: [`TUNNEL_TOKEN=${resource.token}`],
      Labels: {
        "com.deskswarm.component": "tunnel",
        "com.deskswarm.tunnel": resource.tunnel_id,
      },
      HostConfig: {
        NetworkMode: resource.network,
        RestartPolicy: { Name: "unless-stopped" },
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: 128 * 1024 * 1024,
        PidsLimit: 64,
        LogConfig: {
          Type: "json-file",
          Config: { "max-size": "1m", "max-file": "2" },
        },
      },
    });
    await container.start();
    return container.id;
  },
  async stop(serverId: number, id: number, tunnelId: string) {
    const container = hostDocker(serverId).getContainer(
      `deskswarm-tunnel-${id}`,
    );
    let info;
    try {
      info = await container.inspect();
    } catch (e: any) {
      if (e.statusCode === 404) return;
      throw e;
    }
    if (info.Config?.Labels?.["com.deskswarm.tunnel"] !== tunnelId)
      throw Error("هوية حاوية النفق غير مطابقة");
    if (info.State?.Running) await container.stop({ t: 10 });
  },
};
